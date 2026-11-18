/**
 * Broker MQTT de développement (sans TLS ni authentification).
 * En production : broker managé ou Mosquitto/EMQX avec TLS, certificats clients et ACL par boîtier.
 */
import { createServer } from 'node:net';
import { Aedes } from 'aedes';

const port = Number(process.env.MQTT_PORT ?? 1883);
const broker = await Aedes.createBroker();
const server = createServer(broker.handle);
server.listen(port, () => console.log(`Broker MQTT de développement sur le port ${port}`));
broker.on('client', (c) => console.log(`+ ${c?.id}`));
broker.on('clientDisconnect', (c) => console.log(`- ${c?.id}`));
