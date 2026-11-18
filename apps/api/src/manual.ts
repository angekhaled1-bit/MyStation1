import {
  BadRequestException, Body, ConflictException, Controller, Get, GoneException, Injectable, NotFoundException, Param,
  ParseUUIDPipe, Post, Res, UploadedFiles, UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { Response } from 'express';
import { isValidPrice, type PriceCommand } from '@fpc/protocol';
import { DbService } from './db/db.service.js';
import { CommandsService, hashToken } from './commands.service.js';
import { CurrentUser, Public, tenantScope, type User } from './auth.js';

const UPLOAD_DIR = resolve(process.env.UPLOAD_DIR ?? 'uploads');
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
/** Le gérant ne peut pas confirmer plus de 15 minutes avant l'heure d'application. */
const EARLY_MS = 15 * 60_000;

type Photo = { buffer: Buffer; size: number; originalname: string };

/** Type d'image déduit du contenu, pas du nom ni de l'en-tête envoyé par le téléphone. */
function imageType(b: Buffer): { mime: string; ext: string } | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp' && /^(heic|heix|mif1|msf1)$/.test(b.toString('ascii', 8, 12))) return { mime: 'image/heic', ext: 'heic' };
  return null;
}

function parsePrices(raw: unknown, label: string): Record<string, number> {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { throw new BadRequestException(`${label} : format illisible`); }
  }
  if (!obj || typeof obj !== 'object') throw new BadRequestException(`${label} : prix manquants`);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (!isValidPrice(n)) throw new BadRequestException(`${label} : prix ${k} invalide`);
    out[k] = n as number;
  }
  return out;
}

interface ManualRow {
  id: string; cmd_id: string; seq: string; status: string; payload: PriceCommand; expires_at: Date;
  opened_at: Date | null; confirmed_at: Date | null; confirmation: any; station_id: string; tenant_id: string;
  code: string; name: string;
}

@Injectable()
export class ManualService {
  constructor(private readonly db: DbService, private readonly commands: CommandsService) {}

  private async find(token: string): Promise<ManualRow> {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new NotFoundException('Lien invalide');
    const r = await this.db.query<ManualRow>(
      `select c.id, c.cmd_id, c.seq, c.status, c.payload, c.expires_at, c.opened_at, c.confirmed_at, c.confirmation,
              s.id as station_id, s.tenant_id, s.code, s.name
       from commands c join stations s on s.id = c.station_id
       where c.manual_token_hash = $1 and c.channel = 'manual'`,
      [hashToken(token)],
    );
    if (!r.rows[0]) throw new NotFoundException('Lien invalide');
    return r.rows[0];
  }

  private view(c: ManualRow) {
    return {
      station: { code: c.code, name: c.name },
      items: c.payload.items.map((i) => ({ fuel: i.fuel, price: i.price, prev: i.prev })),
      applyAt: c.payload.apply_at,
      expiresAt: c.expires_at,
      status: c.status,
      confirmedAt: c.confirmed_at,
      confirmation: c.confirmation,
      canConfirmFrom: c.payload.apply_at ? new Date(Date.parse(c.payload.apply_at) - EARLY_MS).toISOString() : null,
    };
  }

  /** Ouverture du lien par le gérant : la consigne est considérée comme « reçue ». */
  async open(token: string) {
    const c = await this.find(token);
    if (!c.opened_at) {
      await this.db.tx(async (t) => {
        await t.query(
          `update commands set opened_at = now(),
             status = case when status = 'sent' then 'received' else status end, updated_at = now() where id = $1`,
          [c.id],
        );
        await t.query(`insert into command_events(command_id, status) values ($1, 'received')`, [c.id]);
      });
      return this.view(await this.find(token));
    }
    return this.view(c);
  }

  private checkOpen(c: ManualRow) {
    if (['applied', 'partially_applied', 'failed'].includes(c.status)) throw new ConflictException('Déjà confirmé');
    if (['superseded', 'unconfirmed', 'expired'].includes(c.status) || c.expires_at.getTime() < Date.now()) {
      throw new GoneException('Cette consigne a expiré ou a été remplacée');
    }
  }

  async confirm(token: string, body: { totem?: unknown; pump?: unknown; comment?: string }, files: Record<string, Photo[]> | undefined) {
    const c = await this.find(token);
    this.checkOpen(c);
    if (c.payload.apply_at && Date.now() < Date.parse(c.payload.apply_at) - EARLY_MS) {
      throw new ConflictException(`Trop tôt : les nouveaux prix s'appliquent à partir de ${c.payload.apply_at}`);
    }
    const totem = parsePrices(body.totem, 'Totem');
    const pump = parsePrices(body.pump, 'Pompe');
    const photos: { kind: 'totem' | 'pump'; file: Photo }[] = [];
    for (const kind of ['totem', 'pump'] as const) {
      const f = files?.[`${kind}Photo`]?.[0];
      if (!f) throw new BadRequestException(`Photo ${kind === 'totem' ? 'du totem' : 'de la pompe'} obligatoire`);
      if (f.size > MAX_PHOTO_BYTES) throw new BadRequestException('Photo trop lourde (8 Mo maximum)');
      if (!imageType(f.buffer)) throw new BadRequestException('Seules les photos JPEG, PNG, WebP ou HEIC sont acceptées');
      photos.push({ kind, file: f });
    }

    const expected = Object.fromEntries(c.payload.items.map((i) => [i.fuel, i.price]));
    const problems: string[] = [];
    for (const [fuel, price] of Object.entries(expected)) {
      if (totem[fuel] !== price) problems.push(`totem ${fuel} = ${totem[fuel] ?? '?'} au lieu de ${price}`);
      if (pump[fuel] !== price) problems.push(`pompe ${fuel} = ${pump[fuel] ?? '?'} au lieu de ${price}`);
    }
    const status = problems.length ? 'partially_applied' : 'applied';
    const confirmedTotem = Object.fromEntries(Object.entries(expected).filter(([f, p]) => totem[f] === p));
    const comment = typeof body.comment === 'string' ? body.comment.slice(0, 500) : null;

    const dir = join(UPLOAD_DIR, c.id);
    await mkdir(dir, { recursive: true });
    const saved: { kind: string; path: string; mime: string; size: number }[] = [];
    for (const p of photos) {
      const t = imageType(p.file.buffer)!;
      const path = join(dir, `${p.kind}-${randomBytes(6).toString('hex')}.${t.ext}`);
      await writeFile(path, p.file.buffer);
      saved.push({ kind: p.kind, path, mime: t.mime, size: p.file.size });
    }

    await this.db.tx(async (t) => {
      const locked = await t.query('select status from commands where id = $1 for update', [c.id]);
      if (['applied', 'partially_applied', 'failed'].includes(locked.rows[0].status)) throw new ConflictException('Déjà confirmé');
      for (const s of saved) {
        await t.query('insert into command_photos(command_id, kind, path, mime, size) values ($1, $2, $3, $4, $5)', [c.id, s.kind, s.path, s.mime, s.size]);
      }
      const confirmation = { totem, pump, comment, problems };
      await t.query(
        `update commands set status = $2, status_detail = $3, confirmed_at = now(), confirmation = $4, updated_at = now() where id = $1`,
        [c.id, status, problems.join('; ') || null, confirmation],
      );
      await t.query(`insert into command_events(command_id, status, payload) values ($1, $2, $3)`, [c.id, `manual_${status}`, confirmation]);
      await this.commands.recordConfirmedPrices(t, c.station_id, confirmedTotem, c.cmd_id, Number(c.seq));
      await t.query(
        `update alerts set resolved_at = now(), resolved_by = 'system' where command_id = $1 and kind = 'late' and resolved_at is null`,
        [c.id],
      );
      if (problems.length) {
        await t.query(
          `insert into alerts(tenant_id, station_id, command_id, kind, message) values ($1, $2, $3, 'partially_applied', $4)`,
          [c.tenant_id, c.station_id, c.id, `${c.code} : écart signalé par le gérant — ${problems.join('; ')}`],
        );
      }
    });
    return this.view(await this.find(token));
  }

  async problem(token: string, body: { comment?: string }) {
    const c = await this.find(token);
    this.checkOpen(c);
    const comment = typeof body?.comment === 'string' ? body.comment.trim().slice(0, 500) : '';
    if (!comment) throw new BadRequestException('Décrivez le problème');
    await this.db.tx(async (t) => {
      await t.query(
        `update commands set status = 'failed', status_detail = $2, confirmed_at = now(), confirmation = $3, updated_at = now() where id = $1`,
        [c.id, comment, { comment }],
      );
      await t.query(`insert into command_events(command_id, status, payload) values ($1, 'manual_problem', $2)`, [c.id, { comment }]);
      await t.query(
        `insert into alerts(tenant_id, station_id, command_id, kind, message) values ($1, $2, $3, 'failed', $4)`,
        [c.tenant_id, c.station_id, c.id, `${c.code} : problème signalé par le gérant — ${comment}`],
      );
    });
    return this.view(await this.find(token));
  }
}

/** Pages publiques du gérant, protégées par le jeton du lien. */
@Controller('m')
export class ManualController {
  constructor(private readonly svc: ManualService) {}

  @Public()
  @Get(':token')
  open(@Param('token') token: string) {
    return this.svc.open(token);
  }

  @Public()
  @Post(':token/confirm')
  @UseInterceptors(FileFieldsInterceptor([{ name: 'totemPhoto', maxCount: 1 }, { name: 'pumpPhoto', maxCount: 1 }], {
    limits: { fileSize: MAX_PHOTO_BYTES, files: 2, fields: 10 },
  }))
  confirm(@Param('token') token: string, @Body() body: any, @UploadedFiles() files: Record<string, Photo[]>) {
    return this.svc.confirm(token, body ?? {}, files);
  }

  @Public()
  @Post(':token/problem')
  problem(@Param('token') token: string, @Body() body: { comment?: string }) {
    return this.svc.problem(token, body);
  }
}

/** Photos de confirmation, visibles par le siège. */
@Controller('commands')
export class PhotosController {
  constructor(private readonly db: DbService) {}

  @Get(':cmdId/photos/:photoId')
  async photo(@CurrentUser() u: User, @Param('cmdId', ParseUUIDPipe) cmdId: string, @Param('photoId') photoId: string, @Res() res: Response) {
    const r = await this.db.query<{ path: string; mime: string }>(
      `select p.path, p.mime from command_photos p join commands c on c.id = p.command_id join stations s on s.id = c.station_id
       where p.id = $1 and c.cmd_id = $2 and ($3::text is null or s.tenant_id = $3)`,
      [Number(photoId) || 0, cmdId, tenantScope(u)],
    );
    if (!r.rows[0]) throw new NotFoundException();
    res.setHeader('Content-Type', r.rows[0].mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(r.rows[0].path);
  }
}
