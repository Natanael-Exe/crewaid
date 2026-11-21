# MOD-AI-06 — durable run ownership

D-177 ratifies this first implementation boundary. The task remains in progress
until the complete run/interrupt stores, atomic answers, restart reconstruction,
uncertain-dispatch handling and conformance gates pass. This document does not
activate the controlled TanStack backend or claim those later pieces are done.

## Ownership

`AgentTurn` gains nullable `workerId` and `leaseExpiresAt`, with an expiry-scan
index on `(status, leaseExpiresAt)`. These are server-only ownership fields.
`workerId` is an opaque UUID minted for each producer claim, including claims in
the same process. A repeated delivery joins the durable run; it cannot create a
second producer merely because it landed on the same host. `driverEpoch` is the
monotonically increasing fencing token, retained after release.

The lease is 30 seconds; renewal is every 10 seconds. These are named server
constants, with shorter constructor timing inputs only for controlled tests.
No deployment configuration key or client field is added. PostgreSQL's clock
sets and checks expiry; a worker clock cannot extend its own expired authority.
Renewal must finish before expiry, and cannot revive a lease after it expires.
The heartbeat does not overlap renewals and stops on release or ownership loss.
It signals the producer to cancel when renewal loses its fence or fails.

One `activeKey` per bot remains the simultaneous-producer constraint. Claiming
locks the owned bot, then its owned TANSTACK conversation, then the run. A newly
inserted run uses an already-admitted, owned user-role trigger. Client history
and SDK types are absent from this boundary. The uniqueness constraint remains
the final fence against a concurrent legacy producer. A running legacy run with
no lease is busy; a new worker may not declare it expired.

A claim of a healthy running run returns `joined`. Interrupted and terminal
runs return their saved state and grant no producer lease. A pause releases its
active key and lease; its typed approval survives in `RunInterrupt` and a
continuation has a fresh run ID linked by `resumesRunId` (D-160). New message and
resume admission remain distinct server operations; this claim helper does not
authorize a client resume or bypass pending-interrupt validation.

A claim of expired running ownership increments the epoch atomically and returns
a recovery marker. The new producer must inspect durable checkpoints, proposals
and dispatch outcomes before continuing. Claiming is not permission to repeat
an external action. The remaining MOD-AI-06 code blocks uncertain dispatch;
MOD-DU-02 owns provider receipt reconciliation and the complete effect ledger.

## Every writer uses the same fence

The server-owned lease carries owner/bot/thread/run/worker/epoch. Store writes
check ownership, a `running` status, worker and epoch equality, the active key
and an unexpired lease in the same transaction as the write. An earlier
successful check is insufficient. The transcript store gains an optional
transaction fence for the controlled backend composition; that composition
must supply it for leased production runs. The legacy path has no lease and
remains isolated until MOD-AI-15 removes it.

Heartbeat, cancellation, checkpoints, event appends, policy admission and
terminal updates use the captured lease or their separately ratified operator
authority. A replaced worker cannot clear the winner's active key or finish its
run. Terminal completion/failure/abort atomically clears the active key and
both lease fields. An interrupted pause clears those fields without setting a
terminal `endedAt`. Explicit release makes a still-running lease expire; it
does not pretend that the run completed.

Startup's historical blanket recovery is restricted to AI_SDK conversations.
It cannot fail healthy or parked TANSTACK runs. The new recovery scan only
selects running TANSTACK records with a set, expired lease and remains bounded.
Its server batch constant is 100; smaller test batches are allowed. It only
returns owned serializable IDs for internal lifecycle discovery and grants no
producer authority. Candidates must pass the same scoped claim and recovery
admission before any work; malformed/unleased legacy records are not reclaimed.
The recovery coordinator, which reconstructs runtime clients from owned IDs,
supplies the actual restart behavior; an application boot never kills another
healthy producer.

## Acceptance to complete the task

Real PostgreSQL tests must cover owned/foreign triggers and threads, engine
refusal, healthy duplicate delivery, concurrent claims, expiry/takeover,
renewal after expiry, stale writes/finish/release, cancellation and approval
pauses. Real process crash tests must also cover approval answered after restart,
partial/foreign/stale batches that write nothing, receipt loss and uncertain
effects that never dispatch again automatically. Run and interrupt stores must
pass the installed library conformance suite with every omission named.

The remaining interrupt integration must attach the native library request and
answer to the existing policy proposal row. It cannot create a second approval
ledger. The exact field mapping and atomic accepted-versus-consumed boundary
will be ratified before that schema or code changes.
