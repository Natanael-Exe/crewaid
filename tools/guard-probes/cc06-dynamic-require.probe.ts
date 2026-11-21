// PROBE — MUST FAIL LINT. See docs/DECISIONS.md D-013.
// Rule: no-restricted-syntax (non-literal require) · Guard: PRD §7.3 / CC-06
// require() with a computed specifier is a dynamic code path — the same door
// as eval, reached through the module system.
declare function require(specifier: string): unknown;

export function probe(specifier: string): unknown {
  return require(specifier);
}
