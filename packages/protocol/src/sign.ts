import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from './canonical.js';

/**
 * Signature HMAC-SHA256 d'un message, calculée sur sa forme canonique sans le champ `sig`.
 * Chaque boîtier a sa propre clé : une clé volée ne permet d'attaquer qu'une station.
 */
export function signPayload<T extends object>(payload: T, secret: string): T & { sig: string } {
  const { sig: _ignored, ...rest } = payload as T & { sig?: string };
  const sig = computeSig(rest, secret);
  return { ...(rest as T), sig };
}

export function computeSig(payloadWithoutSig: object, secret: string): string {
  if (!secret) throw new Error('Clé de signature vide');
  return createHmac('sha256', secret).update(canonicalJson(payloadWithoutSig)).digest('hex');
}

export function verifyPayload(payload: { sig?: unknown }, secret: string): boolean {
  if (typeof payload.sig !== 'string' || !/^[0-9a-f]{64}$/.test(payload.sig)) return false;
  const { sig, ...rest } = payload;
  const expected = Buffer.from(computeSig(rest, secret), 'hex');
  const received = Buffer.from(sig as string, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}
