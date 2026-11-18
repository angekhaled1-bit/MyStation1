/**
 * Test de bout en bout : API + broker MQTT en mémoire + boîtiers simulés.
 * Nécessite une base PostgreSQL vide dédiée : TEST_DATABASE_URL=postgres://…/fuelprice_test
 * (elle est vidée au début du test). Ignoré si la variable est absente.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import pg from 'pg';
import mqtt from 'mqtt';
import { Aedes } from 'aedes';
import { topics, signPayload } from '@fpc/protocol';
import { Gateway } from '../../gateway-sim/src/gateway.ts';
import { buildSimulatedDevices } from '../../gateway-sim/src/devices.ts';
import { memoryStore, emptyData } from '../../gateway-sim/src/store.ts';

const DB = process.env.TEST_DATABASE_URL;
const skip = !DB && 'TEST_DATABASE_URL absent';
let broker, server, app, base, clients = [], gws = {};

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

  await import('../dist/db/seed.js'); // migrations + données de démo
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../dist/app.module.js');
  app = await NestFactory.create(AppModule, { logger: false });
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
