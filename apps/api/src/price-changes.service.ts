import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException,
} from '@nestjs/common';
import { FUEL_CODE, classifyVariation, isValidPrice, variationPct, type PriceCommand, type VariationLevel } from '@fpc/protocol';
import { DbService } from './db/db.service.js';
import { CommandsService, type StationRow } from './commands.service.js';
import { tenantScope, type User } from './auth.js';

export interface PriceChangeInput {
  stationIds?: string[] | 'all';
  items: { fuel: string; price: number }[];
  applyAt?: string | null;
  /** L'utilisateur a vu le récapitulatif et confirme les variations au-delà du seuil de confirmation. */
  confirm?: boolean;
  comment?: string;
  tenantId?: string; // superadmin seulement
}

export interface PreviewLine {
  stationId: string; stationCode: string; fuel: string; prev: number | null; next: number;
  variationPct: number | null; level: VariationLevel;
}

const MAX_SCHEDULE_DAYS = 14;

@Injectable()
export class PriceChangesService {
  constructor(private readonly db: DbService, private readonly commands: CommandsService) {}

  private parse(input: PriceChangeInput, user: User) {
    const tenantId = user.role === 'superadmin' ? input.tenantId : user.tenant;
    if (!tenantId) throw new BadRequestException('tenantId requis');
    if (!Array.isArray(input.items) || input.items.length === 0) throw new BadRequestException('Aucun prix fourni');
    const fuels = new Set<string>();
    for (const it of input.items) {
      if (!it || typeof it.fuel !== 'string' || !FUEL_CODE.test(it.fuel)) throw new BadRequestException('Code produit invalide');
      if (!isValidPrice(it.price)) throw new BadRequestException(`Prix ${it.fuel} : entier en FCFA supérieur à zéro attendu`);
      if (fuels.has(it.fuel)) throw new BadRequestException(`Produit en double : ${it.fuel}`);
      fuels.add(it.fuel);
    }
    let applyAt: Date | null = null;
    if (input.applyAt) {
      applyAt = new Date(input.applyAt);
      if (Number.isNaN(applyAt.getTime())) throw new BadRequestException('applyAt illisible');
      if (applyAt.getTime() < Date.now() - 60_000) throw new BadRequestException('applyAt est dans le passé');
      if (applyAt.getTime() > Date.now() + MAX_SCHEDULE_DAYS * 86400_000) {
        throw new BadRequestException(`Programmation limitée à ${MAX_SCHEDULE_DAYS} jours`);
      }
    }
    const stationIds = input.stationIds ?? 'all';
    if (stationIds !== 'all' && (!Array.isArray(stationIds) || stationIds.length === 0)) {
      throw new BadRequestException('stationIds : liste non vide ou "all"');
    }
    return { tenantId, stationIds, applyAt, items: input.items };
  }

  private async loadContext(tenantId: string, stationIds: string[] | 'all', items: { fuel: string; price: number }[]) {
    const tenant = (await this.db.query('select * from tenants where id = $1', [tenantId])).rows[0];
    if (!tenant) throw new NotFoundException('Client inconnu');
    const stations = (
      await this.db.query<StationRow>(
        `select id, tenant_id, code, gateway_id, gateway_secret, fuels from stations
         where tenant_id = $1 and ($2::uuid[] is null or id = any($2::uuid[])) order by code`,
        [tenantId, stationIds === 'all' ? null : stationIds],
      )
    ).rows;
    if (stationIds !== 'all' && stations.length !== stationIds.length) throw new NotFoundException('Station inconnue');
    if (stations.length === 0) throw new BadRequestException('Aucune station');

    const prices = (
      await this.db.query<{ station_id: string; fuel: string; price: number }>(
        'select station_id, fuel, price from station_prices where station_id = any($1::uuid[])',
        [stations.map((s) => s.id)],
      )
    ).rows;
    const prevOf = (sid: string, fuel: string) => prices.find((p) => p.station_id === sid && p.fuel === fuel)?.price ?? null;

    const lines: PreviewLine[] = [];
    for (const s of stations) {
      for (const it of items) {
        if (!s.fuels.includes(it.fuel)) throw new UnprocessableEntityException(`${s.code} ne distribue pas ${it.fuel}`);
        if (it.price < tenant.price_min || it.price > tenant.price_max) {
          throw new UnprocessableEntityException(
            `${it.fuel} = ${it.price} hors des bornes du client (${tenant.price_min} à ${tenant.price_max} FCFA/L)`,
          );
        }
        const prev = prevOf(s.id, it.fuel);
        lines.push({
          stationId: s.id, stationCode: s.code, fuel: it.fuel, prev, next: it.price,
          variationPct: variationPct(prev, it.price),
          level: classifyVariation(prev, it.price, { confirmPct: Number(tenant.confirm_pct), blockPct: Number(tenant.block_pct) }),
        });
      }
    }
    return { tenant, stations, lines, prevOf };
  }

  /** Récapitulatif avant envoi : variation par station et par produit. */
  async preview(input: PriceChangeInput, user: User) {
    const p = this.parse(input, user);
    const { tenant, lines } = await this.loadContext(p.tenantId, p.stationIds, p.items);
    return {
      lines,
      blocked: lines.some((l) => l.level === 'block'),
      requiresConfirmation: lines.some((l) => l.level === 'confirm'),
      requiresApproval: tenant.require_double_validation as boolean,
      thresholds: { confirmPct: Number(tenant.confirm_pct), blockPct: Number(tenant.block_pct) },
    };
  }

  async create(input: PriceChangeInput, user: User) {
    const p = this.parse(input, user);
    const { tenant, stations, lines, prevOf } = await this.loadContext(p.tenantId, p.stationIds, p.items);
    const blocked = lines.filter((l) => l.level === 'block');
    if (blocked.length) {
      throw new UnprocessableEntityException({
        message: `Variation supérieure à ${tenant.block_pct} % : saisie bloquée. Vérifiez le prix ou modifiez le seuil.`,
        lines: blocked,
      });
    }
    if (lines.some((l) => l.level === 'confirm') && !input.confirm) {
      throw new ConflictException({
        message: `Variation supérieure à ${tenant.confirm_pct} % : confirmation requise (confirm: true).`,
        lines: lines.filter((l) => l.level === 'confirm'),
      });
    }
    const needsApproval = tenant.require_double_validation as boolean;
    const sent: PriceCommand[] = [];
    const id = await this.db.tx(async (c) => {
      const r = await c.query<{ id: string }>(
        `insert into price_changes(tenant_id, items, station_ids, apply_at, status, comment, created_by)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [p.tenantId, JSON.stringify(p.items), stations.map((s) => s.id), p.applyAt, needsApproval ? 'pending_approval' : 'dispatched',
          input.comment ?? null, user.id],
      );
      const pcId = r.rows[0].id;
      await c.query('insert into audit_log(tenant_id, actor, action, details) values ($1, $2, $3, $4)', [
        p.tenantId, user.id, 'price_change.create', { id: pcId, items: p.items, stations: stations.map((s) => s.code), applyAt: p.applyAt },
      ]);
      if (!needsApproval) {
        for (const s of stations) {
          sent.push(await this.commands.createCommand(c, pcId, s,
            p.items.map((i) => ({ fuel: i.fuel, price: i.price, prev: prevOf(s.id, i.fuel) })), p.applyAt));
        }
      }
      return pcId;
    });
    for (const cmd of sent) await this.commands.publish(cmd);
    return this.get(id, user);
  }

  /** Double validation : un second utilisateur, différent du premier, valide l'envoi. */
  async approve(id: string, user: User) {
    const sent: PriceCommand[] = [];
    await this.db.tx(async (c) => {
      const pc = (await c.query('select * from price_changes where id = $1 for update', [id])).rows[0];
      if (!pc || (tenantScope(user) && pc.tenant_id !== user.tenant)) throw new NotFoundException();
      if (pc.status !== 'pending_approval') throw new ConflictException('Demande déjà traitée');
      if (pc.created_by === user.id) throw new ForbiddenException('La validation doit être faite par une autre personne');
      if (pc.apply_at && new Date(pc.apply_at).getTime() < Date.now() - 60_000) {
        throw new ConflictException('Heure d\'application dépassée : créez une nouvelle demande');
      }
      const stations = (await c.query<StationRow>(
        'select id, tenant_id, code, gateway_id, gateway_secret, fuels from stations where id = any($1::uuid[])', [pc.station_ids],
      )).rows;
      const prices = (await c.query('select station_id, fuel, price from station_prices where station_id = any($1::uuid[])', [pc.station_ids])).rows;
      for (const s of stations) {
        const items = (pc.items as { fuel: string; price: number }[]).map((i) => ({
          fuel: i.fuel, price: i.price,
          prev: prices.find((p: any) => p.station_id === s.id && p.fuel === i.fuel)?.price ?? null,
        }));
        sent.push(await this.commands.createCommand(c, id, s, items, pc.apply_at ? new Date(pc.apply_at) : null));
      }
      await c.query(`update price_changes set status = 'dispatched', approved_by = $2, approved_at = now() where id = $1`, [id, user.id]);
      await c.query('insert into audit_log(tenant_id, actor, action, details) values ($1, $2, $3, $4)', [
        pc.tenant_id, user.id, 'price_change.approve', { id },
      ]);
    });
    for (const cmd of sent) await this.commands.publish(cmd);
    return this.get(id, user);
  }

  async cancel(id: string, user: User) {
    const r = await this.db.query(
      `update price_changes set status = 'cancelled' where id = $1 and status = 'pending_approval'
       and ($2::text is null or tenant_id = $2) returning tenant_id`,
      [id, tenantScope(user)],
    );
    if (!r.rowCount) throw new ConflictException('Seule une demande en attente de validation peut être annulée');
    await this.db.query('insert into audit_log(tenant_id, actor, action, details) values ($1, $2, $3, $4)', [
      r.rows[0].tenant_id, user.id, 'price_change.cancel', { id },
    ]);
    return this.get(id, user);
  }

  async list(user: User, limit = 50) {
    return (
      await this.db.query(
        `select pc.*,
           count(c.id)::int as commands,
           count(c.id) filter (where c.status = 'applied')::int as applied,
           count(c.id) filter (where c.status in ('partially_applied','failed','rejected','expired','unconfirmed'))::int as problems
         from price_changes pc left join commands c on c.price_change_id = pc.id
         where ($1::text is null or pc.tenant_id = $1)
         group by pc.id order by pc.created_at desc limit $2`,
        [tenantScope(user), Math.min(limit, 200)],
      )
    ).rows;
  }

  async get(id: string, user: User) {
    const pc = (await this.db.query('select * from price_changes where id = $1 and ($2::text is null or tenant_id = $2)', [id, tenantScope(user)])).rows[0];
    if (!pc) throw new NotFoundException();
    const commands = (
      await this.db.query(
        `select c.id, c.cmd_id, c.seq, c.status, c.status_detail, c.attempts, c.created_at, c.updated_at, c.expires_at,
                s.code as station_code, s.name as station_name
         from commands c join stations s on s.id = c.station_id where c.price_change_id = $1 order by s.code`,
        [id],
      )
    ).rows;
    return { ...pc, commands };
  }
}
