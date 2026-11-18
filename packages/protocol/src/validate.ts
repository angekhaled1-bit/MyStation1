import { PROTOCOL_VERSION, type PriceCommand, ACK_STATUSES, type CommandAck, type AckStatus } from './types.js';
import { FUEL_CODE, isValidPrice } from './prices.js';

/** Contrôle de forme d'un message reçu (données non fiables). Renvoie une erreur lisible ou null. */
export function checkCommandShape(x: unknown): string | null {
  if (!x || typeof x !== 'object') return 'message non objet';
  const c = x as Partial<PriceCommand>;
  if (c.v !== PROTOCOL_VERSION) return 'version de protocole inconnue';
  if (c.type !== 'set_prices') return 'type de commande inconnu';
  if (typeof c.cmd_id !== 'string' || c.cmd_id.length < 8 || c.cmd_id.length > 64) return 'cmd_id invalide';
  if (!Number.isSafeInteger(c.seq) || (c.seq as number) < 1) return 'seq invalide';
  for (const k of ['tenant', 'station', 'gw', 'issued_at', 'expires_at', 'sig'] as const) {
    if (typeof c[k] !== 'string' || !c[k]) return `${k} manquant`;
  }
  if (c.apply_at !== null && typeof c.apply_at !== 'string') return 'apply_at invalide';
  for (const k of ['issued_at', 'expires_at'] as const) if (Number.isNaN(Date.parse(c[k] as string))) return `${k} illisible`;
  if (c.apply_at && Number.isNaN(Date.parse(c.apply_at))) return 'apply_at illisible';
  if (!Array.isArray(c.items) || c.items.length === 0 || c.items.length > 16) return 'items invalides';
  const seen = new Set<string>();
  for (const it of c.items) {
    if (!it || typeof it.fuel !== 'string' || !FUEL_CODE.test(it.fuel)) return 'code produit invalide';
    if (seen.has(it.fuel)) return `produit en double : ${it.fuel}`;
    seen.add(it.fuel);
    if (!isValidPrice(it.price)) return `prix invalide pour ${it.fuel}`;
    if (it.prev !== null && !isValidPrice(it.prev)) return `prix précédent invalide pour ${it.fuel}`;
  }
  return null;
}

export function checkAckShape(x: unknown): string | null {
  if (!x || typeof x !== 'object') return 'message non objet';
  const a = x as Partial<CommandAck>;
  if (a.v !== PROTOCOL_VERSION) return 'version de protocole inconnue';
  if (typeof a.cmd_id !== 'string' || !a.cmd_id) return 'cmd_id manquant';
  if (typeof a.gw !== 'string' || !a.gw) return 'gw manquant';
  if (!ACK_STATUSES.includes(a.status as AckStatus)) return 'statut inconnu';
  if (typeof a.at !== 'string' || Number.isNaN(Date.parse(a.at))) return 'horodatage invalide';
  if (typeof a.sig !== 'string') return 'signature manquante';
  return null;
}
