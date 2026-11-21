# infra/sandbox-image

The bot sandbox image (PRD §5). One computer per user, with private bot displays,
browsers, profiles and workspaces. The operator watches over RFB and drives with
real input events.

## Build

```bash
docker build -f infra/sandbox-image/Dockerfile -t crewaid/sandbox:dev .
```

**The build context is the repo root**, not this directory: since M3-PK-01 the
image bundles the skill executor from `packages/skill-runtime` (see "Skill
execution" below) and reads the exact esbuild pin from `apps/desktop`'s
manifest. The root `.dockerignore` keeps local state out of the context.

Builds natively on `linux/arm64` and `linux/amd64` — both verified. §5 pinned
the Chrome apt line to `arch=amd64`; Google now publishes `google-chrome-stable`
for arm64, so the Dockerfile reads the architecture from `dpkg` and the same
file works on an Apple Silicon dev machine and on either Hetzner server line
with no QEMU in the loop. A box with no Docker at all — none installed, no
daemon, no Postgres — is brought to this point by
[`scripts/docker-host-setup.sh`](../../scripts/docker-host-setup.sh), which
installs the tooling, starts Postgres/Redis, and builds this image from the
tree under test.

## Smoke test

```bash
python3 infra/sandbox-image/tests/smoke.py crewaid/sandbox:dev
```

Runs under the §5.1 limits and checks health, fixed geometry, RFB, and an
actual CDP WebSocket command from a peer container. Also verifies relay death,
clean shutdown, a wedged startup probe, and **restart**. Test containers and
their network are removed afterward. The sandbox-image CI workflow builds and
runs this test.

Restart is not the same boot. `docker start` after a kill replays the entrypoint
against the filesystem the previous run left behind, and that is the only path
out of `UNHEALTHY` — D-031 forbids replacing a stopped desktop with a fresh one,
because the bot's workspace lives inside it. Two cases cover it: the real
kill-and-start sequence, and a **planted** `/tmp/.X1-lock` naming pid 1. The
second one exists because the first is a coin flip — Xvfb refuses a display
whose lock names a live pid, and whether a restart trips that depends on which
pid the stale lock happens to name in the new namespace. M2-QA-04 found the
defect; the planted lock is what holds it still.

## Run

`DockerSandboxProvider` (M2-BE-01) owns this in production. To bring one up by
hand under the exact §5.1 constraints:

```bash
docker network create agent-net          # normally created by the provider
docker run -d --name crewaid-sandbox \
  --memory 2g --memory-swap 2g --cpus 1.0 --pids-limit 512 \
  --security-opt no-new-privileges --cap-drop ALL \
  --network agent-net --tmpfs /dev/shm:size=512m --restart no \
  crewaid/sandbox:dev
```

No host volumes, by design. Files the bot produces come back through the
session's `readFile()`.

## What it runs

`entrypoint.sh` starts the supervised processes in dependency order, each gated
on a readiness probe for the one before it: `dbus-daemon` → `Xvfb :1` →
`xfce4-session` (+`plank`) → `google-chrome` on private port 9223 → the `socat`
relay publishing CDP on 9222 (D-030) → `x11vnc` → `agent-bridge` → the screen
gateway. Cold start is about 5 s against §7.4's 20 s budget.

The screen gateway (D-223) is the one exception to the rule below: it runs in a
restart loop, so a gateway that dies comes back after a second and the desktop
stays up. A viewer service failing must not cost the bot its desktop.

**If any of them exits, the entrypoint exits non-zero** (§5) — including a
clean exit, which is mapped to 1. A component that shuts itself down tidily
still leaves a desktop missing a piece, and `exited 0` is the one state the
orchestrator would not replace. The log names which process died:

```
[entrypoint] plank (pid 91) exited with status 0 — tearing down the sandbox
```

## Ports

`5900` x11vnc (RFB) · `5901`-`5916` a seat's own window-scoped RFB stream
(D-046, WORKSPACE §20) · `9222` Chrome CDP · `7070` agent-bridge · `7071` the
screen gateway, on loopback only.

The screen gateway (`packages/screen-gateway`, bundled to
`/opt/screen-gateway/gateway.cjs`) serves this machine's screens straight to a
viewer that holds a grant (D-223): `GET /v1/stream?ticket=…&quality=…` is a
WebSocket carrying one seat's RFB updates, the same stream the orchestrator
serves, and `GET /health` answers `ok`. It is reached only through a provider's
authenticated preview, admits a ticket only if the key the bridge was given
verifies it, it names this computer and its port is a seat's, and it never
forwards input. It is never published, and neither is the bridge: 7070 has no
auth of its own.

None are published to a host interface. The machine's three are resolved by the
orchestrator through `getPortEndpoint` and must forward the endpoint's headers
(D-012); a seat's port is picked at seat creation out of the declared range,
published with the machine's own when the container is created — a container's
ports are fixed for its life and `setPorts` is deliberately not implemented,
so the range is what a seat can ever be handed — and resolved per seat through
the same `getPortEndpoint` call.

## agent-bridge (§5.2)

The bridge exposes eight internal-only routes:

| Method | Path | Response |
|---|---|---|
| `GET` | `/health` | `200` with display geometry, Chrome build and AT-SPI status; `503` when any check fails |
| `GET` | `/screenshot` | The current fixed framebuffer as uncached `image/png`; `503 SCREENSHOT_FAILED` on a bounded capture failure |
| `GET` | `/atspi/events` | `text/event-stream`; `event: atspi` frames carry JSON-safe event type, detail, source name/role and data |
| `POST` | `/skill/run?botId=<id>` | Validates `{ "script": string, "params": object }` and executes the script inside this container; the run's outcome is the response body |
| `GET` | `/seats` | The machine's seats (D-046): each one's bot label, CDP target, X window, RFB port and geometry; `?botId=<id>` answers that bot's own seat instead, `404 NO_SUCH_SEAT` when it has none |
| `POST` | `/seats` | Creates a seat from an optional `{ "botId", "profile", "identityRevision", "url", "width", "height", "left", "top" }`; `400 INVALID_SEAT_REQUEST` for unusable fields and `503 SEAT_UNAVAILABLE` for refusal. Idempotent only for the same bot, profile and revision; named profiles are exclusive |
| `POST` | `/seats/control?botId=<id>` | Internal replay fence: opaque UUID token, take/renew/release, bounded lease and drain. New replays refuse `HUMAN_IN_CONTROL` until hand-back or expiry. Take acknowledges only after existing runners exit |
| `POST` | `/screen/key` | D-223: `{ "publicKey", "session" }`, the orchestrator's ticket key and this computer's session, written to `$XDG_RUNTIME_DIR/crewaid-screen-ticket.json` for the screen gateway; `400 INVALID_SCREEN_KEY` for anything else |
| `POST` | `/seats/<seatId>/close` | Takes `{ "identityRevision" }`, refuses stale revisions, drains active replay, then closes all managed processes; incomplete shutdown retains the reservation. New replay during closure refuses with 409. `404 NO_SUCH_SEAT` for an id that is not open |

The SSE connection starts with `retry: 3000` and emits a comment heartbeat
every 15 seconds. Each subscriber has a bounded 256-event queue; a slow unused
v1 consumer loses its oldest event rather than growing the bridge indefinitely.

`POST /skill/run` accepts at most 256 KiB and rejects unknown fields. The
transport boundary — validation, 400/413/415 — is M2's and is unchanged.
Execution is M3's, and since M3-PK-01 a valid request runs inside this
container (see below).

The entrypoint blocks on `/health` before declaring the sandbox up. The other
routes fail independently, so a temporary screenshot or AT-SPI stream failure
does not turn a healthy desktop into a failed health probe.

## Skill execution (M3-PK-01)

`POST /skill/run` executes model-generated skill scripts **inside this
container**. Nothing about that execution happens in the orchestrator process
(PRD §7.3), and the executor is shipped into the image rather than installed at
runtime:

- **Runtime.** The image carries exactly one Node binary, copied from the
  pinned `node:22.23.2-bookworm-slim` stage in the Dockerfile — no apt package
  (bookworm ships the wrong major and unpins the patch), npm from the same pinned stage, and
  nothing fetched at container start. It runs as `bot` under the §5.1
  limits like every other process here; the container's isolation is unchanged
  (no new capabilities, no ports, no mounts, no docker socket).
- **Executor.** `packages/skill-runtime/src/runner.ts` is bundled by esbuild
  (version read from the repo's own pin) into
  `/opt/skill-runtime/runner.mjs`, built from the repository at the commit the
  image was built from. The exact `playwright-core` pin from the skill manifest
  ships with its native code/assets in `/opt/skill-runtime/node_modules`; no
  browser is downloaded or launched by the library. `/opt` is image-owned, so a running sandbox cannot
  rewrite it.
- **Skill source.** A compiled skill is a TS module that default-exports
  `async run(ctx, params)`. The runner writes it to a private temp file and
  imports it, so annotations are type-stripped by Node, not compiled: enum,
  namespace, and decorator syntax inside a skill is **not supported** and
  surfaces as a load error the run reports. Scripts may use the `SkillContext`,
  their params, and Node builtins — there are no packages to import.
- **Response contract.** The bridge answers `200` with the run's outcome:

  ```json
  { "ok": true,  "result": <json>, "logs": ["…"], "durationMs": 12 }
  { "ok": false, "code": "SKILL_EXECUTION_FAILED", "detail": "…", "logs": [], "durationMs": 3 }
  ```

  A script that throws is the second shape — the request was still served. A
  runner that cannot run at all (missing binary, crash, unreadable outcome,
  timeout) answers `500 SKILL_RUNTIME_FAILED` / `SKILL_TIMEOUT`, because then
  there is no outcome to report. One run is bounded by `SKILL_TIMEOUT_S`
  (600 s), and the outcome, logs, and details are all size-bounded; a result
  over 256 KiB fails the run with `SKILL_RESULT_TOO_LARGE` rather than
  truncating. The outcome travels back through a file, so anything the skill
  prints to stdout cannot corrupt the response.

The `ctx` methods are the PRD §6/M3 `SkillContext`: `click`, `doubleClick`,
`type`, `key`, `screenshot`, `waitFor`, `log` — real input through `xdotool`
and real captures through `scrot` in this container's display — plus the
browser adapter: `ctx.page` uses native Playwright strict locators, actionability,
`fill`, `waitForSelector`, `waitForLoadState`, and explicit nested `frameLocator`
scopes. Timeouts are positive, at most 60000 ms (default 10000). It connects lazily
with `noDefaults: true` to the bridge-authorized private bot seat, validating bot,
seat, readiness and port before CDP discovery. There is no global/default endpoint
or new browser/context/page. An X11-only replay never starts Chrome. A selected
page's popup becomes selected, and closing it returns to a live existing page.
The runner aborts outstanding browser work and stops loading before disconnecting;
Chrome and its login profile stay alive. Replay admission covers the entire process
so human control waits for it to exit; replay during control is refused (D-169).

Recording keeps its independent CDP capture. Root-relative iframe/shadow selectors
and text uniqueness measured with a different matcher retain their demonstrated
X11 fallback. The compiler never guesses a frame/host path; reviewed explicit frame
locators and native text selectors are supported by the runtime. See D-172.

## Known deviations from §5

Each is documented at the line that makes it; the first is ratified as
**D-027** and the third as **D-030**:

1. **`--no-sandbox` on Chrome.** §5's flag list and §5.1's `cap_drop: ALL` +
   `no-new-privileges` are mutually exclusive — Chrome's zygote dies at startup
   and the container never reaches `RUNNING`. The container is the trust
   boundary here (§7.3 runs model-generated skills inside it), so the
   constraints win and Chrome gets the flag. §5.1 is **not** relaxed.
2. **`procps` added to the package list.** debian-slim ships no `ps`, and
   M2-QA-04 has to signal one named supervised child to prove the exit contract.

3. **CDP TCP relay, ratified as D-030.** Headed Chrome ignores
   `--remote-debugging-address` and binds loopback, so §5's flag produced a port
   that answered inside the container and refused every connection from outside
   it. Chrome now listens privately on 9223 and a supervised `socat` relay
   carries the contractual port 9222 for HTTP and WebSockets. The external port,
   and therefore everything downstream of it, is unchanged.

## Open for M2-BE-09 — two isolation gaps, both measured

### Bots are not isolated from each other

Every sandbox joins one shared `agent-net`, and the RFB and CDP ports listen on
`0.0.0.0` within it because the orchestrator has to reach them. Without the host egress policy, nothing else on
that bridge is fenced off, so with two bots running:

```
botA -> http://<botB>:9222/json/version   {"Browser": "Chrome/152.0.7977.82", ...}
botA -> tcp://<botB>:5900                 RFB 003.008
```

CDP is unauthenticated and drives the browser, so this is not "bot A can see bot
B" — it is bot A navigating bot B's browser, reading whatever B is signed into,
and watching its screen. Skill code is model-generated and runs inside these
containers (§7.3), which is the population this matters for.

The relay (D-030) did not create this; binding CDP where the orchestrator can
reach it does, and §5 requires that. The fix belongs with the `agent-net`
firewall rules: bot containers need a route to the orchestrator and to the
internet, and no route to each other. A per-bot network, or iptables rules that
drop bridge-internal traffic between sandbox IPs, both satisfy that.

### Postgres and Redis are reachable from a sandbox

Verified on this image, on `agent-net`, with the §5.1 flags above:

```
docker.sock inside the container   ABSENT      (§5.1 / R5 satisfied)
host bind mounts                   none        (§5.1 / R5 satisfied)
Postgres via the agent-net gateway REACHABLE   <-- §7.3 violation
Redis    via the agent-net gateway REACHABLE   <-- §7.3 violation
```

A separate user-defined bridge is **not** sufficient. `infra/compose` publishes
Postgres and Redis on host ports, and every container can reach a published
port through its own default gateway (`172.x.0.1`) regardless of which network
it sits on. §7.3's "no route to Postgres or Redis" therefore needs the iptables
rules on `agent-net` that M2-BE-09 owns — denying RFC1918 destinations covers
the gateway — or those ports must stop being published in the VPS deployment.
The host installer and mandatory service ordering are documented in
[`infra/compose/README.md`](../compose/README.md#install-the-sandbox-egress-policy-linux-daemon-host).
The image alone does not apply this policy. M2-QA-06 must verify the deployed
image and host together; the unprotected baseline above remains reproducible
when the installer has not run.

The shared computer image also includes Git and native build tools. Bots can create separate
Git worktrees and use Node/npm to install and build project dependencies as the unprivileged
`bot` user. The machine’s existing volume preserves those worktrees across restarts.

### Display-seat routing

Seats expose whole fixed-size X displays. RFB uses 5901–5916; CDP uses published
relays on 9301–9316, forwarding to Chrome's private loopback ports 9317–9332.
The Docker provider publishes both seat ranges. Replace existing containers when
upgrading; restarting cannot update their port bindings.

`GET /screenshot?botId=<id>` captures the selected live seat.
`POST /skill/run?botId=<id>` runs the unchanged `{script, params}` body on that
seat's display and browser. Replay requires a live private seat; omitting `botId`
is refused. Machine-level screenshots remain available for health/smoke tooling.
The orchestrator ensures a seat before replay and supplies the bot id for recording
screenshots. Control requires an acknowledgement from the updated bridge: an old
image without the replay fence cannot grant control. Rebuild the image from this
source and replace development containers before using the updated screen client.
A bridge exit ends its supervised computer; it is never restarted in place while
old runner processes survive.

At boot, legacy named profiles are moved from `.chrome` into `.seats`, with
their Chrome encryption metadata. Retirement removes either layout.

## Browser launch metadata

The internal seat response includes the actual `profile`, `identityRevision` and `browserGeneration`.
The generation is zero before lazy Chrome launch. Before every launch the bridge
atomically reserves a new safe-integer generation in the profile's
`.crewaid-browser-generation` marker, flushes it, and returns that generation with
the ready browser. Reconnects keep it; relaunch and named-profile transfer advance
it. Corrupt or exhausted markers refuse launch instead of recycling a generation.
The orchestrator requires this metadata; install the matching sandbox image.
Playwright connects to the private CDP relay with `noDefaults: true` and leaves
Chrome alive when the turn disconnects. CDP recording remains independent.

The registry remembers the highest requested identity revision for each bot until
the computer stops. A stale create, browser start or close cannot restore an older
selection. It retains a profile/slot during failed cleanup and confirms process-group
exit before forgetting the holder. Chrome singleton cleanup refuses a live or unknown
same-host lock owner. This preserves cooperative product controls within the shared
same-UID computer; arbitrary shell access is not isolated between bots.

`python3 infra/sandbox-image/tests/identity_handoff.py <image>` exercises actual
Chrome storage, private concurrency, simultaneous named acquire, graceful transfer,
stale requests, browser replacement, replay drain, stop/start, crash during transfer
and live unowned singleton preservation. It uses a local fixture site, no real accounts
or model keys, and removes only its own container. Image CI runs it after supervision
smoke. Backup/restore and retirement acceptance remain M9-BE-04.
