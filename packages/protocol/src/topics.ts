/**
 * Arborescence MQTT.
 *   fpc/v1/t/{tenant}/g/{gatewayId}/cmd    cloud → boîtier (QoS 1, session persistante)
 *   fpc/v1/t/{tenant}/g/{gatewayId}/ack    boîtier → cloud (QoS 1)
 *   fpc/v1/t/{tenant}/g/{gatewayId}/state  boîtier → cloud (QoS 1, retenu, testament « offline »)
 * Le broker doit restreindre chaque boîtier à ses propres topics (ACL par certificat client).
 */
export const TOPIC_ROOT = 'fpc/v1';

const SEGMENT = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function assertSegment(name: string, value: string): void {
  if (!SEGMENT.test(value)) throw new Error(`${name} invalide pour un topic MQTT : ${value}`);
}

function base(tenant: string, gatewayId: string): string {
  assertSegment('tenant', tenant);
  assertSegment('gatewayId', gatewayId);
  return `${TOPIC_ROOT}/t/${tenant}/g/${gatewayId}`;
}

export const topics = {
  cmd: (tenant: string, gw: string) => `${base(tenant, gw)}/cmd`,
  ack: (tenant: string, gw: string) => `${base(tenant, gw)}/ack`,
  state: (tenant: string, gw: string) => `${base(tenant, gw)}/state`,
  /** Abonnements côté cloud (tous les boîtiers de tous les clients). */
  allAcks: `${TOPIC_ROOT}/t/+/g/+/ack`,
  allStates: `${TOPIC_ROOT}/t/+/g/+/state`,
};

export function parseTopic(topic: string): { tenant: string; gatewayId: string; kind: string } | null {
  const m = /^fpc\/v1\/t\/([^/]+)\/g\/([^/]+)\/(cmd|ack|state)$/.exec(topic);
  return m ? { tenant: m[1], gatewayId: m[2], kind: m[3] } : null;
}
