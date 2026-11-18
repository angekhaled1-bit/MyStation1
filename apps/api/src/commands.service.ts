import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  FINAL_ACK_STATUSES, PROTOCOL_VERSION, checkAckShape, parseTopic, signPayload, verifyPayload,
  type AckStatus, type CommandAck, type GatewayState, type PriceCommand,
} from '@fpc/protocol';
import { DbService } from './db/db.service.js';
import { MqttService } from './mqtt.service.js';
import { NotifierService } from './notifier.service.js';
import { topics } from '@fpc/protocol';

/** Ordre de progression : un accusé en retard ne fait jamais reculer le statut. */
const RANK: Record<string, number> = {
  sent: 0, received: 1, scheduled: 2, totem_applied: 3,
  applied: 10, partially_applied: 10, rejected: 10, expired: 10, superseded: 10, failed: 10, unconfirmed: 9,
};
const ALERT_STATUSES: Partial<Record<AckStatus, string>> = {
  partially_applied: 'Prix appliqué partiellement',
  failed: 'Échec de l\'application du prix',
  rejected: 'Commande refusée par le boîtier',
  expired: 'Commande reçue après expiration',
};

export const COMMAND_TTL_MS = Number(process.env.COMMAND_TTL_HOURS ?? 24) * 3600_000;
const RETRY_AFTER_MS = Number(process.env.COMMAND_RETRY_SECONDS ?? 60) * 1000;
const OFFLINE_AFTER_MS = Number(process.env.GATEWAY_OFFLINE_MINUTES ?? 10) * 60_000;
/** Phase 0 : délai après l'heure d'application au-delà duquel une station sans confirmation est « en retard ». */
const MANUAL_LATE_MS = Number(process.env.MANUAL_LATE_MINUTES ?? 30) * 60_000;
const PUBLIC_WEB_URL = process.env.PUBLIC_WEB_URL ?? 'http://localhost:3000';

export const STATION_COLUMNS = 'id, tenant_id, code, name, mode, manager_name, manager_phone, gateway_id, gateway_secret, fuels';
export interface StationRow {
  id: string; tenant_id: string; code: string; name: string; mode: 'gateway' | 'manual';
  manager_name: string | null; manager_phone: string | null;
  gateway_id: string | null; gateway_secret: string | null; fuels: string[];
}

/** Ce qu'il reste à faire après le commit : publier en MQTT ou prévenir le gérant. */
export type Outgoing =
  | { kind: 'mqtt'; cmd: PriceCommand }
  | { kind: 'manual'; cmd: PriceCommand; commandId: string; token: string; station: StationRow };

export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

const FUEL_LABELS: Record<string, string> = { SP: 'Super', GO: 'Gasoil', PL: 'Pétrole' };
export function formatAbidjan(d: Date): string {
  return d.toLocaleString('fr-FR', { timeZone: 'Africa/Abidjan', dateStyle: 'short', timeStyle: 'short' });
}

@Injectable()
export class CommandsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Commands');
  private timer?: NodeJS.Timeout;

  constructor(private readonly db: DbService, private readonly mqtt: MqttService, private readonly notifier: NotifierService) {}

  onModuleInit() {
    this.mqtt.onMessage((t, p) => this.onMessage(t, p));
    // Relances et expirations. Avec plusieurs instances d'API, passer par une file Redis (BullMQ) ou un verrou.
    this.timer = setInterval(() => void this.sweep().catch((e) => this.log.error(e.message)), 15_000);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /**
   * Crée, signe et publie une commande pour une station, dans la transaction de la demande de prix.
   * La publication MQTT se fait après le commit (voir publishPending).
   */
  async createCommand(
    c: pg.PoolClient,
    priceChangeId: string,
    station: StationRow,
    items: { fuel: string; price: number; prev: number | null }[],
    applyAt: Date | null,
  ): Promise<Outgoing> {
    const seqRow = await c.query<{ cmd_seq: string }>(
      'update stations set cmd_seq = cmd_seq + 1 where id = $1 returning cmd_seq',
      [station.id],
    );
    const now = new Date();
    const expires = new Date((applyAt ?? now).getTime() + COMMAND_TTL_MS);
    const unsigned: Omit<PriceCommand, 'sig'> = {
      v: PROTOCOL_VERSION,
      type: 'set_prices',
      cmd_id: randomUUID(),
      seq: Number(seqRow.rows[0].cmd_seq),
      tenant: station.tenant_id,
      station: station.code,
      gw: station.gateway_id ?? 'manual',
      issued_at: now.toISOString(),
      apply_at: applyAt ? applyAt.toISOString() : null,
      expires_at: expires.toISOString(),
      items,
    };
    if (station.mode === 'manual') {
      // Pas de boîtier : la consigne part vers le gérant avec un lien personnel à usage unique.
      const cmd = { ...unsigned, sig: '' } as PriceCommand;
      const token = randomBytes(24).toString('base64url');
      // Une seule consigne ouverte par station : la précédente, non confirmée, est remplacée et son lien ne marche plus.
      await c.query(
        `update commands set status = 'superseded', status_detail = $2, updated_at = now()
         where station_id = $1 and channel = 'manual' and status in ('sent', 'received')`,
        [station.id, `remplacée par ${unsigned.cmd_id}`],
      );
      const r = await c.query<{ id: string }>(
        `insert into commands(cmd_id, price_change_id, station_id, seq, payload, status, expires_at, channel, manual_token_hash)
         values ($1, $2, $3, $4, $5, 'sent', $6, 'manual', $7) returning id`,
        [cmd.cmd_id, priceChangeId, station.id, cmd.seq, cmd, expires, hashToken(token)],
      );
      await c.query(`insert into command_events(command_id, status) values ($1, 'created')`, [r.rows[0].id]);
      return { kind: 'manual', cmd, commandId: r.rows[0].id, token, station };
    }
    const cmd = signPayload(unsigned, station.gateway_secret!) as PriceCommand;
    const r = await c.query<{ id: string }>(
      `insert into commands(cmd_id, price_change_id, station_id, seq, payload, status, expires_at)
       values ($1, $2, $3, $4, $5, 'sent', $6) returning id`,
      [cmd.cmd_id, priceChangeId, station.id, cmd.seq, cmd, expires],
    );
    await c.query(`insert into command_events(command_id, status) values ($1, 'created')`, [r.rows[0].id]);
    return { kind: 'mqtt', cmd };
  }

  async dispatch(o: Outgoing) {
    if (o.kind === 'mqtt') return this.publish(o.cmd);
    await this.notifyManager(o.station, o.commandId, o.cmd, o.token, false);
  }

  manualLink(token: string) {
    return `${PUBLIC_WEB_URL}/m/${token}`;
  }

  async notifyManager(station: StationRow, commandId: string, cmd: PriceCommand, token: string | null, reminder: boolean) {
    const prices = cmd.items.map((i) => `${FUEL_LABELS[i.fuel] ?? i.fuel} ${i.price}`).join(', ');
    const when = cmd.apply_at ? `le ${formatAbidjan(new Date(cmd.apply_at))}` : 'dès maintenant';
    const link = token ? this.manualLink(token) : null;
    const body =
      `${reminder ? 'RAPPEL - ' : ''}${station.code} : nouveaux prix à appliquer ${when} (FCFA/L) : ${prices}. ` +
      (link ? `Confirmez avec photos du totem et d'une pompe : ${link}` : 'Confirmez avec le lien reçu précédemment.');
    if (!station.manager_phone) {
      await this.db.query(
        `insert into alerts(tenant_id, station_id, command_id, kind, message) values ($1, $2, $3, 'no_contact', $4)`,
        [station.tenant_id, station.id, commandId, `${station.code} : aucun numéro de gérant, consigne non envoyée`],
      );
      return;
    }
    const ok = await this.notifier.send({
      tenantId: station.tenant_id, commandId, recipient: station.manager_phone, body, secret: token ?? undefined,
    });
    await this.db.query('insert into command_events(command_id, status, payload) values ($1, $2, $3)', [
      commandId, reminder ? 'reminder_sent' : ok ? 'notified' : 'notify_failed', { to: station.manager_phone },
    ]);
    if (!ok) {
      await this.db.query(
        `insert into alerts(tenant_id, station_id, command_id, kind, message) values ($1, $2, $3, 'notify_failed', $4)`,
        [station.tenant_id, station.id, commandId, `${station.code} : échec d'envoi de la consigne au gérant`],
      );
    }
  }

  async publish(cmd: PriceCommand) {
    try {
      await this.mqtt.publish(topics.cmd(cmd.tenant, cmd.gw), cmd);
    } catch (e) {
      // Pas grave : la relance périodique renverra la commande.
      this.log.warn(`publication de ${cmd.cmd_id} différée : ${(e as Error).message}`);
    }
  }

  private async onMessage(topic: string, payload: Buffer) {
    const t = parseTopic(topic);
    if (!t) return;
    let msg: unknown;
    try {
      msg = JSON.parse(payload.toString());
    } catch {
      return this.log.warn(`message illisible sur ${topic}`);
    }
    const st = await this.db.query<StationRow>(
      `select ${STATION_COLUMNS} from stations where tenant_id = $1 and gateway_id = $2 and mode = 'gateway'`,
      [t.tenant, t.gatewayId],
    );
    const station = st.rows[0];
    if (!station) return this.log.warn(`boîtier inconnu : ${t.tenant}/${t.gatewayId}`);
    if (t.kind === 'ack') await this.onAck(station, msg);
    else if (t.kind === 'state') await this.onState(station, msg as GatewayState);
  }

  private async onState(station: StationRow, s: GatewayState) {
    if (!s || typeof s.online !== 'boolean' || s.gw !== station.gateway_id) return;
    await this.db.query(
      `insert into gateway_status(gateway_id, online, last_seen_at, last_seq, reported)
       values ($1, $2, now(), $3, $4)
       on conflict (gateway_id) do update set online = excluded.online, last_seen_at = excluded.last_seen_at,
         last_seq = coalesce(excluded.last_seq, gateway_status.last_seq), reported = excluded.reported`,
      [station.gateway_id, s.online, s.last_seq ?? null, s],
    );
    if (s.online) {
      await this.db.query(
        `update alerts set resolved_at = now(), resolved_by = 'system'
         where station_id = $1 and kind = 'gateway_offline' and resolved_at is null`,
        [station.id],
      );
    }
  }

  private async onAck(station: StationRow, msg: unknown) {
    const err = checkAckShape(msg);
    if (err) return this.log.warn(`accusé invalide de ${station.gateway_id} : ${err}`);
    const ack = msg as CommandAck;
    if (ack.gw !== station.gateway_id || !verifyPayload(ack, station.gateway_secret!)) {
      return this.log.warn(`accusé non authentifié de ${station.gateway_id} pour ${ack.cmd_id}`);
    }
    await this.db.tx(async (c) => {
      const r = await c.query<{ id: string; status: string; seq: string }>(
        'select id, status, seq from commands where cmd_id = $1 and station_id = $2 for update',
        [ack.cmd_id, station.id],
      );
      const cmd = r.rows[0];
      if (!cmd) return this.log.warn(`accusé pour une commande inconnue : ${ack.cmd_id}`);
      await c.query('insert into command_events(command_id, status, payload, at) values ($1, $2, $3, $4)', [
        cmd.id, ack.duplicate ? `${ack.status} (doublon)` : ack.status, ack, ack.at,
      ]);
      if ((RANK[ack.status] ?? 0) <= (RANK[cmd.status] ?? 0)) return;
      await c.query('update commands set status = $2, status_detail = $3, updated_at = now() where id = $1', [
        cmd.id, ack.status, ack.reason ?? null,
      ]);
      if (ack.applied && (ack.status === 'applied' || ack.status === 'partially_applied' || ack.status === 'totem_applied')) {
        await this.recordConfirmedPrices(c, station.id, ack.applied, ack.cmd_id, Number(cmd.seq));
      }
      const alert = ALERT_STATUSES[ack.status];
      if (alert && !ack.duplicate) {
        await c.query(
          'insert into alerts(tenant_id, station_id, command_id, kind, message) values ($1, $2, $3, $4, $5)',
          [station.tenant_id, station.id, cmd.id, ack.status, `${station.code} : ${alert}${ack.reason ? ' — ' + ack.reason : ''}`],
        );
      }
    });
  }

  /** Enregistre les prix confirmés sur place, sans écraser un prix confirmé par une commande plus récente. */
  async recordConfirmedPrices(c: pg.PoolClient, stationId: string, prices: Record<string, number>, cmdId: string, seq: number) {
    for (const [fuel, price] of Object.entries(prices)) {
      await c.query(
        `insert into station_prices(station_id, fuel, price, source_cmd_id, updated_at)
         values ($1, $2, $3, $4, now())
         on conflict (station_id, fuel) do update set price = excluded.price, source_cmd_id = excluded.source_cmd_id, updated_at = now()
         where station_prices.source_cmd_id is null
            or (select seq from commands where cmd_id = station_prices.source_cmd_id) <= $5`,
        [stationId, fuel, price, cmdId, seq],
      );
    }
  }

  /** Relance les commandes sans accusé, marque les commandes expirées et les boîtiers silencieux. */
  async sweep() {
    const resend = await this.db.query<{ id: string; payload: PriceCommand }>(
      `update commands set attempts = attempts + 1, last_sent_at = now()
       where channel = 'mqtt' and status = 'sent' and expires_at > now() and last_sent_at < now() - make_interval(secs => $1)
       returning id, payload`,
      [RETRY_AFTER_MS / 1000],
    );
    for (const r of resend.rows) {
      this.log.log(`relance de ${r.payload.cmd_id} vers ${r.payload.gw}`);
      await this.db.query(`insert into command_events(command_id, status) values ($1, 'resent')`, [r.id]);
      await this.publish(r.payload);
    }

    const expired = await this.db.query<{ id: string; station_id: string; tenant_id: string; code: string }>(
      `update commands c set status = 'unconfirmed', status_detail = 'aucune confirmation finale avant expiration', updated_at = now()
       from stations s
       where s.id = c.station_id and c.status not in (${FINAL_ACK_STATUSES.map((s) => `'${s}'`).join(',')}, 'unconfirmed')
         and c.expires_at < now()
       returning c.id, c.station_id, s.tenant_id, s.code`,
    );
    for (const e of expired.rows) {
      await this.db.query(
        `insert into alerts(tenant_id, station_id, command_id, kind, message) values ($1, $2, $3, 'unconfirmed', $4)`,
        [e.tenant_id, e.station_id, e.id, `${e.code} : prix non confirmé avant expiration, intervention à prévoir`],
      );
    }

    // Phase 0 : station manuelle sans confirmation après l'heure d'application + délai → alerte et rappel au gérant.
    const late = await this.db.query<{ id: string; payload: PriceCommand; station_id: string }>(
      `select c.id, c.payload, c.station_id from commands c
       where c.channel = 'manual' and c.status in ('sent', 'received') and c.expires_at > now()
         and coalesce((c.payload->>'apply_at')::timestamptz, c.created_at) < now() - make_interval(secs => $1)
         and not exists (select 1 from alerts a where a.command_id = c.id and a.kind = 'late')`,
      [MANUAL_LATE_MS / 1000],
    );
    for (const l of late.rows) {
      const station = (await this.db.query<StationRow>(`select ${STATION_COLUMNS} from stations where id = $1`, [l.station_id])).rows[0];
      await this.db.query(
        `insert into alerts(tenant_id, station_id, command_id, kind, message) values ($1, $2, $3, 'late', $4)`,
        [station.tenant_id, station.id, l.id, `${station.code} : prix non confirmés par le gérant après l'heure d'application`],
      );
      await this.notifyManager(station, l.id, l.payload, null, true);
    }

    // Boîtier hors ligne (testament MQTT reçu) depuis plus du délai toléré : une seule alerte ouverte à la fois.
    await this.db.query(
      `insert into alerts(tenant_id, station_id, kind, message)
       select s.tenant_id, s.id, 'gateway_offline', s.code || ' : boîtier hors ligne'
       from stations s join gateway_status g on g.gateway_id = s.gateway_id
       where g.online = false and g.last_seen_at < now() - make_interval(secs => $1)
         and not exists (select 1 from alerts a where a.station_id = s.id and a.kind = 'gateway_offline' and a.resolved_at is null)`,
      [OFFLINE_AFTER_MS / 1000],
    );
  }
}
