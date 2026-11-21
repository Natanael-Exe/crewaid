# MOD-AI-08 — The chat the operator reads, on TanStack React

MOD-AI-16 gave a TanStack thread a front door and MOD-AI-17 made every turn on
it behave like a bot's conversation. Nothing can look at one. The renderer's
transcript is a §4.2 frame reader: `useChat.ts` fetches `GET /bots/:id/messages`,
`chatReducer.ts` folds `message.created` / `.delta` / `.part` / `.completed` into
`messagesByBot` and `streamingByBot`, and `viewTypes.ts` turns a §4.1 row into a
`TranscriptMessage`. All three are the AI SDK path.

This task replaces that transcript authority with `@tanstack/ai-react`'s
`useChat` over the chat routes, flips new threads to `TANSTACK`, and leaves every
other thing `chatReducer` holds — the roster, unread counts, groups, Work
revisions, recordings, the computer, the seat, usage notices — exactly where it
is. D-192 ratifies it.

**One authority, not two.** The renderer stops speaking the AI SDK conversation
routes altogether rather than keeping a second transcript state machine beside
the first. That is the task's own instruction, and D-158 is what makes it
affordable: pre-launch, no users, no production data, so a database written
before this change is re-seeded rather than migrated. A thread still marked
`AI_SDK` says so in place of its transcript. MOD-AI-15 deletes the server half.

## 1. Which engine a new thread gets

`Conversation.engine` defaults to `TANSTACK` (`@default(TANSTACK)`, one
migration). Every create site — a bot's birth, a duplicate, the conversation a
Work Start opens — already relies on the default, so the default is the whole
change and there is exactly one place to read the answer off. D-165's `AI_SDK`
default is superseded.

## 2. The operator's view of a stored thread

`loadThread` reads a thread **for the model**: it drops `SYSTEM` rows, reads a
teammate's row as a `user` turn, and carries no product facts. `GET
/bots/:id/chat?threadId=` goes through that same store, so today a hydrate would
hand the renderer the model's view of the conversation and the transcript would
be missing its system notices, its `/new` dividers, its teammate attribution,
its unfinished-reply reasons and its attachments.

So the hydrate gets its own reader: `createPrismaMessageStore(prisma, scope,
{ view: 'operator' })`, the same store with its writes refused as
`hydrateOwnedChat` already refuses them, differing in two ways:

- `SYSTEM` rows are kept, as `role: 'system'`.
- every message carries `metadata.crewaid`, the §3.4 projection
  (`crewaidMetadataOf`) that nothing called until now: `author`, `fromBotId`,
  `runId`, `sequence`, `stopReason`, `taskId`, `routineId`, `chainId`,
  `hopCount`, `startsTopic`, and `attachments`.

`attachments` is the one widening: `crewaidMetadataOf` projected
`attachmentIds`, and an attachment card needs a name, a type and a size. Ids
alone would mean a round trip per message for data the read already has in hand.
There is no `GET /attachments/:id`, and this is why there does not need to be
one.

The model's reader is untouched: product metadata never reaches a provider, and
a `SYSTEM` row still says nothing to it.

## 3. One client per thread, mounted by its thread id

`renderer/chat/ChatThread.tsx` owns the hook and nothing else does. `App.tsx`
mounts it with `key={thread.id}`, which is what keeps one bot's conversation out
of another's: the hook preserves its messages across a client rebuild on
purpose, so re-keying it in place is how cross-bot leakage would happen. A key
change unmounts and remounts, and the fresh client hydrates from the server.

```
useChat({
  threadId: thread.id,
  persistence: true,            // server-authoritative; nothing cached in the browser
  history: { pageSize: 50 },    // the hydrate's newest window
  interrupts: [toolApproval],   // D-175's definition, already in the tree
  connection: crewaidChat(client, botId, frames),
  live: true,
  queue: { whenBusy: 'queue' },
  streamProcessor: { chunkStrategy: new WordBoundaryStrategy() },
})
```

A bot the operator is not looking at has no client, and does not need one: its
run is produced by the server, logged durably, and replayed in full when the
operator comes back. That is what MOD-AI-07's log was for. What the sidebar
needs about an off-screen bot — that it is working, and that it has something
unread — it gets from §4.2 `bot.status` and from `GET /bots`, whose unread count
already counts a TanStack run correctly (D-165).

## 4. Every run reaches the window through its durable log

`renderer/chat/crewaidChat.ts` is the connection adapter, and it is a
`subscribe`/`send` adapter rather than a `connect` one for one reason: a window
has to show a run **it did not start**. A routine fires, a teammate's message
arrives, a message deferred behind a running turn is answered later — D-188
announces each of those with `run.started` on the §4.2 socket, and a `connect`
adapter has nowhere to put a run nobody asked it for.

- `subscribe()` yields the chunks of every run this thread produces, in the
  order they are announced. A run is read from its log at `offset=-1` — replayed
  from the start, then tailed — and read once: the adapter keeps the run ids it
  has opened, so an announcement for a run already being read changes nothing.
- A run is announced by the `run.started` frame, by the hydrate's `activeRun`,
  and by `send`'s own response.
- `send()` POSTs `/bots/:id/chat`. The client mints the run id (D-160) and the
  server claims it, so the response is that run's log and goes into the same
  queue. A deferred message answers `202` with an empty stream, and the run that
  does answer it arrives later as an announcement like any other.
- `joinRun` and `hydrate` are the stock `fetchServerSentEvents` handlers: their
  URL shapes (`?runId&offset=-1`, `?threadId&limit&before`) are already the
  routes this server serves.

Credentials and URLs come from the same two places everything else in the
renderer uses: `API_ROUTES` for the path and the CC-07 credential bag for the
bearer (D-025). The adapter is handed an `ApiClient`, never a path literal, and
every request is a `fetch`.

## 5. What the reducer stops owning

| Leaves `ChatState` | What owns it now |
| --- | --- |
| `messagesByBot` | `useChat`'s `messages` |
| `streamingByBot` | the same `messages` — a part in flight is a part of the message |
| `cursorByBot` | `hasOlderMessages` / `loadOlderMessages` |
| `historyStatusByBot`, `historyErrorByBot` | `status`, `error` |
| `approvalsByBot`, `approvalLoadsByBot` | `interrupts` |
| `activityByBot` | `sessionGenerating`, for the thread on screen |

`activityByBot` stays, because the sidebar and the right rail ask it about bots
with no client. It keeps its `bot.status` arm and loses the arms that read a
message frame. Everything else in `ChatState` is untouched: `bots`, `botsStatus`,
`botsError`, `groups`, `unreadByBot`, `viewedBotId`, `work`, `usageNotice`,
`recordingByBot`, `wakeByBot`, `seatControlByBot`, `lastError`.

The frames that fed the leaving keys become documented no-ops in the exhaustive
switch, as `run.started` already is: `message.created`, `message.delta`,
`message.part`, `message.attachments`, `message.completed`, `approval.requested`,
`approval.resolved`. They are the AI SDK path's and MOD-AI-15 removes them with
it. The `error` frame keeps its `errorByBot` and `lastError` arms and loses its
partial-promotion arm — a TanStack run's failure is in its own log.

Two frames do reach the chat client, through `ChatThread`, because they are about
the thread on screen and have no run of their own:

- `message.deleted` (D-147 serves both engines) — the deleted ids leave
  `messages`, and a clear empties them.
- `message.created` for a `SYSTEM` row — the limit notice MOD-AI-17 posts
  between two runs belongs to no run's log, so the frame is the live signal and
  the row is appended.

## 6. The transcript's new wire shape

`renderer/chat/uiMessage.ts` is the only place a `UIMessage` becomes a
`TranscriptMessage`, the way `viewTypes.toTranscriptMessage` was the only place
a §4.1 row did. `TranscriptMessage`, `AnyPart`, the part registry, the tool
folds, `ReasoningPart`, `transcriptRows`, `transcriptPrefs` and every component
below `Transcript` keep their shapes and their tests.

- `role` + `metadata.crewaid.author` → `author`. A `BOT` row whose `fromBotId`
  is not this thread's bot is a teammate's message and arrives as `role: 'user'`;
  the metadata is what tells them apart, and `fromBotId` is set from it exactly
  as it is today.
- `parts` map onto `AnyPart` by `type`. A part still in flight carries
  `state: 'streaming'`, which is what `ReasoningPart` and `StreamingMarkdown`
  already read, so a reply does not rearrange itself when it settles.
- `metadata.crewaid` supplies `stopReason`, `taskId`, `startsTopic` and
  `attachments`; `createdAt` supplies the ordering key and the time and date
  labels.

`streamedText`, `appendDelta`, `blocksToParts`, `StreamingBlock` and
`StreamingMessage` go: they existed to accumulate deltas, and the chat client
accumulates them now. `messageOrder.ts`'s `withTail` goes with them — there is
no tail to splice when the in-flight reply is a message in the list. Server
order is the list's order.

## 7. The composer, Stop, and an approval

- **Sending** hands `sendMessage(content, { body: { attachmentIds } })` the
  turn's claimed uploads, which is the one key `forwardedProps` accepts (D-190).
  The operator's message is on screen the moment they send it instead of after
  the round trip.
- **The composer's queue stays the operator's** (CC-45): it holds drafts they can
  edit, reorder and send now, which no transport queue can do. It is still the
  gate that decides when `sendMessage` is called, and the client's own queue is
  behind it for the race where a run starts between the drain decision and the
  send.
- **Stop** sends `bot.cancel` and then calls `stop()`. The frame is the authority
  — §3.9, and closing a stream is a disconnect, not a cancel — and `stop()` ends
  this window's read of a run that is already ending.
- **An approval** is a bound `crewaid.tool-approval` interrupt. `ApprovalPrompt`
  keeps its `PendingApproval` prop and its edited-args answer;
  `resolveInterrupt({ approved, editedArgs })` replaces the `approval.respond`
  frame, and the hydrate re-prompts a pending one after a reload or on another
  window. `GET /bots/:id/approvals` leaves the renderer.

## 8. What the operator gets out of it

The landing page's showcase (`apps/web/src/showcase`) is the app as we describe
it to someone who has not installed it, and three things it shows are things the
app does not do yet. They are in scope because they are the difference between a
transcript that works and one that feels alive, and because the client now
supplies what each needs.

- **A message arrives instead of appearing.** The showcase springs each row in
  (`AppWindow.tsx`'s `AnimatePresence` + `layout="position"`). The transcript
  gets the same entrance, under `prefers-reduced-motion`.
- **The sidebar says what a bot is doing.** The showcase's preview reads
  "Typing…" while the bot thinks. `sessionGenerating` for the thread on screen
  and `activityByBot` for the rest already carry that fact.
- **Text streams in words, not fragments.** `WordBoundaryStrategy` emits on word
  boundaries rather than on every chunk, which is what stops a reply juddering a
  character at a time.

And two the client supplies directly:

- **A failed send is retryable in place.** `reload()` re-sends the last message,
  so a send that failed could be a button rather than a banner and a retype.
  Not wired in this change.
- **A reader that fell behind catches up.** `connectionStatus` is the chat
  stream's own state, distinct from the §4.2 socket's, so "reconnecting" is said
  about the thing that is actually reconnecting.

## Acceptance

Real PostgreSQL for the server half; the desktop suite renders with
`renderToStaticMarkup` as it does today.

- A new bot's thread is `TANSTACK`, and so is a duplicate's and a Work Start's.
- A hydrate carries what the operator reads: system rows, a teammate's row
  attributed to its sender, an unfinished reply's reason, a `/new` divider, a
  task brief's id, and each attachment's name, type and size. The model's
  reader is unchanged by all of it.
- Text, reasoning, tool calls and results, structured output, attachments and
  errors render; a settled reply looks the same as it did one token earlier.
- A run the window did not start — a routine, a teammate, a message deferred
  behind a running turn — is joined and replayed from its start, exactly once.
- Switching bots mid-turn and coming back shows the whole run, with no part
  lost, no part twice, and nothing from the other bot.
- A reload, and a second window, show a pending approval and answer it once.
- Stop ends the run and keeps the partial reply.
- Older pages load on scroll; a clear empties the transcript; `/new` divides it.
- Unread markers, groups, Work, recordings, the computer and the seat behave as
  they did.
