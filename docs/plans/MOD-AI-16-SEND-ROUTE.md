# MOD-AI-16 — Admitting a user turn and starting its producer

`POST /bots/:id/chat` is the half of D-159 §3.2 that D-188 left unowned. Until it
exists, `GET /bots/:id/chat` can hydrate a thread and join a run's log, and
nothing in production creates a conversation run, so a TanStack client has
nowhere to send. This document is the contract; D-190 ratifies it.

## The route

`POST /bots/:id/chat`, behind `AuthGuard` and `@OwnedResource('bot', 'id')`,
exactly as the read side. The body is an AG-UI `RunAgentInput`, parsed by the
library's own `chatParamsFromRequestBody`, so the shape this server accepts is
the shape the stock client sends. A body the parser rejects is `400`.

The response is the same durable SSE stream the join serves: the run's event log,
replayed from its start and then tailed, in the library's encoding, with
`X-Crewaid-Wire-Version` and `X-Accel-Buffering: no`. One reader loop serves both
routes, so keep-alives, session re-reads and drain backpressure behave
identically whether a client sent a turn or rejoined one.

The response is a reader, not the run. The producer is started separately and
holds its own lease, so a client that disconnects mid-stream, or never reads the
body at all, changes nothing about the work: it rejoins with `?runId=&offset=`
(D-187). This is the same rule from the other side — a reader has no authority
over a producer.

## Admission (D-159 §3.3)

In order, before the library sees anything:

1. `threadId` must be the bot's own conversation, and that conversation must be
   `TANSTACK`. Any other id is `404`, never a statement about whose it is.
2. Messages whose id is already stored on the thread are **ignored**: they never
   override, reorder or truncate stored rows. What remains is the new input.
3. Every new message must be `role: 'user'`; an assistant, tool, system,
   developer, reasoning or activity message from a client is `400`. More than one
   new user message is `400` too: a run answers one trigger, and a client that
   batches is describing something this route does not implement.
4. A new message id must be well formed (1–64 of `[A-Za-z0-9_-]`) and must not
   collide with a stored id on another thread. A collision is `409` without
   saying where the id exists.
5. `forwardedProps` is allow-listed to `attachmentIds` (ids this principal owns
   and has not claimed). Any other key, and a non-empty `tools`, `context` or
   `state`, is `400`. Client-declared tools grant nothing here; admitting
   display-only ones needs its own decision.
6. A body with neither a new user message nor `resume` is `400`. A body with
   both is `400`: answering an approval and asking something new are two
   requests, and run order between them would otherwise be the client's to pick.
7. The thread's live state decides what happens next, under the thread lock:
   - **`resume` present** → the answers are admitted by `admitOwnedToolResumeBatch`
     (D-181/D-182), which stages each decision on its parked proposal and creates
     the continuation run that answers them. The response streams that
     continuation. `parentRunId` is the parked run the client names; a resume
     naming no pending interrupt consumes nothing and is `409`.
   - **a `running` run on the thread** → the user message is stored and left for
     the next run (M5-BE-16 moved server-side), and the response is an SSE stream
     that closes with no events. The deferred message is answered when the
     running producer settles, and that run is announced by `run.started`, which
     is how a client discovers any run it did not start.
   - **pending interrupts and no `resume`** → `409`. The thread is waiting for a
     person, and a new instruction is not an answer to it.
   - **otherwise** → the user message and its attachment claims are persisted in
     one transaction, and only then is the run claimed.
8. The run id is the client's, insert-if-absent (D-160). A repeat of a live run
   on the same thread with the same trigger is a double submit and joins the
   first run's log rather than starting a second. An id that names a run
   elsewhere, or a second concurrent run on this thread, is `409`.

Nothing above is a model call, a tool call or an external effect. Admission
grants no dispatch authority: the producer's lease and the restored plans decide
what may run (D-183).

## One turn assembly

A bot's turn is assembled the same way whichever engine runs it: the bot row and
its group, the roster the team block names, the resolved memory block, the
plugin tools, the registry resolution, the policy runtime, and the computer and
browser handles that a tool wakes. `agent/turn-assembly.ts` is that one place,
and both `AgentTurnService.startTurn` and this route's producer read from it. A
second assembly would be two answers to "what is this bot told and what may it
do", which is the kind of divergence nobody notices until a bot behaves
differently depending on which engine answered it.

What the engines keep to themselves is what is genuinely theirs: the AI SDK path
keeps its draft reply row and its §4.2 frames; this path keeps the lease, the
durable log and the library's persistence.

## Where a tool's attachment lands

An AI SDK turn hands its tools the draft reply's id, so a file a tool produces
claims the message the operator is already watching. A TanStack run composes no
draft: its assistant rows are minted by the engine as they stream, so there is
no id to hand out at assembly time.

A tool-produced attachment therefore claims **the canonical tool result message
of the call that produced it**. That row's id is derived by `assignTranscriptIds`
from the thread, the call's originating run and the tool call id, and the backend
already reserves it when `TOOL_CALL_START` arrives — before the tool executes —
so the row the attachment names exists when the claim is written. The derivation
is stable, so a save of the same result updates one row and the attachment stays
on it. `crewaidMetadataOf` already projects a row's attachment ids, so the card
reaches a client without a new field.

`ToolContext.messageId` becomes `attachmentHost(toolCallId)`, a function both
engines supply: the AI SDK path returns its draft id for every call, this path
derives the row. A tool that files an attachment or a memory asks for the host it
is writing to rather than being told one at build time.

## Acceptance

Real PostgreSQL throughout, and a real model once.

- A user turn admitted through this route streams, and a reader that reconnects
  at an offset sees each event once.
- A disconnect does not end the run; the run finishes and the log replays whole.
- An answered approval resumes through this route and consumes each decision
  once; a second answer consumes nothing.
- A stale, shortened or foreign transcript, an assistant message from a client,
  an unexpected `forwardedProps` key, a second concurrent run and a resume for
  nothing each change nothing and answer as above.
- A message sent while a run is live is stored once and answered after it.
- One real GLM 5.3 Flash run completes end to end: text streams, a tool runs,
  the transcript rows and the log agree, and the run ends `completed`.
