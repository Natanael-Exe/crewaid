// PROBE — MUST FAIL LINT. See docs/DECISIONS.md D-013.
// Rule: no-eval · Guard: PRD §7.3 / CC-06
export function probe(source: string): unknown {
  return eval(source);
}
