// PROBE — MUST FAIL LINT. See docs/DECISIONS.md D-013.
// Rule: no-new-func · Guard: PRD §7.3 / CC-06
export function probe(body: string): unknown {
  return new Function(body);
}
