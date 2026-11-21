# Sandbox workspace and lifecycle contract

**M2-AR-01 / M3-AR-01 / M5-AR-01.** Ratified as **D-039**, **D-041** and **D-046**;
`docs/DECISIONS.md` wins over `docs/PRD.md` wherever they conflict, and PRD §5 explicitly defers
to this document ("Specify paths, ownership, retention, and migration before implementing
storage").

D-031 decided the *policy* — bot identity and saved workspace outlive a container; no arbitrary
host mounts; no silent empty replacement; capacity admission; idle stop; reconciliation that never
deletes a workspace. It deliberately left the mechanism open. This is the mechanism, at the level
of detail **M2-BE-10**, **M2-BE-11**, **M2-BE-12** and **M2-QA-08** can be built and tested from.

Where a claim below was measured rather than reasoned, the measurement is given.

Implementation status: §2–§13 shipped in M2. D-041's M3 extension is specified in §14–§18;
M3-BE-10 implements provisioning and migration, M3-BE-11 implements ensure-ready and execution
ownership, CC-16 implements the automatic screen-card wake, and M3-QA-07 verifies the complete
lifecycle.

**M5-BE-17 implements §19's computer ownership and shared lifecycle.** Read the older
§2–§18 workspace keys as computer ids: `Sandbox.userId` owns the computer and
`Bot.sandboxId` attaches its tenants. Existing machines take their former bot's id, preserving
all volume names, labels and runtime references. New machines have independent ids. The provider's
legacy `botId` option and `crewaid.botId` label carry that computer id.

Create and backfill serialize on the user row before selecting a computer; duplicates select the
source computer. Deletion and repair lock User → Bot → Sandbox. Capacity counts computers, idle
stop checks every tenant, and retention checks the Sandbox row rather than a departed bot. Lifecycle,
health and reconciliation transitions emit the existing bot-keyed frames for every attached bot.
Git, npm and native build tools are installed in the image for §21's project worktrees.
Per-bot seats (§20) and private/shared directory management remain the sequenced M5-BE-18/19 work.

M3-BE-10 implements §14–§15: create/duplicate provision inside a bounded 30-second database
transaction, using a short networkless helper to seed home. Backfill starts in the background at
boot and retries once per minute (disabled with the existing `SANDBOX_RECONCILE_ON_BOOT=false`
test switch); each bot uses the same owner-checked, User-then-Bot-then-Sandbox lock order as deletion.
The explicit start path performs the same check before admission. Runtime creation requires the
existing volume, so even a volume disappearing after admission cannot silently recreate storage.
`lastStartedAt` is also the lifecycle fencing timestamp: classification occurs before claiming it,
and a failed claimed start remains explicit recovery rather than resetting historical evidence.
The automatic wake callers and activity ownership in §16–§17 remain M3-BE-11 / CC-16 work.

---

## 1. What is durable, and what is not

| | Durable across | Not promised across |
|---|---|---|
| Files the bot creates under `/home/bot` | stop/start, container replacement, image update | — |
| The supported browser profile (`/home/bot/.chrome`) | stop/start, container replacement, image update | a Chrome major-version profile migration that Chrome itself refuses |
| Bot memory (Postgres rows) | everything; it is not in the container at all | — |
| Running processes, open windows, the X session | — | any stop, restart or replacement |
| Image-owned desktop config (§3) | — | **deliberately** replaced from the image on every boot |
| System packages installed at runtime (`apt install`) | — | any container replacement |

The last two are the ones to say out loud to an operator. A bot that installs a package into its
own container loses it the next time the container is replaced; the durable equivalent is a change
to the versioned base image. D-031 already forbids promising otherwise, and this contract does not.

---

## 2. Storage layout

> **Superseded in part by D-046 (§19).** "Per bot" below becomes "per computer", and a bot
> references the computer it works on. Everything else in this section — named volume not bind
> mount, ownership validated at attachment, the label check — is unchanged and is the reason the
> change is a key swap rather than a rewrite. §19 now supplies the ownership and lifecycle keys for §2.

**One Docker named volume per bot**, mounted at `/home/bot`.

```
name    crewaid-workspace-<botId>
labels  crewaid.botId=<botId>
        crewaid.managedBy=crewaid-orchestrator
mount   /home/bot   (read-write, the container's WORKDIR and $HOME)
```

A **named volume**, not a bind mount: R5 and §5.1 forbid arbitrary host paths, and D-031 permits
storage only where it is *provider-managed*. A named volume is exactly that — the daemon owns the
path, nothing in the orchestrator names a host directory, and the container still cannot reach the
host filesystem.

**Keyed on `botId`, never on `sessionId`.** They are the same string today (M2-BE-03 makes the
session id the bot id), and that is precisely why the distinction has to be written down: the
workspace belongs to the **bot** and must survive any change of session. A future sessionId that
diverges must not drag the workspace with it.

**Ownership is validated at attachment.** Before mounting, the provider reads the volume's
`crewaid.botId` label and refuses to start if it does not equal the bot being started. A volume with
no `crewaid.managedBy=crewaid-orchestrator` label is not ours and is never mounted. This is the
"validate ownership at attachment" requirement in D-031, and it is what keeps a reconciliation bug
from attaching one bot's workspace to another bot's desktop — the single worst failure available
in this design, because it is silent and it leaks data between bots.

**Permissions.** Docker populates an empty named volume from the image's content at that path,
preserving ownership, so `/home/bot` arrives owned by `bot:bot`. Measured: a fresh volume mounted
at `/home/bot` came up containing `.bashrc`, `.profile`, `.cache`, `.chrome` and `.config`, and the
`bot` user could write to it without any `chown` step.

---

## 3. Image-owned paths, and why a volume at `/home/bot` is not enough on its own

**The hazard, measured.** A named volume is populated from the image *only while it is empty*.
Once populated it is frozen with respect to the image. Measured on `crewaid/sandbox:dev`: after
deleting `/home/bot/.config/plank` from the volume and re-running the same image, the directory
stayed gone, while a user-created file survived.

That matters because the image seeds desktop configuration under `/home/bot/.config` —
specifically plank's three dock launchers — and §5's acceptance criteria include *"the Electron
screen panel shows the XFCE desktop with Chrome, Thunar, and a terminal in the dock."* A plain
workspace volume would freeze every bot's dock, shell config and XDG layout at whatever the first
boot happened to write, and D-031's "supported image replacement" would be aspirational: the files
would survive, but the desktop would never improve.

**The mechanism: a pristine skel outside the mount point.**

```
/opt/crewaid/skel/...      in the IMAGE, outside /home/bot, so the volume cannot shadow it
```

The entrypoint copies the skel over `$HOME` **before the session bus and X start**, since plank
and xfce4-session read their configuration at startup:

```sh
cp -a /opt/crewaid/skel/. "$HOME"/
```

Two categories, and the difference is the whole point:

- **Image-owned — overwritten from the skel on every boot.** Whatever is *in* the skel is
  image-owned; the skel's contents are the manifest, so there is no second list to drift. Today
  that is `.config/plank/` and nothing else.
- **Bot-owned — created if absent, never overwritten.** `/home/bot/.chrome`, `/home/bot/.cache`,
  and the working tree itself. These must not appear in the skel at any point, ever: a skel entry
  for `.chrome` would silently reset every bot's browser profile on every boot.

**Verified end to end.** A v1 image seeded a volume; a user then wrote `notes.txt` and deleted the
Thunar launcher. Booting a v2 image with the skel sync restored the deleted launcher, added v2's
new launcher, and left `notes.txt` untouched.

**The accepted cost:** an operator's edit to an image-owned path does not survive a reboot — the
Thunar launcher came back. That is the correct semantic for config the image owns, and it is the
price of the dock tracking the image. Any path an operator is expected to customise must therefore
be bot-owned, and adding one is an image change, not a runtime one.

### 3.1 Durable paths accumulate locks

Making a path durable changes an assumption every program in it was written
against: that a fresh container means a fresh filesystem. Anything that writes a
lock file naming a process, a host, or a display now finds a stale one on the
next boot — and the programs that do this refuse to start rather than risk
corrupting state they think is in use.

**The entrypoint clears the stale locks it knows about, before the process that
would trip on them starts.** This is safe here and nowhere else, for the same
reason in each case: the entrypoint is pid 1 in a private pid and mount
namespace, before anything in the container has opened the resource, so a lock
found at that moment is always stale by construction.

Two are known, and both were found by running the thing rather than reasoning
about it:

| Lock | Written by | Symptom if left |
|---|---|---|
| `/tmp/.X1-lock` | Xvfb | `(EE) Server is already active for display 1`, boot dies. Intermittent — it depends on whether the recorded pid is live again in the new pid namespace. Found by M2-QA-04. |
| `$HOME/.chrome/Singleton{Lock,Cookie,Socket}` | Chrome | `The profile appears to be in use by another Google Chrome process … on another computer`, Chrome exits, the supervisor kills the sandbox. **Deterministic** on every container replacement, because the replacement always has a new hostname. Found by M2-BE-10's own workspace test. |

The Chrome one is the sharper lesson: it is a consequence *of* durability. The
X lock predates the workspace, but Chrome's profile lock only became a problem
the moment the profile started surviving — and it would have made D-031's "the
browser profile survives replacement, and a logged-in session is still logged
in" an empty promise, because Chrome would never have started to use it.

**So the rule generalises:** adding a bot-owned durable path means asking what
inside it assumes a fresh filesystem. The answer is usually a lock file, and the
place to deal with it is the entrypoint, before the owning process starts.

Durability also constrains shutdown order. A persistent Chrome cookie set through
CDP can be acknowledged before its batched SQLite write reaches the profile on
disk. Sending SIGTERM to Chrome, even before terminating X and D-Bus, and asking
the window manager to close Chrome both lost that cookie reproducibly. On a
requested container stop, the entrypoint therefore sends Chrome's own
`Browser.close` CDP command while the desktop dependencies are still live, waits
up to five seconds for Chrome to flush and exit, and only then falls back to
SIGTERM and tears down the remaining processes. M2-QA-08 holds this still with a
real persistent cookie across stop/start and container replacement.

---

## 4. The M2 lifecycle situations

D-031 requires these to be distinguishable. They are distinguished by two independent observations
— whether a **container** carries `crewaid.sessionId=<botId>`, and whether a **volume** carries
`crewaid.botId=<botId>` — never by the database alone, which can be stale, and never by container
state alone, which cannot tell a first run from a lost one.

| Container | Workspace volume | Situation | Action |
|---|---|---|---|
| absent | absent | **First creation** | Create volume, create container, start. The only path that may produce an empty desktop. |
| present, running | present | **Reattach** | Attach. Do not restart; do not touch the workspace. |
| present, stopped | present | **Start stopped** | `start` the existing container. Same container id (M2-QA-03/04). |
| absent | present | **Replacement from saved workspace** | Create a *new* container against the *existing* volume. |
| present | absent | **Inconsistent** | Refuse. Never mount a fresh empty volume under an existing container — see below. |

**The M2 forbidden transition.** Container absent + volume present must **never** be treated as
first creation when the provider has no independent proof that the volume was deliberately
provisioned before its first runtime. That is the exact failure D-031 was written against: a
missing container, an unsupported resume, or a transient daemon error silently producing a fresh
empty desktop, so the bot's files appear to have been deleted by the product. D-041 adds that proof
and §15 replaces this table for M3. Without the complete §15 evidence, the recoverable error stands
until replacement is selected and validated; `UNHEALTHY` with `lastError` is the state, not
`STOPPED` (already enforced by M2-BE-05 and asserted by M2-QA-04).

**Container present + volume absent** is the same class of fault seen from the other side, and is
also refused. Creating the missing volume would populate it from the image and hand the bot a
plausible-looking desktop with none of its history.

---

## 5. Exclusive writers

> **Re-scoped by D-046 (§21), not deleted.** The rule below is about the *volume*, and it stays
> true of a volume — what changes is whose volume it is. It becomes "at most one running container
> may mount a **computer's** workspace", and the three fences move with it. The rule it does NOT
> become is "one writer inside the container": several bots sharing one filesystem is the point of
> D-046, and §21 says what governs that instead.

**At most one running container may mount a bot's workspace.** Three independent fences, which is
the same defence-in-depth M2-QA-02 measured for container creation:

1. The per-bot start lock — `Sandbox.state = STARTING` as a compare-and-swap with a lease (D-029).
2. The container name is derived from the session id, so the daemon itself refuses a duplicate.
3. The ownership label check at attachment (§2).

Reconciliation (M2-BE-12) must additionally refuse to attach a volume that a *running* container
already mounts, even when the database has no row for that container — a provisioned-but-unrecorded
container is precisely the case where the first two fences have already been bypassed.

Read-only inspection of a stopped workspace (the retention reaper, §9) is not a writer and is not
subject to this rule, but must not run against a workspace whose container is running.

---

## 6. Image replacement and migration

The base image is **versioned** and the running container records the image reference it was
created from, so replacement is detectable rather than guessed.

- Replacement is **explicit**: an operator action or an orchestrator-initiated recovery, never a
  silent side effect of a start.
- Replacement destroys the container and creates a new one **against the same volume**. The volume
  is never recreated, never renamed, and never emptied as part of replacement.
- The skel sync (§3) is what makes the new image's desktop configuration take effect.
- Supported persistent paths are the bot-owned set in §3. Nothing outside `/home/bot` persists.

**Migration contract.** A change that alters the *meaning* of a bot-owned path — moving the browser
profile, changing its layout — requires a migration step that runs once per workspace and records
that it ran, inside the workspace. There is no such change today; the requirement exists so that
the first one is not improvised. A change to an image-owned path needs no migration by
construction, because the skel replaces it.

---

## 7. Capacity admission

A configurable ceiling on simultaneously running sandboxes, enforced **in addition to** the per-bot
start lock — the two answer different questions ("is this bot already starting?" versus "does the
host have room?").

- Admission counts sandboxes in `STARTING` **and** `RUNNING`, because a start in flight is already
  consuming the host. `UNHEALTHY` counts too: the container may still exist and still hold memory.
- A start that would exceed the ceiling is refused **explicitly**, before any Docker call:

  ```
  HTTP 503
  { "statusCode": 503, "code": "SANDBOX_CAPACITY",
    "message": "...", "detail": { "running": 6, "limit": 6 } }
  ```

  503 rather than 409: the condition is temporary and the same request will succeed later. The
  shape is the existing `ApiErrorSchema`; `code` is a free-form string there, so no error enum is
  extended. **A capacity refusal must not leave the row in `STARTING`** — it is refused before the
  lock is claimed.
- The refusal is visible to the operator as a capacity message, never as a generic failure. A bot
  that will not start because the host is full and a bot that will not start because Docker is
  broken are different problems with different actions.
- **Admission is serialized, not merely checked.** Counting occupied slots and then becoming one
  of them is a single invariant spanning rows, and Read Committed protects it not at all: two
  starts for two different bots touch different rows, block on nothing, and both read the same
  count. Measured on the M2-BE-11 implementation with the serialization removed — five
  simultaneous starts against a ceiling of **two**, all five admitted, while every sequential
  assertion still passed. So the count and the claim happen inside one transaction holding a
  transaction-scoped Postgres advisory lock (`pg_advisory_xact_lock`), held across two indexed
  queries and no Docker I/O and released by the commit or rollback. A ceiling that holds for every
  start except a burst fails exactly when it is needed: an operator starting a column of bots, or
  a restart bringing several back at once.
- **A bot that already occupies a slot is admitted without counting.** Restarting an `UNHEALTHY`
  sandbox adds no sandbox — the container is already there and already counted. Charging it for a
  slot it holds would make a full host one where the sick sandboxes can never be recovered, and
  would make §4.1's idempotent start answer "the host is full" about a sandbox that is running.
- Background/queued starts are **out of scope** here and are specified when jobs are introduced
  (D-031). M2 refuses; it does not queue.
- The default ceiling follows §7.5's sizing (six concurrent bots on 8 vCPU / 16 GB). It is a
  measurement target, not a proven guarantee — M2-QA-09 records the real numbers, and the default
  is expected to move.

---

## 8. Idle stop and leases

A running sandbox with nothing happening in it is stopped after a configurable idle period. The
workspace is untouched; this is a stop, not a deletion.

**What counts as activity** (resets the idle timer):

- An `AgentTurn` running for that bot.
- An active `Recording`.
- Manual takeover — the operator driving the desktop through `screen.input`.
- An explicit keep-running lease, held until its expiry.

**What does not count**, and this is the load-bearing half:

- **A screen subscription.** A rail thumbnail is one `screen.subscribe` at quality 3, kept open for
  as long as the app is; D-031 is explicit that maintaining a thumbnail must not keep compute
  alive. Watching is not working.
- Health polling. It is the orchestrator's own traffic.
- An open Electron window, a connected WebSocket, or a selected bot.

**Disconnecting does not cancel work.** An idle stop is never a way for a dropped socket to kill a
running turn; if a turn is running, the sandbox is by definition not idle.

Approval-aware suspension — pausing a sandbox that is blocked waiting for a human decision — is
M5, and requires state revalidation before continuing (D-031). It is not in M2.

---

## 9. Retention and deletion

**Deleting a bot does not immediately delete its workspace.** The container is destroyed at once;
the workspace is reclaimed after a configurable grace period (default 7 days). An accidental bot
deletion is otherwise unrecoverable and takes the browser profile — and every logged-in session in
it — with it.

**Never as orphan cleanup.** D-031 is explicit and it is repeated here because it is the rule most
likely to be broken by a well-meaning reconciliation change: a workspace is only ever deleted by
the retention path below. A runtime-orphan sweep (M2-BE-12) removes *containers*. It may never
remove a volume, whatever it finds.

**Mechanism.** A volume labelled `crewaid.botId=X` for which no `Bot` row `X` exists is *orphaned*.
The reaper records the first time it observed the volume orphaned by writing a marker inside the
volume itself, and deletes the volume once that marker is older than the grace period.

The marker lives in the workspace rather than in Postgres on purpose:

- It survives a database restore or a fresh database. A workspace whose reclaim deadline lived only
  in a table would become immortal the moment that table was lost — or, worse, be deleted early by
  a restore that resurrected an old row.
- It is self-healing and idempotent: a missing marker means "first observation", so a crash between
  deleting a bot and marking its volume costs a grace period, not a workspace.
- It needs no new table and therefore no PRD §3 deviation.

*Rejected:* a `WorkspaceReclaim` table. Easier to query, but it couples the fate of durable bot data
to the orchestrator's own database, which is the coupling this design is trying to avoid.

Re-creating a bot does not adopt an orphaned workspace: bot ids are cuids and are never reused, so
an orphaned workspace stays orphaned. Restoring one is an explicit operator action, out of scope
for M2.

The reaper checks once per minute, beginning one minute after boot. The configured retention
period must be a positive whole number of days. It writes `.crewaid-orphaned-at` inside the volume;
missing, malformed or future timestamps start a fresh grace period. Restoring the original Bot
row clears the orphan clock, as does an explicit workspace start. Any container reference,
including a stopped or unmanaged container, prevents volume deletion. Removal is non-forced.
The short marker helper has no network, capabilities, host mounts or writable root filesystem;
it runs isolated Python directly, not the sandbox entrypoint or workspace code. Old interrupted
helpers are cleaned up without deleting their attached volumes.

Bot deletion locks the bot and sandbox rows, destroys the runtime, then commits the database
cascade. An in-flight lifecycle operation returns a retryable conflict instead of racing deletion;
a teardown failure retains the database records for retry. Keeping workspace bytes is not an
in-app undo feature: profiles, conversations and bot identity still follow the database cascade.

---

## 10. Data model

Two additions to `Sandbox`, both nullable, both ratified as deviations from PRD §3 in the manner
`schema.prisma` already documents (see `Bot.autoReviewRules`) and pinned in
`test/schema-contract.test.ts`:

| Field | Type | Why |
|---|---|---|
| `lastActiveAt` | `DateTime?` | Idle stop needs a "since when" that survives an orchestrator restart. Derived state would restart the clock on every deploy and make idle stop unpredictable. |
| `keepRunningUntil` | `DateTime?` | The explicit lease of §8. A lease with no expiry is a leak; a lease held in memory does not survive the restart it is most needed across. |

**No field for the workspace volume name.** It is derivable (`crewaid-workspace-<botId>`) and the
authoritative record of ownership is the volume's own label. A stored copy could disagree with the
daemon, and a stored name that disagrees is worse than no name at all.

**No field for the image reference** in M2. Replacement is explicit (§6), so nothing depends on
detecting it automatically yet; when M2-BE-10 needs it, it is an additive column, not a redesign.

---

## 11. Configuration

New keys follow the existing `SANDBOX_*` convention and **must be added to `turbo.json`'s
`globalEnv`** in the same change — Turbo's strict env mode otherwise strips them, and a test gated
on one becomes a dormant guard (D-017).

| Key | Default | Meaning |
|---|---|---|
| `SANDBOX_MAX_RUNNING` | `6` | Host capacity ceiling (§7). §7.5's sizing; a measurement target. |
| `SANDBOX_IDLE_STOP_MS` | `1800000` | Idle stop after 30 minutes. `0` disables, matching `SANDBOX_HEALTH_INTERVAL_MS`. |
| `SANDBOX_WORKSPACE_RETENTION_DAYS` | `7` | Grace period before an orphaned workspace is reclaimed (§9). |

Each is read once, at construction, and a malformed value throws at boot rather than at first use —
the `auth.guard.ts` pattern.

---

## 12. What an implementer must not do

Collected because each one is a specific way this design fails silently.

1. **Do not treat "container missing, volume present" as first creation.** §4.
2. **Do not mount a volume without checking its `crewaid.botId` label.** §2.
3. **Do not put a bot-owned path in the skel.** A skel entry for `.chrome` resets every browser
   profile on every boot, and the symptom is "the bot keeps getting logged out". §3.
4. **Do not delete a volume from any orphan-runtime path.** §9.
5. **Do not let a screen subscription count as activity.** §8.
6. **Do not claim the start lock before the capacity check.** A refused start that leaves the row
   `STARTING` wedges the bot for the length of the lease. §7.
7. **Do not check capacity outside a critical section.** The count and the claim that makes it
   true are one invariant; separated, the ceiling holds for every sequential start and for no
   burst. Measured: five of five admitted against a ceiling of two. §7.
8. **Do not bind-mount a host path**, for any reason, including diagnostics. R5, §5.1.
9. **Do not add a bot-owned durable path without asking what locks it.** §3.1. The
   symptom is not a missing file; it is a program refusing to start, and the
   message usually blames another computer.

---

## 13. Acceptance

The tests M2-QA-08 and M2-QA-09 must cover, restated from D-031 as checkable statements:

- A file written in the desktop survives stop → start, and survives container replacement.
- The browser profile survives both; a logged-in session is still logged in.
- An image update changes the dock; the same update does not disturb user files. (§3's measurement,
  as an automated test.)
- A container replacement leaves Chrome able to start against the saved profile — the case §3.1
  exists for, and the one that turns "the profile survives" from a claim into a fact.
- Starting the (`SANDBOX_MAX_RUNNING` + 1)-th sandbox returns 503 `SANDBOX_CAPACITY` and leaves that
  bot's row untouched — not `STARTING`, not `ERROR`.
- An idle sandbox stops; one with a running turn, an active recording, or a held lease does not.
- A sandbox with only a screen subscription open **does** stop.
- Reconciliation with a provisioned-but-unrecorded container adopts or removes the container and
  leaves every workspace intact.
- Deleting a bot leaves its workspace for the grace period, and the reaper removes it afterwards.
- No test in the suite leaves a `crewaid-workspace-*` volume behind.

---

## 14. Provision storage at bot creation (M3)

Creation and duplication gain one postcondition: before the existing §4.1 response succeeds, the
bot has a `STOPPED` Sandbox row and an owned `crewaid-workspace-<botId>` volume. The provider exposes
an idempotent internal workspace-provision operation; this is not a desktop start and does not
create a container, publish ports, wait for bridge health, or enter capacity admission.

The volume remains Docker-managed and thin in the only meaningful sense available here: no disk
quota or image-sized copy is reserved for the bot. It consumes metadata plus bytes actually
written. Image layers are shared by Docker. The 2 GiB memory and 1 CPU provider limits remain
runtime ceilings, not reservations, and apply only after a container exists.

Provisioning must also seed the same initial `/home/bot` contents a first M2 container mount would
have produced. Pre-creating a non-empty volume changes Docker's copy-up behaviour, so an
implementation may not write lifecycle metadata into an otherwise empty volume and accidentally
suppress that seed. A short provider helper may populate and validate it, but it receives no
network, host mount, published port or desktop process.

### 14.1 Commit, failure and retry

The operation is a small saga because Postgres and Docker cannot share a transaction:

1. Open the database transaction and create the Bot, its Conversation and its original `STOPPED`
   Sandbox intent under one generated bot id.
2. Before that transaction commits, ensure the exact labelled workspace exists and is seeded;
   validate both the create and adopt branches because Docker volume creation is idempotent.
3. Commit and publish the successful bot response only after both stores agree.

If provisioning fails, the database transaction/request fails and no bot is published. If Docker
succeeds but the database commit fails, the only permitted residue is the correctly labelled
volume for a bot id with no Bot row. Do not delete it in rollback: the failure may be ambiguous,
and D-039 §9 retention already provides the conservative, recoverable cleanup path. A retry is
idempotent for the same bot id; a new request with a new id creates a new workspace and leaves the
old orphan to retention. A full runtime pool has no bearing on any of these steps.

Deletion keeps D-039's lock order. Provisioning rechecks the Bot intent before publishing success;
if deletion wins, no runtime is created and any unattached volume is retained as an orphan. No
provisioning compensation may force-remove a volume or a container reference.

### 14.2 Existing bots

M3-BE-10 runs an idempotent reconciliation over every existing Bot. A bot with neither Sandbox row
nor workspace receives the original `STOPPED` row and provisioned volume; a bot with a valid
workspace adopts it without replacing bytes; a bot with any contradictory runtime/workspace
evidence follows §15 recovery and is not rewritten into “never started.” The sweep starts no
container and consumes no capacity slot. Individual failures are recorded/logged and retried on a
later sweep; ensure-ready performs the same idempotent check so one failed batch cannot leave a bot
permanently unusable.

## 15. Never-started is evidence, not “no container”

M3 intentionally introduces **provisioned, never started**: volume present, container absent. It is
safe to create the first runtime only when all of these independent observations agree:

- a Bot row exists for the workspace's `crewaid.botId` label;
- the Sandbox row is the original `STOPPED` intent with `sessionId`, `containerId`, and
  `lastStartedAt` all null;
- the provider finds the exact labelled workspace and no container references or mounts it; and
- the workspace has no durable `.crewaid-runtime-created-at` marker.

The provider writes `.crewaid-runtime-created-at` immediately after the first container is created and
before starting it or publishing success. It contains the positive creation time as Unix
milliseconds, written by the same isolated helper discipline as `.crewaid-orphaned-at`. The marker is
lifecycle evidence, not user data and not a configuration key. It is checked together with the
database and daemon observations rather than trusted alone: deletion, a symlink, a non-regular
file, a malformed value, or a future value produces disagreement and therefore recovery, never
permission to create an empty workspace. A failed container create before the marker is written
remains retryable first start; once a container has been created against the workspace, the marker
is written even if later startup or readiness fails, because subsequent work is recovery from a
failed runtime.

| Durable evidence | Runtime observation | Classification | Allowed action |
|---|---|---|---|
| original never-started row; no marker | no container; owned volume | **Provisioned, never started** | Create first container against that volume. |
| prior-start row or marker | matching stopped container; owned volume | **Stopped** | Start the existing container. |
| prior-start row or marker | no container; owned volume | **Lost runtime / saved workspace** | Enter explicit replacement recovery; never call it first start. |
| any | running matching container; owned volume | **Reattach** | Reuse it after readiness. |
| observations disagree | any | **Inconsistent** | Fail closed as recoverable error; preserve workspace. |

The first-runtime marker does not replace the volume ownership labels, database start lease or
exclusive-writer check. Those answer different questions. Reconciliation may repair stale row
details only after the daemon and marker evidence identify the same lifecycle class.

## 16. One automatic ensure-ready path

All callers that need a computer use one orchestrator-owned operation. It first ensures §14
storage, then reuses D-039 capacity admission, per-bot start serialization, resume/create recovery,
and bridge health readiness. Simultaneous screen, recording and skill callers receive the same
ready runtime; they do not create one container each. The operation is internal—M3 adds no REST
route or WebSocket event. Existing authenticated lifecycle APIs remain the transport where a
client needs one.

These actions request readiness:

- explicitly opening the computer from its rail card;
- starting a recording/teaching session;
- beginning a skill, agent tool or later routine step that requires the computer.

These actions do not: selecting a bot or conversation, rendering a collapsed card/thumbnail,
subscribing to frames, health polling, or keeping the app/socket open. A message such as “open this
link and fill the form” wakes the runtime when its browser tool begins, even if the user never
opened the screen card. Conversely, a text-only turn need not wake a computer.

Switching away and disconnecting only detach the viewer. Neither invokes stop nor cancels work.
The idle policy in §8 decides when the runtime can stop.

### 16.1 Capacity and retry

Admission runs only if ensure-ready needs to start/create a container. At capacity, an interactive
caller receives the existing `503 SANDBOX_CAPACITY`; the Sandbox remains `STOPPED`, the workspace
remains ready, and the screen UI shows capacity separately from runtime failure with a retry
action. Concurrent retry still passes through serialized admission.

M3 does not add a queue. A future background scheduler may defer and retry with bounded backoff,
but it must preserve the same ceiling, revalidate ownership/work state before each attempt, and
must not evict a sandbox with active ownership merely to make room.

## 17. Activity ownership and supported background work

An idle decision uses positive durable evidence. Ownership must exist **before** ensure-ready can
race an idle-stop claim:

- a non-terminal `AgentTurn` owns computer work for that turn;
- a `Recording` in `RECORDING` owns its capture;
- a managed operation without one of those rows acquires a bounded renewable
  `keepRunningUntil` lease, renews while it has positive progress/liveness, and stops renewing on
  success, failure or cancellation;
- accepted manual input advances `lastActiveAt`; merely receiving frames never does.

`keepRunningUntil` is monotonic while active: a caller may extend it, never shorten it. “Release”
means stop renewing and record final activity, not clear a shared deadline that another owner may
still depend on. Expiry is bounded crash recovery. The ordinary idle interval begins after the
latest durable work/activity mark, so a completed owner does not cause an immediate stop.

**The bound is derived, not configured** (M3-BE-11). D-041 adds no configuration key, and a lease
shorter than the interval that checks it would be a policy that fires between its own sweeps. So a
lease lasts three idle sweeps — three minutes at the §11 defaults, and never longer than the idle
period itself, because a crashed owner must not buy a sandbox more uptime than doing nothing would
have. Owners renew three times per bound, so two consecutive failed renewals still leave protection
standing. That is the bound §18 crashes an owner to measure.

Background work is supported only where there is a positive lifecycle signal. A skill/tool request
remaining active, a managed process handle that reports exit, or a browser download lifecycle that
reports completion may renew protection after the viewer leaves. The shipped manual terminal and
browser paths must expose such start/completion evidence before the product claims their jobs or
downloads survive beyond normal input-idle grace. A detached daemon, arbitrary process, or app
with no lifecycle signal is explicitly unsupported in M3; process count, focus, selected bot,
screen changes and low CPU are not substitutes for ownership. If a signal is lost, its bounded
lease expires rather than pinning a runtime forever.

## 18. M3 acceptance additions

M3-QA-07 adds these checks to §13:

- Create more than ten bots while the runtime ceiling is full: every bot gets isolated storage,
  no new container, no reserved CPU/RAM, and no `SANDBOX_CAPACITY` creation failure.
- Provision failure, retry, concurrent deletion and bootstrap migration preserve ownership and
  leave only retention-managed orphan volumes; never-started reconciliation starts nothing.
- Wake a fresh bot from explicit screen access and from computer-requiring work; text-only
  selection/messages do not wake it. Concurrent wakes produce one runtime.
- Capacity refusal preserves the stopped workspace and a later retry succeeds without data loss.
- Switching bots or disconnecting a viewer does not stop ongoing work. An owned managed job or
  download survives the switch, then idle stop releases the runtime after ownership/activity ends.
- Crash an activity owner: protection expires within its documented bound. Passive viewing, low
  CPU and selection never protect a sandbox.
- Measure volume growth and host usage for never-started, stopped and running bots; do not change
  the six-runtime default without those measurements.

---

## 19. The computer is the unit of storage; a bot is a tenant of one

**M5-AR-01, ratifying D-046.** One named volume per **computer**, mounted at `/home/bot`, with the
bots attached to that computer sharing it.

```
name    crewaid-workspace-<computerId>
labels  crewaid.computerId=<computerId>
        crewaid.managedBy=crewaid-orchestrator
mount   /home/bot   (read-write, the container's WORKDIR and $HOME)
```

Everything §2 says about the *mechanism* is unchanged and deliberately so: a named volume rather
than a bind mount (R5 and §5.1 still forbid host paths), ownership validated by label before every
attachment, and a volume without `crewaid.managedBy=crewaid-orchestrator` is never ours. Only the key
changes. That is what makes this a migration rather than a rewrite.

**What `/home/bot` now contains.** The home directory is the machine's, not a bot's. Three kinds of
path, and the distinction is a convention the tools enforce, never a boundary (§22):

| Path | Who | Why |
|---|---|---|
| `/home/bot/agents/<botId>/` | one bot | scratch, notes, work in progress |
| `/home/bot/shared/` | every bot on the machine | the project, worktrees, the board, memory |
| `/home/bot/groups/<groupId>/` | the bots in that group (D-131) | files the group shares; kept when the group is deleted |
| `/home/bot/.chrome/<botId>/` | one bot | persistent cookies and browser state, isolated by profile (§20) |
| `/home/bot/.chrome` metadata and `Default`, `.config`, `.cache` | the machine | browser-wide state and desktop configuration |
| `/home/bot/.crewaid-deleted-profiles/` | the machine | durable profile-retirement tombstones |

**Deleting a bot does not delete the computer** unless it was the last tenant. D-041 said a bot
owns storage from creation; under D-046 that ownership moves to the computer, and bot deletion
removes `agents/<botId>/` and the bot's seat. The retention grace period in §9 applies to the
computer, and a computer with a live tenant is never a reclaim candidate.

A departing tenant's Chrome profile is **retired**, then removed before Chrome starts on the
next machine boot (D-056). A short, networkless volume helper writes a tombstone even when the
machine is stopped; it never edits a loaded profile. The bridge refuses new seats for retired
profiles. Boot removes the directory and its `Local State` references before starting Chrome,
and keeps the tombstone to refuse stale allocations. Other profiles survive. As with seat
release, a post-commit cleanup failure is logged and does not turn a committed bot deletion into
an HTTP failure. The last tenant's volume follows §9 retention instead.

**Idle stop (§8) reads the machine, not the bot.** A computer is idle only when **no** attached bot
is working. The per-bot reading is the bug this sentence exists to prevent: it stops a machine out
from under a working sibling, and it does so more often the more bots are attached, which is
exactly backwards.

---

## 20. A seat: how one machine gives each bot its own screen

> **Amended by D-060 (2026-09-15): a seat is a DISPLAY, not a window.** The
> measurements below stand and the conclusion drawn from them did not. Topology B
> was priced correctly — a private display costs 439 MB against a whole private
> container's 443 MB — and eliminated for buying "nothing" over topology C. What
> that comparison never priced is what the window costs, and using it found the
> bill: minimising the window froze the screen with no restore control, anything
> that was not that window was invisible to its own operator, and a destroyed
> window left a seat advertising a dead RFB port. The third is a bug; the second
> is what window-scoped capture means, and it is G2 — "watch any bot's screen" —
> delivered as "watch any bot's browser".
>
> Two things in §20.2 and §20.3 below are now history rather than contract: the
> ICCCM `min == max` pin (a display cannot be resized at all, so R8 holds without
> it) and the marker-title identification (a seat's browser is launched, not
> located). The per-seat `--user-data-dir` that D-060 requires is also the thing
> point 2 below reports as unnecessary — true of one browser serving many
> profiles, and the reason a per-bot display looked impossible until it was
> measured the other way round.

The shared-machine products have one machine and therefore one desktop. §1.4 G2 — watch any bot's
screen, take control — is a differentiator, and M2 shipped it (D-035, D-037, D-038). A shared
*container* does not require a shared *display*, and this section is the measurement that decided
how.

**Original comparison, before the per-profile amendment below.** Measured on `crewaid/sandbox:m4qa0304` (the M4 image, unchanged by M5-BE-01), 1280×800,
`cap_drop: ALL`, `no-new-privileges`, `--cpus 4`, cgroup `memory.current` after idle settle:

| Topology | Cost per added seat | Shared logins | Per-bot screen |
|---|---|---|---|
| **A** — a container per bot (today) | **443 MB** (whole container) | no | yes |
| **B** — one container, an X display per seat | **439 MB** | no — profiles are forced apart | yes |
| **C** — one container, a Chrome **window** per seat | **79–98 MB** | **yes** | **yes** |

Six bots, extrapolated from the same run: **~2.7 GB** as six containers, **~840 MB** as six seats
on one machine. Seven seats idled at **937 MB** and **0.4–0.8 %** of four vCPU.

**Topology B is dominated, and that is the result that decides this.** A private display costs
439 MB, which is within noise of a whole private container at 443 MB. Paying per-display therefore
buys *nothing* over keeping D-039's containers — while giving up the isolation those containers
provide. It is eliminated on the numbers, not on taste.

**A seat WAS a Chrome window on the machine's one display, with its own RFB stream** — the
three mechanisms below are what made that work, and are kept because two of them still hold.
Point 1's `x11vnc -id` is replaced by whole-display capture (D-060); point 2's shared
`--user-data-dir` is exactly what D-060 had to give up to put a browser on each seat's display;
point 3 is unchanged and is why the capture can bind to a seat's own endpoint. Three mechanisms,
each verified rather than assumed:

1. **`x11vnc -id <winid>` serves one window.** Verified through the RFB `ServerInit` message: the
   full-screen port advertised `1280×800`, the window-scoped port advertised `1050×780` — the
   window's own geometry. A seat's §4.3 stream shows that seat and nothing else.
2. **Chrome's singleton serves a persistent profile per bot (D-056).** A second
   `google-chrome --no-sandbox --user-data-dir=/home/bot/.chrome --profile-directory=<botId>`
   delegates to the running browser and exits. Separate `--user-data-dir`s require separate
   browser processes; separate `--profile-directory`s do not. Each bot gets its own cookie jar
   and browser context. A unique marker title identifies the requested target and X window;
   diffing target/window lists is ambiguous when a new profile also opens a New Tab window.
   Delegation needs `--no-sandbox` under the existing dropped-capability constraints too.
3. **Seats are distinct CDP targets.** Seven windows produced seven page targets. M4 already
   speaks per-target CDP (`Target.attachToTarget` with flatten), so capture binds to a seat the
   same way it binds to a bot today.

**Current topology C′ — a window and profile per bot.** The per-profile measurement adds about
133 MB and six processes per bot, versus 47–98 MB for a window on an already loaded profile.
This deliberately replaces shared logins as the default; named, approved shared identities give
them back where they are wanted (M5-BE-27, D-057). Files remain shared through the computer
workspace. Profiles are a browser-state separation and tool guardrail, not a same-uid security
boundary (§22).

**A shared identity is a named profile, not a copied session (D-057).** `POST /seats` takes an
optional `profile`; absent means the bot's own, which is why the field's ABSENCE is as
load-bearing as its presence — a request that always carried one would move every bot onto a
shared cookie jar and still produce a working seat. Grants may coexist, but only one live seat
may hold a named profile. The name is the directory, validated against the same charset
the bridge accepts, and two names are refused: any bot's id, which is that bot's own profile, and
`Default`, which is the machine's launch window. Because a seat's profile is fixed when the
window opens, a switch is necessarily release-then-recreate rather than a change to the seat in
place — §20.1's pin is what makes that true.

**Selection and transfer (D-173).** `Bot.activeIdentityId` selects the named identity;
`Bot.identityRevision` fences older requests. `BotIdentity` records permission, never a running
lease. Reselecting an older grant works regardless of its timestamp. Attach reconciles the
durable selection against the bridge after an interrupted transition, and every browser action
rechecks its seat, launch generation and selected grant. A revoked connection is dropped without
repeating its action; another read reconnects and observes the new profile.

The expanded screen offers **Release shared login** after hand-back and teaching have ended.
`DELETE /bots/:id/identity` revokes the selected permission and selects private, then closes the
old seat after supported actions and replays drain. It never wakes a stopped computer. A close
failure is reported; the bridge retains its profile reservation until all managed processes have
exited. Retry completes the same release. Another bot sees the holder's name and release steps,
and is never allowed to eject it. Chrome is asked to flush storage before shutdown. Live or
unverifiable singleton locks outside the registry are preserved, not killed or cleared.

This is one user's cooperative same-UID computer. Shell and files can bypass product controls;
private browser profiles and X displays do not create an OS security boundary between bots.
Sites can expire or restrict sessions by device, IP or account policy. No cookie copy or export
is performed. Workspace/profile backup, restore and retirement remain owned by M9-BE-04.

**Ports are not capacity.** The sixteen published seat ports are an upper bound, not a promise
that sixteen profiles fit. On 2026-09-14, the original accumulating Docker suite hit the
512-task cgroup limit (25 `pids.events` limit hits, Chrome `pthread_create` failures) without an
OOM kill. Linux counts threads in that limit; six extra processes do not mean six extra tasks.
Before each serialized creation the bridge requires 160 tasks and 256 MiB of cgroup headroom.
It returns `SEAT_UNAVAILABLE` when either reserve is missing, preserving existing seats rather
than launching into a known shortage. These are conservative admission reserves, not hard
per-page resource bounds: arbitrary pages can still consume more after admission, and Chrome
may retain a profile's resources after its seat closes. A larger machine or a second computer
may be needed. The production 2 GiB / 512-task limits remain unchanged.

### 20.1 R8 and a seat: the constraint the measurement found

R8 fixes a framebuffer for its lifetime and forbids renegotiation. A window-scoped RFB stream
advertises the **window's** size, so a resized seat window renegotiates — precisely what R8 bans,
and what invalidates every recorded input coordinate (M3) and every cached dimension the client
holds.

**`--window-size` does not pin it.** Measured: every delegated window came up at Chrome's default
`1050×780` inside the 1280×800 screen and ignored the flag, because the flag applies to a browser
*launch* and a delegated window is not one. Windows cascade in position (10,10 → 20,20 → …) and
are otherwise identical.

**A window also cannot be the full size of the screen it is on.** Measured (M5-BE-25): asked for
1280×800 on a 1280×800 display, a window comes back **1279×799** — one pixel short in each
direction, decorated or not. That matters more than it sounds, because a client does not read the
geometry off the RFB stream: `rfbChannel.ts` SYNTHESISES the handshake from the `Sandbox` row, so a
seat streaming anything other than the advertised size gives a misaligned picture and offset input.

So the X display is deliberately **larger than the screen the product advertises** —
`SCREEN_WIDTH + SCREEN_MARGIN` by `SCREEN_HEIGHT + SCREEN_MARGIN` — and a seat is created at
exactly the advertised size inside it. Verified: two seats of 1280×800 both fit exactly at (0,0) on
a 1288×808 display. The extra strip is only ever visible in the machine-wide stream on 5900, which
is not what any bot's §4.3 stream shows.

So a seat's geometry must be set **once, over CDP** (`Browser.setWindowBounds`) at seat creation
and never again, and the window must not be user-resizable. **R8 then holds per seat rather than
per screen**, which is the honest restatement: the unit R8 protects is the framebuffer a client is
streaming, and under D-046 that is a seat.

**Measured (M5-BE-18): it can, and the `-clip` fallback is not needed.** Setting the seat window's
ICCCM `WM_NORMAL_HINTS` with `min == max` — once, at seat creation, after the bounds have settled —
makes every later resize fail, through all four paths that exist:

| asked by | mechanism | result with the pin |
|---|---|---|
| `wmctrl -i -r <id> -e` | EWMH `_NET_MOVERESIZE_WINDOW` to xfwm4 | refused |
| `xdotool windowsize` | raw X `ConfigureRequest` | refused |
| `Browser.setWindowBounds` | Chrome resizing its own window | refused, and CDP reports the old bounds |
| a page's `window.resizeTo` | Chrome, on behalf of the content | refused |

Without the pin the same measurement resizes the window to 700×800 and the *next* RFB `ServerInit`
advertises the new size — the renegotiation R8 bans, reproduced on demand.

Two consequences worth stating. The window manager enforces this against the **human** during a
§4.3 takeover, and Chrome enforces it against **itself and the page**, so a hostile site cannot
resize a seat either. And the pin must come *after* the bounds have reached X: it asserts what it is
told and reads nothing, so pinning early freezes the seat at Chrome's default 1050×780 with no way
to correct it — the pin is what refuses the correction.

The image therefore carries `python3-xlib`: nothing else in it can write `WM_NORMAL_HINTS`
(`xdotool` and `wmctrl` only ask for a geometry, and `x11-utils`' `xprop` cannot express
`XSizeHints`).

**One more thing the implementation measured.** Chrome's singleton *does* delegate, as finding 2
above says — but only with `--no-sandbox`. Without it the delegating invocation dies with a
`Trace/breakpoint trap` under §5.1's `cap_drop: ALL`, for exactly the reason the entrypoint's own
Chrome needs the flag. A seat does not use delegation at all in the end: `Target.createTarget` with
`newWindow: true` produces the same window with no second process, and returns the target id
directly. Identifying the seat's *X* window still needs a before/after diff of the window list —
Chrome's `windowId` is not an X id, and every window shares one PID and one WM_CLASS — which is why
seat creation is serialized.

### 20.2 The pointer, and why bots do not fight over it

One X pointer serves the whole display. Bots never touch it: CDP input is synthetic to the
renderer, which is the entire reason M4 needed a correlator to tie an X11 click to a CDP click at
all — if they were the same event there would be nothing to correlate. Human takeover through §4.3
*does* use the X pointer, and is one-operator-at-a-time by its nature.

**One machine therefore does not mean one bot at a time.**

---

## 21. Concurrency inside a shared machine

§5's exclusivity rule survives with its key swapped: **at most one running container may mount a
computer's workspace**, and its three fences move with it. What it never meant, and must not be
read as now, is one writer *inside* the container — several bots sharing one filesystem is the
point of D-046.

Inside the machine there is no orchestrator-side lock and there should not be one: the orchestrator
cannot see a write a shell performed. What governs instead:

- **The project area is git.** Concurrent work is separate worktrees on separate branches, which is
  the same answer a human team uses and the reason D-046 expects `git` in the image — it is installed with npm and native build tools.
- **A bot's own area is its own by convention** (§19), enforced only as far as §22 says.
- **An operator-visible collision is better than a silent one.** Two bots writing one file is a
  merge conflict a PM can see and resolve, not a lock the orchestrator can arbitrate.

---

## 22. What the boundary is, stated plainly

**Isolation is per computer, not per bot.** Every bot attached to a machine can read and write
everything on it: the other bots' files, the shared browser profile, the logged-in accounts.

Three things follow, and none of them should be discovered later:

1. **Path scoping in tools is a guardrail, not a boundary.** `fs_read`/`fs_write` can refuse a path
   (§6/M5 requires it, and M5-QA-01 tests `/etc/shadow` and escapes upward), but `shell()` executes
   as the same uid and can read anything that uid can. A per-bot uid would make it real; that is
   deliberately **not** proposed, because the same decision that shares the filesystem is what
   makes the shared filesystem useful.
2. **Blast radius is the machine.** One bot's `rm -rf`, or one prompt injection off a web page,
   reaches every tenant. Under topology C there is a sharper version: all seats share one Chrome,
   and the entrypoint's supervision contract (§5/M2-IN-03) exits the container when a supervised
   process dies — so one browser crash takes every seat on that machine down together. Per-bot
   containers do not have this failure mode, and it is the clearest thing D-046 trades away.
3. **The container boundary is unchanged.** R5, R8 and §7.3 hold exactly as before: a
   provider-managed named volume, no host path, no Docker socket, the same `agent-net` egress
   policy. What changed is how many bots sit behind one boundary — which is why a user who wants
   two boundaries creates two computers, and why D-046 made the count a user's choice rather than
   fixing it at one.

---

## 23. A snapshot: one saved copy of the computer (D-237)

A provider that implements `SandboxProvider.snapshots` keeps **one** snapshot per computer.

- **What it holds** depends on the provider. On Runtime it is the whole machine — files, memory and
  running programs — copied off the host after capture. Docker (CC-88) will hold `/home/bot` only.
- **Save** replaces the slot: the new snapshot is taken under a pending name and swapped in only
  once Runtime verifies the off-host copy, so the old one stays protected during the upload.
- **Restore** replaces the computer's machine with one made from the snapshot. It is the one
  supported path that discards workspace state, which is why it is only ever the person's choice,
  is refused while a bot is working, and retires every profile that does not belong to a current
  bot or identity before the restored machine is used.
- **Recreate.** A computer whose machine is missing comes back from its snapshot when one is ready
  (§4's "replacement from saved workspace"); without one, the start is refused as before.
- Retention deletes a computer's snapshots with its workspace (§9).
