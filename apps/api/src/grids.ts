import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException,
  Param, ParseUUIDPipe, Post,
} from '@nestjs/common';
import { FUEL_CODE, isValidPrice } from '@fpc/protocol';
import { DbService } from './db/db.service.js';
import { PriceChangesService } from './price-changes.service.js';
import { CurrentUser, Roles, tenantScope, type User } from './auth.js';

interface GridInput { effectiveAt: string; items: { fuel: string; price: number }[]; reference?: string; tenantId?: string }

/**
 * Grille officielle des prix (fixés par l'État). Saisie par une personne, validée par une autre,
 * puis diffusée à toutes les stations pour l'heure d'entrée en vigueur. Une fois validée, elle devient
 * la référence : tout prix de station différent est bloqué et signalé comme non conforme.
 */
@Injectable()
export class GridsService {
  constructor(private readonly db: DbService, private readonly priceChanges: PriceChangesService) {}

  async list(u: User) {
    return (
      await this.db.query(
        `select g.*, (g.id = (select id from official_grids x where x.tenant_id = g.tenant_id and x.status = 'validated'
                              and x.effective_at <= now() order by effective_at desc limit 1)) as current
         from official_grids g where ($1::text is null or g.tenant_id = $1) order by g.effective_at desc, g.created_at desc limit 50`,
        [tenantScope(u)],
      )
    ).rows;
  }

  async create(b: GridInput, u: User) {
    const tenantId = u.role === 'superadmin' ? b?.tenantId : u.tenant;
    if (!tenantId) throw new BadRequestException('tenantId requis');
    const at = new Date(b?.effectiveAt);
    if (Number.isNaN(at.getTime())) throw new BadRequestException("Date d'entrée en vigueur illisible");
    if (!Array.isArray(b.items) || b.items.length === 0) throw new BadRequestException('Aucun prix');
    const tenant = (await this.db.query('select price_min, price_max from tenants where id = $1', [tenantId])).rows[0];
    const seen = new Set<string>();
    for (const i of b.items) {
      if (!i || !FUEL_CODE.test(i.fuel) || seen.has(i.fuel)) throw new BadRequestException('Produit invalide ou en double');
      seen.add(i.fuel);
      if (!isValidPrice(i.price)) throw new BadRequestException(`Prix ${i.fuel} : entier en FCFA attendu`);
      if (i.price < tenant.price_min || i.price > tenant.price_max) {
        throw new BadRequestException(`${i.fuel} = ${i.price} hors des bornes (${tenant.price_min} à ${tenant.price_max})`);
      }
    }
    const r = await this.db.query(
      `insert into official_grids(tenant_id, effective_at, items, reference, status, created_by)
       values ($1, $2, $3, $4, 'pending_approval', $5) returning *`,
      [tenantId, at, JSON.stringify(b.items.map((i) => ({ fuel: i.fuel, price: i.price }))), b.reference?.slice(0, 200) ?? null, u.id],
    );
    await this.audit(tenantId, u, 'grid.create', { id: r.rows[0].id, items: b.items, effectiveAt: at, reference: b.reference });
    return r.rows[0];
  }

  private async load(id: string, u: User) {
    const g = (await this.db.query('select * from official_grids where id = $1 and ($2::text is null or tenant_id = $2)', [id, tenantScope(u)])).rows[0];
    if (!g) throw new NotFoundException();
    return g;
  }

  async approve(id: string, u: User) {
    const g = await this.load(id, u);
    if (g.status !== 'pending_approval') throw new ConflictException('Grille déjà traitée');
    if (g.created_by === u.id) throw new ForbiddenException('La grille doit être validée par une autre personne');
    const r = await this.db.query(
      `update official_grids set status = 'validated', validated_by = $2, validated_at = now() where id = $1 and status = 'pending_approval' returning *`,
      [id, u.id],
    );
    if (!r.rowCount) throw new ConflictException('Grille déjà traitée');
    await this.audit(g.tenant_id, u, 'grid.approve', { id });
    return r.rows[0];
  }

  async cancel(id: string, u: User) {
    const g = await this.load(id, u);
    if (g.price_change_id) throw new ConflictException('Grille déjà diffusée');
    if (g.status === 'cancelled') return g;
    const r = await this.db.query(`update official_grids set status = 'cancelled' where id = $1 returning *`, [id]);
    await this.audit(g.tenant_id, u, 'grid.cancel', { id });
    return r.rows[0];
  }

  /** Envoie la grille à toutes les stations (boîtier ou gérant) pour son heure d'entrée en vigueur. */
  async dispatch(id: string, u: User) {
    const g = await this.load(id, u);
    if (g.status !== 'validated') throw new ConflictException("La grille doit d'abord être validée");
    if (g.price_change_id) throw new ConflictException('Grille déjà diffusée');
    const at = new Date(g.effective_at);
    const pc = await this.priceChanges.create(
      {
        stationIds: 'all',
        items: g.items,
        applyAt: at.getTime() > Date.now() + 60_000 ? at.toISOString() : null,
        comment: `Grille officielle${g.reference ? ' ' + g.reference : ''}`,
        tenantId: g.tenant_id,
      },
      u,
      g.id,
    );
    await this.audit(g.tenant_id, u, 'grid.dispatch', { id, priceChangeId: pc.id });
    return pc;
  }

  private audit(tenantId: string, u: User, action: string, details: object) {
    return this.db.query('insert into audit_log(tenant_id, actor, action, details) values ($1, $2, $3, $4)', [tenantId, u.id, action, details]);
  }
}

@Controller('grids')
export class GridsController {
  constructor(private readonly svc: GridsService) {}

  @Get()
  list(@CurrentUser() u: User) { return this.svc.list(u); }

  @Roles('operator')
  @Post()
  create(@CurrentUser() u: User, @Body() b: GridInput) { return this.svc.create(b, u); }

  @Roles('approver')
  @Post(':id/approve')
  approve(@CurrentUser() u: User, @Param('id', ParseUUIDPipe) id: string) { return this.svc.approve(id, u); }

  @Roles('operator', 'approver')
  @Post(':id/cancel')
  cancel(@CurrentUser() u: User, @Param('id', ParseUUIDPipe) id: string) { return this.svc.cancel(id, u); }

  @Roles('operator')
  @Post(':id/dispatch')
  dispatch(@CurrentUser() u: User, @Param('id', ParseUUIDPipe) id: string) { return this.svc.dispatch(id, u); }
}
