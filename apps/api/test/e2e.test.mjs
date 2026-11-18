/**
 * Test de bout en bout : API + broker MQTT en mémoire + boîtiers simulés.
 * Nécessite une base PostgreSQL vide dédiée : TEST_DATABASE_URL=postgres://…/fuelprice_test
 * (elle est vidée au début du test). Ignoré si la variable est absente.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import mqtt from 'mqtt';
import { Aedes } from 'aedes';
import { topics, signPayload } from '@fpc/protocol';
import { Gateway } from '../../gateway-sim/src/gateway.ts';
import { buildSimulatedDevices } from '../../gateway-sim/src/devices.ts';
import { memoryStore, emptyData } from '../../gateway-sim/src/store.ts';

const DB = process.env.TEST_DATABASE_URL;
const skip = !DB && 'TEST_DATABASE_URL absent';
let broker, server, app, base, clients = [], gws = {}, notifier, commandsSvc;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('délai dépassé'); await wait(100); }
}
const H = (tok = 'dev-operator') => ({ Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' });
async function api(path, body, tok) {
  const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: H(tok), body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

function startGateway(gw, faults = {}) {
  const c = mqtt.connect(process.env.MQTT_URL, { clientId: `gw-${gw}`, clean: false });
  const { totem, pumps } = buildSimulatedDevices({ SP: 875, GO: 715 }, 2, faults);
  const g = new Gateway(
    { tenant: 'afriquia', gatewayId: gw, secret: `dev-secret-${gw}`, priceMin: 500, priceMax: 1500, deviceAttempts: 2, retryDelayMs: 10 },
    memoryStore(emptyData({ SP: 875, GO: 715 })), totem, pumps,
    {
      publishAck: (a) => c.publish(topics.ack('afriquia', gw), JSON.stringify(a), { qos: 1 }),
      publishState: (s) => c.publish(topics.state('afriquia', gw), JSON.stringify(s), { qos: 1, retain: true }),
    },
  );
  c.on('connect', () => {
    c.subscribe(topics.cmd('afriquia', gw), { qos: 1 });
    c.publish(topics.state('afriquia', gw), JSON.stringify(g.state(true)), { qos: 1, retain: true });
  });
  c.on('message', (_t, p) => void g.receive(p));
  clients.push(c);
  return { client: c, totem, pumps, gateway: g };
}

before(async () => {
  if (skip) return;
  const pool = new pg.Pool({ connectionString: DB });
  await pool.query('drop schema public cascade; create schema public;');
  await pool.end();

  broker = await Aedes.createBroker();
  server = createServer(broker.handle);
  await new Promise((r) => server.listen(0, r));
  process.env.MQTT_URL = `mqtt://localhost:${server.address().port}`;
  process.env.DATABASE_URL = DB;
  process.env.MQTT_CLIENT_ID = 'fpc-api-test';
  process.env.NOTIFY_PROVIDER = 'log';
  process.env.MANUAL_LATE_MINUTES = '0';
  process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'fpc-uploads-'));

  await import('../dist/db/seed.js'); // migrations + données de démo
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../dist/app.module.js');
  app = await NestFactory.create(AppModule, { logger: false });
  notifier = app.get((await import('../dist/notifier.service.js')).NotifierService);
  commandsSvc = app.get((await import('../dist/commands.service.js')).CommandsService);
  await app.listen(0);
  base = await app.getUrl();
  base = base.replace('[::1]', 'localhost');

  gws.ok = startGateway('gw-0007');
  gws.partial = startGateway('gw-0008', { deadPumps: ['pump-2'] });
  await until(async () => (await api('/stations')).body.filter((s) => s.online).length === 2);
});

after(async () => {
  if (skip) return;
  for (const c of clients) await c.endAsync();
  await app?.close();
  await new Promise((r) => broker.close(r));
  server.close();
});

test('authentification requise', { skip }, async () => {
  const r = await fetch(base + '/stations');
  assert.equal(r.status, 401);
});

test('seuils : blocage > 15 %, confirmation > 5 %', { skip }, async () => {
  assert.equal((await api('/price-changes', { items: [{ fuel: 'SP', price: 1050 }] })).status, 422);
  assert.equal((await api('/price-changes', { items: [{ fuel: 'SP', price: 935 }] })).status, 409);
  assert.equal((await api('/price-changes', { items: [{ fuel: 'SP', price: 890.5 }] })).status, 400);
});

test('changement de prix appliqué, partiel signalé, prix confirmés mis à jour', { skip }, async () => {
  const stations = (await api('/stations')).body;
  const ids = stations.filter((s) => ['CI-ABJ-012', 'CI-ABJ-031'].includes(s.code)).map((s) => s.id);
  const r = await api('/price-changes', { stationIds: ids, items: [{ fuel: 'SP', price: 890 }, { fuel: 'GO', price: 725 }] });
  assert.equal(r.status, 201);
  const done = await until(async () => {
    const d = (await api(`/price-changes/${r.body.id}`)).body;
    return d.commands.every((c) => ['applied', 'partially_applied'].includes(c.status)) && d;
  });
  const by = Object.fromEntries(done.commands.map((c) => [c.station_code, c.status]));
  assert.deepEqual(by, { 'CI-ABJ-012': 'applied', 'CI-ABJ-031': 'partially_applied' });
  assert.deepEqual(gws.ok.totem.snapshot(), { SP: 890, GO: 725 });
  const after = (await api('/stations')).body.find((s) => s.code === 'CI-ABJ-012');
  assert.deepEqual(after.prices, { SP: 890, GO: 725 });
  const alerts = (await api('/alerts')).body;
  assert.ok(alerts.some((a) => a.kind === 'partially_applied' && a.station_code === 'CI-ABJ-031'));
});

test('accusé falsifié ignoré', { skip }, async () => {
  const stations = (await api('/stations')).body;
  const s = stations.find((x) => x.code === 'CI-ABJ-012');
  const r = await api('/price-changes', { stationIds: [s.id], items: [{ fuel: 'GO', price: 726 }], applyAt: new Date(Date.now() + 3600e3).toISOString() });
  const cmd = (await until(async () => {
    const d = (await api(`/price-changes/${r.body.id}`)).body;
    return d.commands[0]?.status === 'scheduled' && d.commands[0];
  }));
  const forged = signPayload({ v: 1, cmd_id: cmd.cmd_id, gw: 'gw-0007', status: 'applied', at: new Date().toISOString() }, 'mauvaise-cle');
  gws.ok.client.publish(topics.ack('afriquia', 'gw-0007'), JSON.stringify(forged), { qos: 1 });
  await wait(500);
  assert.equal((await api(`/price-changes/${r.body.id}`)).body.commands[0].status, 'scheduled');
});

test('double validation : une autre personne doit valider', { skip }, async () => {
  const pool = new pg.Pool({ connectionString: DB });
  await pool.query('update tenants set require_double_validation = true');
  const stations = (await api('/stations')).body;
  const s = stations.find((x) => x.code === 'CI-ABJ-012');
  const r = await api('/price-changes', { stationIds: [s.id], items: [{ fuel: 'SP', price: 891 }] });
  assert.equal(r.body.status, 'pending_approval');
  assert.equal(r.body.commands.length, 0);
  assert.equal((await api(`/price-changes/${r.body.id}/approve`, {}, 'dev-operator')).status, 403);
  const ok = await api(`/price-changes/${r.body.id}/approve`, {}, 'dev-approver');
  assert.equal(ok.body.status, 'dispatched');
  await until(async () => (await api(`/price-changes/${r.body.id}`)).body.commands[0].status === 'applied');
  await pool.query('update tenants set require_double_validation = false');
  await pool.end();
});

// ---------- Phase 0 : stations sans boîtier ----------

const JPEG = new Blob([Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)])], { type: 'image/jpeg' });

async function stationId(code) {
  return (await api('/stations')).body.find((s) => s.code === code).id;
}
async function manualChange(code, items, extra = {}) {
  const before = notifier.recent.length;
  const r = await api('/price-changes', { stationIds: [await stationId(code)], items, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const msg = notifier.recent.slice(before).find((m) => m.body.includes(code));
  assert.ok(msg, 'consigne envoyée au gérant');
  const token = /\/m\/([A-Za-z0-9_-]+)/.exec(msg.body)[1];
  return { pc: r.body, msg, token };
}
async function confirm(token, totem, pump, photos = true) {
  const f = new FormData();
  f.set('totem', JSON.stringify(totem));
  f.set('pump', JSON.stringify(pump));
  if (photos) { f.set('totemPhoto', JPEG, 't.jpg'); f.set('pumpPhoto', JPEG, 'p.jpg'); }
  const r = await fetch(`${base}/m/${token}/confirm`, { method: 'POST', body: f });
  return { status: r.status, body: await r.json() };
}

test('phase 0 : consigne au gérant, ouverture du lien, confirmation avec photos', { skip }, async () => {
  const { pc, msg, token } = await manualChange('CI-BKE-004', [{ fuel: 'SP', price: 890 }, { fuel: 'GO', price: 725 }]);
  assert.equal(msg.recipient, '+2250700000004');
  assert.equal(pc.commands[0].channel, 'manual');

  // Le jeton n'est jamais stocké en clair, même dans le journal des notifications.
  const pool = new pg.Pool({ connectionString: DB });
  const logged = (await pool.query('select body from notifications order by id desc limit 1')).rows[0].body;
  await pool.end();
  assert.ok(!logged.includes(token) && logged.includes('[lien masqué]'));

  const opened = await fetch(`${base}/m/${token}`).then((r) => r.json());
  assert.equal(opened.status, 'received');
  assert.equal(opened.station.code, 'CI-BKE-004');
  assert.equal((await fetch(`${base}/m/invalide-invalide-invalide`)).status, 404);

  assert.equal((await confirm(token, { SP: 890, GO: 725 }, { SP: 890, GO: 725 }, false)).status, 400);
  const ok = await confirm(token, { SP: 890, GO: 725 }, { SP: 890, GO: 725 });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'applied');
  assert.equal((await confirm(token, { SP: 890, GO: 725 }, { SP: 890, GO: 725 })).status, 409);

  const st = (await api('/stations')).body.find((s) => s.code === 'CI-BKE-004');
  assert.deepEqual(st.prices, { SP: 890, GO: 725 });
  const detail = (await api(`/price-changes/${pc.id}`)).body.commands[0];
  assert.equal(detail.photos.length, 2);
  const img = await fetch(`${base}/commands/${detail.cmd_id}/photos/${detail.photos[0].id}`, { headers: H() });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(`${base}/commands/${detail.cmd_id}/photos/${detail.photos[0].id}`)).status, 401);
});

test('phase 0 : écart entre totem et pompe signalé', { skip }, async () => {
  const { token } = await manualChange('CI-YAM-002', [{ fuel: 'SP', price: 890 }]);
  const r = await confirm(token, { SP: 890 }, { SP: 880 });
  assert.equal(r.body.status, 'partially_applied');
  const st = (await api('/stations')).body.find((s) => s.code === 'CI-YAM-002');
  assert.equal(st.prices.SP, 890); // le totem est conforme
  assert.ok((await api('/alerts')).body.some((a) => a.station_code === 'CI-YAM-002' && /pompe SP = 880/.test(a.message)));
});

test('phase 0 : confirmation trop tôt refusée, problème signalé, retard et rappel', { skip }, async () => {
  const early = await manualChange('CI-SPE-007', [{ fuel: 'GO', price: 720 }], { applyAt: new Date(Date.now() + 3600e3).toISOString() });
  assert.equal((await confirm(early.token, { GO: 720 }, { GO: 720 })).status, 409);

  const late = await manualChange('CI-SPE-007', [{ fuel: 'GO', price: 721 }]);
  const before = notifier.recent.length;
  await commandsSvc.sweep();
  assert.ok((await api('/alerts')).body.some((a) => a.kind === 'late' && a.station_code === 'CI-SPE-007'));
  assert.ok(notifier.recent.slice(before).some((m) => m.body.startsWith('RAPPEL') && m.recipient === '+2250700000007'));

  const pb = await fetch(`${base}/m/${late.token}/problem`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ comment: 'Télécommande du totem en panne' }),
  }).then((r) => r.json());
  assert.equal(pb.status, 'failed');
  assert.ok((await api('/alerts')).body.some((a) => a.kind === 'failed' && /Télécommande/.test(a.message)));
});

test('grille officielle : double validation, prix non conformes bloqués, diffusion à toutes les stations', { skip }, async () => {
  const items = [{ fuel: 'SP', price: 900 }, { fuel: 'GO', price: 730 }];
  const effectiveAt = new Date(Date.now() - 60_000).toISOString();
  const own = await api('/grids', { effectiveAt, items, reference: 'test auto-validation' }, 'dev-admin');
  assert.equal((await api(`/grids/${own.body.id}/approve`, {}, 'dev-admin')).status, 403);

  const g = await api('/grids', { effectiveAt, items, reference: 'Arrêté fictif n° 1' });
  assert.equal(g.body.status, 'pending_approval');
  assert.equal((await api(`/grids/${g.body.id}/dispatch`, {})).status, 409);
  assert.equal((await api(`/grids/${g.body.id}/approve`, {}, 'dev-approver')).body.status, 'validated');

  // Avec une grille en vigueur, un prix différent est bloqué même s'il est proche.
  const off = await api('/price-changes', { items: [{ fuel: 'SP', price: 901 }] });
  assert.equal(off.status, 422);
  assert.match(off.body.message, /grille officielle/);

  const before = (await api('/stations')).body;
  assert.ok(before.every((s) => s.compliant === false));

  const d = await api(`/grids/${g.body.id}/dispatch`, {});
  assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.equal(d.body.commands.length, 5);
  assert.deepEqual([...new Set(d.body.commands.map((c) => c.channel))].sort(), ['manual', 'mqtt']);
  assert.equal((await api(`/grids/${g.body.id}/dispatch`, {})).status, 409);

  await until(async () => (await api('/stations')).body.find((s) => s.code === 'CI-ABJ-012').compliant === true);
  const st = (await api('/stations')).body.find((s) => s.code === 'CI-BKE-004');
  assert.equal(st.compliant, false);
  assert.deepEqual(st.compliance_issues, ['SP : 890 au lieu de 900', 'GO : 725 au lieu de 730']);
});
