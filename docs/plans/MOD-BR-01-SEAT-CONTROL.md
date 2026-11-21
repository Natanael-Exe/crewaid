# MOD-BR-01 — Seat control, browser freshness and login leases

Ratified by **D-163** on 3 October 2026, from `main` at `c1c35b5`. MOD-BR-02 implements the control
barrier, MOD-BR-03 the observed references, MOD-BR-05 the lease hardening, and MOD-SC-03/04 bind
the selected screen transport to it. MOD-BR-02's implementation and acceptance evidence
are recorded in `docs/reviews/MOD-CONTINUATION-2026-10-03.md`; observed references and
login lease hardening remain their separate tasks.

## 1. Baseline at ratification

- **Watching is driving.** `ScreenService.input` accepts input from any socket subscribed to a
  bot's screen: "membership IS the authorisation". Every open thumbnail could type into the seat.
- **Nothing stops the bot while a person drives.** Browser, desktop, shell and skill tools keep
  dispatching while the operator's input reaches the same display. The only takeover-aware code is
  the activity clock (`SandboxActivityService`, §8).
- **Held input is the viewer's job.** `renderer/screen/heldInput.ts` releases what the viewer saw
  pressed. A viewer that crashes or loses its socket leaves keys down that only it knew about.
- **A shared login is exclusive by accident of process state.** The bridge refuses a second seat on
  a profile another live seat holds (`seats.py`, D-060). That table is in memory. A bridge restart
  that leaves a Chrome running forgets the holder, and only Chrome's own singleton lock remains.
- **Grants are durable, holders are not recorded.** `BotIdentity` says a bot *may* use an identity.
  Which seat currently *has* it lives only in the bridge.

## 2. Three things that must not be confused

| Thing | What it grants | Where it lives | Lifetime |
|---|---|---|---|
| **View subscription** | Pixels of a seat | the screen transport (§4.2 today, MOD-SC-03 later) | while a socket watches |
| **Control lease** | Input to a seat, and a pause on the bot's seat actions | orchestrator memory, per seat, fenced by an epoch | seconds to minutes; renewed |
| **Identity grant** | Permission for a bot to open its browser on a named login | `BotIdentity` row (approval record) | until revoked |
| **Identity lease** | Which seat's Chrome is running on that login's profile now | the bridge, checked against Chrome's own lock | while that Chrome runs |

A subscription never confers a lease. A grant never confers a lease. A lease never outlives its
seat, and an approval is never a lease.

## 3. The trust domain

All of a user's bots run as one Unix user on one computer (D-046). Any of them can read the
others' files and browser profiles, and `shell` can reach any display. **The user's computer is the
trust boundary. Bots on it are not isolated from each other, and nothing below claims they are.**
The control barrier keeps the *supported* automation paths off a seat a person is driving. These
bypasses are documented, not guarantees broken:

- A process a bot started earlier in the background (a `shell` command left running, a cron entry
  in the container) can still send input to the display.
- Another bot's `shell` can name this seat's display. Admission gates a bot's `shell` on its own
  seat only; refusing every bot's shell while any seat is held would stop the whole computer for one
  person's takeover.
- Anything a bot can write to disk, another bot can read, including a browser profile's cookies.

## 4. The seat control state machine

Each seat (one per bot, D-060) carries:

- `mode`: `agent`, `draining` or `human`;
- `epoch`: a counter that rises on every grant and every hand-back;
- `observationRequired`;
- the holder: user, session and socket;
- `leaseExpiresAt` and `drainDeadline`;
- `inFlight`: the agent seat actions already dispatched;
- `held`: the keys and buttons the server has seen pressed and not released.

| From | Event | To | Effects |
|---|---|---|---|
| agent | `take` from a subscribed socket | draining | holder ← requester; `drainDeadline` ← now + `SEAT_CONTROL_DRAIN_MS`. New agent seat actions wait at admission (§5). If `inFlight` is 0 the grant follows at once. |
| draining | `inFlight` reaches 0 | human | `epoch`++; `leaseExpiresAt` ← now + `SEAT_CONTROL_LEASE_MS`. Every subscriber is sent the new state. |
| draining | `drainDeadline` passes | agent | The request is refused `DRAIN_TIMEOUT`. Waiting agent actions proceed. **Exclusivity is never claimed** for a seat that did not drain. |
| draining | requester releases, disconnects or signs out | agent | Waiting agent actions proceed. |
| human | `renew` from the holder socket at the current epoch | human | `leaseExpiresAt` extended |
| human | `take` from any other socket | human | refused `NOT_CONTROLLER`. There is no stealing; the lease's expiry is the bound on an absent holder. |
| human | `release`; lease expires; holder socket closes; its session is revoked (D-149); the seat or its browser stops or is replaced | agent (**hand-back**) | Release everything in `held` to the display (key-up, button-up). `epoch`++. Every observed browser reference is invalidated (§6). `observationRequired` ← true. Every subscriber is sent the new state. |

Late events from a superseded holder (a `renew`, a `release`, input) carry or imply an older epoch
or a different socket, and are refused `STALE_EPOCH` or `NOT_CONTROLLER`. They change nothing.

**Restarts.** Control state lives in orchestrator memory and is never persisted.

- An orchestrator restart closes every socket, so no holder survives it. Every seat starts in
  `agent` with `observationRequired` true. The server no longer knows what was held, so the first
  time it reaches each display it releases every modifier and mouse button there.
- A bridge restart is a hand-back for every seat it serves. The orchestrator cannot tell which
  seats' browsers survived, so it treats each as replaced (§6). The person takes control again if
  they still want it.

## 5. Admission: every seat mutation path

Enforced at the one place a tool call is dispatched: today the registry's execution wrapper, after
MOD-AI-05 the `onBeforeToolCall` re-check (D-159 §3.6). Enforced again at the bridge for skill
replays.

| Path | Class | In `draining` / `human` | After hand-back |
|---|---|---|---|
| `browser_navigate`, `browser_click`, `browser_type` | seat action | waits for `agent` up to `SEAT_CONTROL_AGENT_WAIT_MS`, then refused `HUMAN_IN_CONTROL` | refused `OBSERVATION_REQUIRED` until an observation runs |
| `mouse_move`, `mouse_click`, `mouse_scroll`, `keyboard` | seat action | same | same |
| `shell` | seat action: it can reach the display | same | same |
| `run_skill` | seat action; a running replay counts in `inFlight` | same. An in-flight replay that outlasts the drain makes the take fail `DRAIN_TIMEOUT`, and the operator can cancel the bot. | same |
| `use_identity` | seat action: it replaces the seat's browser | same | same |
| `browser_read`, `screenshot`, `capture_screen` | observation | allowed; it does not clear `observationRequired` | allowed; **clears** `observationRequired` |
| `record_screen_start`, `record_screen_stop` | recording control | allowed: teaching is a person driving while the bot records | allowed |
| `fs_read`, `fs_write`, `attach_file`, `save_skill`, board, memory, Work, `send_message`, routines, bot management, MCP | not seat actions | unaffected. Control is over the screen and browser, not the files. | unaffected |

- A wait for control does not count as a step. A cancel ends it. The turn's time limit still applies.
- A refusal is a tool *result* carrying one of the codes in §8, worded for the model to act on.
- Human input is admitted only from the holder socket while `mode` is `human`. It is then teed to
  the recording before it is forwarded (§4.3 order, unchanged). The server records each press in
  `held` and clears it on the matching release. Input from any other socket is dropped with an
  `error` frame naming `NOT_CONTROLLER`. A subscriber that holds no lease is an observer and can
  only watch.

## 6. Browser freshness

- Each seat has a **browser generation**. It rises whenever the seat's Chrome is launched,
  relaunched, or replaced on another profile.
- Each observation that returns element references opens a **snapshot generation**.
- A reference names its seat, browser generation, snapshot generation and element ordinal.
  MOD-BR-03 writes the string format.
- A reference is **invalid** after any of these:
  - a top-level navigation;
  - a new browser generation;
  - a hand-back;
  - a newer snapshot of the same tab.
- An action on an invalid reference is refused `STALE_REFERENCE`. It **never** falls back to a
  guessed selector or a first match.

## 7. Login leases

- **Authority is the bridge's, checked against the disk.** Before launching Chrome on a profile, the
  bridge reads Chrome's `SingletonLock` in that directory. If the lock names a live process on this
  host that no seat owns (an orphan from before a bridge restart), the bridge refuses
  `IDENTITY_IN_USE`, or reaps it after a graceful flush (MOD-BR-05 picks which). At most one live
  Chrome per user-data-dir, always.
- **Transfer happens only after exit.** A bot asking for an identity another seat holds is refused
  `IDENTITY_IN_USE`, with the holding bot named. There is no pre-emption. The operator closes the
  holder's browser from the UI, which flushes and exits it, and then the next bot may open it.
- **The orchestrator mirrors, never decides.** It records the holder the bridge reports, to show
  "in use by Quill" in the UI, and it clears the record when the bridge says the browser exited.
  It never tells a bot an identity is free on its own knowledge.
- **A revoked grant while held** closes the holder's browser at the next point where `inFlight` is
  0, as a drain does. It is a browser replacement, so references die with it.
- **Computer stop or start** ends every lease. **A crash during a hand-off** releases the lock with
  the process. Chrome's own recovery handles the profile, and the next opener is the next holder.
- **Concurrent private seats are unaffected.** Two bots on their own profiles run side by side.
  Only a named login serialises.

## 8. Wire and configuration (ratified names)

The payload schemas live in `packages/shared/src/seat-control.ts`, with fixture pairs:
`ScreenControlPayloadSchema`, `ScreenControlStatePayloadSchema`, `SeatControlRefusalCodeSchema` and
the enums they use. MOD-BR-02 registers the two frames when it implements them. Until then they
are exported but on no registry, so no reducer or gateway changes for them yet.

- **`screen.control`** (client → server, §4.2): `{ botId, action: 'take' | 'renew' | 'release',
  epoch? }`. `epoch` is required for `renew` and `release`.
- **`screen.control.state`** (server → client, §4.2, sent to every subscriber of the seat on every
  transition and on subscribe): `{ botId, mode, epoch, holder, leaseExpiresAt?, drainDeadline?,
  observationRequired }`.
  - `holder` is `'self' | 'other' | null` relative to the receiving socket, so no session or
    socket id ever leaves the server.
  - `leaseExpiresAt` is present when `mode` is `human`; `drainDeadline` is present when `mode` is
    `draining`.
- **Refusal codes**: `HUMAN_IN_CONTROL`, `OBSERVATION_REQUIRED`, `DRAIN_TIMEOUT`, `NOT_CONTROLLER`,
  `STALE_EPOCH`, `STALE_REFERENCE`, `IDENTITY_IN_USE`, `SEAT_UNAVAILABLE`.
- **Config** (read by MOD-BR-02, which adds them to `turbo.json`, `.env.example` and the self-host
  compose file):
  - `SEAT_CONTROL_DRAIN_MS` (default 5000);
  - `SEAT_CONTROL_LEASE_MS` (default 30000, renewed every third of it while the expanded view has
    focus);
  - `SEAT_CONTROL_AGENT_WAIT_MS` (default 120000).

When MOD-SC-03 selects a transport, its native input path must call the same admission. A
streamer's client-side view-only flag, or a private port, grants nothing (D-158).

## 9. What MOD-BR-02 must prove

1. A take during a slow agent action drains.
2. A take whose drain times out is refused, and the bot keeps the seat.
3. During human control every seat action waits and then refuses, while reads still work.
4. Input from an observer socket, a stale socket, a closed holder, and a duplicate take, renew or
   release never reaches the display.
5. A hand-back after the person navigated refuses the bot's next action until it observes, and its
   old references are refused `STALE_REFERENCE`.
6. A holder that disconnects with Shift held leaves no key down.
7. A bridge or orchestrator restart during control leaves the seat in `agent` with
   `observationRequired`.
