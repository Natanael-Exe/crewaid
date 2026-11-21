/* global setTimeout */
// PROBE — MUST FAIL LINT. See docs/DECISIONS.md D-013.
// Rules: no-implied-eval · @typescript-eslint/no-implied-eval · Guard: PRD §7.3 / CC-06
//
// A string handed to setTimeout is an eval path with a delay: the string is
// compiled and executed. The block configures the base rule and its type-aware
// twin together; both are asserted.
//
// The `/* global */` directive is load-bearing for the BASE rule only: it
// reports a call whose callee resolves to a global variable, and the TS scope
// manager does not register `setTimeout` as one by itself (this same fixture
// without the directive fires the type-aware twin alone). The twin — which
// asks the type checker whether a string was passed — is the net that catches
// real TS code; the directive buys evidence the base rule is alive.
export function probe(): void {
  setTimeout('probe()', 1);
}
