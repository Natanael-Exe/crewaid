# MOD-AI-03 — The canonical transcript and the target persistence schema

Ratified by **D-165** on 3 October 2026. It writes the columns D-159 §3.4–§3.7 left to this task,
with D-160's amendments. Migration `20261003170000_d165_transcript_runs` creates them. MOD-AI-04
builds the message store on them, MOD-AI-06 the run and interrupt stores, and MOD-AI-07 the event
log.

## 1. One engine per thread

`Conversation.engine` (`AI_SDK` | `TANSTACK`, default `AI_SDK`) says which engine writes a thread.

- A thread keeps the engine it started with for its whole life. Neither engine reads the other's
  rows, so there is no converter, no old-format reader and no mixed thread.
- MOD-AI-05 decides which new threads are `TANSTACK` (the controlled comparison accounts first).
- A development database that holds the wrong engine's threads is reset with `pnpm db:reset`,
  which still refuses anything that does not look local.
- MOD-AI-15 drops `AI_SDK`, the column, and the columns only that engine writes (`agentTurnId`,
  `AgentTurn.steps`).

## 2. The canonical message

A TANSTACK thread is the library's `ModelMessage[]`, stored as one `Message` row per message. The
row id is the message id.

`Message.parts` holds the message body: the `ModelMessage` without its id or time. One Zod schema,
`TranscriptBodySchema` in `agent/persistence/transcript.ts`, defines it. It is strict: a field the
library adds later is refused there, not dropped on the way to the database.

| Role | Body | Notes |
|---|---|---|
| `user` | `content: string`, `name?` | Text only. Attachments are `Attachment` rows pointing at the message, turned into parts for the model at call time. No bytes are stored in the transcript. |
| `assistant` | `content: string \| null`, `name?`, `toolCalls?`, `thinking?` | A tool call keeps its `id`, `function.name`, `function.arguments` (the raw string), `encryptedValue?` and provider `metadata?` such as a thought signature. Reasoning keeps its `signature` and `redacted` flag. |
| `tool` | `content: string`, `toolCallId`, `error?` | The result exactly as the model was given it. |

**Only the library's own metadata is stored.** That is `metadata.tanstack`:

- the run tag `withPersistence` puts on an assistant message (`run.id`, which reload uses to pair a
  message with its run);
- a tool result's outcome.

Saves come from the server's run, never from a client. Any other key is dropped, a client's
`metadata.crewaid` included. When a run tag is present it decides the row's `runId`, and a tag
that names a different run than the one saving it is refused. What the product knows is in
columns and is projected on read as `metadata.crewaid` (`crewaidMetadataOf`):

- author and sender bot;
- run and sequence;
- stop reason;
- task, routine, chain and hop;
- topic boundary;
- attachment ids.

`structuredOutput` is refused: Crewaid's chat has no structured output, and a body that has one
is a contract violation, not a value to keep.

**Every row has a stable id** (`assignTranscriptIds`).

- The engine names an assistant message after its stream.
- A tool result has no id, and neither has the text the engine records at an interrupt. The store
  names them deterministically, so the same message saved twice updates one row:
  - a tool result: `tr_` + sha256(thread, run, call id), since some providers number calls from
    zero on every request;
  - an id-less assistant message: `ta_` + sha256(thread, run, body, occurrence).
- A user message always has an id: the route that admits it assigns one.

## 3. Rows and authors

| Message | `author` | `fromBotId` | `runId` |
|---|---|---|---|
| The user's message | `USER` | null | null |
| A teammate's message (`send_message`), read as a user turn | `BOT` | the sender | null |
| The thread's bot speaking | `BOT` | the thread's bot | the run |
| A tool result | `TOOL` | the thread's bot | the run |
| A SYSTEM notice or a `/new` boundary | `SYSTEM` | — | — |

- A SYSTEM row is not a model message. `loadThread` skips it, and hydrate shows it as a
  `role: 'system'` UI message.
- The mapper refuses a row whose author cannot carry its role.
- `Message.content` stays the plain text (an assistant's text, or `''`, and a tool's result).
  Search, excerpts and the unread count keep reading one column.
- `agentTurnId` (unique, one reply per turn) belongs to AI_SDK threads. A TANSTACK run writes
  many rows, so `runId` is a separate, non-unique column.

## 4. Order

`Message.sequence` is a global `SERIAL`, unique, indexed with the conversation.

- Taken when the row is inserted. MOD-AI-04 inserts a reply's row when the message begins, so a
  user message admitted while a reply streams sorts after the reply's earlier rows.
- It is monotonic across the whole database, so it orders every thread without a per-thread
  counter that both engines would have to share.
- It is an `Int`: rows reach JSON in many places and a `BigInt` cannot. Widening it is one
  `ALTER COLUMN ... TYPE bigint` when two billion messages are in sight.
- The migration renumbers existing rows by `createdAt, id`, the order the transcript has always
  used.

## 5. Runs (`AgentTurn`)

**Status vocabulary.** The status is now the library's `RunStatus`, in the database and on the
wire, so nothing translates on the way through:

| Was | Now |
|---|---|
| `RUNNING` | `running` |
| `AWAITING_APPROVAL` | `interrupted` |
| `SUCCEEDED` | `completed` |
| `FAILED` | `failed` |
| `CANCELLED` | `aborted` |
| `INTERRUPTED` (the worker died) | `failed`, with `errorCode = 'WORKER_LOST'` |

The routine vocabulary (`RunStatus`: `PENDING`, `RUNNING`, …) is a different enum and is
unchanged.

**New columns:**

| Column | Holds |
|---|---|
| `conversationId` | The run's thread (`RunRecord.threadId`). Required; the migration fills it from the bot's conversation. |
| `errorCode` | A D-006 code, or `WORKER_LOST`. Never a vendor's text. A failed run's `RunError` is the code plus a sentence built from it. |
| `driverEpoch`, `cancelRequested`, `detachedSince`, `sandboxKey` | The library's fencing fields. Nullable, so "never set" stays distinct from `false` and `0`. |
| `resumesRunId` | D-160: the paused run whose interrupts this continuation answered. A turn (D-164's memory scope) is a run plus the continuations chained to it this way. |
| `eventsClosedAt` | When the run's event log closed; a tail stops there. |

**`activeKey`.** A TANSTACK run holds it only while `running` (D-160). An AI_SDK turn still holds
it while parked on an approval, as it always has, until that path is deleted.

## 6. Interrupts (`RunInterrupt`)

| Column | Holds |
|---|---|
| `id` | The interrupt id, minted by the server (cuid). |
| `runId`, `conversationId` | Cascade-deleted with the run and with the thread. |
| `userId` | The owner, directly, for retention and export (D-159 §3.14). |
| `status` | `pending`, `resolved` or `cancelled`. |
| `sequence` | Insertion order. The library's lists require it, and a batch shares a millisecond. |
| `requestedAt`, `resolvedAt` | When it was asked and answered. |
| `payload`, `response` | JSON. MOD-AI-02 writes `crewaid.tool-approval`'s schemas, with D-164's binding inside the payload. |

## 7. Events (`RunEvent`)

| Column | Holds |
|---|---|
| `id` | A `BIGSERIAL`, and it is the offset: monotonic, so it orders a run and a thread. Never sent raw; the adapter writes it as a string. |
| `runId`, `conversationId`, `userId` | As for interrupts. |
| `chunk` | One AG-UI event as the library emitted it. |
| `createdAt` | When it was appended. |

MOD-AI-07 ratifies retention and backpressure.

## 8. Product semantics that must survive

- **Topic boundaries** stay SYSTEM rows with `startsTopic`. The model never sees them.
- **Read markers** stay on `Conversation.lastReadAt`. The unread count counts BOT rows after it,
  but a TANSTACK run's rows count once (`COUNT(DISTINCT COALESCE(runId, id))`). A reply of three
  steps is one unread reply.
- **Task, routine and deliverable references** stay columns and relations on the row that carries
  them.
- **Memory** keeps `Memory.messageId` with `SetNull`, and deliverables do the same: deleting a
  message never deletes what it established (D-073, D-147).
- **Attachments** stay rows that cascade with their message.
- **Clear and delete** (D-147) remove a thread's events and pending interrupts in the same
  transaction as its messages. MOD-AI-04 and MOD-AI-07 implement that. Deleting a run cascades
  its interrupts and events now.

## 9. The mapper

`apps/orchestrator/src/agent/persistence/transcript.ts` is the one place a row becomes a library
record:

- `toTranscriptRow` and `fromTranscriptRow` for messages;
- `crewaidMetadataOf` for the product projection;
- `toRunRecord` for runs;
- `toInterruptRecord` for interrupts.

Every crossing is a `safeParse`, and nothing is cast. A violation (`missing-id`,
`unreadable-body`, `author-mismatch`) goes back to the caller to report.

## 10. Evidence

- `test/mod-ai-03-transcript.integration.test.ts`, on real Postgres, round-trips one thread. It
  has:
  - text;
  - reasoning with a signature;
  - two tool calls with provider metadata, and their results, one with an error;
  - a teammate's message tied to a task;
  - a topic boundary;
  - a routine's message;
  - an interrupted run with an assistant tool call;
  - a failed run's partial reply.

  It also checks:
  - the same ids, order and bodies, and the provenance projection;
  - "never set" fencing fields;
  - interrupt ordering inside one millisecond;
  - an approval binding read back intact;
  - sequence order against save order;
  - memory and deliverable `SetNull`;
  - run cascades.

  Its unit half covers the refusals.
- A mutation that drops reasoning in the mapper fails the round trip.
- `test/schema-contract.test.ts` pins every new column and enum. CI's drift guard pins the
  migration.
- `test/d131-groups-http.integration.test.ts` checks that a run counts once in the unread count.
