import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalJson, signPayload, verifyPayload, classifyVariation, variationPct,
  checkCommandShape, topics, parseTopic, type PriceCommand,
} from '../src/index.js';

const SECRET = 'cle-de-test-du-boitier';

function cmd(): Omit<PriceCommand, 'sig'> {
  return {
    v: 1, type: 'set_prices', cmd_id: 'cmd-0000-0001', seq: 41, tenant: 'afriquia', station: 'CI-ABJ-012',
    gw: 'gw-0007', issued_at: '2026-11-18T08:00:00.000Z', apply_at: null, expires_at: '2026-11-19T08:00:00.000Z',
    items: [{ fuel: 'SP', price: 890, prev: 875 }, { fuel: 'GO', price: 725, prev: 715 }],
  };
}

test('JSON canonique indépendant de l\'ordre des clés', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: null }] }), '{"a":[2,{"c":null,"d":3}],"b":1}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.throws(() => canonicalJson({ a: Number.NaN }));
});

test('signature valide acceptée', () => {
  const signed = signPayload(cmd(), SECRET);
  assert.match(signed.sig, /^[0-9a-f]{64}$/);
  assert.equal(verifyPayload(signed, SECRET), true);
  // Ordre des clés différent à la réception : toujours valide
  const reordered = JSON.parse(JSON.stringify({ sig: signed.sig, ...cmd() }));
  assert.equal(verifyPayload(reordered, SECRET), true);
});

test('commande falsifiée, mauvaise clé ou signature absente refusées', () => {
  const signed = signPayload(cmd(), SECRET);
  const tampered = structuredClone(signed);
  tampered.items[0].price = 790;
  assert.equal(verifyPayload(tampered, SECRET), false);
  assert.equal(verifyPayload(signed, 'autre-cle'), false);
  assert.equal(verifyPayload({ ...signed, sig: undefined }, SECRET), false);
  assert.equal(verifyPayload({ ...signed, sig: 'abc' }, SECRET), false);
});

test('seuils de variation 5 % / 15 %', () => {
  assert.equal(variationPct(1000, 1050), 5);
  assert.equal(classifyVariation(1000, 1050), 'ok');
  assert.equal(classifyVariation(1000, 1051), 'confirm');
  assert.equal(classifyVariation(1000, 1150), 'confirm');
  assert.equal(classifyVariation(1000, 1151), 'block');
  assert.equal(classifyVariation(1000, 849), 'block');
  assert.equal(classifyVariation(null, 900), 'confirm');
});

test('contrôle de forme', () => {
  const ok = signPayload(cmd(), SECRET);
  assert.equal(checkCommandShape(ok), null);
  assert.match(checkCommandShape({ ...ok, items: [{ fuel: 'SP', price: 890.5, prev: null }] })!, /prix invalide/);
  assert.match(checkCommandShape({ ...ok, items: [{ fuel: 'SP', price: 1, prev: null }, { fuel: 'SP', price: 2, prev: null }] })!, /double/);
  assert.match(checkCommandShape({ ...ok, v: 2 })!, /version/);
});

test('topics', () => {
  assert.equal(topics.cmd('afriquia', 'gw-0007'), 'fpc/v1/t/afriquia/g/gw-0007/cmd');
  assert.deepEqual(parseTopic('fpc/v1/t/afriquia/g/gw-0007/ack'), { tenant: 'afriquia', gatewayId: 'gw-0007', kind: 'ack' });
  assert.throws(() => topics.cmd('afriquia', 'gw/#'));
});
