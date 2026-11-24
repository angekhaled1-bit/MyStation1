import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signPayload, verifyPayload, type CommandAck, type PriceCommand } from '@fpc/protocol';
import { Gateway } from '../src/gateway.js';
import { buildSimulatedDevices, type SimFaults } from '../src/devices.js';
import { memoryStore, emptyData } from '../src/store.js';

const SECRET = 'secret-test';
let n = 0;

function command(over: Partial<PriceCommand> = {}, prices = { SP: 890, GO: 725 }): PriceCommand {
  n++;
  const base = {
    v: 1 as const, type: 'set_prices' as const, cmd_id: `cmd-test-${String(n).padStart(4, '0')}`, seq: n,
    tenant: 'afriquia', station: 'CI-ABJ-012', gw: 'gw-0007',
    issued_at: new Date().toISOString(), apply_at: null, expires_at: new Date(Date.now() + 3600e3).toISOString(),
    items: Object.entries(prices).map(([fuel, price]) => ({ fuel, price, prev: null })),
    ...over,
  };
  const { sig, ...rest } = base as PriceCommand;
  return signPayload(rest, SECRET) as PriceCommand;
}

function setup(faults: SimFaults = {}, store = memoryStore(emptyData({ SP: 875, GO: 715 }))) {
  const acks: CommandAck[] = [];
  const { totem, pumps } = buildSimulatedDevices({ SP: 875, GO: 715 }, 2, faults);
  const gw = new Gateway(
    { tenant: 'afriquia', gatewayId: 'gw-0007', secret: SECRET, priceMin: 500, priceMax: 1500, deviceAttempts: 3, retryDelayMs: 1 },
    store, totem, pumps, { publishAck: (a) => { acks.push(a); } },
  );
  const statuses = (id: string) => acks.filter((a) => a.cmd_id === id).map((a) => a.status);
  return { gw, acks, totem, pumps, store, statuses };
}

test('cas nominal : totem et pompes mis à jour, accusés signés', async () => {
  const s = setup();
  const c = command();
  await s.gw.receive(JSON.stringify(c));
  assert.deepEqual(s.statuses(c.cmd_id), ['received', 'totem_applied', 'applied']);
  assert.deepEqual(s.totem.snapshot(), { SP: 890, GO: 725 });
  assert.deepEqual(s.pumps[1].snapshot(), { SP: 890, GO: 725 });
  assert.deepEqual(s.store.data.lastValid, { SP: 890, GO: 725 });
  assert.ok(s.acks.every((a) => verifyPayload(a, SECRET)));
});

test('commande falsifiée en route : rien n\'est écrit', async () => {
  const s = setup();
  const c = command();
  c.items[0].price = 790;
  await s.gw.receive(JSON.stringify(c));
  assert.deepEqual(s.statuses(c.cmd_id), ['rejected']);
  assert.equal(s.acks[0].reason, 'bad_signature');
  assert.deepEqual(s.totem.snapshot(), { SP: 875, GO: 715 });
});

test('rejeu : renvoie le résultat sans réécrire', async () => {
  const s = setup();
  const c = command();
  await s.gw.receive(JSON.stringify(c));
  await s.totem.write({ SP: 1 }); // si le boîtier réécrivait, on verrait 890 réapparaître
  await s.gw.receive(JSON.stringify(c));
  const last = s.acks.at(-1)!;
  assert.equal(last.status, 'applied');
  assert.equal(last.duplicate, true);
  assert.equal(s.totem.snapshot().SP, 1);
});

test('prix hors bornes locales refusé', async () => {
  const s = setup();
  const c = command({}, { SP: 8900, GO: 725 });
  await s.gw.receive(JSON.stringify(c));
  assert.deepEqual(s.statuses(c.cmd_id), ['rejected']);
  assert.match(s.acks[0].reason!, /out_of_bounds/);
});

test('commande expirée ou plus ancienne que la dernière appliquée', async () => {
  const s = setup();
  const exp = command({ expires_at: new Date(Date.now() - 1000).toISOString() });
  await s.gw.receive(JSON.stringify(exp));
  assert.deepEqual(s.statuses(exp.cmd_id), ['expired']);

  const older = command();
  const newer = command();
  await s.gw.receive(JSON.stringify(newer));
  await s.gw.receive(JSON.stringify(older));
  assert.deepEqual(s.statuses(older.cmd_id), ['superseded']);
});

test('commande destinée à un autre boîtier ignorée', async () => {
  const s = setup();
  const c = command({ gw: 'gw-0099' });
  await s.gw.receive(JSON.stringify(c));
  assert.equal(s.acks[0].reason, 'wrong_gateway');
});

test('totem muet au premier essai : nouvel essai local puis succès', async () => {
  const s = setup({ totemMuteCount: 1 });
  const c = command();
  await s.gw.receive(JSON.stringify(c));
  assert.equal(s.acks.at(-1)!.status, 'applied');
});

test('une pompe ne répond pas : application partielle signalée', async () => {
  const s = setup({ deadPumps: ['pump-2'] });
  const c = command();
  await s.gw.receive(JSON.stringify(c));
  const last = s.acks.at(-1)!;
  assert.equal(last.status, 'partially_applied');
  assert.deepEqual(last.devices!.map((d) => d.ok), [true, true, false]);
  assert.deepEqual(s.store.data.lastValid, { SP: 890, GO: 725 });
});

test('relecture du totem différente : échec du totem, dernier prix valide inchangé', async () => {
  const s = setup({ totemReadMismatch: true });
  const c = command();
  await s.gw.receive(JSON.stringify(c));
  assert.equal(s.acks.at(-1)!.status, 'partially_applied');
  assert.deepEqual(s.store.data.lastValid, { SP: 875, GO: 715 });
});

test('programmation : appliqué seulement à l\'heure dite', async () => {
  let now = Date.now();
  const store = memoryStore(emptyData({ SP: 875, GO: 715 }));
  const acks: CommandAck[] = [];
  const { totem, pumps } = buildSimulatedDevices({ SP: 875, GO: 715 }, 1);
  const gw = new Gateway(
    { tenant: 'afriquia', gatewayId: 'gw-0007', secret: SECRET, priceMin: 500, priceMax: 1500, deviceAttempts: 1, retryDelayMs: 1 },
    store, totem, pumps, { publishAck: (a) => { acks.push(a); }, now: () => new Date(now) },
  );
  const c = command({ apply_at: new Date(now + 60_000).toISOString() });
  await gw.receive(JSON.stringify(c));
  assert.deepEqual(acks.map((a) => a.status), ['received', 'scheduled']);
  assert.equal(totem.snapshot().SP, 875);
  now += 61_000;
  await gw.processDue();
  assert.equal(acks.at(-1)!.status, 'applied');
  assert.equal(totem.snapshot().SP, 890);
});

test('reprise après coupure : une commande restée en file est appliquée au redémarrage', async () => {
  const data = emptyData({ SP: 875, GO: 715 });
  const c = command();
  data.queue.push(c); // état laissé par une coupure entre « received » et l'écriture
  data.seen[c.cmd_id] = { status: 'received' } as CommandAck;
  const s = setup({}, memoryStore(data));
  await s.gw.processDue();
  assert.equal(s.acks.at(-1)!.status, 'applied');
  assert.equal(s.store.data.queue.length, 0);
});
