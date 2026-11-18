import {
  BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { assertSegment, FUEL_CODE } from '@fpc/protocol';
import { DbService } from './db/db.service.js';
import { MqttService } from './mqtt.service.js';
import { PriceChangesService, type PriceChangeInput } from './price-changes.service.js';
import { CurrentUser, Public, Roles, tenantScope, type User } from './auth.js';

@Controller()
export class HealthController {
  constructor(private readonly db: DbService, private readonly mqtt: MqttService) {}

  @Public()
  @Get('health')
  async health() {
    await this.db.query('select 1');
    return { ok: true, mqtt: this.mqtt.connected };
  }

  @Get('me')
  me(@CurrentUser() u: User) {
    return u;
  }
}

@Controller('stations')
export class StationsController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@CurrentUser() u: User) {
    return (
      await this.db.query(
        `select s.id, s.tenant_id, s.code, s.name, s.city, s.fuels, s.gateway_id,
           coalesce(g.online, false) as online, g.last_seen_at,
           coalesce((select jsonb_object_agg(fuel, price) from station_prices p where p.station_id = s.id), '{}') as prices,
           (select max(updated_at) from station_prices p where p.station_id = s.id) as prices_updated_at,
           (select count(*)::int from alerts a where a.station_id = s.id and a.resolved_at is null) as open_alerts
         from stations s left join gateway_status g on g.gateway_id = s.gateway_id
         where ($1::text is null or s.tenant_id = $1) order by s.code`,
        [tenantScope(u)],
      )
    ).rows;
  }

  /** Crée une station et son boîtier. La clé du boîtier n'est affichée qu'une fois. */
  @Roles('admin')
  @Post()
  async create(@CurrentUser() u: User, @Body() b: { code: string; name: string; city?: string; fuels: string[]; gatewayId: string; tenantId?: string }) {
    const tenant = u.role === 'superadmin' ? b.tenantId : u.tenant;
    if (!tenant || !b?.code || !b.name || !Array.isArray(b.fuels) || !b.fuels.every((f) => FUEL_CODE.test(f))) {
      throw new BadRequestException('code, name, fuels[] et gatewayId requis');
    }
    try {
      assertSegment('gatewayId', b.gatewayId);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const secret = randomBytes(32).toString('hex');
    const r = await this.db.query(
      `insert into stations(tenant_id, code, name, city, fuels, gateway_id, gateway_secret)
       values ($1, $2, $3, $4, $5, $6, $7) returning id, code, gateway_id`,
      [tenant, b.code, b.name, b.city ?? null, b.fuels, b.gatewayId, secret],
    );
    await this.db.query('insert into audit_log(tenant_id, actor, action, details) values ($1, $2, $3, $4)', [
      tenant, u.id, 'station.create', { code: b.code, gatewayId: b.gatewayId },
    ]);
    return { ...r.rows[0], gateway_secret: secret };
  }

  @Get(':id/commands')
  async commands(@CurrentUser() u: User, @Param('id', ParseUUIDPipe) id: string) {
    return (
      await this.db.query(
        `select c.cmd_id, c.seq, c.status, c.status_detail, c.attempts, c.payload->'items' as items,
                c.payload->>'apply_at' as apply_at, c.created_at, c.updated_at
         from commands c join stations s on s.id = c.station_id
         where s.id = $1 and ($2::text is null or s.tenant_id = $2) order by c.created_at desc limit 100`,
        [id, tenantScope(u)],
      )
    ).rows;
  }
}

@Controller('price-changes')
export class PriceChangesController {
  constructor(private readonly svc: PriceChangesService) {}

  @Get()
  list(@CurrentUser() u: User, @Query('limit') limit?: string) {
    return this.svc.list(u, limit ? Number(limit) : 50);
  }

  @Roles('operator')
  @Post('preview')
  preview(@CurrentUser() u: User, @Body() b: PriceChangeInput) {
    return this.svc.preview(b, u);
  }

  @Roles('operator')
  @Post()
  create(@CurrentUser() u: User, @Body() b: PriceChangeInput) {
    return this.svc.create(b, u);
  }

  @Get(':id')
  get(@CurrentUser() u: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(id, u);
  }

  @Roles('approver')
  @Post(':id/approve')
  approve(@CurrentUser() u: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.approve(id, u);
  }

  @Roles('operator', 'approver')
  @Post(':id/cancel')
  cancel(@CurrentUser() u: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.cancel(id, u);
  }
}

@Controller('commands')
export class CommandsController {
  constructor(private readonly db: DbService) {}

  @Get(':cmdId')
  async get(@CurrentUser() u: User, @Param('cmdId', ParseUUIDPipe) cmdId: string) {
    const c = (
      await this.db.query(
        `select c.*, s.code as station_code from commands c join stations s on s.id = c.station_id
         where c.cmd_id = $1 and ($2::text is null or s.tenant_id = $2)`,
        [cmdId, tenantScope(u)],
      )
    ).rows[0];
    if (!c) throw new NotFoundException();
    const events = (await this.db.query('select status, payload, at from command_events where command_id = $1 order by at, id', [c.id])).rows;
    return { ...c, events };
  }
}

@Controller('alerts')
export class AlertsController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@CurrentUser() u: User, @Query('all') all?: string) {
    return (
      await this.db.query(
        `select a.*, s.code as station_code from alerts a left join stations s on s.id = a.station_id
         where ($1::text is null or a.tenant_id = $1) and ($2 or a.resolved_at is null)
         order by a.created_at desc limit 200`,
        [tenantScope(u), all === '1'],
      )
    ).rows;
  }

  @Post(':id/resolve')
  async resolve(@CurrentUser() u: User, @Param('id') id: string) {
    const r = await this.db.query(
      `update alerts set resolved_at = now(), resolved_by = $3
       where id = $1 and resolved_at is null and ($2::text is null or tenant_id = $2) returning *`,
      [Number(id), tenantScope(u), u.id],
    );
    if (!r.rowCount) throw new NotFoundException();
    return r.rows[0];
  }
}
