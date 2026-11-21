# MOD-AI-17 — Serving every turn on a TanStack thread

MOD-AI-16 gave a TanStack thread a front door: `POST /bots/:id/chat` admits an
operator's message and starts its producer. Everything else that starts a turn
still assumes an AI SDK thread. A routine posts its prompt, a teammate's message
is delivered, a Work brief is filed, a limit stop is continued and a message that
waited behind a run is answered, and each of those writes an AI SDK row and calls
`AgentTurnService.startTurn`. Stop only reaches an AI SDK turn. The renderer
cannot even ask for a TanStack thread, because nothing tells it a bot's thread
id. This task closes those gaps, so that MOD-AI-08's renderer can rely on a
TanStack thread that behaves like a bot's conversation in every case, not only
the one the send route covers. D-191 ratifies it.

**Which engine a new thread gets is not part of this task.** Threads are still
created `AI_SDK`, so main keeps working on every commit: a TanStack thread is
fully served by the server after this lands, and the renderer that can show one
is MOD-AI-08, which also flips the creation default. `AI_SDK` threads keep their
current path until MOD-AI-15 deletes it.

## 1. The bot names its thread

Each `GET /bots` row (`BotWithSandbox`) gains `thread: { id, engine }`, the
bot's `Conversation.id` and its `TranscriptEngine` (`AI_SDK` | `TANSTACK`), read
with the bot. It is `null` only for a bot whose conversation row is missing. The id is
the `threadId` every chat route requires (D-159 §3.1). The engine is how a client
decides which conversation path a bot's thread speaks; it is a fact of the thread,
never a client preference. Ownership is unchanged: knowing a thread id grants
nothing, and the chat routes still derive the owner from the bot (D-010).

## 2. One trigger writer for each engine

On a `TANSTACK` thread, every out-of-request trigger is written through the
canonical mapper (`toTranscriptRow`), with the product facts in their columns
exactly as today (§3.4):

| Trigger | Role | Product columns |
| --- | --- | --- |
| A routine's prompt | `user` | `routineId` |
| A teammate's message (`send_message` delivery) | `user`, `author = BOT`, sender's `fromBotId` | `chainId`, `hopCount`, `taskId` |
| A Work Start brief | `user` | `taskId` |

The writers keep their callers. `MessagesService` reads the thread's engine
where it already reads the thread, so a routine, a delivery and a Start do not
learn which engine they are writing for. Nothing writes an AI SDK row into a
`TANSTACK` thread, or the reverse. The store refuses that already, and after this
task no caller relies on that refusal to stay correct.

## 3. One way to start a turn

`AgentTurnService.startTurn` stays the single entry point every caller uses. When
the bot's thread is `TANSTACK`, it hands the stored trigger to the TanStack
producer instead of running it:

- The run id is minted by the server: no client proposed one. The run is claimed
  through the D-177 lease, `run.started` announces it (D-188), and its events go
  to the durable log. A window with that bot open joins the run from there.
- A `running` run on the thread, or pending interrupts, mean the trigger stays
  stored and is answered later (M5-BE-16, as D-190 already does for the
  operator's own messages). Nothing is refused, because a background caller has
  nobody to refuse.
- The turn is assembled by `assembleTurn`, exactly as a route-admitted turn is
  (D-190). The trigger's chain position (`chainId`, `hopCount`) rides into the
  assembly, so `send_message` limits and attribution work as they do today.

## 4. What a settled run does next

When a TanStack run settles, the producer does what `AgentTurnService` does after
a turn, with the same rules:

- **Completed, or stopped at a limit:** if a trigger arrived while it ran and no
  run has claimed it, start one run for the newest such trigger (fold, don't
  drain). A trigger is one the operator or a teammate sent: a `user` row.
- **Stopped at a limit and nothing waiting:** continue, up to
  `AGENT_MAX_CONTINUATIONS` runs for the same trigger, with the reason given to
  the model as an instruction rather than a stored message, because the operator
  did not say it (M5-BE-19, M5-BE-29). The system notice the AI SDK path posts is
  posted here too.
- **Aborted or failed:** nothing. Stop means stop, and a failure would hand its
  successor the same fault.
- **Interrupted:** nothing. The answer arrives as a resume, and the continuation
  it creates settles through this same step.

This also repairs a gap in MOD-AI-16. A message admitted while a run was
`running` was stored, but no run was ever started for it.

## 5. A teammate's message reads as a teammate's

The model sees a teammate's `user` row under the sender's current name, worded as
`interBotToUserContent` words it on the AI SDK path. This is a change to the
provider input, applied when the thread is loaded for a call, and it is never
stored: the row keeps the sender's words verbatim, and a renamed or deleted
sender reads as the sidebar would show it (`REMOVED_BOT_NAME`).

## 6. Stop reaches a TanStack run

`bot.cancel` on a bot whose thread is `TANSTACK` (§3.9):

- **A `running` run:** record `cancelRequested` on the run, scoped to the
  principal, and abort it in-process when this worker produces it. A producer on
  another worker is fenced at its next heartbeat, because `cancelRequested`
  fences the lease.
- **An `interrupted` run:** the operator is declining to answer, so its pending
  interrupts are cancelled, the run ends `aborted`, and nothing continues.

A cancelled run ends `aborted` whatever the moment the Stop lands in, and that
takes two repairs the engine does not make itself:

- The library ends its stream on an abort **without calling a terminal hook**,
  so nothing closes the run. The backend closes it `aborted` after the loop,
  which is the only status the lease admits once a cancellation is recorded.
- An abort that lands **before the first model call** — the run is `running`
  from the moment its lease is claimed, while the turn is still being
  assembled — resolves no provider and opens no persistence (D-176), so the
  producer never holds the thread at all. That run is the CALLER's to settle,
  and only for the one run it was holding.

Left open either way, the row stays `running`, keeps the one-active-run fence,
and the next message waits behind a run that will never answer it.

Closing a stream is still a disconnect, not a cancel.

## 7. The AI SDK routes refuse a TanStack thread

`POST /bots/:id/messages`, `GET /bots/:id/messages`, `GET /bots/:id/approvals`
and the §4.2 `approval.respond` frame answer a bot whose thread is `TANSTACK`
with `409 WRONG_ENGINE`. Their TanStack replacements are the chat routes
(D-159 §2.4). Refusing them, rather than translating, keeps the thread to one
writer and one reader. The D-147 routes and `POST /bots/:id/read` serve both
engines, as they do today.

## Acceptance

Real PostgreSQL throughout:

- A `TANSTACK` bot's wire shape names its thread and engine. An `AI_SDK` bot's
  shape names its own.
- A routine firing, a teammate's message and a Work Start each write one
  canonical row with their product columns, start one run, and announce it.
- A trigger that arrives while a run is working is answered exactly once, by
  the next run, folded with any others that queued behind it. That holds whether
  the trigger came through the send route or from a background caller.
- A limit stop continues up to the configured count, then stops with the notice.
- A teammate's message reaches the model attributed to the sender, and is stored
  verbatim.
- Stop ends a running run `aborted`, and an interrupted run `aborted` with its
  interrupts cancelled. Neither starts another run.
- Each AI SDK route refuses a `TANSTACK` thread `409`, and still serves an
  `AI_SDK` thread.
