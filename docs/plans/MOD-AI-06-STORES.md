# MOD-AI-06 — Prisma store composition

D-178 ratifies the next implementation boundary. It builds on D-177 and does
not complete MOD-AI-06 or activate a production backend.

## Run records and producer authority are different operations

The library RunStore creates durable records; D-177 claims a producer. A
created record does not acquire an active key, lease or epoch. Production first
admits an owned canonical USER trigger and claims its AgentTurn. The library's
createOrResume then returns that existing record unchanged. Unknown creation
requires an explicit server admission callback and verifies the owned bot,
TANSTACK thread and canonical trigger under bot/thread locks. It never accepts
client history or creates another producer. Global ID collisions are opaque.

The adapter is scoped to a server principal. Reads only return that principal's
TANSTACK rows. Every mutation requires an explicit server write-authority
callback inside the transaction; no optional writer or memory fallback exists.
Production supplies the captured D-177 lease. Conformance fixtures supply
explicit authority over their own unleased records to exercise the generic
storage contract, including several running records in one thread. Those
records grant no execution authority. Separate real multi-worker tests prove
the actual active-key and lease rules; conformance is not a claim of ownership
or crash safety.

createOrResume ignores replacement timestamps/status/thread/link inputs for
an existing owned row. Unknown update is a no-op and never inserts. Thread
listing sorts by startedAt then insertion sequence; active lookup returns the
latest running record. listReclaimable follows the library's inclusive detached
TTL contract, scoped to the principal. It neither takes a lease nor schedules a
reaper; D-177 lease expiry is the producer recovery criterion.

Subagent creation/listByParentRun is omitted explicitly: bot-to-bot work is a
separate bot/turn, not a hidden subagent transcript. New subagent link inputs
are refused, never silently discarded. resumesRunId is a pause continuation
link and must not be repurposed as the library's subagent parentRunId.

## Lossless usage and safe errors

AgentTurn gains nullable usage (JSON) and errorMessage (string). usage preserves
the library's complete validated TokenUsage snapshot, including cache/reasoning
and provider cost details. The existing numeric counters are updated atomically
as materialized accounting fields on the same run, not a second usage ledger.
Rows without a canonical snapshot retain nonzero legacy counter data. With
null usage and zero counters, usage is absent: missing reporting is never
fabricated as a provider report of zero, and explicit undefined clears it. JSON is validated on both write and reload, and numeric counters are
bounded to PostgreSQL integers.

errorCode remains the machine classification. errorMessage contains only the
server error projector's safe sentence; raw vendor transport/prose never enters
the production projector. The generic adapter requires that projector and does
not assume a library RunError has already been normalized. Synthetic conformance
errors are known fixture values, so the exact RunError contract can be tested
without weakening production normalization. Missing versus explicit undefined
on mutable optional fields remains distinct; explicit undefined clears a field.

## Terminal transaction boundary

The installed persistence middleware writes interrupted run status before
flushing its transcript; on completion it flushes the transcript and commits
resumed decisions before closing the run. These writes must share an owned
transaction in the production composition. A private transaction context lets
the adapter's writes join that transaction; it is never client state and cannot
be used across a provider call. Begin verifies the strict live lease. Its
closing phase permits only that captured worker to flush the selected outcome,
then clears active key and lease fields before commit. A cancelled worker may
flush only its owned abort; a replaced worker cannot enter the boundary.

A failure rolls back the whole transcript/run/decision boundary. The backend
must await its commit before publishing a terminal. Error/checkpoint failures
still prevent a completed run despite isolated library hooks. Restart and event
closure integration must be proven before activation. The exact native
interrupt/private proposal mapping remains a separate ratification before its
schema implementation; no duplicate approval ledger is permitted.

## Acceptance for this slice

Run the installed conformance cases with declared omissions, including current
run state on listByThread. Add real PostgreSQL ownership, ID collision,
concurrent insert, unknown update, transactional authority failure and safe
production projection cases. Retain D-177 stale-writer tests. Complete the
migration drift check, R7 audit and repository gate. The overall task remains
in progress until native interrupt mapping, atomic whole-batch admission,
restored policy plans and real process crash/uncertain-dispatch cases also pass.
