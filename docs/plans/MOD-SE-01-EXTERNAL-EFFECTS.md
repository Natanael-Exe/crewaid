# MOD-SE-01 — External effects, approval binding and untrusted input

Ratified by **D-164** on 3 October 2026. MOD-SE-02 implements the policy service and the dispatch
re-check. MOD-AI-02 writes the `crewaid.tool-approval` interrupt schemas around the binding below.
V1-OFF-10 is the first commit adapter. Nothing here is implemented yet.

## 1. What is true today

- **Two axes decide a call.** `reach` (`contained` | `sensitive`, D-092) is the AUTO default.
  `effect` (`observes` | `acts`, D-144) is what ASK mode reads. Rules override both in AUTO, and
  a `deny` rule holds in every mode.
- **Every browser and desktop action is `contained`.** `use_identity` is the only question asked
  before a bot acts as the operator (D-057). Once a seat holds a named login, every click, key
  press and form fill in that login runs unasked, in this turn and every later one.
- **An approval is remembered by bare tool name for the turn** (D-065). Approving `shell` with
  `ls` approves `rm -rf` for the rest of the turn. Approving one `github__create_issue` approves
  the next ten.
- **An approval is checked once.** The SDK asks at the approval hook, and nothing compares what
  was approved with what runs: not the arguments, not the login, not the grants. There are no
  edited arguments (`approval.respond` is `approved` + `reason`).
- **The house prompt tells a bot to distrust memory text** (`agent-instructions.ts`). That is a
  defence in depth, not an enforcement point, and nothing else depends on it.

## 2. Four effects

Each tool call has exactly one effect, decided **per call**. Most tools have a fixed effect.
A seat action takes its effect from the seat's session (§3), and a commit adapter (§7) is the
only way a call becomes `commit`.

| Effect | Meaning | Examples |
|---|---|---|
| `read` | Changes nothing anywhere. | `fs_read`, `browser_read`, `screenshot`, `memory_search`, an MCP tool its server marks read-only |
| `draft` | Changes only what the user's team owns (the computer's files, Crewaid records, a teammate's inbox), which the operator can see and undo, or acts as the bot itself in its own browser. | `fs_write`, `remember`, `board_add`, Work writes, `send_message`, a click on a private seat |
| `commit` | A known effect outside: something another person or service sees, or that sends, publishes, pays or deletes. Known only because a commit adapter says so, with what it binds to. | V1-OFF-10's send; any later adapter |
| `unknown` | Might commit, and Crewaid cannot tell. | A click, key press or form fill on a seat holding a named login; `shell`; an MCP tool that writes and has no adapter |

`unknown` is the honest name for a click on someone's logged-in session. Crewaid does not claim
to tell "open this email" from "send this email" by looking at a click, so it does not try. A
known commit gets an adapter; everything else on a login is `unknown`.

**Authority** is a separate flag, not a fifth effect. A tool has authority when it creates or
changes what can run later without a person present: `use_identity`, `create_bot`, `edit_bot`,
`delete_bot`, `save_skill`, `schedule_routine`. Their effect is `draft` (they change the user's
own account), but they always ask in AUTO.

## 3. Seat sessions

A seat's browser runs on one of two kinds of profile (D-056, D-057, D-060):

- **Private**: the bot's own profile. Anything signed in there is signed in as the bot, because
  the operator chose to sign it in. Seat actions on a private seat are `draft`.
- **Identity**: a named shared login. Seat actions there are `unknown`.

The seat's session is whatever the orchestrator's mirror of the bridge says it is (MOD-BR-01 §7).
A seat with no live browser is private until the bridge reports otherwise.

**What this does not cover, stated rather than implied:**

- A person who signs their own account into a bot's *private* profile has made that account the
  bot's. A named identity is how a bot is given someone's login, and it is what brings the
  identity rules.
- Policy governs effects done as someone, not data leaving the computer. A bot that can browse
  can put what it read into a URL. Egress is the network policy's job (§7.3), not approval's.
- Any bot's `shell` can read any profile on the computer (D-046, MOD-BR-01 §3). The identity
  grant governs the supported path, `use_identity`, not the disk.

## 4. Every mutation path

| Path | Effect | Authority | AUTO default |
|---|---|---|---|
| `fs_read`, `browser_read`, `screenshot`, `capture_screen`, `board_read`, `memory_read`, `memory_search`, `task_list`, `task_read`, plugin search | read | | allow |
| `fs_write`, `attach_file`, `board_add`, `board_update`, `remember`, `forget`, Work writes, `record_screen_start`/`_stop`, `cancel_routine` | draft | | allow |
| `send_message` | draft: a teammate on the same team, bounded by the hop ceiling and the chain budget (D-092) | | allow |
| `browser_navigate`, `browser_click`, `browser_type`, `mouse_*`, `keyboard` | draft on a private seat, unknown on an identity seat | | allow on a private seat; on an identity seat, the identity window (§5) |
| `run_skill` | the seat's effect: a replay is seat actions | | as above |
| `shell` | unknown | | the rules: the seeded list asks about destructive forms and allows the rest (D-092) |
| `use_identity` | draft | yes | ask; its approval opens the identity window |
| `create_bot`, `edit_bot`, `delete_bot`, `save_skill`, `schedule_routine` | draft | yes | ask |
| MCP tool marked read-only (D-107) | read | | allow |
| MCP tool that writes, no adapter | unknown | | ask (D-108) |
| A tool with a commit adapter | commit | | ask |
| A name that is not registered | — | | deny, in every mode |

No tool a model can call writes `approvalMode`, `autoReviewRules`, an identity grant's revocation,
a plugin grant or an approval. `edit_bot` changes a bot's name, role, prompt and model, and
nothing that decides what the bot may do. MOD-SE-02 adds a test that fails when any tool's input
schema names a policy field.

## 5. Modes, rules and memory

| Effect | ASK | AUTO | FULL |
|---|---|---|---|
| read | allow | allow | allow |
| draft | ask; remembered by tool name for the turn | rules, else allow | allow |
| draft with authority | ask, this call only | rules, else ask, this call only | allow |
| unknown on an identity seat | ask, this call only | rules, else the identity window | allow |
| unknown, anything else | ask, this call only | rules, else ask, this call only | allow |
| commit | ask, this call only | rules, else ask, this call only | allow |

These rules hold in every mode:

- A `deny` rule holds (D-144), and so does refusing an unregistered name.
- A revoked grant refuses at dispatch (§6). A grant is access, not a question, so Full access
  does not skip it.
- FULL stays what D-144 made it: an explicit, per-bot choice to be asked nothing. It also means a
  request that reaches that bot from a teammate is acted on unasked. The menu says so.

**Turn.** A turn is the run a message started, plus every continuation that answered its
interrupts. The admitting route records which paused run a resume answered (D-160). Memory
lives for the turn, and it is read from the turn's resolved `RunInterrupt` rows, so it survives a
restart.

**Approval memory (replaces D-065's bare-name key).**

- *This call only* means the approval covers the call it was given for. A later call is covered
  only if its binding (§6) is identical. Approving `rm -rf build/` does not approve `rm -rf ~`.
- *Remembered by tool name* applies only to `draft` without authority under ASK. This is D-065's
  behaviour where it was harmless: being asked once per turn about `fs_write`.
- **The identity window** is the one approval that covers more than a call. It is opened by
  approving `use_identity`, or by the first seat action of a turn on a seat that already holds a
  login. In that case the prompt names the login and says "for the rest of this task". It covers
  seat actions on that login, on that browser generation, for the rest of the turn. It closes when
  the turn ends, when the seat's browser generation changes (relaunch or another login), or when
  the grant is revoked. It exists because asking about each click on a login is the babysitting
  D-092 removed, and a click cannot be classified any better than this. ASK mode never opens it.

## 6. Approval binding and the dispatch re-check

An approval binds to these fields (`ApprovalBindingSchema` in `packages/shared/src/tool-policy.ts`,
with fixture pairs). MOD-AI-02 carries them in the `crewaid.tool-approval` payload, and MOD-SE-02
stores them on the `RunInterrupt` row. The resume answer never supplies them: they are read from
the stored row (D-160).

| Field | What it pins |
|---|---|
| `toolName` | The tool that will run, behind the plugin door (D-113), never the door itself |
| `effect` | The effect decided for the call (§2) |
| `scope` | `call`, or `identity-turn` for the identity window |
| `argsHash` | sha256 of the final arguments, serialised by RFC 8785 (JCS) |
| `grantRevision` | sha256 over the bot's access grants: identity grants, plugin grants and each plugin connection's credential revision |
| `seat` | `{ identity, browserGeneration }` for a seat action, else `null` |
| `commit` | `{ account, destinations, contentRevision }` from the adapter, else `null` |

**Immediately before dispatch**, after a resume and on every call the policy allows, the service
recomputes the binding from the call it is about to run and the state at that moment: the
current arguments, the seat's identity and browser generation, the grants, and the adapter's view
of account, destinations and content. Then:

- A field that differs from the approval: the call is skipped with `APPROVAL_STALE`, and the
  policy asks again. The tool result tells the model the approval no longer matched and nothing
  ran.
- A revoked grant: refused `GRANT_REVOKED` in every mode.
- `observationRequired` or a person in control (MOD-BR-01): refused with that code. Seat control
  is checked before the binding, because no approval outranks a person driving.

**Edited arguments.** The operator may answer with edited arguments for a `call`-scope approval.
The server then:

1. validates them against the tool's input schema;
2. decides the edited call again, so a `deny` rule that matches the edit still denies;
3. binds the approval to the edited call;
4. dispatches it through `transformArgs`;
5. tells the model in the tool result that the arguments it proposed were edited, and shows
   what ran.

**Commit destinations** are normalised before hashing: trimmed, case-folded where the service
treats case as equal (email addresses), deduplicated and sorted. A content revision is a hash of
the content as it will be sent, read from the source of truth at dispatch (for V1-OFF-10, the
draft), not the model's copy of it.

## 7. Commit adapters

A commit adapter is Crewaid code bound to one tool: a built-in, or one MCP server kind's named
tool. Given the final arguments and the current state, it returns `{ account, destinations,
contentRevision }`. After the call, it returns an outcome:

- `committed`, with the item's reference (message id, URL or issue number);
- `uncertain`;
- `refused`, with a code.

The outcome is stored with the tool result. An `uncertain` outcome is never retried blindly. It
is reconciled first (MOD-DU-02, V1-OFF-10).

**Only an adapter makes a call `commit`.** What an MCP server says about its own tools is a claim
from a third party. A `readOnlyHint` may lower a call to `read` (D-107). Nothing a server says
raises a call to `commit` or grants anything. An MCP tool's description is untrusted text in the
prompt, like a web page.

## 8. Untrusted input

**Untrusted data** is anything the bot did not get from the operator through an authenticated
route or from its own instructions:

- web pages, page titles and URLs;
- files, shell output and attachments;
- email and MCP results, MCP tool descriptions;
- memory text (D-076);
- a teammate bot's message (it is relayed as a user-role message, attributed to its sender);
- a skill's output.

It reaches the model as data. These invariants make that safe without asking the model to be
careful:

1. **Policy inputs are written only by the operator, over authenticated routes.** These are the
   approval mode, the rules, identity and plugin grants, and approvals. No tool writes them (§4).
2. **The client grants nothing.** Client-declared `tools`, `context`, `state`, `forwardedProps`
   beyond `attachmentIds`, client `metadata` and client-sent history are refused or ignored
   (D-159 §3.3). A resume is validated against the stored interrupt, so a forged, foreign or stale
   answer consumes nothing (D-160).
3. **A teammate's message carries no authority.** The receiving bot acts under its own mode,
   rules and grants. A sender's approval, mode or identity window never crosses a hop.
4. **Enforcement is the policy service at dispatch.** An injected instruction can make a model
   *propose* a send, a publish or a delete. The proposal then meets the same rules, the same
   question and the same binding as any other. The house prompt's distrust of memory text stays
   as a defence in depth and is nobody's enforcement.

## 9. What changes in earlier decisions

- **D-092**: browser and desktop seat actions are `contained` only on a private seat. On an
  identity seat they are `unknown` and go through the identity window. `reach` stops being stored
  and is derived for the wire, so `ToolInfoSchema` is unchanged: `contained` is `read` or `draft`
  without authority, and `sensitive` is everything else. On an identity seat, the derived `reach`
  of a browser tool is `sensitive`.
- **D-144**: `effect: observes | acts` becomes the four effects. `observes` is `read`; `acts` is
  the other three. The three modes keep their names and their promise.
- **D-065**: memory is per turn as before, but keyed by binding. A bare name is the key only for
  `draft` under ASK. The identity window is the one wider scope.
- **D-057**: the approval of `use_identity` still creates the grant. It now also opens the
  identity window, and it no longer leaves the login open for every later turn.
- **D-107 and D-108** are unchanged: the read-only ladder, the M5 matcher and the absence of an
  MCP-specific path all stand.

## 10. What MOD-SE-02 must prove

1. An approval does not cover a call with different arguments, a different login or browser
   generation, a changed grant, or a changed destination or content revision. Each is skipped
   `APPROVAL_STALE` and asked again.
2. Edited arguments are validated, decided again (a `deny` still denies), bound and dispatched.
   The model is told.
3. A revoked identity or plugin grant refuses `GRANT_REVOKED` at dispatch in every mode, FULL
   included.
4. A forged tool result, a page and a teammate's message each instructing a send, publish or
   delete produce a proposal that meets the ordinary question. Nothing runs unasked in ASK or
   AUTO.
5. On an identity seat in AUTO, the first seat action of a turn asks once. Later ones in the same
   turn run. A relaunch or a login change asks again. ASK asks every time.
6. Reads and drafts on a private seat run unasked in AUTO. Every mode behaves as §5's table says.
7. No tool's input schema names a policy field.
