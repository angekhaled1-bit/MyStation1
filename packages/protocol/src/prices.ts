export interface VariationThresholds {
  /** Au-delà de ce pourcentage, une confirmation explicite est exigée. */
  confirmPct: number;
  /** Au-delà de ce pourcentage, la saisie est bloquée. */
  blockPct: number;
}

export const DEFAULT_THRESHOLDS: VariationThresholds = { confirmPct: 5, blockPct: 15 };

export type VariationLevel = 'ok' | 'confirm' | 'block';

export function isValidPrice(p: unknown): p is number {
  return typeof p === 'number' && Number.isSafeInteger(p) && p > 0;
}

/** Variation en pourcentage, arrondie à 0,01. null si pas de prix précédent. */
export function variationPct(prev: number | null, next: number): number | null {
  if (prev === null || prev <= 0) return null;
  return Math.round(((next - prev) / prev) * 10000) / 100;
}

export function classifyVariation(
  prev: number | null,
  next: number,
  t: VariationThresholds = DEFAULT_THRESHOLDS,
): VariationLevel {
  const pct = variationPct(prev, next);
  if (pct === null) return 'confirm'; // premier prix : toujours le faire confirmer
  const abs = Math.abs(pct);
  if (abs > t.blockPct) return 'block';
  if (abs > t.confirmPct) return 'confirm';
  return 'ok';
}

export const FUEL_CODE = /^[A-Z0-9]{2,8}$/;
