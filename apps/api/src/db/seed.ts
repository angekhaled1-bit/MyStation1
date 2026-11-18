/**
 * Données de démonstration : client AFRIQUIA et 3 stations fictives.
 * Les clés des boîtiers correspondent aux valeurs par défaut du simulateur (dev-secret-<gw>).
 */
import 'reflect-metadata';
import { DbService } from './db.service.js';

const db = new DbService();
await db.migrate();
await db.query(
  `insert into tenants(id, name) values ('afriquia', 'AFRIQUIA (démo)') on conflict (id) do nothing`,
);
const stations = [
  ['CI-ABJ-012', 'Station Plateau (fictive)', 'Abidjan', 'gw-0007'],
  ['CI-ABJ-031', 'Station Cocody (fictive)', 'Abidjan', 'gw-0008'],
  ['CI-BKE-004', 'Station Bouaké Centre (fictive)', 'Bouaké', 'gw-0009'],
];
for (const [code, name, city, gw] of stations) {
  const r = await db.query<{ id: string }>(
    `insert into stations(tenant_id, code, name, city, fuels, gateway_id, gateway_secret)
     values ('afriquia', $1, $2, $3, '{SP,GO}', $4, $5)
     on conflict (tenant_id, code) do update set name = excluded.name returning id`,
    [code, name, city, gw, `dev-secret-${gw}`],
  );
  for (const [fuel, price] of [['SP', 875], ['GO', 715]] as const) {
    await db.query(
      `insert into station_prices(station_id, fuel, price) values ($1, $2, $3) on conflict do nothing`,
      [r.rows[0].id, fuel, price],
    );
  }
}
console.log('Données de démonstration insérées.');
await db.onModuleDestroy();
