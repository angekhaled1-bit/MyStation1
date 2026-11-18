import { readFileSync } from 'node:fs';
import mqtt from 'mqtt';
import { PROTOCOL_VERSION, topics, type GatewayState } from '@fpc/protocol';
import { loadConfig } from './config.js';
import { buildSimulatedDevices } from './devices.js';
import { fileStore } from './store.js';
import { Gateway } from './gateway.js';

const cfg = loadConfig();
const store = fileStore(cfg.dataFile, cfg.initial);
// Le totem simulé démarre sur le dernier prix valide mémorisé (comme un vrai afficheur).
const { totem, pumps } = buildSimulatedDevices(store.data.lastValid, cfg.pumpCount, cfg.faults, cfg.latencyMs);

const cmdTopic = topics.cmd(cfg.tenant, cfg.gatewayId);
const ackTopic = topics.ack(cfg.tenant, cfg.gatewayId);
const stateTopic = topics.state(cfg.tenant, cfg.gatewayId);

const offline: GatewayState = { v: PROTOCOL_VERSION, gw: cfg.gatewayId, online: false, at: '' };

const client = mqtt.connect(cfg.mqttUrl, {
  clientId: `gw-${cfg.tenant}-${cfg.gatewayId}`,
  clean: false, // session persistante : le broker garde les commandes QoS 1 pendant une coupure
  keepalive: 30,
  reconnectPeriod: 5000,
  username: cfg.mqttUsername,
  password: cfg.mqttPassword,
  ca: cfg.tlsCa ? readFileSync(cfg.tlsCa) : undefined,
  cert: cfg.tlsCert ? readFileSync(cfg.tlsCert) : undefined,
  key: cfg.tlsKey ? readFileSync(cfg.tlsKey) : undefined,
  will: { topic: stateTopic, payload: Buffer.from(JSON.stringify(offline)), qos: 1, retain: true },
});

const gw = new Gateway(
  { ...cfg, fw: 'sim-0.1.0' },
  store,
  totem,
  pumps,
  {
    publishAck: (ack) => {
      console.log(`→ ack ${ack.cmd_id} ${ack.status}${ack.reason ? ' (' + ack.reason + ')' : ''}`);
      client.publish(ackTopic, JSON.stringify(ack), { qos: 1 });
    },
    publishState: (s) => {
      client.publish(stateTopic, JSON.stringify(s), { qos: 1, retain: true });
    },
    log: (m) => console.log(m),
  },
);

client.on('connect', () => {
  console.log(`Connecté à ${cfg.mqttUrl}, écoute ${cmdTopic}`);
  client.subscribe(cmdTopic, { qos: 1 });
  client.publish(stateTopic, JSON.stringify(gw.state(true)), { qos: 1, retain: true });
  void gw.processDue(); // reprise d'une commande interrompue par une coupure
});
client.on('offline', () => console.log('Hors ligne, nouvelle tentative…'));
client.on('error', (e) => console.error('MQTT :', e.message));
client.on('message', (topic, payload) => {
  if (topic === cmdTopic) void gw.receive(payload).catch((e) => console.error('Erreur de traitement :', e));
});

// Commandes programmées : vérification chaque seconde.
setInterval(() => void gw.processDue(), 1000);

setInterval(() => {
  console.log(`[affichage] totem ${JSON.stringify(totem.snapshot())} | ${pumps.map((p) => `${p.name} ${JSON.stringify(p.snapshot())}`).join(' | ')}`);
}, 30000).unref();

const shutdown = () => {
  client.publish(stateTopic, JSON.stringify(gw.state(false)), { qos: 1, retain: true }, () => client.end(false, () => process.exit(0)));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
