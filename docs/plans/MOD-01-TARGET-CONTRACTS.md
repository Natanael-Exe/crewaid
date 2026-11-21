# MOD-01 — Target contracts for the architecture modernization

Ratified by **D-159** on 3 October 2026, from `main` at `1570abd`. It turns D-158's direction into the
contracts the later MOD tasks code against. `tasks.json` stays the authority on status and
prerequisites; [the handoff](ARCHITECTURE-MODERNIZATION-2026-10-03.md) stays the authority on each
task's scope. Where this document and an older decision disagree, D-159 says which one wins.

Package facts below were read from the published tarballs, not from memory: `@tanstack/ai@0.64.0`,
`@tanstack/ai-client@0.36.1`, `@tanstack/ai-react@0.29.4`, `@tanstack/ai-persistence@0.7.2`,
`@tanstack/ai-compaction@0.1.12`, `@tanstack/ai-mcp@0.7.0`, `@tanstack/ai-openai@0.26.0`,
`@tanstack/ai-anthropic@0.19.4`, `@tanstack/ai-openrouter@0.20.2` and `@ag-ui/core@1.0.1`. Versions
are a snapshot; MOD-02 picks and pins the set it proves together.

## 1. What this ratifies, and what it hands on

MOD-01 fixes the names and boundaries that several tasks share: identities, routes, event
vocabulary, table names, the authority of each store, guard changes, the reset procedure, where
evidence goes and how budgets are set. Column lists, payload fields and numeric limits belong to the
task that writes the code that reads them, and the delegation table in §8 says which task that is.
A later task may refine anything here **only** by adding a decision; nothing in this document is a
default to drift from silently.

Nothing here is implemented by this change. No dependency is added, no schema migrates, no database
is reset.

## 2. Inventory of the current stack

### 2.1 Inference and model consumers

Every production import of `ai`, `@ai-sdk/*` and `@openrouter/ai-sdk-provider`, as found by an import
scan of `apps/` and `packages/` (tests excluded; 73 test files and helpers also import these and move
with their subject). The desktop imports none of them today.

| File (`apps/orchestrator/src/…`) | Imports | Role today | Target owner |
| --- | --- | --- | --- |
| `agent/turn-runner.ts` | `ToolLoopAgent`, `pruneMessages`, stream/step types | the agent loop, trimming, checkpoints, usage folding | MOD-AI-05 (loop), MOD-AI-10 (trim → compaction) |
| `agent/execution/execution-backend.port.ts` | `ModelMessage`, `ToolSet` types | D-087 execution seam | MOD-AI-05 (port reshaped, §3.11) |
| `agent/execution/ai-sdk-execution-backend.ts` | via runner | the only backend | MOD-AI-05 replaces, MOD-AI-15 deletes |
| `agent/agent-turn.service.ts` | `ModelMessage` type | turn coordinator, approvals map, recovery | MOD-AI-05/06 |
| `agent/tool-approval.ts` | `ModelMessage` type | approval decision + response messages | MOD-AI-02, MOD-SE-02 |
| `agent/tool-registry.ts`, `agent/tool-result-projection.ts` | `Tool`, `ToolSet` types | registry, result projection | MOD-AI-02 |
| `agent/trigger-content.ts` | `ModelMessage` type | trigger + attachment parts | MOD-AI-03 |
| `agent/{board,bot,browser,computer,identity,machine,memory,skill,skill-authoring}-tools.ts`, `interbot/send-message.tool.ts`, `routines/routine-tools.ts`, `work/work-tools.ts` | `tool` | built-in tool definitions | MOD-AI-02 |
| `mcp/mcp-connection.ts`, `mcp-transport.ts`, `mcp-tools.ts`, `mcp-servers.service.ts`, `mcp-tool-binding.ts`, `mcp-indirect-tools.ts` | `@ai-sdk/mcp`, `tool`, `jsonSchema` | MCP client, D-113 bridge | MOD-AI-09 |
| `models/provider-factory.ts` | `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`, `@openrouter/ai-sdk-provider` | provider construction, D-085 custom endpoints | MOD-AI-01 |
| `models/model-resolution.service.ts`, `models/included-models.port.ts` | `LanguageModel` type | D-086 owner-scoped resolution | MOD-AI-01 |
| `models/normalize-error.ts` | `APICallError`, `RetryError`, … | D-006 error vocabulary | MOD-AI-01 |
| `billing/included-models.service.ts` | `wrapLanguageModel`, `@openrouter/ai-sdk-provider` | D-157 reserve/settle per call | MOD-AI-11 |
| `memory/memory-distill.service.ts` | `generateText` | memory distillation | MOD-AI-12 |
| `skills/skill-compile.service.ts`, `skills/skill-revise.service.ts` | `generateText` | skill compile/revise | MOD-AI-12 |
| `telemetry/ai-telemetry.ts` | `LanguageModelUsage`, `Telemetry` | CC-03/04 usage and telemetry | MOD-AI-11 |

`packages/sandbox-core/src/types.ts` imports `@ai-sdk/harness`. That is the computer-provider seam,
not inference, and **stays** (D-158); MOD-AI-15 must not remove it by name association.

### 2.2 Where a turn starts

Every path below ends in `AgentTurnService.startTurn` today and must reach the one target execution
path (MOD-AI-05) and the one recovery authority (MOD-DU-02):

| Entry point | Trigger |
| --- | --- |
| `messages/messages.controller.ts` | operator message, `POST /bots/:id/messages` |
| `interbot/bot-message.delivery.service.ts` | `send_message` delivery (BullMQ `BOT_MESSAGE_JOB`), chains |
| `routines/routine-runner.service.ts` | routine firing (BullMQ `ROUTINE_JOB`) |
| `work/task-start.service.ts` | Work Start brief (D-135) |
| `AgentTurnService.continueAfterLimit` | M5-BE-19 continuation after a limit stop |
| `AgentTurnService.answerMessageThatArrivedDuringTurn` | M5-BE-16 deferred message |
| `ws/ws.gateway.ts`, `agent/approvals.controller.ts` | approval answers resuming a parked turn |
| `main.ts` → `recoverInterruptedTurns` | boot sweep marking RUNNING turns INTERRUPTED (R9, D-032) |

### 2.3 The §4.2 socket, frame by frame

| Frame | Direction | Target |
| --- | --- | --- |
| `message.delta`, `message.part`, `message.completed`, `turn.step` | S→C | **Removed.** Carried by AG-UI events on the conversation stream (§3.2). `turn.step` has no renderer surface today and is not replaced. |
| `approval.requested` | S→C | **Removed.** `RUN_FINISHED` with an `interrupt` outcome plus the hydrate response (§3.6). |
| `approval.respond` | C→S | **Removed.** `RunAgentInput.resume` on the run route (§3.6). |
| `message.attachments` | S→C | **Removed.** `CUSTOM` event `crewaid.message.attachments` on the conversation stream. |
| `message.created` | S→C | **Kept, narrowed** to messages written outside a run: SYSTEM notices, `/new` boundaries, chain deliveries the window did not send. |
| `message.deleted` | S→C | Kept (D-147). |
| `bot.cancel` | C→S | Kept; becomes a durable cancel request (§3.9). |
| `bot.status`, `bots.changed`, `sandbox.state`, `recording.event`, `recording.state`, `skill.compiled`, `mcp.status`, `usage.notice`, `task.changed`, `project.changed`, `goal.changed`, `deliverable.changed`, `error` | S→C | Kept as product notifications. |
| `screen.subscribe`, `screen.unsubscribe`, binary `screen.frame`, `screen.input` | both | Kept unchanged until MOD-SC-03 ratifies the selected transport; never moved onto the conversation stream. |
| **`run.started`** (new) | S→C | Tells every window a run began on a bot's thread, so a mounted chat joins it (§3.8). |

### 2.4 REST routes the migration changes

| Route | Target |
| --- | --- |
| `POST /bots/:id/messages` | **Replaced** by `POST /bots/:id/chat` (§3.2). |
| `GET /bots/:id/messages` | **Replaced** by the hydrate form of `GET /bots/:id/chat` (§3.2). |
| `GET /bots/:id/approvals` | **Removed.** Pending interrupts arrive in the hydrate response; D-067 is superseded. |
| `DELETE /bots/:id/messages`, `DELETE /bots/:id/messages/:messageId`, `POST /bots/:id/topics`, `POST /bots/:id/read` | Kept, with the run-state rule in §3.10. |
| `GET /bots/:id/turns` | Kept; reads the run store (§3.5). |
| `POST /attachments`, `GET /attachments/:id` | Kept. Upload-then-claim (D-019/D-021) is unchanged; claiming moves to run admission (§3.3). |

### 2.5 Shared schemas the migration changes

`packages/shared/src/ws.ts` (the removed frames above; `run.started` added; `WIRE_VERSION` 1 → 2),
`models.ts` (`MessageSchema.parts`, `AgentTurnSchema` statuses, `messageId` no longer `CuidSchema`
where it carries a stream message id), `rest.ts` (`SendMessageBodySchema`, `ListMessagesQuery/Response`,
`ListApprovalsResponseSchema`, `TurnSummarySchema`). Every exported schema keeps its valid/invalid
fixture pair (`schemas.test.ts`). AG-UI and TanStack types are **not** re-declared in shared: shared
stays Zod-only (M0-04), and the conversation stream is validated by the library's own
`RunAgentInputSchema` server-side and by the client library on receipt.

### 2.6 Persistence the migration changes

`Message` (`parts`, ordering, product columns), `AgentTurn` (status vocabulary, ownership fencing,
links), `Conversation` (unchanged identity, now the thread), `Attachment` (claim at admission),
`Memory.messageId`, `Deliverable.messageId`, `TaskEvent.messageId` (relations that must survive
reconciliation), `UsageLedger`/`ModelCharge` (D-157 settlement keyed to runs). Two new tables (§3.6,
§3.7).

### 2.7 Policies

Auto-review rules (`Bot.autoReviewRules`, D-050, D-064), approval mode (`Bot.approvalMode`, D-144),
per-turn approval memory (D-065), contained versus external tools (D-092), MCP approval as the M5
matcher (D-108), read-only unwrapping behind the bridge (D-107), limits that are the operator's
(D-047, D-052, D-072).

### 2.8 Provider seams

Owner-scoped resolution (D-086) through `ModelResolutionService`; `Bot.modelId` as a `ProviderModel`
id or `default`; custom endpoints admitted twice and never to a private address (D-085); encrypted
BYOK under the credential keyring; the D-006 error vocabulary (`normalize-error.ts`); CC-11 prompt
caching with the memory block last (D-094); D-157 included models registered only on `cloud`.

### 2.9 Guards that move

R1 (desktop bans `ai`, `@ai-sdk/*`), M0-04 (shared bans `ai`, `@ai-sdk/*`), M2-BE-02 (one file names
`@ai-sdk/harness`), R10 (MCP clients never in sandbox packages), R7/D-010 (`prisma-allowlist.test.ts`),
D-026 (`ownership-route-coverage.test.ts`), §4.2 both-direction validation (`TurnEventBus`, `WsClient`),
`schema-contract.test.ts`, `check-pins.mjs`, and D-013 probes for each.

## 3. The ratified target contracts

### 3.1 Identity

| AG-UI / TanStack concept | Crewaid record | Rule |
| --- | --- | --- |
| `threadId` | `Conversation.id` | One thread per bot, as today. A request's `threadId` must equal the bot's conversation id or the request is refused `404`. |
| `runId` | `AgentTurn.id` | **The client's proposed id, insert-if-absent (D-160).** An id that already names a run on another thread is refused `409`; a repeat on the same thread is a double-submit and joins the first run. *Superseded: "minted by the server" — the stock client never adopts a server id, and its approvals then never submit.* |
| message `id` | `Message.id` | A new user message keeps the id the client proposed when it is well formed (1–64 of `[A-Za-z0-9_-]`) and absent; an id already stored on this thread with the same content is a duplicate submit; any other collision is refused `409` without saying where the id exists. Assistant and tool message ids are minted server-side by the run. |
| `interruptId` | `RunInterrupt.id` | Minted server-side; never derived from a tool-call id alone. |
| `toolCallId` | the provider's id | Unchanged; unique within its run, not globally. |

Ids stay opaque strings on the wire. Ownership is always derived from the bot's owner, never from
possession of an id (D-010).

### 3.2 Conversation delivery

One route family per bot, all behind `AuthGuard` and an `@OwnedResource('bot', 'id')` marker:

| Route | Purpose | Notes |
| --- | --- | --- |
| `POST /bots/:id/chat` | Start a run or resume an interrupted one. Body: AG-UI `RunAgentInput`. Response: a durable SSE stream of AG-UI events, offset-tagged. | Parsed with the library's `chatParamsFromRequestBody`; admission rules in §3.3. |
| `GET /bots/:id/chat?threadId=…[&limit&before]` | Hydrate: stored transcript window, `activeRun`, pending `interrupts`, `page`. | Shape is the client library's `ChatHydrationResult`. Built with `reconstructChat` and an `authorize` callback, plus the out-of-run product rows (§3.4). |
| `GET /bots/:id/chat?runId=…&offset=…` (or `Last-Event-ID`) | Join or resume one run's event log: replay strictly after the offset, then tail. | Read-only; never starts a producer, never bills. A run id that is not on this bot's thread is `404`. |

This is the request shape `fetchServerSentEvents(url)` speaks, so the renderer uses the stock
connection adapter rather than a custom one. Bearer credentials go in the `Authorization` header from
the CC-07 bag, exactly as `ApiClient` sends them; there is no query-string token on these routes.
SSE responses set `X-Accel-Buffering: no`.

Background runs (routines, chains, Work starts, continuations, deferred messages) have no request to
answer. They write the same event log, and the run is discovered through `run.started` (§3.8) or the
hydrate response's `activeRun`.

The supported AG-UI version is the one `@tanstack/ai` pins exactly (`@ag-ui/core` `1.0.0`, protocol
`1.0` at this snapshot). A client and server built from different MOD versions are not supported;
the desktop refuses a server whose `WIRE_VERSION` it does not know (§3.8).

### 3.3 Admission: the server owns history

`withPersistence` merges a non-empty `messages` list into the stored thread by id, and the last
incoming id that is already stored becomes a cutoff after which stored messages are dropped. A client
that sends a stale or shortened transcript would therefore truncate the server's. The route closes
that before the library sees the body:

1. Messages whose id is already stored are ignored. They never override, reorder or cut the stored
   thread.
2. New messages must all be `role: 'user'`; an assistant, tool or system message from a client is
   refused `400`.
3. A body with no new user message and no `resume` is refused `400`. Regenerate and edit are not
   supported by this migration; adding them needs its own decision.
4. The new user message is persisted, with its attachments claimed (`forwardedProps.attachmentIds`),
   **before** the run starts, in one transaction. The run is then started with an empty `messages`
   list, so the library loads the server copy.
5. `forwardedProps` is allow-listed to `attachmentIds` only. `tools` (client-declared tools),
   `context` and `state` grant nothing and are refused `400` when non-empty; a later decision may
   admit display-only client tools.
6. A thread with a `running` run or pending interrupts (D-160) refuses a new user message `409`
   unless it is a `resume` for those interrupts. The existing M5-BE-16 behaviour (a message that arrives during a turn is
   answered after it) moves server-side: the message is stored and queued for the next run, and the
   `409` is reserved for a client that tries to start a second concurrent run itself.

### 3.4 The canonical transcript

- **One row per model message.** The thread's canonical list is TanStack `ModelMessage[]`
  (`user`, `assistant`, `tool`), one `Message` row each, with the message id as the row id and an
  explicit per-thread sequence for order. A BOT turn becomes its assistant and tool rows, linked to
  the run. The sequence is reserved when a message begins, not when it is saved, so a user message
  admitted while a reply is streaming sorts after that reply's earlier rows. MOD-AI-03 writes the
  columns.
- **Product rows are not model messages.** `ModelMessage` has no `system` role. SYSTEM notices and
  `/new` boundaries stay `Message` rows that `loadThread` does not return and the model never sees;
  hydrate merges them into the UI list as `role: 'system'` UI messages.
- **Product facts are columns, projected on read.** `taskId`, `routineId`, `chainId`, `hopCount`,
  `startsTopic`, sender bot, attachments and read state live in columns and relations and are
  projected into `metadata.crewaid` when a message is sent to a client. Client-supplied `metadata`
  is never stored.
- **Attachments are references.** A user row stores attachment ids. The bytes are turned into image
  or document parts for the model at call time, with the vision check, as
  `AttachmentsService.forModel` does now. No attachment bytes enter the transcript or the event log.
- **`loadThread` returns the whole canonical thread.** The `/new` boundary (D-147), the history
  budget (`AGENT_HISTORY_MESSAGES`, `AGENT_HISTORY_CHARS`) and compaction (MOD-AI-10) are
  transformations of the **provider input**, applied in middleware, never storage windows. A store
  that returned a window would let a full-replace save delete what it did not load, and it would fail
  the conformance suite.
- **`saveThread` reconciles; it never deletes.** It inserts new ids and updates changed rows by id
  inside one transaction. A stored id missing from the incoming list is kept and logged as a contract
  violation. Rows leave a thread only through the D-147 routes.
- **No casts across the Prisma boundary.** Rows become `ModelMessage` through one validating mapper.

### 3.5 Runs

`AgentTurn` is the TanStack `RunStore`. Its status vocabulary becomes the library's, so nothing
translates on the way through:

| Library `RunStatus` | Meaning | Replaces |
| --- | --- | --- |
| `running` | owned by a live worker | `RUNNING` |
| `interrupted` | waiting for a person (an approval); **not** terminal | `AWAITING_APPROVAL` |
| `completed` | finished | `SUCCEEDED` |
| `failed` | finished with an error; the D-006 code is stored beside the message | `FAILED`, and today's crash-time `INTERRUPTED` (code `WORKER_LOST`) |
| `aborted` | an explicit cancel | `CANCELLED` |

Today's `INTERRUPTED` means "the process died", which is the opposite of the library's
`interrupted`. The old name is retired rather than reused. Whether a run whose worker died is failed
or recovered is MOD-DU-02's to decide; until then it is `failed` with `WORKER_LOST`.

`createOrResume` is insert-if-absent. `update` on an unknown run is a no-op. The fencing fields
(`driverEpoch`, `cancelRequested`, `detachedSince`, `sandboxKey`) round-trip with "never set" kept
distinct from `false`/`0`. The nullable unique `activeKey` stays, covering `running` runs only
(D-160): a continuation is a new run with no parent link and the paused run stays `interrupted`, so
a fence over non-terminal runs would refuse every resume. The admitting route records which paused
run a resume answered.

### 3.6 Interrupts and approvals

- **Durable.** A new table, `RunInterrupt`, implements the library's `InterruptStore`, with
  `commitBatch` so a resume batch applies all-or-nothing. **D-067 is superseded**: a pending approval
  is a row, and it survives a restart.
- **Policy decides per call.** The library's `needsApproval` is a static boolean on a tool
  definition; Crewaid's decision depends on the call's arguments, the bot's rules, its approval mode
  and the turn's memory. The decision therefore lives in middleware: `onInterruptBoundary` at
  `beforeTools` asks for the calls the policy says to ask about, as one batch, and `onBeforeToolCall`
  re-checks every call immediately before dispatch, returning `skip` (denied) or `transformArgs`
  (edited arguments). The re-check is what MOD-SE-02 hardens; a stored approval never authorizes a
  call whose arguments, destination or grants changed after it was given.
- **Interrupt name.** One generic interrupt definition, id `crewaid.tool-approval`, with a Zod
  payload and response. MOD-AI-02 writes the schemas; MOD-SE-01 decides the fields that bind an
  approval to a revision.
- **On the wire.** A pause is `RUN_FINISHED` with outcome `interrupt`; an answer is
  `RunAgentInput.resume` (`interruptId`, `status`, `payload`) on `POST /bots/:id/chat`. A forged,
  foreign, stale or partial batch consumes nothing.

### 3.7 The delivery log

- **Postgres is the log of record.** A new table, `RunEvent`, holds every AG-UI event a run emits,
  in order, keyed to its run and thread. It implements the library's `StreamDurability` (append,
  read after offset, snapshot, close), and `UpsertableStreamDurability` if MOD-DU-02 needs to
  re-derive offsets after a crash. The offset is a per-thread sequence, so a reader can also tail a
  thread across runs.
- **Redis carries wake-ups, never content.** Live tailing across workers may use Redis pub/sub to
  say "thread T has events after N". Event content is never published or cached there, which keeps
  CC-74 (encryption) and CC-75 (region) to one store.
- **Replay is not execution.** Reading the log never starts a producer, never calls a provider and
  never writes a charge.
- **Bounded.** Events for terminal runs are deleted after a retention period that MOD-AI-07
  ratifies. Clearing a conversation or deleting a message (D-147) deletes the matching events in the
  same transaction, so a deleted message cannot be replayed.

### 3.8 The product notification channel

The §4.2 socket stays the account-scoped channel for product state (§2.3), with D-149's rule that a
frame goes only to the account it belongs to and a socket stops receiving when its session ends.

- **`run.started`** `{ botId, threadId, runId }`, emitted once when a run is created, whatever started
  it. A window with that bot's chat mounted joins the run (§7 item 2 records the client mechanism
  MOD-02 must prove).
- **`WIRE_VERSION` becomes 2** in the change that removes the conversation frames. No v1 reader is
  kept; the desktop shows "update required" against a server it cannot read.

### 3.9 Cancellation

`bot.cancel` stays the command. It records durable cancel intent on the bot's non-terminal run
(`cancelRequested`, the library's `requestRunCancel`) and aborts it in-process when this worker owns
it. A client closing its stream, including the library client's `stop()` on a fetch, is a disconnect,
not a cancel: the run keeps going and its log keeps every event.

### 3.10 Clear, delete, topic and read races

D-147's three routes and `POST /bots/:id/read` keep their shapes. While the bot's thread has a run
in `running`, or has pending interrupts (D-160), clear, delete and `/new` are refused `409`
(`RUN_ACTIVE`) as D-147 already does for `RUNNING`; the operator cancels first. A clear deletes the thread's rows, its
`RunEvent` rows and its pending `RunInterrupt` rows in one transaction, honours the existing
"Also forget" memory choice and keeps deliverables (D-147). Read markers stay on `Conversation`.

### 3.11 The execution port

`ExecutionBackend` (D-087) stays the seam and keeps its capability flags. What crosses it changes:
no `ModelMessage` or `ToolSet` from any SDK, and no TanStack type either. The request carries the
thread and run references and Crewaid's neutral tool registrations (Zod schemas plus an executor);
the backend owns adapters, middleware and stores. Ports for persistence and frames are replaced by
the run store and the event log. MOD-AI-05 writes the types.

### 3.12 Package boundaries and guards

| Rule | Target |
| --- | --- |
| R1, desktop | May import `@tanstack/ai-react`, `@tanstack/ai-client`, `streamdown`, and `@tanstack/ai` **as types only**. Bans every provider adapter (`@tanstack/ai-openai`, `-anthropic`, `-openrouter`, …), `@tanstack/ai-persistence`, `@tanstack/ai-mcp`, `@tanstack/ai-compaction`, any `/byok` subpath, `@ag-ui/encoder`, and keeps every existing ban. |
| M0-04, shared | Adds `@tanstack/*` and `@ag-ui/*` to the zero-dependency ban. |
| New churn firewall | In the orchestrator, `@tanstack/ai*` and `@ag-ui/*` are importable only from `agent/execution/**`, `models/**`, `mcp/**` and the persistence adapter's directory; MOD-02 writes the exact allow-list when the packages land, with a probe. |
| R10 | Adds `@tanstack/ai-mcp` and `@modelcontextprotocol/client` to the sandbox-package ban. |
| M2-BE-02 | Unchanged. |
| R7/D-010, D-026 | Every new store's Prisma call is scoped or exempt in `prisma-allowlist.test.ts`; every new route carries an ownership marker. |
| §4.2 validation | `TurnEventBus` and `WsClient` keep validating product frames both ways; AG-UI events are validated by the libraries. |
| M0-07 | Our manifests pin exactly; transitive carets inside TanStack packages are pinned by the lockfile and checked by MOD-02's drift fixtures. |
| D-013 | Each new or changed rule ships a probe in `tools/guard-probes/probes.json` that lints under the rule's own block. |

### 3.13 Screen, input and the computer

- Pixels never travel on the conversation stream, and a media failure never ends a conversation.
- The screen keeps its §4.2 subscription and binary frames until MOD-SC-03 ratifies the selected
  transport; MOD-SC-03 then owns its endpoints, credentials, revocation and capabilities.
- Input authority is server state: a controller lease that MOD-BR-01 defines. A client view-only
  flag or a private port grants nothing.
- One shared computer per user; each bot keeps its own display, window manager, session bus,
  workspace and Chrome profile; a named login is a full Chrome profile leased to one bot at a time
  (D-046, D-056, D-057, D-060, D-061). The streamer's ports stay private to the computer and are
  reached only through the provider tunnel with credentials the orchestrator mints and revokes.
- The `SandboxProvider` port and `@ai-sdk/harness` re-export are unchanged by the chat migration.

### 3.14 Retention, encryption, region and deletion

Every new table (`RunEvent`, `RunInterrupt`) carries `userId` directly, so retention, export and
deletion queries do not join through bots. No conversation content is written outside Postgres
(§3.7). Deleting a bot cascades its runs, interrupts and events. CC-74 (encryption), CC-75 (region)
and CC-76 (access report) remain the owners of those promises and read these tables as additional
content stores; adopting TanStack persistence satisfies none of them.

### 3.15 Configuration keys

A new key is ratified in the decision of the task that first reads it, and in that same change it is
added to `turbo.json` `globalEnv`, `infra/compose/.env.example` and the self-host compose file. No
MOD task reads a key that has no decision.

## 4. Clean installation and the development reset

The product is pre-launch (D-158), so the target is installed fresh rather than migrated from data.

- **Schema.** Changes ship as ordinary Prisma migrations appended to the journal, so
  `pnpm db:deploy` on an empty database produces the target schema and CI's
  `prisma migrate diff --exit-code` stays meaningful. Destructive migrations (dropping columns or
  values the target no longer has) are allowed. No converter, backfill or dual-read path is written.
- **Reset.** The existing `pnpm db:reset` (`scripts/db-reset.mjs`, V1-17) is the development reset,
  and no second script is written. It already refuses `NODE_ENV=production`, refuses a database that
  is not on a local host, makes the operator name the database back, runs `prisma migrate reset` and
  re-seeds. The MOD tasks extend it only where a new store holds state outside Postgres: the task
  that first puts run state anywhere else (expected: MOD-AI-07, if Redis wake-ups need clearing) adds
  that store to the same guarded script, flushing only the Redis logical database `REDIS_URL` names.
  `pnpm db:clean` keeps its role for leftovers. Computers are recreated from the target image rather
  than reset in place. CI keeps creating its own empty database; nothing resets a database the
  operator did not name.
- **Order of a clean deployment.** Database migrated, queue empty, server, then a desktop of the same
  version, then fresh computers from the target image. MOD-AI-14 and MOD-SC-08 record it.

## 5. Evidence

Each MOD task that claims a runtime result keeps its evidence in
`docs/reviews/evidence/mod-<task-id-lowercase>/`, the convention the M-series already uses:

- `summary.txt`: the commit inspected, the commands run, results with pass/fail/skip counts, and
  every limitation — including suites that skipped and why.
- `env.txt`: Node, pnpm, Postgres, Redis, Docker and browser versions; edition; image digests;
  provider and model ids where a real model ran. Never a secret.
- `canonical-runs.sh` and, for guards, `falsify.sh`, so a reviewer can rerun the claim.
- Measurements as JSON, each file under 1 MiB; larger raw captures are summarized, not committed.

A mocked or unit-level pass is never recorded as Postgres, hosted-screen or real-model evidence. A
task that could not reach a required environment says so in `summary.txt` and stays open.

## 6. How budgets are set

Budgets come from measured baselines, ratified before the work they gate:

- **Chat** (MOD-03 measures, ratified before MOD-AI-13). Per reference scenario: server time from
  admission to first text event, p50/p95; total turn time; provider calls; input, cached-input and
  output tokens; cost; peak event-log rows and bytes per run; memory per active run. Default budget:
  latency p95 no worse than baseline +10%; tokens and cost no worse than baseline +5%, except where
  compaction intentionally reduces them; every functional fixture passes.
- **Screen** (MOD-SC-01 measures, ratified before MOD-SC-03). Input-to-visible latency p50/p95,
  frame age, cadence, readable-text check, encoder and decoder CPU, bytes per second, queue depth and
  memory, per scenario and viewer count. The selected transport must improve the reported
  expanded-screen interaction p95 against baseline and meet the absolute budget MOD-SC-01 ratifies.
- A budget that cannot be measured in an available environment blocks its gate; it is not waived.

## 7. Open verifications for MOD-02

**Resolved by D-160** (`docs/reviews/evidence/mod-02/`): item 1 **failed** and §3.1 changed;
items 2–4 hold (item 2 by `detach()` + `attach()`, which re-hydrates and joins `activeRun`); item 5
holds (no server package, provider SDK or `@tanstack/markdown` in the renderer graph; licenses
inventoried); item 6 moves to MOD-AI-09 with `@modelcontextprotocol/client` 2.3.0 installed beside
the current `@ai-sdk/mcp`.

These are facts about the libraries that the contracts above rely on and that only a running
integration can confirm. MOD-02 proves each against real builds, or records the decision that
replaces the assumption before any dependent task starts:

1. The React client adopts the server-minted run id from `RUN_STARTED` when it proposed another
   (§3.1). If it does not, MOD-02 ratifies accepting the client's id under insert-if-absent with
   the ownership check.
2. A mounted `useChat` can join a run it did not start when told about it by `run.started` — by
   remounting through `attach()`/hydrate, or by a subscribe-mode connection adapter. MOD-02 records
   which, with a test.
3. `withPersistence` with an empty `messages` list loads the stored thread, including the user
   message admitted in the same request (§3.3 step 4).
4. A durable SSE response from `POST /bots/:id/chat` reconnects with `Last-Event-ID` through the
   Electron renderer's `fetch` without duplicates.
5. `@tanstack/ai-react`'s dependencies (`@tanstack/markdown`, the optional `@mcp-ui/client` peer)
   either stay out of the renderer bundle or are inventoried with their licenses.
6. `@tanstack/ai-mcp` uses `@modelcontextprotocol/client` 2.x; MOD-02 confirms it coexists with the
   transport and OAuth behaviour D-099 … D-118 rely on, or records the gap for MOD-AI-09.

## 8. Who ratifies the rest

| Contract | Ratified in | Constraint from this document |
| --- | --- | --- |
| Exact dependency set and pins, churn-firewall allow-list | MOD-02 | §3.12, §7 |
| Message, run, interrupt and event columns | MOD-AI-03 | §3.4–§3.7, §4 |
| Seat control, input and freshness | MOD-BR-01 | §3.13 |
| External-effect policy and approval binding | MOD-SE-01 | §3.6 |
| Docker lifecycle supervisor API | MOD-SE-03 | R2 moves with it |
| Tool definitions and `crewaid.tool-approval` schemas | MOD-AI-02 | §3.6, §3.11 |
| Execution port types | MOD-AI-05 | §3.11 |
| Lease, heartbeat and fencing timings | MOD-AI-06 | §3.5 |
| Event-log retention and backpressure | MOD-AI-07 | §3.7 |
| Recovery authority, `WORKER_LOST` handling | MOD-DU-01/02 | §3.5 |
| Screen transport, media/input contracts | MOD-SC-03 | §3.13 |
| Chat and screen budgets | MOD-03, MOD-SC-01 | §6 |
