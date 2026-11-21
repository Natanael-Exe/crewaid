# MOD-DU-01 — Execution durability selection

Decision: use TanStack persistence with the existing Prisma/PostgreSQL domain
records and scoped lease/epoch ownership. Keep BullMQ for scheduling and delivery.
Do not add DBOS or Temporal to the production dependency graph for this migration.
D-171 records the contract. MOD-AI-06 and MOD-DU-02 implement it; this evaluation
does not mark their production recovery work complete.

## Executable comparison

`tools/prototypes/mod-du-01` runs the same native TanStack `chat()` flow twice.
Both variants use PostgreSQL-backed message, run and interrupt stores through
`withPersistence`. The model is scripted; it requests one reviewed external
action, pauses through `defineInterrupt`, then continues through the library.
The provider is an independent loopback HTTP fixture with durable receipts.

The PostgreSQL driver discovers saved state and the approval answer, then resumes
under a fresh lease. The DBOS driver wraps the initial run and continuation in
steps, waits through `recv` and restores the workflow after a process crash. DBOS
notifications only wake it; the database owns the approval. The two variants share
the same ownership, policy, effect reservation and receipt reconciliation code.
They persist JSON IDs/state and reconstruct model/provider clients in each worker.

The fixture uses a small generic JSON store rather than the product's Prisma
schema. It is outside the application workspaces, has an independent exact lockfile
and installs candidate dependencies only for evaluation. Its full-replace message
store proves the library contract; it does not supersede D-165's product message
reconciliation or introduce a second Prisma client.

| Failure or delivery boundary | PostgreSQL | DBOS | Required invariant |
| --- | --- | --- | --- |
| Producer killed while approval is pending; answer submitted after death | Passed | Passed | Saved approval resumes without a live process or client connection. |
| Provider commits, producer dies before receiving the response | Passed | Passed | Query the receipt; exactly one POST in this fixture. |
| Response arrives, producer dies before recording the local outcome/checkpoint | Passed | Passed | Reconcile the receipt before attempting another dispatch. |
| Provider committed but has no receipt API | Passed | Passed | Record `uncertain`; do not automatically POST again. |
| Healthy duplicate, then suspended owner expires and resumes after replacement | Passed | Passed | Refuse healthy takeover, fence old writes/dispatch and preserve the winner's completed state. |
| Completed job delivered again; duplicate DBOS notification/workflow ID | Passed | Passed | Rejoin completed state without another provider POST. |
| Foreign tenant reads the same thread ID | Passed | Passed | No transcript is visible in the foreign scope. |

Five crash scenarios per engine passed. The supplied TanStack persistence
conformance suite passed 27 tests, with one explicitly omitted metadata-store
case. The chat-only fixture excludes generation/media stores. Evidence lives in
`docs/reviews/evidence/mod-du-01/proof.json`; the README provides reproducible
commands. The SIGKILL/SIGSTOP boundaries are actual child-process failures, not
exceptions substituted for a restart. The stale process reports a failed epoch
check before it can write or dispatch. A DBOS handle may subsequently read the
winning executor's result; that read grants no authority to its old step.

## What the engine removes, and what remains

DBOS records completed step outputs and deduplicates workflow IDs. Workflow inputs
must be serializable and replay must invoke steps in a deterministic order;
database/API operations and client reconstruction belong inside steps. An
incomplete external step can execute again after recovery. These are useful
workflow guarantees, but require an idempotent or reconcilable external action.
[DBOS workflows](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial),
[DBOS architecture](https://docs.dbos.dev/architecture).

In this fixture the PostgreSQL worker's orchestration branch is four lines plus
the approval polling helper. DBOS removes that polling and adds the registered
step sequence, notification delivery, launch/shutdown, application version and
executor identity. About 470 lines of shared fixture store, model, approval,
ownership and effect logic remain in both variants. Those lines are not a forecast
of production code size: much is fixture plumbing, and the product already owns
the message adapter. The important measured result is that neither engine removes
the common safety/reconciliation work or the pause/resume idempotence guards.

DBOS also creates its own system journal tables, in addition to product run and
interrupt state; the evidence records the observed table inventory. It requires
schema migration privileges or a separate migration step, pool budgeting, worker
identity/recovery management, and deterministic versioned workflow deployment.
Automatic recovery in the tested local setup reused the identity of a known dead
executor. It is not proof that it is safe to reuse a healthy executor's ID or to
recover every worker on application startup.

Notifications are durable and can be deduplicated by their idempotency key.
They are useful wakeups, while PostgreSQL remains the approval authority.
[DBOS workflow communication](https://docs.dbos.dev/typescript/tutorials/workflow-communication).
The prototype deliberately keeps answer persistence and notification separate:
a crash between them needs a retry/outbox. DBOS's `sendInTransaction` accepts a
raw `pg` transaction on its system database, not a Prisma transaction object;
adopting it here would require an explicit integration decision or retain an
outbox. No such second database access path is installed in the product.
[DBOS client transaction API](https://docs.dbos.dev/typescript/reference/client).

For this migration the existing TanStack run/interrupt records already supply
the state to resume. Adding a workflow journal did not eliminate enough recovery
code to offset two lifecycle representations and another operational contract.
DBOS is a viable candidate for a future separately scoped multistep workflow if
that requirement demonstrates a benefit; it is rejected for this migration, not
claimed to be an unsuitable library in general. Temporal was not prototyped:
this flow passed without a separate workflow platform, and no additional required
feature justified another candidate or two engine installations.

## Obligations for the selected production implementation

- **MOD-AI-06:** implement the complete TanStack run/interrupt store contracts and
  conformance tests with the existing Prisma client. Claim the bot/conversation
  under the D-168 conversation lock, allocate a fresh `driverEpoch`, persist owner
  and lease state, and reject writes from an expired/replaced owner. Reconstruct
  runtime clients from owned IDs. Use insert-if-absent run creation and an atomic
  validated interrupt batch; paused runs do not fence the bot as running work.
- **MOD-AI-06/MOD-DU-02:** recover only expired ownership. Healthy work is never
  interrupted by global startup cleanup. Duplicate BullMQ deliveries join durable
  state. Heartbeats, cancellation and release use owner+epoch predicates. Lock
  helpers can coordinate, but a lock alone never authorizes a stale writer.
- **MOD-SE-02/MOD-DU-02:** approvals retain the approved argument/resource revision.
  Dispatch rechecks ownership, grants, seat generation and policy after waits.
  The fixture approval is artificial; it is not a shortcut around the ratified
  production approval binding or the bridge's independent control fence.
- **MOD-DU-02:** ratify the exact effect ledger schema before its migration. Reserve
  an operation identity before dispatch, persist confirmed receipts/results and
  expose uncertain outcomes. After an incomplete dispatch, use a supported
  provider idempotency key or read-only reconciliation. An absent/unavailable
  receipt is not proof that nothing happened. Unknown GUI/MCP writes require
  manual resolution rather than another click/send. Product database operations
  may have transactional guarantees; arbitrary remote writes do not.
- **MOD-AI-07/11:** event replay never starts a producer or bills again. Model
  inference that was in flight at a crash can already have incurred usage; this
  fixture proves no exactly-once provider billing. Reservation/settlement and
  resumed inference accounting retain their task ownership.
- **MOD-DOC-01/QA-01 and M9-BE-05:** carry the selected ownership/effect contract into
  fresh setup, cleanup/retention, backup/restore and broader real-provider faults.
  No historical customer migration or deployment rollback deliverable is needed.

## Limits

This is correctness evidence for one action workflow on local PostgreSQL 16,
Node 24 and the exact pinned packages. Elapsed durations include subprocess startup,
polling and deliberately expired two-second leases; they are not product latency
or throughput benchmarks. No hosted network, real model, browser commit adapter,
real provider idempotency contract, complete production reaper or all-provider
commercial recovery was tested. The DBOS fixture emitted a `pg` concurrent-query
deprecation warning; no future-major compatibility is claimed. The candidate
lockfile uses `pg` 8.23.0 and no runtime dependency was changed.
