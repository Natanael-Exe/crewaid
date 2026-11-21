// PROBE — MUST FAIL LINT. See docs/DECISIONS.md D-013.
// Rule: no-restricted-imports · Guard: V1-10 — a job keeps its persisted owner
//
// The mistake this fences is not exotic; it is the obvious thing to reach for
// while wiring a principal through. A background job needs a userId, the
// gateway has one for the socket in front of it, and asking it compiles, runs,
// and is silently wrong: on a shared install the job acts as whoever happens
// to be connected, and already-authorized work dies when that socket closes.
//
// Lints under the orchestrator block so it is judged by the one definition of
// the rule rather than a copy that could drift — which is the exact failure
// the M2-BE-02 probe's own comment records.
import { WsPrincipals } from '../../apps/orchestrator/src/ws/ws-principals.js';

export type Probe = WsPrincipals;
