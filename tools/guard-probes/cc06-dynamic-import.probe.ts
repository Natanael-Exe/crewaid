// PROBE — MUST FAIL LINT. See docs/DECISIONS.md D-013.
// Rule: no-restricted-syntax (ImportExpression) · Guard: PRD §7.3 / CC-06
// Dynamic import is an execution path for untrusted model-generated skill source.
export async function probe(specifier: string): Promise<unknown> {
  return await import(specifier);
}
