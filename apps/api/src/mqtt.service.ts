import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import mqtt, { type MqttClient } from 'mqtt';
import { topics } from '@fpc/protocol';

type Handler = (topic: string, payload: Buffer) => void | Promise<void>;

@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Mqtt');
  private client!: MqttClient;
  private handlers: Handler[] = [];
  connected = false;

  onModuleInit() {
    const url = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
    this.client = mqtt.connect(url, {
      clientId: process.env.MQTT_CLIENT_ID ?? 'fpc-cloud-api',
      clean: false,
      username: process.env.MQTT_USERNAME,
      password: process.env.MQTT_PASSWORD,
      ca: process.env.MQTT_CA ? readFileSync(process.env.MQTT_CA) : undefined,
      cert: process.env.MQTT_CERT ? readFileSync(process.env.MQTT_CERT) : undefined,
      key: process.env.MQTT_KEY ? readFileSync(process.env.MQTT_KEY) : undefined,
      reconnectPeriod: 3000,
    });
    this.client.on('connect', () => {
      this.connected = true;
      this.log.log(`connecté à ${url}`);
      this.client.subscribe([topics.allAcks, topics.allStates], { qos: 1 });
    });
    this.client.on('close', () => (this.connected = false));
    this.client.on('error', (e) => this.log.warn(e.message));
    this.client.on('message', (t, p) => {
      for (const h of this.handlers) {
        Promise.resolve(h(t, p)).catch((e) => this.log.error(`traitement ${t} : ${(e as Error).message}`));
      }
    });
  }

  onMessage(h: Handler) {
    this.handlers.push(h);
  }

  /** Publication QoS 1 : le broker garde le message pour un boîtier hors ligne (session persistante). */
  publish(topic: string, payload: object): Promise<void> {
    return new Promise((resolve, reject) =>
      this.client.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => (err ? reject(err) : resolve())),
    );
  }

  async onModuleDestroy() {
    await this.client?.endAsync();
  }
}
