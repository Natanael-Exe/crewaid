# Telegram channel

Contract for the user-requested Telegram integration (2026-10-17, revised 2026-10-21; D-233).

## Behavior

Each person connects **their own Telegram bot**, so their crew has its own name and
one bot's ban or rate limit affects only its owner. Both editions support the
channel. One account has at most one bot; one bot serves at most one account.
Group chats and messages from bots are ignored.

In Settings → Channels a signed-in person gets their bot one of two ways:

1. **QR code** (only when the deployment runs a manager bot, `canCreateBots`). The
   app shows a QR code for `https://t.me/newbot/{manager}/{suggested_username}?name={name}`
   and an 8-character code. Scanning opens Telegram's create-a-bot screen with the
   name ("Ana’s Crew") and username (`ana_crew_ab12_bot`) filled in; the person
   keeps or edits them. The manager receives `managed_bot`; the server fetches the
   bot's token, restricts the bot to its creator (`setManagedBotAccessSettings`),
   registers the bot's own webhook and holds it as a pending bot for 30 minutes.
2. **Pasted token** (always available). The person creates a bot with @BotFather and
   pastes its token. The server validates it with `getMe`, refuses the manager's
   own bot, registers the webhook and holds a pending bot bound to that account.
   The app offers `https://t.me/{bot}?start={code}`, which sends the code with Start.

The person sends the code to the new bot (with or without the dash, any case). The
right code **claims** the bot and the bot answers "Confirm in Crewaid". The app
then shows "Telegram user {name} wants to connect through @{bot}" with Confirm and
Cancel. Only Confirm, made with the account's session, creates the connection; it
then sets the bot's `/` menu and sends a hello with the crew list. Cancel retires
the bot.

Pairing rules: a code is 8 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`
(about 39 bits), generated with `crypto.randomInt`, one per account, single use,
valid ten minutes and stored as its SHA-256 digest. A managed bot accepts a code
only from its creator. A pasted bot accepts only a code issued to the account that
pasted it. Five wrong codes retire the pending bot. A creator may hold three
unclaimed managed bots at once. A claim waits ten minutes for its Confirm. A
message to the manager bot itself only gets "create your bot from Crewaid".

Once connected, every crew member is a command: `/emma` selects Emma, and
`/emma find me ten leads` selects her and sends her that message. Slugs are the
name lowercased without diacritics, `[a-z0-9_]{1,32}`; a clash with a control or
another slug gets `_2`; the menu holds at most 100 commands, crew first. It is
re-sent only when its digest changes (on Confirm, `/bots`, `/help` and an unknown
command). Plain text, photos, documents and voice notes enter the selected bot's
existing conversation through ChatSendService, which announces the stored message
before its run starts, so an open Crewaid window shows it above the reply. Voice
uses VoiceService and its normal allowance. `/new` starts a new topic with the
selected crew member, as New topic does in the app; `/new plan the launch` opens
it with that message. Both forms pin the selected crew member and use a boundary
message id derived from the connection and update id, so retries never reset
context again. `/bots`, `/new`, `/status`, `/stop`, `/approvals`, `/unlink`
and `/help` provide controls. Replies and pending approvals for the selected bot are delivered
even while desktop is closed, prefixed with the crew member's name. Selecting
another bot starts delivery from its current transcript position; it does not
export history. The desktop remains the interface for live screen control and
teaching.

Approval buttons resolve the owned, still-pending native interrupt through normal
chat admission with its parent run. They never call a tool directly or change
policy. Truncated approval arguments cannot be approved from Telegram.

## HTTP and configuration

All paths below are relative to `/api/v1`. Shapes live in
`packages/shared/src/telegram.ts`; paths in `API_ROUTES.telegram`.

- `GET /channels/telegram`: `{ configured, canCreateBots, connection: { botUsername,
  displayName, selectedBotId, connectedAt } | null, pending: { botUsername,
  telegramName | null, expiresAt } | null }`. `telegramName` is set once the right
  code arrived; that is when the app shows Confirm.
- `POST /channels/telegram/link`: a new code. `{ code, expiresAt, createUrl }`,
  where `createUrl` is the QR link or null without a manager bot. 409 when connected.
- `POST /channels/telegram/bot`: `{ token }` → `{ botUsername, code, expiresAt,
  openUrl }`. 400 for a token Telegram refuses, 409 when connected or the bot is
  another account's, 503 when Telegram can't be reached.
- `POST /channels/telegram/confirm`: `{ connected: true }`. 404 when nothing is
  waiting for this account's Confirm, 409 when already connected.
- `DELETE /channels/telegram`: cancels a pending bot and the code, and/or
  disconnects, retiring the bot. `{ disconnected: true }`.
- `POST /channels/telegram/manager/webhook`: the manager's updates (`managed_bot`,
  `message`). Session-exempt; requires a constant-time match of
  `X-Telegram-Bot-Api-Secret-Token` against `TELEGRAM_MANAGER_WEBHOOK_SECRET`.
- `POST /channels/telegram/bots/:telegramBotId/webhook`: one person's bot.
  Session-exempt; `:telegramBotId` is `\d{1,20}` and the header's digest must match
  the digest stored for that bot. An unknown bot or a wrong secret is 401.

Both webhooks validate the update and acknowledge only after Redis accepted it.

| Variable | Meaning |
|---|---|
| `TELEGRAM_PUBLIC_URL` | HTTPS origin Telegram can reach, no path. Enables the channel; every webhook is registered under `{origin}/api/v1`. |
| `TELEGRAM_MANAGER_BOT_TOKEN` + `TELEGRAM_MANAGER_WEBHOOK_SECRET` | Optional pair; enables QR creation. The secret is 32–256 characters from A–Z, a–z, 0–9, `_` and `-`. |
| `REDIS_URL`, `CREDENTIAL_KEY` | Required when the channel is enabled; checked at boot. |
| `TELEGRAM_WORKER` | `false` disables consumption on API-only processes. |

On boot and after each minute’s cleanup, the scan queue sets the manager’s
webhook and re-registers every bot whose confirmed webhook URL is not under the
current public URL, rotating its secret. Reconciliation is serialized across
workers. A registering bot has an empty `webhookUrl`; its secret digest is stored
before Telegram is called, and its URL is recorded only after Telegram confirms. That
covers a moved domain or a restarted tunnel. Tokens never reach the client, model
or sandbox and are never logged, including API URLs containing them.

## Persistence and delivery

`TelegramConnection` (one per account, cascading from User) has an immutable id,
unique userId and telegramBotId, botUsername, `managed`, the sealed
tokenCiphertext, webhookSecretHash and webhookUrl, commandsDigest, the confirmed
telegramUserId, chatId and displayName, selectedBotId, selectedAt, message/run
sequence watermarks, notifiedInterruptIds and createdAt/updatedAt. The selected
bot is always resolved with userId; an id alone grants no access. An update is
resolved by bot, Telegram user and chat together.

`TelegramPendingBot` is keyed by telegramBotId: botUsername, `managed`,
ownerTelegramUserId (a managed bot's creator), a unique optional userId (set when a
token is pasted or a code claims it), the sealed token, webhookSecretHash and
webhookUrl, failedAttempts, the claim (claimedAt, claimTelegramUserId,
claimChatId, claimDisplayName), expiresAt and createdAt. A claim locks the pending
row and the code's user, consumes the code and replaces any other bot the account
had waiting. Confirm reseals the token for the connection and deletes the row.

`TelegramLinkTicket` holds the code digest (primary key), a unique userId,
expiresAt and a cascading User relation.

Tokens are sealed with `encryptCredential` under `CREDENTIAL_KEY`, bound to the
pending bot or to the account and bot; only `telegram/telegram-tokens.ts` touches
the cipher. Retiring a bot deletes its webhook (dropping pending updates) and, for a
managed bot, replaces its token with `replaceManagedBotToken`, best effort, then
deletes the row. Before replacing a managed token it records a `TelegramRetiredBot`
marker (`telegramBotId` primary key, `retiredAt`), containing no token or account
data. Manager updates for that id are ignored permanently, so the token-change
update caused by retirement cannot recreate the bot or consume a pending slot.
Pasting a valid token remains an explicit way to connect that bot again.
A `managed_bot` update for a known bot refreshes its token and
webhook, or retires it when its owner changed.

`TelegramAttachmentDelivery` has the composite primary key connectionId /
attachmentId and cascading relations to the connection and attachment.
Owned, unreceipted BOT attachments created after selectedAt are delivered
independently of text watermarks. This includes spoken replies attached after
the text run finishes. Re-selecting the same bot preserves its watermark.

Verified updates go to one of eight BullMQ lanes, `telegram.channel.0` …
`telegram.channel.7`, chosen by a hash of the bot id and chat id (a manager update
by its creator's id). Each lane has one global consumer, so one chat's updates and
deliveries run in order across replicas,
while a slow download or rate limit holds back only the chats on its lane. Jobs
are keyed by the digest of bot id and update id, since Telegram numbers updates per
bot, with exponential retry and seven-day deduplication retention.
`telegram.channel.scan` runs a delivery scan every two seconds and a cleanup every
minute that deletes expired codes and retires expired pending bots. It
queues delivery only for a connection with something to send: a reply or run
past its watermark, an unreceipted file, or an unannounced approval batch. A
connection whose selected bot was deleted is never queued. Provider retries
use deterministic Crewaid message ids and cannot execute a second agent turn.
Updates capture the connection id at receipt; a disconnect/reconnect invalidates
already-queued messages. The selected bot is persisted at first consumption, so
a delayed media retry cannot send the request to a different crew member.
Downloaded media and its transcript are saved on the job before admission, so a
retry never downloads or bills them again. A message for a thread that is
waiting for a decision is refused before anything is downloaded.
Pairing codes are redacted from retained job payloads: the webhook rewrites the
message to `/start` and queues the code's digest, never the code.

Delivery scans recheck the link, owner and ban state. Only persisted BOT content,
never reasoning or tool results, is sent; completed message batches advance the
watermark. Long replies are split to Telegram's limit. Failed sends retain their
watermark and retry, except a 4xx other than 403 and 429: Telegram will refuse
that request every time, so the reply or file is recorded as handled and the
chat is told to open Crewaid. A 403 (bot blocked) disconnects and retires the bot. A rate limit is
waited out in place only when it is five seconds or less. Otherwise the job
retries later.

Approvals are shown one run at a time, oldest first. An action whose details
can't be parsed is shown with Reject only. When a decision is pending that
Telegram can't answer at all, `/approvals` says so and points to Crewaid. Delivery is at least once: a crash after Telegram accepts a
send but before its watermark commits can repeat that notification. Approval
consumption and agent execution retain their existing durable idempotency fences.

Media downloads use Telegram's fixed HTTPS origin and bounded reads (20 MiB;
voice keeps its existing 10 MiB limit). Uploads and downloads use the owned
AttachmentsService. Blocked/missing accounts and unlinked chats grant no access.

## Deployment

1. Optional, for QR creation: create a manager bot with @BotFather, turn on **Bot
   Management Mode** in its settings, and keep its token server-side.
2. Set `TELEGRAM_PUBLIC_URL` (and the manager pair, if any), `REDIS_URL` and
   `CREDENTIAL_KEY` in the server environment.
3. Apply database migrations, rebuild and restart the orchestrator. The worker
   registers the manager's webhook itself.
4. Open Settings → Channels → Connect Telegram, create or paste a bot, send the
   code, and Confirm.
5. Send `/emma hi` (with a crew member's name). Verify a reply, an approval, a
   voice note (if configured), a file and disconnect.

### Testing locally

Telegram must reach your machine over HTTPS, so run a tunnel (for example
`ngrok http 3000`) and use its address as `TELEGRAM_PUBLIC_URL`. A restarted tunnel
gets a new address: update the variable and restart; the worker re-registers every
bot's webhook. Use a separate test manager bot, never the production one: a
webhook registration replaces the previous one.

Existing Crewaid model/computer/voice allowances apply. Telegram ordinary bot
messages are free within platform rate limits. Conversation content sent through
this channel is also processed by Telegram; it is not an end-to-end encrypted chat.
