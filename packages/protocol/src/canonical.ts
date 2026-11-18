/**
 * Sérialisation JSON canonique : clés triées, aucun espace.
 * Le cloud et le boîtier doivent produire exactement les mêmes octets
 * pour un même objet, sinon la signature ne correspond pas.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('Nombre non fini interdit dans un message signé');
    }
    if (value === undefined) throw new TypeError('undefined interdit dans un message signé');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}
