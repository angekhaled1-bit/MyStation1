/**
 * Données de démonstration : client AFRIQUIA, 2 stations avec boîtier et 3 stations en phase 0 (sans boîtier).
 * Les clés des boîtiers correspondent aux valeurs par défaut du simulateur (dev-secret-<gw>).
 * Les numéros de téléphone sont fictifs : n'activez pas une vraie passerelle SMS avec ces données.
 */
import 'reflect-metadata';
import { DbService } from './db.service.js';

const db = new DbService();
await db.migrate();
await db.query(
  `insert into tenants(id, name) values ('afriquia', 'AFRIQUIA (démo)') on conflict (id) do nothing`,
);
// [code, nom, ville, boîtier (null = phase 0, sans boîtier), gérant, téléphone fictif]
const stations: [string, string, string, string | null, string, string][] = [
  ['CI-ABJ-012', 'Station Plateau (fictive)', 'Abidjan', 'gw-0007', 'Gérant Plateau', '+2250700000012'],
  ['CI-ABJ-031', 'Station Cocody (fictive)', 'Abidjan', 'gw-0008', 'Gérant Cocody', '+2250700000031'],
  ['CI-BKE-004', 'Station Bouaké Centre (fictive)', 'Bouaké', null, 'Gérant Bouaké', '+2250700000004'],
  ['CI-YAM-002', 'Station Yamoussoukro (fictive)', 'Yamoussoukro', null, 'Gérant Yamoussoukro', '+2250700000002'],
  ['CI-SPE-007', 'Station San-Pédro Port (fictive)', 'San-Pédro', null, 'Gérant San-Pédro', '+2250700000007'],
];
for (const [code, name, city, gw, manager, phone] of stations) {
  const r = await db.query<{ id: string }>(
    `insert into stations(tenant_id, code, name, city, fuels, mode, gateway_id, gateway_secret, manager_name, manager_phone)
     values ('afriquia', $1, $2, $3, '{SP,GO}', $4, $5, $6, $7, $8)
     on conflict (tenant_id, code) do update set name = excluded.name, mode = excluded.mode,
       gateway_id = excluded.gateway_id, gateway_secret = excluded.gateway_secret,
       manager_name = excluded.manager_name, manager_phone = excluded.manager_phone
     returning id`,
    [code, name, city, gw ? 'gateway' : 'manual', gw, gw ? `dev-secret-${gw}` : null, manager, phone],
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
