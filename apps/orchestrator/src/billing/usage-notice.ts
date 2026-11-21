/**
 * Which notice level, if any, a meter just crossed: `before` and
 * `after` are the period's totals around one recording, `limit` its cap. The
 * higher level wins when one recording crosses both, so a single large charge
 * says "used up" rather than "80%". Nothing for a meter with no limit.
 */
export function crossedLevel(before: number, after: number, limit: number | null): 80 | 100 | null {
  if (limit === null || limit <= 0) return null;
  if (before < limit && after >= limit) return 100;
  const warning = limit * 0.8;
  if (before < warning && after >= warning) return 80;
  return null;
}
