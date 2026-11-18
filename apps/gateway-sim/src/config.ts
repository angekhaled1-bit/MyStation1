import type { SimFaults } from './devices.js';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Variable d'environnement manquante : ${name}`);
  return v;
}

export function loadConfig() {
  const initial = Object.fromEntries(
    env('SIM_INITIAL_PRICES', 'SP=875,GO=715')
      .split(',')
      .map((kv) => kv.split('='))
      .map(([k, v]) => [k.trim(), Number(v)]),
  );
  const faults: SimFaults = {
    totemMuteCount: Number(process.env.SIM_TOTEM_MUTE_COUNT ?? 0),
    deadPumps: (process.env.SIM_DEAD_PUMPS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    totemReadMismatch: process.env.SIM_TOTEM_READ_MISMATCH === '1',
  };
  return {
    mqttUrl: env('MQTT_URL', 'mqtt://localhost:1883'),
    mqttUsername: process.env.MQTT_USERNAME,
    mqttPassword: process.env.MQTT_PASSWORD,
    // En production : certificat client (mTLS). Chemins vers les fichiers PEM.
    tlsCa: process.env.MQTT_CA,
    tlsCert: process.env.MQTT_CERT,
    tlsKey: process.env.MQTT_KEY,
    tenant: env('TENANT', 'afriquia'),
    gatewayId: env('GW_ID', 'gw-0007'),
    secret: env('GW_SECRET', 'dev-secret-gw-0007'),
    dataFile: env('DATA_FILE', `data/${process.env.GW_ID ?? 'gw-0007'}.json`),
    priceMin: Number(env('PRICE_MIN', '500')),
    priceMax: Number(env('PRICE_MAX', '1500')),
    deviceAttempts: Number(env('DEVICE_ATTEMPTS', '3')),
    retryDelayMs: Number(env('DEVICE_RETRY_MS', '1000')),
    pumpCount: Number(env('SIM_PUMPS', '2')),
    latencyMs: Number(env('SIM_LATENCY_MS', '300')),
    initial,
    faults,
  };
}
