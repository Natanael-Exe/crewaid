# MOD-AI-06 — Owned native consumption authority

D-182 ratifies the production consumption boundary for an admitted answer
batch. It does not wire the backend composition, add an endpoint or activate
the execution path.

When a resumed producer answers its interrupts, two server-owned authorities
apply before anything is dispatched or consumed. The dispatch authorizer
verifies each claimed tool resolution against the staged policy decision on
the owned proposal row: the executing continuation must chain to the
interrupted parent through `resumesRunId`, the proposal must belong to that
parent, the user, the bot and the thread, and a staged decision must exist.
A pending, foreign, missing or direction-mismatched claim fails the run
instead of dispatching. Approved dispatch uses the staged effective
arguments — never the runtime's claim. Declined and cancelled decisions skip
dispatch with the staged reason.

The commit authority admits a native terminal write only when the private
proposal is already admitted and the entry's direction matches the staged
decision: a resolved entry requires a staged response with the same approved
direction (and carries the validated answer), and a cancelled entry requires
a staged cancellation. Forged, pending or mismatched entries are refused
before any native column changes, so a batch that failed admission can never
be consumed. Producer liveness stays with the closing boundary's lease fence;
this authority owns only the decision correspondence.

Acceptance uses actual PostgreSQL. Admitted batches authorize dispatch with
staged arguments, including edited approvals; pending, foreign-run and
mismatched claims throw without changing any row. The commit authority
refuses pending and mismatched entries through the installed store and
commits matching ones into the native facet. No endpoint, schema,
composition or tool-loop change is added. Plan reconstruction, cumulative
checkpoint budgets and uncertain-dispatch acceptance remain separate
required MOD-AI-06/MOD-DU-02 work.

## D-183 amendment — restored plans

The authorizer's approved `dispatchArgs` is the proposal's stored `rawArgs`.
`createPolicyRuntime().restore()` runs in `onInterruptResolution` after
authorization and rebuilds plans from the parent's answered operator
proposals (`PolicyProposalStore.staged`), re-assessing and `rebind`-ing edits.
`claimDispatch` writes `dispatchedAt` before the action; a restored plan
carrying it is never dispatched again. Acceptance:
`test/mod-ai06-restored-plans.integration.test.ts` (fresh runtimes per
restart, real PostgreSQL; removing the claim fails both restart cases).
