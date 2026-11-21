// PROBE — MUST FAIL LINT. See docs/DECISIONS.md D-013.
// Rule: no-restricted-properties · Guard: PRD §7.3 / CC-06
// The PRD names vm.runInNewContext specifically. The import ban covers
// `import vm from 'node:vm'`, but a vm-like object can arrive WITHOUT an
// import — as a parameter, from a helper, or through createRequire — so the
// property itself must be banned. This probe isolates that rule: no import,
// only the call.
type VmLike = { runInNewContext(source: string): unknown };
declare const vm: VmLike;

export function probe(source: string): unknown {
  return vm.runInNewContext(source);
}
