# MOD-AI-06 — Owned persistence boundaries

The installed middleware's pause ordering is commit resumed decisions, create
new interrupts, mark the run interrupted, then save the transcript. Completion
saves the transcript, commits resumed decisions, then closes the run. A strict
running-only lease check on every independent store call cannot support the
pause ordering and exposes partial state. These calls must share one transaction.

A server-created boundary captures one immutable RunLease. It locks the owned
bot, TANSTACK conversation and current run in that order and verifies a live
lease using PostgreSQL time. An abort boundary alone may acknowledge durable
cancel intent. The same transaction client is carried in a private per-instance
async context; stores join it only while the awaited callback is open. Nested
boundaries are refused. The client/context cannot be used after callback return,
commit or rollback, including callbacks inheriting its async context.

Inside the boundary, a write proves the captured principal, bot, thread, run,
worker and epoch. A running row retains its active key; the selected closed
status may clear that key without revoking the captured worker's final flush.
Another status, epoch change, cancellation erasure, foreign run or transaction
client is refused. The finalizer requires the selected status and live captured
producer, clears activeKey/workerId/leaseExpiresAt/detachedSince atomically, and
preserves driverEpoch for audit and stale-writer refusal. An interrupted run has
no endedAt; completed/failed/aborted runs have one. A failed operation or finalizer
rolls back every participating store write, including the status change.

Transactions are short database-only operations. Model generation, tool dispatch,
Chrome reset and event delivery stay outside. Terminal delivery must await a
successful boundary; middleware errors remain errors even when the engine
isolates terminal hooks. A checkpoint/closing failure may close as failed only
in a new owned failure boundary after rollback. Loss of ownership prevents even
that failure write. Intermediate checkpoints remain fenced; durable native
interrupts and checkpoints must use the same transaction composition when added.

Parking calls releaseForApproval after persistence commits. It releases supported
action/execution admission and stops work time. It preserves Chrome's generation
and the named-profile reservation (D-173), so an answer can validate its original
binding. Explicit release/shutdown/teardown is different lifecycle work and may
close Chrome; old approvals then fail closed and require a fresh observation and
proposal. No approval memory or edited answer renews an obsolete generation.

Acceptance: real PostgreSQL proves interrupted-status-before-transcript ordering,
completion, rollback after each boundary stage, cancellation/abort, expiry and
takeover, cross-run authority refusal, finalizer refusal and inherited callback
closure. Exercise the installed middleware rather than a copied call sequence.
Keep the overall task in progress until native interrupt/private proposal mapping,
whole-batch answer admission, restored plans and real process crash/uncertainty
acceptance are complete. This boundary adds no route, switch or second ledger.
