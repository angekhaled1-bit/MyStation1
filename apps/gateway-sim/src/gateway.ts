import {
  PROTOCOL_VERSION,
  checkCommandShape,
  signPayload,
  verifyPayload,
  type AckStatus,
  type CommandAck,
  type DeviceResult,
  type GatewayState,
  type PriceCommand,
} from '@fpc/protocol';
import type { PriceDevice } from './devices.js';
import type { Store } from './store.js';

export interface GatewayConfig {
  tenant: string;
  gatewayId: string;
  secret: string;
  /** Bornes locales : dernière défense contre un prix aberrant, même signé. */
  priceMin: number;
  priceMax: number;
  /** Nombre d'essais par équipement avant de déclarer l'échec. */
  deviceAttempts: number;
  retryDelayMs: number;
  fw?: string;
}

export type AckKind = Omit<CommandAck, 'v' | 'cmd_id' | 'gw' | 'at' | 'sig'> & { status: AckStatus };

export interface GatewayIO {
  publishAck(ack: CommandAck): void | Promise<void>;
  publishState?(state: GatewayState): void | Promise<void>;
  log?(msg: string): void;
  now?(): Date;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Cœur du logiciel du boîtier, indépendant du transport MQTT pour pouvoir le tester.
 * Ordre des contrôles : forme → destinataire → signature → doublon → expiration → ordre (seq)
 * → bornes locales → écriture en file persistante → accusé « received ».
 */
export class Gateway {
  private processing = false;

  constructor(
    private readonly cfg: GatewayConfig,
    private readonly store: Store,
    private readonly totem: PriceDevice,
    private readonly pumps: PriceDevice[],
    private readonly io: GatewayIO,
  ) {}

  private now(): Date {
    return this.io.now ? this.io.now() : new Date();
  }

  private log(msg: string) {
    this.io.log?.(`[${this.cfg.gatewayId}] ${msg}`);
  }

  private async ack(cmdId: string, body: AckKind, remember = true): Promise<CommandAck> {
    const ack = signPayload(
      { v: PROTOCOL_VERSION, cmd_id: cmdId, gw: this.cfg.gatewayId, at: this.now().toISOString(), ...body },
      this.cfg.secret,
    ) as CommandAck;
    if (remember) {
      this.store.data.seen[cmdId] = ack;
      this.store.save();
    }
    await this.io.publishAck(ack);
    return ack;
  }

  get data() {
    return this.store.data;
  }

  state(online = true): GatewayState {
    return {
      v: PROTOCOL_VERSION,
      gw: this.cfg.gatewayId,
      online,
      at: this.now().toISOString(),
      last_seq: this.store.data.lastAppliedSeq,
      prices: { ...this.store.data.lastValid },
      pending: this.store.data.queue.length,
      fw: this.cfg.fw,
    };
  }

  private async publishState() {
    await this.io.publishState?.(this.state(true));
  }

  /** Réception d'un message brut sur le topic cmd. */
  async receive(raw: Buffer | string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      this.log('message illisible ignoré');
      return;
    }
    const shapeErr = checkCommandShape(msg);
    const cmdId = (msg as { cmd_id?: unknown })?.cmd_id;
    if (shapeErr) {
      this.log(`commande mal formée : ${shapeErr}`);
      // On ne mémorise pas : un cmd_id non vérifié ne doit pas empoisonner l'anti-doublon.
      if (typeof cmdId === 'string' && cmdId.length <= 64) await this.ack(cmdId, { status: 'rejected', reason: `bad_shape: ${shapeErr}` }, false);
      return;
    }
    const cmd = msg as PriceCommand;
    if (cmd.gw !== this.cfg.gatewayId || cmd.tenant !== this.cfg.tenant) {
      this.log(`commande destinée à ${cmd.tenant}/${cmd.gw}, ignorée`);
      await this.ack(cmd.cmd_id, { status: 'rejected', reason: 'wrong_gateway' }, false);
      return;
    }
    if (!verifyPayload(cmd, this.cfg.secret)) {
      this.log(`signature invalide pour ${cmd.cmd_id} : rien n'est écrit`);
      await this.ack(cmd.cmd_id, { status: 'rejected', reason: 'bad_signature' }, false);
      return;
    }
    const previous = this.store.data.seen[cmd.cmd_id];
    if (previous) {
      // Rejeu ou renvoi par le cloud : on redonne le dernier état connu, sans toucher aux équipements.
      this.log(`doublon ${cmd.cmd_id} (${previous.status})`);
      const { v, cmd_id, gw, at, sig, ...rest } = previous;
      await this.ack(cmd.cmd_id, { ...rest, duplicate: true }, false);
      return;
    }
    const now = this.now().getTime();
    if (Date.parse(cmd.expires_at) <= now) {
      await this.ack(cmd.cmd_id, { status: 'expired' });
      return;
    }
    if (cmd.seq <= this.store.data.lastAppliedSeq || this.store.data.queue.some((q) => q.seq >= cmd.seq)) {
      await this.ack(cmd.cmd_id, { status: 'superseded', reason: `seq ${cmd.seq} déjà dépassé` });
      return;
    }
    const outOfBounds = cmd.items.find((i) => i.price < this.cfg.priceMin || i.price > this.cfg.priceMax);
    if (outOfBounds) {
      this.log(`prix ${outOfBounds.price} hors bornes ${this.cfg.priceMin}-${this.cfg.priceMax}`);
      await this.ack(cmd.cmd_id, {
        status: 'rejected',
        reason: `out_of_bounds: ${outOfBounds.fuel}=${outOfBounds.price}`,
      });
      return;
    }

    this.store.data.queue.push(cmd);
    this.store.data.queue.sort((a, b) => a.seq - b.seq);
    // ack() sauvegarde la file et le statut en une seule écriture.
    await this.ack(cmd.cmd_id, { status: 'received' });
    if (cmd.apply_at && Date.parse(cmd.apply_at) > now) {
      await this.ack(cmd.cmd_id, { status: 'scheduled' });
    }
    await this.publishState();
    await this.processDue();
  }

  /** Applique les commandes dont l'heure est venue. Appelée à la réception, au démarrage et périodiquement. */
  async processDue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      for (;;) {
        const now = this.now().getTime();
        const due = this.store.data.queue.filter((c) => !c.apply_at || Date.parse(c.apply_at) <= now);
        if (due.length === 0) break;
        // Si plusieurs commandes sont échues, seule la plus récente compte : les autres sont dépassées.
        const latest = due[due.length - 1];
        for (const old of due.slice(0, -1)) {
          this.removeFromQueue(old.cmd_id);
          await this.ack(old.cmd_id, { status: 'superseded', reason: `remplacée par ${latest.cmd_id}` });
        }
        await this.apply(latest);
      }
    } finally {
      this.processing = false;
    }
  }

  private removeFromQueue(cmdId: string) {
    this.store.data.queue = this.store.data.queue.filter((c) => c.cmd_id !== cmdId);
  }

  private async withRetries<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let i = 1; i <= this.cfg.deviceAttempts; i++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        this.log(`essai ${i}/${this.cfg.deviceAttempts} : ${(e as Error).message}`);
        if (i < this.cfg.deviceAttempts) await sleep(this.cfg.retryDelayMs);
      }
    }
    throw lastErr;
  }

  private async writeAndVerify(dev: PriceDevice, prices: Record<string, number>): Promise<DeviceResult> {
    try {
      await this.withRetries(() => dev.write(prices));
      const readBack = await this.withRetries(() => dev.read());
      const mismatch = Object.entries(prices).find(([k, v]) => readBack[k] !== v);
      if (mismatch) return { device: dev.name, ok: false, error: `${dev.name} : relu ${mismatch[0]}=${readBack[mismatch[0]]}, attendu ${mismatch[1]}` };
      return { device: dev.name, ok: true };
    } catch (e) {
      return { device: dev.name, ok: false, error: (e as Error).message };
    }
  }

  private async apply(cmd: PriceCommand): Promise<void> {
    const prices = Object.fromEntries(cmd.items.map((i) => [i.fuel, i.price]));
    this.log(`application de ${cmd.cmd_id} : ${JSON.stringify(prices)}`);

    // Écritures idempotentes : après une coupure, on reprend depuis le début sans risque.
    const totem = await this.writeAndVerify(this.totem, prices);
    if (totem.ok) await this.ack(cmd.cmd_id, { status: 'totem_applied', applied: prices });

    const results: DeviceResult[] = [totem];
    for (const p of this.pumps) results.push(await this.writeAndVerify(p, prices));

    const okCount = results.filter((r) => r.ok).length;
    const status: AckStatus = okCount === results.length ? 'applied' : okCount === 0 ? 'failed' : 'partially_applied';

    if (totem.ok) {
      this.store.data.lastValid = { ...this.store.data.lastValid, ...prices };
    }
    // Même en échec partiel, la commande est consommée : c'est au cloud de relancer avec une nouvelle commande.
    this.store.data.lastAppliedSeq = Math.max(this.store.data.lastAppliedSeq, cmd.seq);
    this.removeFromQueue(cmd.cmd_id);
    await this.ack(cmd.cmd_id, {
      status,
      devices: results,
      applied: totem.ok ? prices : undefined,
      reason: status === 'applied' ? undefined : results.filter((r) => !r.ok).map((r) => r.error ?? r.device).join('; '),
    });
    await this.publishState();
  }
}
