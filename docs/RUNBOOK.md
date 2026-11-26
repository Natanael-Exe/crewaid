# Incident runbook

For the person running Crewaid on their own machine or server. Each entry
starts with **what you see**, because that's what you have when something goes
wrong. The component that failed is what you're trying to find.

PRD §8 names six incidents:

1. [A bot's computer won't start](#1-a-bots-computer-wont-start)
2. [A bot stops answering with a model error](#2-a-bot-stops-answering-with-a-model-error)
3. [Spend is higher than it should be](#3-spend-is-higher-than-it-should-be)
4. [A conversation between bots is stuck, or won't stop](#4-a-conversation-between-bots-is-stuck-or-wont-stop)
5. [A reply stopped halfway after a restart](#5-a-reply-stopped-halfway-after-a-restart)
6. [A bot says a plugin "needs to be reconnected"](#6-a-bot-says-a-plugin-needs-to-be-reconnected)
7. [Local coding connector ("crewaid-connect") won't run tasks](#7-local-coding-connector-crewaid-connect-wont-run-tasks)

---

## First look, whatever the symptom

**Is the orchestrator up, and can it reach what it needs?**

```bash
curl -s localhost:3000/health
# {"status":"ok","db":true,"redis":true,"docker":true,"sandboxes":[…]}
```

`/health` needs no sign-in. A `false` in it is usually the whole answer:

| Field | `false` means | Consequence |
|---|---|---|
| `db` | Postgres is unreachable | Nothing works |
| `redis` | Redis is unreachable | Chat still works. Skill compiling, bot-to-bot messages and routines don't |
| `docker` | The Docker daemon is unreachable | No computer can start or be watched |

`sandboxes` lists every computer with its state.

**The log.** The orchestrator writes one JSON line per event to stdout (to your
terminal under `pnpm orch`, otherwise wherever your process manager puts it).
Every line about a bot carries `botId`, and turn and chain lines also carry
`turnId` and `chainId`, so filtering by id finds a whole incident:

```bash
pnpm orch 2>&1 | tee orch.log          # if it isn't already captured somewhere
grep '"botId":"<id>"' orch.log | tail -50
```

**Finding a bot's id.** The app shows names, not ids:

```bash
docker exec -it crewaid-postgres psql -U crewaid crewaid \
  -c "select id, name from \"Bot\" order by name;"
```

---

## 1. A bot's computer won't start

**What you see.** The screen card says _"Something went wrong with this
computer"_ and offers **Try again**. Or it says _"This host is already running
N of M sandboxes"_. Or it stays on _"Waking the computer…"_.

**Look at the reason.** Hover the card: the host-level reason (`Sandbox.lastError`)
is one hover away. The same text is in the log and in:

```bash
docker exec -it crewaid-postgres psql -U crewaid crewaid -c \
  "select b.name, s.state, s.\"sessionId\", s.\"lastError\"
     from \"Bot\" b join \"Sandbox\" s on s.id = b.\"sandboxId\" where b.name = '<name>';"
```

| The reason says | It is | Do this |
|---|---|---|
| `image crewaid/sandbox:dev not found` | The sandbox image was never built on this host, or `SANDBOX_IMAGE` names another tag | Build it from the repo root: `docker build -f infra/sandbox-image/Dockerfile -t crewaid/sandbox:dev .`, then **Try again** |
| _"already running N of M sandboxes"_ | Capacity. `SANDBOX_MAX_RUNNING` (default 6) counts `STARTING`, `RUNNING` **and** `UNHEALTHY` computers | Stop one you don't need: `POST /api/v1/bots/<id>/sandbox/stop`. Or wait: an idle computer stops itself after `SANDBOX_IDLE_STOP_MS` (30 min). Raise the limit only if the host has room (PRD §7.5 sizes six on 8 vCPU / 16 GB) |
| `no room on the daemon`, or a Docker error about CPUs or memory | Docker itself refused | `docker system df`, `docker ps`. Each computer is capped at 8 GB RAM and 4 CPUs (D-063). These are caps, not reservations, but Docker refuses a container that asks for more CPUs than the host has |
| `Runtime … is missing; workspace … was preserved` | The container is gone (host reboot, `docker rm`) but the bot's files survived | **Try again**. It builds a new container on the same workspace |
| `bridge is unhealthy`, or the computer went `UNHEALTHY` after running | Something inside the container died (the entrypoint exits if any part of the desktop does) | **Try again** restarts the same container. `docker logs crewaid-sandbox-<sessionId>` names the process that died |
| Stuck on _"Waking…"_ | The start is still running, or Docker is hung | Check `docker` in `/health`. A start holds a 60-second lease, and one that can't finish gives up when the lease runs out. If the card still hasn't moved after a couple of minutes, restart the orchestrator |

**After a host reboot**, restart the orchestrator. With
`SANDBOX_RECONCILE_ON_BOOT=true` (the default) it matches every row against
the containers that actually exist, re-adopts the ones that are still running,
and marks the rest so that **Try again** rebuilds them. Nobody's workspace is
deleted.

**Fixed when** the card shows the live screen.

---

## 2. A bot stops answering with a model error

**What you see.** The reply ends with one of these, and the bot goes idle. When the provider gave
its own reason, it shows on the next line as _"<connection name> says: …"_ (D-228). That line
usually names the fix:

| Message | Means | Do this |
|---|---|---|
| _"The model provider is busy right now…"_ | Rate limited | Wait a minute, then tell the bot to carry on |
| _"The model provider is having trouble at their end…"_ | Provider outage | Switch to a model from **another provider** in the composer and tell the bot to carry on. Check the provider's status page |
| _"The model took too long to answer…"_ | Timeout | Tell the bot to carry on |
| _"The provider account is out of credit…"_ | Quota | Switch model and carry on, or top up the account |
| _"The provider would not let the bot use this model…"_ | Bad or revoked key, or a key the provider refuses for this use (a free tier, a region, a plan) | Read the provider's own line under the message, if there is one. Then **Settings → Models**: re-enter the key, or switch models in the composer |
| _"This conversation is too long for the model to hold at once…"_ | Context overflow | Start a new conversation, or pick a model with a larger context window |
| _"Something went wrong between the bot and the model…"_ | Unclassified. Usually Crewaid's fault rather than yours | The log has the provider's own words in the turn's error `detail`. Search by `botId` |

**Why switching models is the fix.** A bot's history can span several models,
so moving to another provider mid-conversation loses nothing. V1 doesn't fall
back to another provider on its own. You pick the model.

**Fixed when** the bot answers after _"carry on"_.

---

## 3. Spend is higher than it should be

There is **no automatic spending cap**: CC-26 removed it. Nothing stops a bot
for costing too much. You notice, and then you stop it.

**See what is spending.** Tokens per bot per day, straight from Postgres:

```bash
docker exec -it crewaid-postgres psql -U crewaid crewaid -c \
  "select b.name, date(t.\"startedAt\") as day, count(*) as turns,
          sum(t.\"inputTokens\") as input, sum(t.\"cachedInputTokens\") as cached,
          sum(t.\"outputTokens\") as output
     from \"AgentTurn\" t join \"Bot\" b on b.id = t.\"botId\"
    where t.\"startedAt\" > now() - interval '3 days'
    group by 1, 2 order by 2 desc, 4 desc;"
```

For dollars, `GET /api/v1/usage?from=YYYY-MM-DD&to=YYYY-MM-DD` prices the same
counters with the per-provider price table (CC-12). It needs your session token
as `Authorization: Bearer <token>`.

**Stop it**, in order of how much it stops:

1. **The turn in progress**: press **Stop generating** in that bot's composer.
2. **What keeps starting new turns.**
   - **Routines**: in the bot's Routines panel, switch the routine off. This includes follow-ups the bot scheduled for itself, which are marked as the bot's.
   - **Bot-to-bot messages**: see entry 4.
3. **Everything, for a while**: stop the orchestrator. Nothing runs while it is
   down, and on restart any turn it cut off is marked interrupted (entry 5)
   rather than resumed.

**Bound it from now on.** These per-turn ceilings ship off. Setting one in
`.env` and restarting makes it a refusal:

| Variable | Bounds | §6/M5's value |
|---|---|---|
| `AGENT_MAX_TURN_TOKENS` | Input tokens accumulated over one turn | `150000` |
| `AGENT_MAX_TURN_MS` | Working time of one turn (approval waits excluded) | `600000` |
| `AGENT_MAX_CONTINUATIONS` | How often a turn stopped by a ceiling carries on by itself | `3` (shipped); `0` stops and waits for you |

---

## 4. A conversation between bots is stuck, or won't stop

**What you see.** A bot says it has asked another bot and then nothing comes
back. Or two bots keep messaging each other and the spend keeps climbing.

### Nothing comes back

Check these in order:

1. **An approval is waiting.** A new bot's `send_message` asks for your
   approval on every hop unless its rules allow it. Look for an approval card in
   the **sending** bot's conversation and approve or deny it.
2. **Redis or the delivery worker is off.** `redis` in `/health` must be `true`,
   and `BOT_MESSAGE_WORKER=true` on exactly one orchestrator. Without Redis,
   `send_message` refuses, and the bot is told why.
3. **The chain was cut.** When a ceiling stops a chain, **both** transcripts get
   a system message naming the ceiling (`CHAIN_MAX_HOPS`, `CHAIN_MAX_TOKENS` or
   `CHAIN_MAX_REPEAT_SENDS`). A chain also ends silently if one of its bots was
   deleted.
4. **The log**: `grep '"chainId":"<id>"'`. Every delivery, refusal and failed
   job is logged under its chain.

### It won't stop

- Press **Stop generating** on whichever bot is working. That ends the current
  turn. A message already queued for the other bot is still delivered.
- To end it for good, **deny** the next send approval. If that bot's rules
  allow `send_message`, change them back to ask.
- To make runaway chains impossible, set the ceilings. They ship off (D-047),
  and §6/M7's values are:

  ```bash
  CHAIN_MAX_HOPS=10            # deliveries in one chain
  CHAIN_MAX_TOKENS=200000      # tokens spent by every bot in the chain
  CHAIN_MAX_REPEAT_SENDS=3     # messages from one bot to one other bot, per chain
  ```

- To stop all bot-to-bot delivery right now, set `BOT_MESSAGE_WORKER=false`
  and restart the orchestrator. Queued deliveries wait in Redis until a worker
  runs again.

---

## 5. A reply stopped halfway after a restart

**What you see.** A reply ends mid-sentence, followed by the system message:
_"The orchestrator restarted while this bot was working, so the turn was stopped
partway. It is not resumed automatically — send another message to carry on."_

**What happened.** The orchestrator stopped (crash, deploy, reboot) during a
turn. On boot, every turn still marked running was closed as `INTERRUPTED`.
Every step it had finished was already saved, so what the bot did before the
stop (files written, tools called) is kept. Only the step in flight was lost.

**Do this.** Send the bot a message such as _"carry on"_. Its partial reply is
part of the conversation it reads (the system message isn't), and whatever it
did on its computer is still there.

**If a bot looks busy but nothing is happening** and there was no restart:

- **Stop generating** ends the turn.
- If the bot still won't take a message, restarting the orchestrator runs the
  same recovery.

**Fixed when** the bot answers the next message.

---

## 6. A bot says a plugin "needs to be reconnected"

**What you see.** The bot says a plugin (Gmail, GitHub, …) _"needs to be
reconnected"_ or _"stopped responding"_, and works on without it. In
**Settings → Plugins**, that plugin shows **Reconnect**.

**Why.** A plugin that isn't connected is left out of the bot's tools until it
is reconnected. The bot is told which one and why, so it can tell you instead
of failing at the call.

| Status | Usually | Do this |
|---|---|---|
| Needs reconnecting | The OAuth grant expired or was revoked, or the server issued no refresh token | **Settings → Plugins → Reconnect**, and sign in to the service again |
| Stopped responding | The plugin's server is down or unreachable | Wait, then **Try again**. For a custom server, check it is up |
| A custom server's token is rejected | The bearer token was rotated | **Add token** on that plugin and paste the new one |
| _"has a stored credential that cannot be read"_ | `CREDENTIAL_KEY` changed since it was stored | Reconnect. Tokens stored under the old key cannot be recovered |

⚠️ **Gmail, Google Calendar and Google Drive every seven days.** With an
_external_ OAuth consent screen still in "Testing", Google's refresh tokens
expire after seven days. Those plugins will need reconnecting weekly until the
app is published in Google Cloud Console.

**Fixed when** the plugin shows connected and the bot uses it again.

---

## 7. Local coding connector (`crewaid-connect`) won't run tasks

**What you see.** `local_code_task` refuses with `CONNECTOR_ON_OTHER_INSTANCE`,
`CONNECTOR_OFFLINE`, or `CONNECTOR_BUSY`, or `crewaid-connect` closes with
`CLI_OUTDATED` (WebSocket close `4003`).

**Single-orchestrator requirement.** Each local connector holds an in-memory
outbound WebSocket on `/ws/connectors` to one orchestrator process, and live
task dispatch is routed in-process (the `LocalConnector.connectedInstanceId`
column records which orchestrator owns the socket). Local connectors require a
**single orchestrator process** — if you run multiple orchestrator replicas
behind a load balancer, dispatches that land on a different replica refuse
explicitly with `CONNECTOR_ON_OTHER_INSTANCE` rather than timing out.

| Code / symptom | Means | Do this |
|---|---|---|
| `CONNECTOR_ON_OTHER_INSTANCE` | The laptop socket is attached to a different orchestrator replica than the one handling the bot's turn | Run a single orchestrator replica when using local connectors, or wait until Redis cross-replica routing is enabled |
| `CONNECTOR_OFFLINE` | `crewaid-connect` is not running or lost connectivity for more than the 60s mid-task grace window | Start `crewaid-connect` in the target repo again; check network reachability to `/ws/connectors` |
| `CONNECTOR_BUSY` | Another `local_code_task` is already running on that connector (strictly one task per connector at a time) | Wait for the active task to finish or cancel it before starting another |
| `CLI_OUTDATED` (close `4003`) | The laptop CLI's `protocolVersion` is older than the orchestrator's `MIN_CONNECTOR_PROTOCOL_VERSION` | Update `@crewaid/connector-cli` on the laptop and reconnect |
| Close `4001` | Token was rotated or the connector was revoked in **Settings → Local harnesses** | Re-authenticate the CLI with the new token, or remove the stale local config |
| Close `4002` | A second `crewaid-connect` instance connected with the same connector token and superseded this socket | Keep only one CLI process running per paired connector |

**Fixed when** the connector shows **Online** in **Settings → Local harnesses**
and `list_local_connectors` lists it as `ONLINE`.
