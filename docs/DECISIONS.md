# Contract Decisions

Binding decisions made after PRD rev 3. Where these conflict with `PRD.md`, **these win.**
Every entry here is something more than one person codes against.

---

## D-001 · HeroUI free core only
**Supersedes:** §2.5 ("start from those and adapt")
No Pro license. Chat surface and sidebar are composed from free HeroUI v3 primitives
(`Card`, `Surface`, `Avatar`, `Chip`, `ListBox`, `TextArea`, `ScrollShadow`, `Skeleton`).
The free MCP server is still available and should be used: `npx -y @heroui/react-mcp@latest` (stdio).
**Cost:** +11d frontend, already reflected in M1 estimates.

## D-002 · Three first-party model providers
**Supersedes:** §2.3 (single `@ai-sdk/openai-compatible` endpoint)
OpenRouter + OpenAI + Anthropic, composed with `createProviderRegistry`.
R3 still holds: never call a provider HTTP API directly.

## D-003 · `GET /api/v1/models` — new endpoint
**Extends:** §4.1
```
GET /api/v1/models
→ { models: [ { id, provider, label,
                capabilities: { tools, vision, reasoning },
                contextWindow } ] }
```
`id` is the registry key in `provider:model` form (e.g. `anthropic:claude-opus-4.8`).
Auth-guarded like every other route. **Static/config-derived and cached at boot** — do not
live-query the three providers on each call. Consumed by M1-FE-10 (model picker).

## D-004 · `Bot.modelId` stays the literal `"default"`
The column default is unchanged. `"default"` is a registry **alias**, resolved via env
`DEFAULT_MODEL_ID` (e.g. `anthropic:claude-opus-4.8`) at call time.

*Why:* R3 requires that switching endpoints is a config change. Baking a concrete
`provider:model` into a migration breaks that and forces a data migration over every existing
`Bot` row the day the default provider changes. An unknown alias raises a typed error — never a crash.

## D-005 · `autoReviewRules` pulled forward into M0-03
**Extends:** §3 `Bot` model. Originally implied by M5; added now to avoid a later migration.
```prisma
autoReviewRules Json @default("[]")
```
Ordered array, first match wins, default `ask` when nothing matches:
```ts
{ toolPattern: string; argMatch?: string; decision: 'allow' | 'ask' | 'deny' }
```
`packages/shared` holds the authoritative Zod schema (M0-04); M5-BE-08's matcher validates against it.

*Why a Json column, not a table:* it is always read as one whole ordered list per bot and never
queried across bots. A table buys nothing and costs a join plus ordering columns.

## D-006 · Normalized error-code vocabulary
All three providers normalize into exactly these, shipped as a Zod enum in `packages/shared`:
```
RATE_LIMITED · CONTEXT_OVERFLOW · CONTENT_REFUSED · AUTH_FAILED
PROVIDER_UNAVAILABLE · TIMEOUT · QUOTA_EXCEEDED · INVALID_REQUEST · UNKNOWN
```
The raw provider error rides along as a non-displayed `detail` field for logs.
**Rule:** the transcript never renders a vendor error string. Regexing a provider message in the
UI layer means the normalization is in the wrong layer.

> **Amended by D-228:** the server may pass on the provider's own reason, cleaned and attributed,
> beside the normalized sentence. The raw string still never renders, and the judgement stays here.

---

## Upstream caveat · harness optional members
Verified against `@ai-sdk/harness@1.0.98`.

On `HarnessV1NetworkSandboxSession`, `restricted()` and `getPortUrl()` are **required**, but
`setNetworkPolicy()`, `setPorts()`, and `resumeSession()` are **optional**. Two consequences:

- **§7.3 network policy** — iptables rules on the `agent-net` bridge are the *primary* mechanism.
  `setNetworkPolicy()` is an opportunistic upgrade behind a capability check, not the default path.
- **M2 resume** — write the `resumeSession()` call site as an optional call with a `createSession()`
  fallback only for a confirmed first creation. D-029 supersedes automatic fresh creation for an existing workspace; unsupported resume or recovery failures must be explicit.

This is exactly what M0-07 (exact version pins) and M2-BE-02 (re-export harness types through one
file) exist to contain. **M2-BE-02 must land before anything downstream imports harness types
directly**, or the churn firewall has a hole in it.

## Upstream caveat · `stepCountIs` default
`stepCountIs` is an alias of `isStepCount` and compiles as the PRD writes it, but its **default is
20, not 25**. M5-BE-01 must set 25 explicitly and expose it in config, since §5's loop limits are
all specified as configurable.

*Config (M5-BE-01):* `AGENT_MAX_STEPS` (25), added to `turbo.json`'s `globalEnv` in the same change
per D-039's note. It bounds STEPS — one model call plus the tools it asked for — which is the axis
`stopWhen` controls; §6/M5 words the same limit as "25 tool calls per user turn", and a step may
carry several. `agent-loop-steps.test.ts` re-measures the upstream default rather than trusting this
paragraph, so an SDK bump that changed it would fail the build instead of aging this note.

Two more things measured against `ai@7.0.89` while wiring it, because both look like free choices
and are not:

- **`ToolLoopAgent` has no `onError`.** `streamText`'s default for it is `console.error(error)`, and
  the value printed is the provider's `APICallError` — which carries `requestBodyValues`, i.e. the
  prompt. An agent built without one puts the conversation on stderr, outside the structured
  logger's redaction and against the `recordInputs: false` the same call asks for. `stream()`
  forwards what it does not destructure, so the callback still reaches `streamText`; the runner
  declares the argument as the intersection rather than casting, and pins it with a test.
- **A throw from `onStepStart` is swallowed** — the step runs anyway, so it is not a refusal hook. A
  throw from `prepareStep` surfaces as an `error` chunk, which the turn runner already turns into a
  failed turn. That is where a per-step guard belongs (M5-BE-02, M5-BE-11): with tools registered,
  steps 2..n reach the provider without passing CC-05's pre-call cap check.

## Upstream note · Anthropic prompt caching (CC-11)
`cacheControl` is `{ type: 'ephemeral', ttl?: '5m' | '1h' }` with a dedicated system-message options
type. **Use the 1h TTL** — with up to 25 steps per turn, 5m is nearly useless.

## D-007 · Electron 44.x, not 32
**Supersedes:** §2.3 and the original M1-FE-01 task line ("Electron 32").

Electron 32 reached **end of life on 2025-03-04** — over a year unpatched, embedding
Chromium M128. Electron's support policy is the latest three stable majors; 32 has been
outside that window for four major releases. Since Electron ships a full Chromium and this
app renders remote content and proxies a VNC framebuffer, running an EOL browser engine is
a live security defect, not a version-currency preference.

The `44.1.1` pin was correct and stands. Pin the major (`44.x`) exactly, per M0-07.

*Caught as a conflict between the PRD text and the actual M0 pin.*

## D-008 · Streaming-safe markdown rendering is in scope
**Extends:** M1 frontend. New task **M1-FE-11** (2d).

Every bot reply is markdown containing code blocks, and the transcript streams token by
token. A naive renderer flashes raw syntax whenever a code fence is momentarily unclosed
mid-stream. The HeroUI Pro Chat template would have absorbed this; under D-001 we own it.

Requirement: the renderer must tolerate **incomplete markdown on every frame** — an unterminated
fence, table, or list renders as in-progress content, never as raw source and never as a
layout jump when it closes. Budget the parser choice for incremental input, not for
whole-document correctness.

Also newly explicit: **M1-FE-12** (2d) — the free tier has no `Resizable`/`Splitter` among its
71 components, so the three-pane shell (sidebar │ transcript │ right rail) and the `⌘1..9`
bot-switch bindings are hand-built. The right rail stays empty until M2 fills it with the
VNC thumbnail.

---

## Verified free-tier component findings (M1-FE-02)

Checked against the installed tree — `@heroui/react@3.2.4`, `react-aria-components@1.21.0` —
not recalled. Reproducible via `scripts/heroui-mcp-probe.py`.

- **71 free components.** All 20 primitives named in the M1 brief are present. **No blocking gap**;
  D-001 is safe.
- **`DropZone` / `FileTrigger`** exist in `react-aria-components` but HeroUI does **not** re-export
  them — import direct. This closes the M1-FE-08 attachment/file-drop risk.
- **Variable-height virtualization is supported** via `estimatedRowSize` + `updateItemSize(key, size)`.
  HeroUI's own docs only demonstrate a fixed `rowHeight: 50`, which would mislead anyone building
  the transcript from the docs alone.
- **`TextArea` has no auto-grow.** Confirmed from the real props table. M1-FE-07 hand-rolls it
  (`field-sizing: content` or a `scrollHeight` loop), plus IME composition handling so `Enter`
  does not submit mid-composition.

**Open technical risk:** virtualization fights token-by-token streaming in M1-FE-04 (a growing
last row invalidates measured sizes). Spiking this before committing to an approach.
This, not the free tier, is the real threat to the M1 frontend estimate.

## D-009 · Schema fixes, landed in M0-03
**Supersedes:** §3 "field names are contractual" / M0-03 "§3 verbatim".

Three defects in the PRD schema that would fail acceptance gates as written. Fixing them in
M0 costs minutes; fixing them later costs a migration against live data.

1. **`Message.stopReason String?`** — ADD. M1 acceptance requires "the partial persisted with
   `stopReason: 'interrupted'`", and the `message.completed` WS frame carries `stopReason`, but
   the `Message` model has no such column. Only `AgentTurn` has one. Built verbatim, M1 fails.
2. **`Skill.sourceRecordingId @unique`** — DROP the `@unique`. It contradicts M3's "editing and
   saving a script bumps `version` and keeps the previous version queryable": v1 and v2 of a skill
   both reference the same source recording, so the second edit violates the constraint. Keep the
   relation, drop the uniqueness.
3. **`AgentTurn` cached-token columns** — ADD `cachedInputTokens` and `cacheCreationTokens`.
   Once CC-11 (Anthropic prompt caching) lands, cached reads bill at a fraction of fresh input.
   Without separating them, CC-12's cost reporting and §7.2's hard spend cap are provably wrong —
   and §7.2 is a hard stop, so wrong numbers mean either false halts or blown budgets.

*Raised in pre-gate review.*

## D-010 · The R7 test is an allowlist over ALL Prisma call sites
**Supersedes:** M1 required test "no Prisma `bot.findMany` or `bot.findFirst` call site lacks a
`userId` in its where clause".

As specified the test is theatre. It inspects two method names on one model, but **10 REST routes
are direct-by-id and have no `userId` in their where clause by construction**:

```
/skills/:id · /skills/:id/approve · /skills/:id/run · /skills/:id/runs/:runId
/recordings/:id · /recordings/:id/stop · /recordings/:id/discard
/attachments/:id/download · /routines/:id/run-now
/mcp/servers/:id · /mcp/servers/:id/connect · /mcp/servers/:id/refresh-tools
```

Every one is an IDOR — the exact class R7 exists to prevent — and the test passes green over all
of them. v1 has a single seeded user, so nothing is exploitable today; the risk is that the
green test certifies the pattern, and R7's whole purpose is to make multi-user adoption a guard
swap rather than an audit of every endpoint.

**Replacement:** invert to an allowlist. Enumerate every Prisma call site in `apps/orchestrator`;
each must either scope by `principal.userId` or appear in an explicit, commented exemption list.
New unscoped call sites fail CI by default. Paired with **M1-BE-12**: direct-by-id routes resolve
the resource to its owning `userId` before any handler logic runs.

*Raised in review. A passing test that certifies
a vulnerability is worse than no test.*

## D-011 · M0-07 pin corrections
Two defects in the pin list:

- **`zod` was unpinned.** It is the *only* runtime dependency `packages/shared` is permitted
  (M0 acceptance), and AI SDK 7 peers `^3.25.76 || ^4.1.8` — a Zod major mismatch breaks schema
  inference across both apps. Pin **`zod@4.5.4`**.
- **"openai@4.0.55" is ambiguous and dangerous.** That reads as OpenAI's own SDK. The intended
  package is **`@ai-sdk/openai@4.0.55`**. Pinning the former and calling it directly breaches R3
  ("model access goes through the AI SDK's provider abstraction"). Always write the scoped name.

Also pin **`electron@44.1.1`** per D-007.

## D-012 · `getPortEndpoint`, not `getPortUrl` — and forward its headers
**Supersedes:** §4.3 and every M2 task line naming `getPortUrl`.

Verified directly against the shipped `@ai-sdk/harness@1.0.98` typedefs:

```ts
/** @deprecated Use `getPortEndpoint` instead. */
readonly getPortUrl: (options: {...}) => ...

readonly getPortEndpoint: (options: {...}) => PromiseLike<HarnessV1PortEndpoint>;

type HarnessV1PortEndpoint = {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
};
```

The PRD names `getPortUrl` throughout §4.3 and M2 (ports 5900, 9222, 7070). It is deprecated.
**Use `getPortEndpoint`.**

The consequence is not cosmetic: the endpoint returns **optional headers that must be sent when
connecting**. That lands directly on the RFB proxy (M2-BE-06) — opening the VNC socket to
`endpoint.url` while dropping `endpoint.headers` produces a connection failure that looks like a
sandbox or networking fault, not a missing-header bug. The same applies to the CDP attach in M4
and the bridge calls in M2-IN-04.

Also corrected: the optional provider method is **`resumeSession?`**, not `resume?`. Upstream's own
doc comment at line 75 says `resume?({ sessionId })` and is **wrong** — the actual declaration at
line 1384 is `readonly resumeSession?`. Do not copy the doc comment.

Confirmed still true from the earlier caveat: `setNetworkPolicy?` and `setPorts?` are optional
(lines 128, 151); `restricted()` is required (line 165). Upstream explicitly recommends
optional-call syntax: `sandboxSession.setNetworkPolicy?.(policy)`.

*Found during implementation, correcting two errors in the original write-up.*

## D-013 · Every architectural rule needs a failing probe
**Extends:** M0 lint rules, CC-06, and review gates.

The orchestrator `no-restricted-imports` rule **silently did nothing**: ESLint does not
merge `no-restricted-imports` across flat-config blocks, so the orchestrator block wordlessly
replaced the global `dockerode` ban (R2). A probe file importing `@ai-sdk/harness` linted clean.

Caught only by testing every architectural rule with a probe that **must fail**.

**Requirement:** every lint rule or architecture test defending a rule in §2.2 or §7.3 ships with a
committed probe that the rule must reject. A guard that cannot be demonstrated failing is not
evidence — this applies to R2, R4, R7 (D-010), §7.3's eval ban (CC-06), and the D-010 allowlist.
Treat "show me the probe failing" as a gate question, not a nicety.

## D-014 · CI must check migration drift, not just apply migrations
**Extends:** M0-05 / CI.

`prisma migrate deploy` **exits 0 on schema drift**. `autoReviewRules` was in `schema.prisma`,
absent from the database, and deploy reported "no pending migrations."

Benign in M0; in M1 it ships a missing column that first fails at runtime under load. CI now runs
`prisma migrate diff --exit-code`, verified to catch real drift.

## D-015 · `McpServer.user` relation added
**Extends:** §3.

`McpServer` has a `userId` field but no `user` relation, so deleting a `User` orphans rows in
`McpCredential` — encrypted OAuth tokens with no owner and no cascade. §7.3 requires credentials be
destroyable; orphaned ciphertext violates that. Relation added with cascade delete.

*One schema addition beyond D-005/D-009, declared in the schema header rather than buried.*

## D-016 · Probes lint under their rule's own block — and assert on ruleId
**Extends:** D-013. The probe harness itself had the failure mode it exists to catch — twice.

1. Probes outside every tsconfig hit "not found by the project service" **parser errors**;
   eslint exits fatal and an exit-code check reads that as "rule fired". Nothing fired.
   Fixed via `allowDefaultProject` for `tools/guard-probes/*.ts`.
2. Scope-specific bans (CC-06, R10, R1, shared-zero-deps) only apply **inside their scoped
   directories**. Probes sitting in `tools/guard-probes/` linted clean under 7 of 9 guards —
   the runner caught it because it asserts on ruleId, not exit code. Fixed by including each
   `*-*.probe.ts` glob in its rule's own block, so every rule is defined exactly once and the
   probe inherits the real config rather than a copy.

The runner (`tools/guard-probes/run-probes.mjs`) fails on: parser errors, a clean lint, or the
wrong rule id. The first run caught 7/9 probes proving nothing; after the fix all 9 demonstrate
their guards, and `pnpm lint` over real source stays green.

**Process note:** `run-probes.mjs` is wired into CI (`.github/workflows/ci.yml`, `guards` job).
Until the `workflow`-scope push lands, run it locally: `node tools/guard-probes/run-probes.mjs`.

## D-017 · CI fails on unannotated skipped tests
**Raised at the M0-09 gate; ratified for M1.**

The gate caught the D-016 failure class inside the test suite itself: the skill-versioning
regression test silently skipped in every CI run because Turbo 2.x strict env mode strips
undeclared env vars (`DATABASE_URL` absent from `turbo.json` → the test's skip guard saw
nothing and skipped). Green badge, dormant guard. Fixed in M0 by declaring the vars
(`globalEnv` in `turbo.json`); D-017 generalizes the prevention:

**CI fails when any test reports `skipped` unless the skip is annotated** with a
reason, e.g. `it.skip // @skip-reason: @slow nightly` or a checked-in allowlist file.
Nightly `@slow` tests are the expected population; anything else skipping is a guard not
firing and breaks the build.

*Design note:* the skip-allowlist needs to distinguish per-suite (unit vs `@slow`), which is
why this is M1-adjacent rather than an M0 blocker.

## D-018 · PRD correction — `prisma generate` belongs in the M0 chain
**Docs fix.** The M0 acceptance chain (`pnpm install && pnpm build &&
pnpm test && pnpm lint`) omits `prisma generate`; generated-client-dependent tests fail on
a clean clone without it. CI runs it explicitly between install and migrate. PRD §6/M0 to
be corrected in the next doc pass.

## D-019 · `POST /attachments` — the missing creation half
**Extends:** §4.1. Found during M1-BE-03.

§4.1 gives message-send an `attachmentIds` parameter and `GET /attachments/:id/download`,
but defines **no route that creates Attachment rows** — `attachmentIds` could never reference
anything real. The creation half:

```
POST /api/v1/attachments   (multipart/form-data)
→ 201 { id, filename, mimeType, sizeBytes, storageKey }
```

Storage under `ARTIFACT_DIR` (§3 Attachment model). Scoped by principal like every route —
ownership resolved at creation time per D-010. Consumed by M1-FE-08 (composer attachment
chips). Lives in M1-BE-03 scope so both halves of the contract land in one PR.

## D-020 · `Attachment.messageId` is nullable — two-phase attach lifecycle
**Extends:** §3. Found during D-019 implementation.

D-019 makes attachment **creation** its own route (`POST /attachments`). That forces a
sequencing reality §3 never addressed: **an upload necessarily happens before the message that
will claim it exists.** The column's alternatives:

1. **Nullable `messageId`** (chosen) — upload creates the row unclaimed; `POST
   /bots/:id/messages` with `attachmentIds` claims it. The schema comment documents the intent.
2. *Rejected:* two-phase claim via a transactional FK insert at message-send only, with a
   pending-upload staging area — more machinery, same user-visible behavior, plus a second
   concept (`AttachmentClaim`) for v1's single-operator scope.
3. *Rejected:* auto-create a ghost Message per upload — pollutes conversation history and
   corrupts the transcript contract.

**Consequence — the lifecycle rule that makes this safe:** an unclaimed attachment is a
temporary state, not a storage state. Attachments unclaimed by a message **must** be
reaped (TTL, e.g. 24h) so the artifact directory doesn't accumulate orphaned uploads. That
reaper is a small BullMQ job and lands with **M8** (routines infrastructure exists there);
it is a required acceptance criterion of D-019, not a nice-to-have. Until the reaper exists,
`DELETE /attachments/:id` (client-initiated) is the manual fallback.

**Migration note:** `ALTER TABLE "Attachment" ALTER COLUMN "messageId" DROP NOT NULL;` —
applies cleanly to both prior migrations.

**Addendum (ratified):** `DELETE /attachments/:id` returns **409** when the attachment is
claimed by a message — the manual fallback exists for the *unclaimed* case only. Message-claimed
rows belong to the message lifecycle (cascade via conversation delete). Negative test ships with
the route.

**Known limitation, stated in the M1 PR:** the route ships in M1, the reaper in M8; until
then unclaimed uploads are bounded only by user behavior. The interim option — a TTL check on
read returning **410 Gone** for unclaimed rows older than 24h — is **ratified**: it's ~10 lines,
prevents expired uploads from being served, and the 410 is semantically honest. It does not reclaim disk space or bound artifact growth. The
reaper remains the real fix; D-029 pulls initial cleanup into M2, with recurring-job integration in M8-BE-07.

## D-022 · Multer upload limits — deliberate config, not library defaults
**Raised during PR #12 verification (unbounded Multer defaults vs the ratified "deliberate config" ruling); decided 2026-09-02.**

\`main.ts\` ran Multer with library defaults — no fileSize cap, unlimited files per request. That contradicts the deliberate-config ruling and the six-sandbox capacity budget: an unbounded upload can balloon a 2GB sandbox disk and starve D-019's \`ARTIFACT_DIR\`.

**Ratified limits:** \`{ fileSize: 25 MiB (26_214_400 bytes), files: 5 }\` per request. Oversized/over-count requests return **413** (Payload Too Large), not a raw Multer error. Changes land with the WS gateway lane (M1-BE-04), tests included.

## D-021 · `Attachment.ownerId` — ownership from creation, not from claiming
**Found during review of PR #6; same migration-now logic as D-005/D-009.**

D-019's upload route stored no owner and the claim query filtered only `{ messageId: null }`.
The IDOR chain: user B binds user A's unclaimed upload to B's message and downloads A's file
through the now-owned link. (Not exploitable at v1's single seeded user — but it is the exact
D-010 class: a vulnerable pattern shipping under a green test, contradicting D-019's own text.)

**Schema:** `Attachment.ownerId String` (no default) + index, added to the D-019 migration line.

**Three enforced changes:**
1. `upload()` takes `@CurrentUser()` and persists `ownerId`.
2. Claim query: `{ id: { in }, messageId: null, ownerId: principal.userId }` — foreign or
   unknown claims → 404, never silently bound.
3. `resolveForDownload` gets a second arm: unclaimed rows resolve by `ownerId` directly;
   claimed rows keep the message→conversation→bot→userId path.

**Also from review of PR #6:**
- **J2 — pagination tiebreak:** `(conversationId, createdAt)` sort with a createdAt cursor
  double-renders or skips same-millisecond messages. Fix: `orderBy [{createdAt desc},{id desc}]`,
  cursor becomes the composite. New test: 3 same-ms messages, page size 2, all pages walked,
  each seen exactly once.
- **J3 — D-020 fences were never in the diff:** the 409-on-claimed and 410-TTL semantics were
  ratified but didn't reach the initial diff.
  Fences land with J1/J2 in one PR.
- **Tooling (ratified):** the CDP smoke probe must hard-fail when the
  answering window's repo path isn't the build under test — an early smoke run verified
  the wrong working tree via a port collision. A verification tool that trusts whichever window
  answers is D-013's class inside the tooling.

## D-023 · Attachment-only message sends — text OR attachments
**Decided on 2026-09-02 in response to the M1-FE-08 contract flag.**

The §4.1 `POST /bots/:id/messages` body is amended to support a message whose
payload is carried entirely by uploaded attachments. This is intentionally
separate from D-022 (Multer upload limits), which already owns that identifier
in this decision log; the implementation branch was initially labelled D-022
before that numbering collision was found.

**Valid message payloads:**

- text only: trimmed, non-empty `content`, with no attachments;
- attachments only: `attachmentIds` contains at least one ID and `content` is
  absent or the empty string;
- text plus attachments: both are sent together.

The contract is valid exactly when trimmed `content` is non-empty **OR** at
least one `attachmentIds` entry is present. A payload with no text and no
attachments — including whitespace-only text without attachments — is rejected
with a validation error (HTTP 400). `content` is optional on the request and
is capped at **100,000 characters**. The orchestrator persists absent content
as `''` because `Message.content` is NOT NULL; the transcript therefore keeps
an ordinary string while the attachment cards carry the file presentation.

The renderer applies the same floor before making the request: a send is
available only for non-whitespace text or at least one ready attachment. The
server-side refinement remains authoritative. M1-BE-06's prompt layer may
bridge the persisted empty trigger for provider protocol compatibility; that
does not alter the verbatim transcript representation.

Tests cover text-only, text-plus-attachments, both forms of attachment-only,
and every empty-nothing/whitespace rejection path in the shared schema,
renderer gate, and real-Postgres message integration suite.

**PR #5 (Electron shell) PASSED outright** — reviewer rebuilt the PR head and reproduced 7/7.

## D-024 · WS bad-token wire contract — pre-upgrade HTTP 401
**Decided during PR #16 blocker closure on 2026-09-02; verified against `@nestjs/platform-ws` 11.2.3 and `ws` 8.21.3.**

The §4.2 endpoint is `ws://<host>/ws?token=<ORCH_API_TOKEN>`. Missing, empty, or
incorrect tokens MUST be rejected during the HTTP Upgrade with **HTTP 401**. No
WebSocket connection is established and therefore no WebSocket close code is
on the wire for this authentication failure.

`CrewaidWsAdapter.create()` supplies `ws`'s `verifyClient(info, done)` hook. Nest's
stock adapter forwards the WebSocket server options to `ws` but only exposes its
message-parser option in the constructor type, so the custom adapter adds the
hook at the `create()` boundary. The gateway retains a defense-in-depth token
check; if a nonstandard adapter bypasses the pre-upgrade hook, that fallback
closes the already-upgraded socket with **1008 (policy violation)**. That
fallback is not the supported wire contract and must not be described as an
alternative success path.

Regression tests open real sockets and assert `unexpected-response` status 401
for both missing and wrong tokens, plus a valid-token connection and the normal
frame-validation cases. This decision supersedes the former informal
`1008/401` wording in task notes.

## D-025 · Authenticated renderer routes are fetched, never linked
**Decided during PR #44 finding closure on 2026-09-04.**

Renderer markup MUST NOT hand an authenticated route to `<a href>`,
`<a download>`, `<img src>`, or another browser-owned request. Those requests
run outside `ApiClient`, do not carry the bearer token, and therefore receive
401 from `AuthGuard`. The renderer fetches through `ApiClient`; file bytes are
then saved through a temporary blob URL. The §4.2 query token is not precedent:
a WebSocket handshake cannot set an Authorization header, while `fetch` can.

`ApiClient.download()` enforces the shared 25 MiB attachment ceiling before
reading a declared-oversized body and while consuming an undeclared or
misdeclared stream. A component aborts its in-flight read when it unmounts and
does not start a save after cleanup. A renderer-scoped lint rule rejects JSX
`download` attributes, and its D-013 guard probe proves the rule fires.

---

## D-026 · Ownership is declared on the handler; the fence moved to build time
**Decided while closing M1-BE-18 on 2026-09-04.**

`ResourceOwnershipGuard` MUST NOT know URLs. A route declares the row it
operates on with `@OwnedResource(kind, param)`, and the guard resolves that
through the single `OwnershipService.findOwned` record. Adding a family in
M3–M8 therefore touches the handler and the finder record, and the compiler
checks the pair: the record is `satisfies Record<OwnedResourceKind, …>`, so a
kind a route can name is a kind with a relation behind it.

This replaces three lists that had to agree by hand — a regex route table, a
switch over six lookup names, and a path-family predicate. The predicate also
carried a runtime property that the decorator alone would lose: a path inside a
known family that was not in the table was refused rather than served, so a
forgotten entry failed closed.

That property is not dropped, it is moved earlier. A marker is absent by
default, so the fence now lives in `test/ownership-route-coverage.test.ts`,
which walks the module graph by reflection — no application, no database, no
`skipIf` — and fails when a parameterised route carries neither a marker nor a
written exemption. A missing fence is a red build rather than a 404 discovered
in production, and the check covers the `bots/:id` families the old predicate
never looked at.

Exemptions are explicit and must name the layer that scopes instead. The bot
families are exempt because `BotsService.findOwned` scopes every query by
`principal.userId`; fencing them twice would put the 404 in two places and make
the service's own scoping look optional.

---

## D-027 · Chrome runs with `--no-sandbox`; §5.1's constraints are not relaxed
**Found while building the §5 image for M2-IN-02 on 2026-09-05.**
**Supersedes:** the Chrome flag list in §5's `entrypoint.sh` description.

§5's Chrome invocation and §5.1's container constraints cannot both hold. §5.1
mandates `cap_drop: ALL` and `no-new-privileges`, and those close both doors
Chrome has to sandbox itself: the setuid helper needs the privileges
`no-new-privileges` denies, and the namespace sandbox needs `CAP_SYS_ADMIN` for
`clone(CLONE_NEWPID)`. Chrome does not degrade to running unsandboxed — the
zygote dies during startup and takes the browser with it:

```
Failed to move to new namespace: PID namespaces supported,
Network namespace supported, but failed: errno = Operation not permitted
FATAL .../zygote_host_impl_linux.cc:213] Zygote process exited prematurely
```

Reproduced on a clean build under the exact §5.1 flags. Without `--no-sandbox`
the container never reaches `RUNNING`.

**The constraints win, and Chrome gets the flag.** The container is already the
trust boundary for this image, because §7.3 executes model-generated skill code
inside it — Chrome's internal sandbox was defence in depth around code that is
untrusted either way, not the fence keeping a bot away from the host. That fence
is `cap_drop: ALL`, `no-new-privileges`, the pids and memory limits, and the
`agent-net` egress policy, and every one of them stays exactly as §5.1 wrote it.

The alternative — restoring Chrome's own sandbox by granting `CAP_SYS_ADMIN` or
dropping `no-new-privileges` — trades a boundary that holds against the whole
container for one that only holds inside it. **Do not relax §5.1 to get the
Chrome sandbox back.** If a future revision wants both, the answer is gVisor or
a per-bot VM, not a capability.

> **Superseded by D-145.** The premise was wrong: the namespace sandbox does not need
> `CAP_SYS_ADMIN`, it needs Docker's seccomp profile to stop gating three syscalls on it. §5.1's
> constraints still hold unrelaxed, and Chrome keeps its sandbox wherever the container allows it.

Two consequences worth knowing before they surprise someone:

- Chrome renders a permanent infobar reading *"You are using an unsupported
  command-line flag: --no-sandbox. Stability and security will suffer."* It is
  visible in the operator's screen panel and will appear in every M3 recording.
  `--test-type` suppresses it and also changes other Chrome behaviour; that is a
  separate call, deliberately not folded into this one.
- `--class=google-chrome` travels with `--user-data-dir`. Chrome appends the
  profile path to its WM_CLASS instance name, so the window comes up as
  `google-chrome (/home/bot/.chrome).Google-chrome` and matches the
  `StartupWMClass` of neither desktop entry it ships — the dock then shows
  Chrome twice. This is cosmetic, but the §5 acceptance criterion names the
  dock's contents.

---

## D-028 · `createSession()` returns a sandbox that is serving, not merely started
**Found while implementing M2-BE-01 on 2026-09-05.**

Docker publishes a container's port mapping the instant the container starts —
roughly two seconds before anything inside is listening. A provider that waits
only for the mapping returns a session on which every port resolves and every
connection is refused, and the first version of `DockerSandboxProvider` did
exactly that: the whole real-Docker suite ran in 2 s and the only test that
touched a port failed with `SocketError: other side closed`.

**`createSession()` and `resumeSession()` return only once the agent-bridge
answers `/health`.** Two consequences worth knowing:

- **Callers may assume a usable sandbox.** M2-BE-04's `POST
  /bots/:id/sandbox/start` does not need its own readiness wait to satisfy §5's
  "returns within 20 s with `state: RUNNING` and a healthy bridge" — the
  provider has already waited. §7.4's 20 s budget is the provider's timeout, and
  the §5 image boots in about 5.
- **This is the boot edge only.** Ongoing health polling, and the transition to
  `UNHEALTHY` when a running sandbox dies, remain M2-BE-05. The two are not the
  same mechanism and should not be merged: this one blocks a caller that has
  nothing yet, and that one notices a caller's sandbox dying underneath it.

The probe is injected (`bridgeProbe`), so the unit suites keep running with no
daemon and no image. Without that seam the readiness wait would only ever have
been exercised by the gated integration test — which is how the defect got
written in the first place.

---

## D-029 · The `Sandbox` row is the start lock, and `STARTING` is a lease
**Decided while closing M2-BE-04 on 2026-09-05.**

§5 requires two concurrent starts to produce exactly one container. The lock is
a compare-and-swap on the `Sandbox` row, not a mutex:

```sql
UPDATE "Sandbox" SET state = 'STARTING'
 WHERE botId = ? AND state IN ('STOPPED','ERROR','UNHEALTHY')
```

`updateMany` reports the row count and `botId` is unique, so exactly one caller
sees 1. That caller creates the container; the others wait for it and return its
result — five simultaneous starts, one container, five identical answers.

An in-process mutex would pass the same test and be wrong for a reason the test
cannot see: it holds only while there is one orchestrator process. The database
is already what has to be right when there are two, and `botId @unique` is
already the constraint that says so.

**`STARTING` is a lease, not a state.** A starter that dies holding it would
otherwise wedge that bot forever, so a `STARTING` row older than 60 s is
reclaimable. The lease is deliberately far above §7.4's 20 s cold-start budget:
reclaiming a start that is merely slow produces the second container the whole
mechanism exists to prevent.

**Review amendment (2026-09-05): stop shares the lifecycle lease.** A stop
waits for an active start and claims the row before touching Docker; a start
arriving during stop waits and then resumes. `STARTING` denotes an unsettled
lifecycle operation because the wire enum has no `STOPPING` state. Every claim
compares the previously read state and timestamp, and advances `lastStartedAt`
monotonically. Completion and failure updates require that same timestamp so
an expired holder cannot overwrite its successor. Stop may reclaim abandoned
leases too. This reuses the existing schema and remains a database CAS.

Container discovery uses the stable session key even if the first creator
crashed before persisting `sessionId`. Only absence permits creation; a live
container with a failed readiness probe retains the original failure. Persist
`session.id` as `sessionId`, the Docker `containerId` separately, and the
session's display dimensions in the resolution columns.

**Two consequences for M2-BE-05.** Health polling writes `state` on the same
row, so it must not treat `STARTING` as a sandbox to mark `UNHEALTHY` — that
would release a lock it does not hold, mid-create. And it must not write
`RUNNING` over a `STARTING` row for the same reason. Poll transitions belong on
rows that have settled.

---

## D-030 · Chrome's CDP port is reached through a relay, not bound directly
**Found in review of PR #55 on 2026-09-05.** **Amends:** D-027 and §5's Chrome flags.

Headed Chrome **ignores `--remote-debugging-address=0.0.0.0`** and binds its
debugging server to loopback regardless. §5 specifies that flag, so the image
looked correct and was not: the port answers inside the container and refuses
every connection from outside it.

That combination is worse than a plain failure, because the obvious health
check confirms the broken configuration. Reproduced on the pre-fix image:

```
from inside the container   loopback 9222 -> HTTP 200
from a peer container       peer     9222 -> exit 7 (connection refused)
```

The bridge's `/health` probes CDP over loopback, so it reported the sandbox
healthy while M4's CDP attach — which arrives from the orchestrator, across the
container boundary — could never have connected. A green check on the one path
that is not the real one.

**Chrome now listens privately on 9223, and a supervised `socat` relay carries
the contractual port 9222.** The relay is byte-for-byte TCP, so HTTP discovery
and the WebSocket upgrade both pass through unchanged; the smoke test drives a
real `Browser.getVersion` over that socket from a peer container rather than
trusting `/json/version` alone. §5's external port is unchanged, so nothing
downstream — `SANDBOX_PORTS.cdp`, `EXPOSE`, `getPortEndpoint` — moves.

**No capability and no host publication is added.** The relay is one more
supervised child, which means the M2-IN-03 exit contract covers it: killing
`socat` takes the container down, and the smoke test asserts that.

The general lesson is worth more than the fix: **a health check that probes
from inside the sandbox cannot prove reachability from outside it.** The §5.2
bridge is the right place to check that the desktop is alive, and the wrong
place to check that the orchestrator can reach it. Tests for a port contract
belong on a peer container.

## D-031 · Durable workspaces and bounded sandbox lifecycle
**Decided 2026-09-05 after reviewing the personal MVP and prospective paid product.**
**Supersedes:** R5 / §5.1's blanket volume prohibition, automatic fresh-create fallback in M2, and D-020's cleanup sequencing.

The personal MVP remains one operator on a VPS, with a separate desktop per bot. Bot identity and saved workspace must outlive a container. The sandbox provider remains the runtime boundary; this decision does not replace the harness interface or introduce cloud provisioning in M2.

- Permit provider-managed storage dedicated to a bot's workspace and supported browser profile. Arbitrary host-path mounts, the Docker socket, infrastructure secrets, and other bots' private storage remain forbidden. Validate ownership at attachment; allow only one writable runtime per workspace. Select and document the exact storage paths and migration contract before implementation.
- Distinguish first creation, reattachment to a running session, starting a stopped session, and replacement from saved workspace. A missing container, unavailable resume capability, or transient provider failure must not silently produce an empty replacement desktop. Surface a recoverable error until recovery is selected and validated.
- Files, supported browser profiles, and bot memory survive supported stop/start and image replacement. Live processes and open windows are not promised across stop or replacement. Do not promise arbitrary system-installed packages survive replacement; ship a versioned base image and document supported persistent paths.
- Add host capacity admission alongside the per-bot start lock. A configurable running-sandbox limit must reject excess interactive starts with an explicit capacity response; background queue behavior is specified when jobs are introduced. The existing CPU/RAM defaults are initial measurement targets, not proven capacity guarantees.
- Add configurable idle stop. Active work, recording, manual takeover, and an explicit keep-running lease prevent stopping. Disconnecting the desktop does not cancel work. Merely maintaining a screen thumbnail does not keep compute alive. Approval-aware suspension is integrated in M5 and requires state revalidation before continuing.
- Reconcile desired state with provider observations, including provisioned-but-unrecorded containers, missing runtimes, stale starts, and partial teardown. Never delete a workspace as an automatic orphan-runtime cleanup action. Bot deletion and retention require an explicit storage cleanup contract.
- M2 measures startup, restart, peak memory, CPU, disk growth, and active runtime on representative Chrome/desktop tasks. Test stop/start, image replacement with restored files/profile, concurrent admission, idle exclusions, and restart reconciliation.
- Reap expired unclaimed attachments in M2 with an idempotent startup/periodic cleanup mechanism; M8 may move scheduling into BullMQ. HTTP 410 alone does not delete bytes. Define a cumulative artifact quota and disk-pressure behavior, not just per-upload limits.

## D-032 · Interrupted turns are recorded, not automatically replayed
**Clarifies:** R9, §2.5, M5-BE-10.

MVP step checkpoints preserve completed-step records. On backend restart, unfinished turns become INTERRUPTED; automatic resumption is not a v1 guarantee. A tool may have performed an external action before its result was checkpointed. Do not blindly replay that action. Record uncertain outcomes and require reconciliation or user direction. Paid background execution requires durable job identity, leases, duplicate-delivery handling, and tool-specific idempotency/recovery rules in M9.

## D-033 · Paid launch is a separate release gate
**Extends:** §9. The $30 ceiling is a product constraint, not a validated cost estimate.

Keep M0–M8 scoped to the personal, self-hosted MVP. M9 is a separate, conditional commercialization milestone after v1 sign-off. Its intended topology is a shared backend plus customer-isolated compute, with individual bot desktops/workspaces inside each customer environment. Ordinary Docker containers sharing a kernel across unrelated customers are not the intended initial commercial boundary. Provider selection remains open until representative workload costs are measured.

Saved bots do not imply running desktops. Initial paid-plan design targets bounded active compute, storage, and concurrency; multiple saved bots with one active desktop task is a candidate, not an advertised entitlement yet. Meter billable allowance separately from actual provisioned uptime, idle grace, startup, storage, and traffic. BYOK inference costs remain separate and visible per job.

M9 must cover authentication/revocation, tenant scope through jobs and screen streams, encrypted per-customer model credentials, provisioning/reconciliation, backups and restoration, retention/deletion, entitlements, billing and metering, cost validation, and operational incident handling. A new provider implementation and auth guard alone do not satisfy this gate. See COMMERCIAL-ROADMAP.md.

## D-034 · Task graph and release evidence
**Extends:** PRD §0 and review gates.

Every milestone gate depends on all required tasks in that milestone and its required cross-cutting controls. Milestone N+1 starts only after the prior gate passes. Historical completion is preserved; corrected dependencies do not constitute rerunning or reapproving completed work. A task marked done with unfinished prerequisites must have its scope/dependencies reconciled with actual evidence.

`tasks.json` is canonical. TASKS.md, tasks.csv, and board.html are generated views. Browser-local board changes are planning annotations only until recorded in tasks.json and regenerated; they are not release evidence. Add a validator for duplicate/missing IDs, cycles, gate coverage, and inconsistent completion. Cost reporting and hard caps gate M5 autonomous execution; storage cleanup gates M2. Neither is a floating optional item.

## D-035 · §4.3 binary frames carry a bot id header
**Extends:** §4.2 (`screen.frame`, `screen.input`) and §4.3.

§4.2 transports `screen.frame` and `screen.input` as **binary** WebSocket frames rather than JSON envelopes, so neither carries the `botId` every other frame has. One §4.2 socket multiplexes up to six desktops and `screen.subscribe` is per-bot, so raw RFB bytes leave "which desktop is this" unanswerable in both directions. (This originally also cited the rail thumbnail and the full-screen viewer as two concurrent subscriptions. They are one — see D-037. The six desktops are the reason that stands on its own.)

Both directions therefore carry a two-field header, and the RFB message follows it untouched:

```
byte 0        bot id length in bytes, 1..64   (matches CuidSchema's ceiling)
bytes 1..n    bot id, UTF-8
bytes n+1..   the RFB message, verbatim
```

One RFB message per frame. `encodeScreenBinaryFrame` / `decodeScreenBinaryFrame` in `packages/shared/src/screen.ts` are the only source of truth for the shape.

*Why a header rather than routing by the socket's current subscription:* inbound, the consequence of guessing is typing into the wrong bot's desktop — silently, and only once a second subscription exists, which is the configuration the product ships in. Outbound it is the same question with a milder symptom: a viewer cannot attribute the frame it just received.

*Why this is not "transcoding":* §4.3's prohibition is about the pixels. Nothing reads, rewrites, or re-encodes a byte of the RFB message; the header is prepended on send and sliced off on receive, and the payload is passed on as a view into the same buffer.

*Rejected:* concatenating several RFB messages per frame. It would save a header on a mouse drag and cost the receiver a second framing layer to find their boundaries — the exact scanning problem §4.3 already solves once, on the server side.

## D-036 · `screen.input` forwards KeyEvent and PointerEvent only
**Extends:** §4.3 ("validated as well-formed `PointerEvent` (type 5) or `KeyEvent` (type 4), then forwarded").

The validator (`apps/orchestrator/src/screen/rfb-input.ts`) accepts exactly two RFB client message types, at their exact lengths, one per frame. Everything else is refused with a §4.2 `error` frame — including a well-formed event with trailing bytes.

This is a fence, not a formality. The upstream RFB connection is **shared** by every subscriber watching that sandbox, and the proxy's state machine assumes it is the only thing configuring it:

| Refused | What forwarding it would do |
|---|---|
| SetPixelFormat (0) | TPIXEL is 3 bytes only for the pinned 32bpp true-colour format; changing it desyncs `scanServerMessage` permanently, for every viewer |
| SetEncodings (2) | Offers an encoding the scanner cannot measure (LastRect, ZRLE, DesktopSize) — same permanent desync |
| FramebufferUpdateRequest (3) | Breaks the one-request-in-flight invariant. RFB has no request ids, so the `fullRepaint` bit becomes a guess, and that bit is all that keeps a late subscriber from decoding deltas against pixels it never had |
| ClientCutText (6) | Pushes attacker-chosen text into the sandbox clipboard for the agent to paste. §4.3 asks for input forwarding, not a clipboard channel |

The length must be **exact** rather than sufficient: a valid PointerEvent followed by a SetPixelFormat is what a "long enough" check forwards.

Padding bytes and the KeyEvent down-flag are read but not constrained — RFC 6143 leaves padding undefined on receipt and defines any non-zero down-flag as "pressed", so rejecting either would refuse conformant clients while preventing nothing. Coordinates are not clamped: an out-of-range pointer is legal RFB that x11vnc handles, and clamping would couple a pure validator to live geometry.

*Authorisation:* membership in a bot's subscriber set **is** the authorisation, established by the ownership check `screen.subscribe` already performed (R7). An unknown bot, another user's bot, and a bot this socket simply is not watching all receive the same refusal, so the channel never answers "does this bot exist". This also keeps the input path free of database reads, which matters on a path carrying every mouse move.

## D-037 · The thumbnail and the full-screen viewer are one subscription, not two
**Amends:** D-035's rationale text, which cites "the right rail's thumbnail plus the full-screen viewer" as two subscriptions on one socket. D-035's wire format is unchanged; only that illustration was wrong.

M2-FE-02's full-screen viewer is the **same** viewer as the rail thumbnail: one DOM node, one noVNC instance, one `screen.subscribe`. Expanding swaps the node's CSS classes from a rail-sized card to a fixed full-window overlay and raises the §4.3 quality from 3 to 9. Collapsing reverses both.

Two viewers were never available to build:

- **The orchestrator keys subscribers by socket.** `ScreenStream.subscribers` is a `Map<WebSocket, Subscriber>`, and `add()` treats a second `screen.subscribe` from a socket that is already a member as a *quality change* rather than a second membership — deliberately, so a resubscribing client cannot leak a slot only its disconnect can free. A renderer holding "two subscriptions" would hold one, and either viewer's `screen.unsubscribe` would blind the other.
- **Two decoders cannot read one Tight stream.** The zlib dictionaries are per-connection and cumulative, so a decoder that starts second is inflating against history it never saw. The server's remedy for a late joiner — replace the upstream, precede its first full repaint with a Tight reset — keys off socket membership, which a second viewer on the same socket already has. It would not fire, and the second viewer would render nothing but `zlib inflate failed`.

Quality changes re-send `screen.subscribe` on the existing membership, without an intervening `screen.unsubscribe`. The orchestrator updates the upstream encoder's quality and requests a full repaint in place. Both ends retain their compression dictionaries, and expanding or collapsing does not reconnect the upstream. Unsubscribing is reserved for leaving the viewer or changing sockets/bots. A socket reconnect rebuilds the decoder before subscribing to the new stream.

The real Docker/Electron lifecycle probe caught a `zlib inflate failed` error in the earlier unsubscribe/resubscribe implementation. Keeping the stream intact avoids that failure and the unnecessary upstream reconnect. The probe verifies canvas identity, new pixels, quality changes, keyboard collapse, and reconnect recovery; the multiplex integration test verifies that repeated quality changes preserve one upstream and one membership.

*Consequences:*

- Collapsing the right rail still unsubscribes, because the card unmounts. Full screen is unreachable from a collapsed rail, so the shell clears the expanded flag when it collapses the rail rather than leaving a viewer that would reopen on its own.
- A desktop that dies while the viewer is open leaves the viewer open, showing `Sandbox.lastError`. Closing it would put the only explanation off screen.
- R8's renderer half — scale the picture, never the display — is one constant, `VIEWER_DISPLAY_POLICY`, because `scaleViewport` and `resizeSession` only mean R8 as a pair. It cannot be violated from here in any case: `RfbChannel` is a dead end for client messages, so a SetDesktopSize noVNC produced would be refused there rather than reaching x11vnc.

## D-038 · Input is captured only by the full-screen viewer, and released when it closes
**Extends:** §4.3 and D-036 (`screen.input`); **builds on** D-037 (one viewer, two surfaces).

M2-FE-03 turns noVNC's own keyboard and pointer capture on and feeds what it produces into the
D-035 envelope. Five things about that are decisions rather than plumbing.

**The rail thumbnail stays view-only.** Only the full-screen surface forwards input, and only
while a live desktop is under it — `screenCardPresentation().interactive` is the entire rule, and
it is a field on a pure value so it can be asserted without a DOM. The rail is a card a few
hundred pixels wide showing a 1280x800 framebuffer, so `scaleViewport` multiplies a click in it up
to somewhere the operator never aimed, on a desktop they are watching out of the corner of their
eye. That is not a limitation waiting to be lifted; it is what keeps a glance from becoming a
keystroke. The second half matters as much: the viewer deliberately stays open when the sandbox
dies (D-037), so `expanded` alone would keep forwarding keystrokes at a placeholder — and every one
would come back as an error frame, because the subscription that authorised them died with the
desktop.

**Two gates, not one.** noVNC's `viewOnly` is the primary one and stops the events being generated
at all; the renderer checks the same flag again before sending. The second check exists because the
first is asynchronous with React: an event already queued when the operator collapses would
otherwise leave the rail.

**The picture takes focus when the viewer opens.** noVNC creates its canvas with `tabIndex = -1`
and grabs `keydown` on it, so nothing else can put focus there and nothing else will. Without this
the operator gets a full-screen desktop that ignores every keystroke until they think to click it
first — a silent failure with no symptom to report. The consequence is accepted deliberately: Tab
belongs to the remote desktop while the viewer is open, so the Close button is mouse-only and
**Escape is the keyboard way out**. Escape is therefore handled on the `window` in the CAPTURE
phase, which runs ahead of the canvas's own grab, and `stopPropagation` keeps that one key local
while every other key reaches the sandbox. A bubbling or card-scoped handler would see Escape only
after noVNC had already sent it — leaving no exit the remote desktop could not swallow first. A
surface with no live picture has nothing to type into, so there the close button takes focus
instead; a contained focus scope with nothing focused traps the keyboard.

**The viewer releases what it was holding, because noVNC cannot.** Capture ends abruptly — a
collapse, a bot switch, a rail that closes — and whatever was down at that instant reached the
sandbox as a press with no release. X has no notion of a client going away for a key it was told is
down, so a stuck modifier is permanent and invisible: every later click the agent makes becomes a
ctrl-click. noVNC knows about this and releases held keys on `ungrab()`, but in 1.7.0
`set viewOnly` assigns `_viewOnly` *before* calling it, and every release `_allKeysUp()` produces
is then dropped by `sendKey`'s `if (... || this._viewOnly) return` — while `_keyDownList` is
cleared on the way past, so afterwards neither side knows. `disconnect()` has the same shape.
`heldInput.ts` therefore tracks the messages already going out, and replays their inverses:
the button first, while the modifiers that gave a drag its meaning are still down, then the keys in
reverse press order.

Focus moving from the canvas to local controls, or away from the Electron window, also ends
capture. The viewer pauses noVNC before sending the tracked releases and resumes when the canvas
regains focus. For an interrupted drag it also dispatches a local mouseup while noVNC is view-only
to clear noVNC's mouse-capture overlay and cached button mask without forwarding another event.
Window blur alone only clears noVNC's keyboard state; it does not release pointer buttons.

**Those releases go out before the unsubscribe.** Membership in the subscriber set *is* the
authorisation for `screen.input` (D-036), so a release sent after `screen.unsubscribe` is refused —
the key stays stuck and the refusal surfaces as an error for an event the operator never knowingly
sent. React runs effect cleanups in declaration order, which is why the interactivity effect is
declared ahead of the one that owns the subscription. That ordering is load-bearing, not stylistic.

`RfbChannel` continues to swallow every other client message (SetPixelFormat, SetEncodings,
FramebufferUpdateRequest, ClientCutText). That is the client half of D-036 and it is asserted, not
assumed: forwarding one would reconfigure the shared upstream under every other viewer of that
desktop.

*Evidence:* the real Docker + Electron probe drives two terminals mapped at known positions in two
directories and types `touch proof.txt` with no path in it, so the file landing in the first one —
and the sandbox's own `xdotool getwindowfocus` moving to it — are consequences of the click and of
nothing else. It then holds Shift across a collapse and asserts the release on the wire. Both
claims were confirmed by mutation: a viewer that never releases, and one that never takes focus,
each fail the probe at exactly the assertion written for them.

## D-039 · Workspace layout, capacity and idle lifecycle — the contract D-031 asked for
**Implements:** D-031, which decided the policy and deliberately left the mechanism open.
**Extends:** PRD §5, which defers here ("Specify paths, ownership, retention, and migration before
implementing storage"). Full contract: [`docs/WORKSPACE.md`](WORKSPACE.md).

M2-AR-01. The parts that are decisions rather than detail:

**One Docker named volume per bot, mounted at `/home/bot`, keyed on `botId`.** A named volume
rather than a bind mount because R5 and §5.1 forbid host paths and D-031 permits storage only where
the provider owns it. Keyed on the bot rather than the session because the workspace must survive
any change of session — they are the same string today, which is exactly why the distinction needs
writing down. Ownership is a label on the volume (`crewaid.botId`), checked before every mount;
attaching one bot's workspace to another bot's desktop is the worst failure available here, because
it is silent and it leaks between bots.

**A volume at `/home/bot` is not sufficient on its own, and the reason is measurable.** Docker
populates a named volume from the image only while the volume is empty; after that the image's
version of those files is frozen. Measured on `crewaid/sandbox:dev`: deleting `/home/bot/.config/plank`
from the volume and re-running the same image left it deleted. Since the image seeds the dock's
launchers there, and §5's acceptance criteria include the dock showing Chrome, Thunar and a
terminal, a plain workspace volume would freeze every bot's desktop configuration at whatever its
first boot wrote — "supported image replacement" would preserve files while never improving the
desktop.

So the image keeps a pristine copy **outside** the mount point at `/opt/crewaid/skel`, and the
entrypoint copies it over `$HOME` before the session bus and X start. **The skel's contents are the
manifest of what the image owns** — there is no second list to drift out of step. Everything else
is bot-owned and is created if absent but never overwritten; a skel entry for `.chrome` would reset
every browser profile on every boot. Verified: a v2 image restored a launcher the operator had
deleted, added a new one, and left the operator's files untouched. The accepted cost is that edits
to image-owned paths do not survive a reboot, which is the correct meaning of "image-owned".

**Four lifecycle situations, distinguished by two observations** — does a container carry
`crewaid.sessionId`, does a volume carry `crewaid.botId` — never by the database alone. In M2,
**container absent with a volume present is never first creation.** That is the precise failure
D-031 exists to prevent: a lost container silently producing an empty desktop, so the product
appears to have deleted the bot's work. D-041 extends the evidence and replaces this M2-only rule
for workspaces provisioned at bot creation; disagreement still fails closed as recoverable error.

**Capacity admission is separate from the start lock**, answers a different question ("does the
host have room?"), counts `STARTING`/`RUNNING`/`UNHEALTHY`, and refuses **before** claiming the
lock — a refusal that left the row `STARTING` would wedge the bot for a lease. The refusal is
explicit (`503`, `code: "SANDBOX_CAPACITY"`, with `running` and `limit`), because "the host is
full" and "Docker is broken" call for different actions. M2 refuses rather than queues.

**Idle stop counts work, not watching.** A turn, a recording, manual takeover or a held lease keeps
a sandbox alive. A screen subscription does not — the rail thumbnail is open for as long as the app
is, and D-031 is explicit that a thumbnail must not keep compute alive. Disconnecting never cancels
work: if a turn is running, the sandbox is not idle.

**A deleted bot's workspace is reclaimed after a grace period (default 7 days), never by orphan
cleanup.** The reclaim deadline is a marker written inside the workspace rather than a row in
Postgres, so it survives a database restore, is self-healing when absent (a missing marker means
"first observation"), and needs no new table. A runtime-orphan sweep removes containers and may
never remove a volume, whatever it finds.

*Data model:* `Sandbox.lastActiveAt` and `Sandbox.keepRunningUntil`, both nullable, ratified as
PRD §3 deviations the way `Bot.autoReviewRules` already is. No column for the volume name — it is
derivable and the label is authoritative, and a stored copy that disagrees with the daemon is worse
than no copy.

*Config:* `SANDBOX_MAX_RUNNING` (6), `SANDBOX_IDLE_STOP_MS` (1800000, `0` disables),
`SANDBOX_WORKSPACE_RETENTION_DAYS` (7) — each added to `turbo.json`'s `globalEnv` in the same
change, or Turbo's strict env mode strips it and any test gated on it becomes a dormant guard
(D-017).

---

## D-040 · M2 owns the skill-run transport; M3 owns skill execution
**Decided by Natanael on 2026-09-07.**
**Clarifies:** PRD §5.2 and the M2-IN-04 → M3-PK-01 dependency.

The bridge's `POST /skill/run` route accepts exactly `{ "script": string, "params": object }`,
with a 256 KiB request limit. M2 validates that contract but executes no model-generated code: a
valid request returns `503` with `code: "SKILL_RUNTIME_UNAVAILABLE"` until M3-PK-01 ships the
`@crewaid/skill-runtime` executor into the sandbox. Invalid requests already receive their permanent
`400`/`413`/`415` responses in M2.

This is a boundary, not a placeholder endpoint. The executor package explicitly belongs to
M3-PK-01 and depends on M2-IN-04; implementing a second executor in M2 would either duplicate it or
reverse the recorded dependency. The `503` also prevents a caller from mistaking accepted input
for executed work.

The other M2-IN-04 routes are complete behavior. `GET /screenshot` returns the current fixed
framebuffer as raw `image/png`. `GET /atspi/events` is a real SSE stream with bounded per-client
queues and JSON `atspi` events, although v1 has no consumer (PRD §9). Each route fails independently
of `/health`, which remains the readiness contract for the desktop as a whole.

---

## D-041 · A bot owns storage from creation; compute wakes only for work
**Decided by Natanael on 2026-09-08.**
**Extends:** D-031 and D-039. Full implementation contract: [`docs/WORKSPACE.md`](WORKSPACE.md),
§14–§18.

Creating or duplicating a bot provisions its provider-owned workspace before the create request
succeeds. Provisioning creates no desktop container, takes no runtime-capacity slot, reserves no
CPU or RAM, and assigns no fixed-size virtual disk. The named volume remains isolated by bot
identity and grows only as data is written. Runtime CPU and memory limits remain ceilings applied
when a container is running; stopped and never-started bots consume storage bytes and metadata,
not a hot machine.

The M2 rule “container absent + volume present is never first creation” cannot survive this product
model unchanged: a newly created bot intentionally has that shape. First runtime creation is
therefore allowed only when **independent durable evidence agrees** that the workspace was
provisioned but never started: the `Sandbox` row is the original `STOPPED` row with no session,
container or `lastStartedAt`, and the workspace has no `.crewaid-runtime-created-at` marker. The
provider writes that marker before publishing a successful first start. Any disagreement is
recovery, never an empty first boot. Volume identity remains provider-observed and
label-validated; the database alone is not evidence that bytes are present or owned by the bot.

Provisioning is an idempotent, retryable part of bot creation, not a best-effort afterthought. A
request is not reported successful until Bot, Conversation, `STOPPED` Sandbox intent and workspace
all exist. Database rollback may leave only a correctly labelled orphan volume; D-039 retention is
the sole path that can later reclaim it. Existing bots are backfilled idempotently without
starting containers, and readiness also repairs a missing never-provisioned workspace so a failed
batch cannot strand a bot forever.

There is one orchestrator-owned **ensure ready** operation, internal rather than a new public wire
contract. Explicitly opening the computer, starting a recording, or beginning skill/tool work that
needs the computer calls it; merely selecting a conversation, rendering a rail thumbnail, health
polling, or holding a screen subscription does not. Concurrent callers share the existing start
lock and one readiness result. Switching bots or losing a viewer detaches presentation only: it
does not stop a runtime or cancel its work.

Capacity is still D-039 admission, applied only when ensure-ready needs a running container. Bot
creation never returns `SANDBOX_CAPACITY`. An interactive wake that finds the host full returns the
existing retryable `503 SANDBOX_CAPACITY` and leaves the provisioned workspace stopped; the UI
offers retry and does not pretend the bot is broken. A future queued caller may retry with bounded
backoff, but may not bypass the ceiling or evict active work.

Idle ownership follows positive evidence, never selection state or low CPU. Durable non-terminal
`AgentTurn` and `Recording` rows own their work. Operations without such a row acquire a bounded,
renewable keep-running lease before readiness and stop renewing it on every completion, failure or
cancellation path; expiry provides crash recovery and no owner may shorten another owner's
protection. Manual input advances activity but a passive viewer does not. Background processes and
downloads are protected only when a managed operation or bridge lifecycle signal can identify
their start and completion. The shipped manual terminal and browser paths must provide such a
positive signal before they are advertised as protected; arbitrary detached processes are not
inferred from CPU, process count, focus or bot selection.

No REST route, WebSocket event, table or configuration key is added by this decision. M3-BE-10 and
M3-BE-11 extend provider/orchestrator internals and use the existing `Sandbox` clocks and work rows.
If implementation proves an additional wire or durable contract necessary, it must first be added
to this decision and the shared contract in the same change.

---

## D-042 · `Recording.warning` — a hard limit is not a stop
**Decided by Natanael on 2026-09-10.**
**Extends:** PRD §3's `Recording` and §4.1's `GET /recordings/:id`. Class: the same PRD §3 gap
addition as D-005, D-009, D-021 and D-039 §10.

§6/M3 sets two hard limits — "20 minutes, 5000 events. Exceeding either auto-stops and marks the
recording `READY` with a warning" — and §3's `Recording` has nowhere to put the warning. Without a
column, a recording cut off at 5000 events and a recording the user chose to end are the same row
in the same state. The user is told their skill is ready to compile from a trace that stops in the
middle of the task, and the first symptom is a skill that does two thirds of it.

Added: `Recording.warning RecordingWarning?`, with `enum RecordingWarning { EVENT_LIMIT TIME_LIMIT }`.
Nullable and with no default, so the ordinary case is `null` and no existing row is retroactively
claimed to have been truncated. NO COLUMN RENAMES; nothing in §3 changes meaning.

An enum rather than a message. The renderer picks the sentence it shows (M3-FE-01) and the compiler
decides whether a truncated trace is worth compiling at all (M3-BE-06); neither can branch on prose
that a later edit rewords. It is the same reasoning as D-006 for provider errors: a vendor's string
is not a vocabulary.

**Read, not pushed.** The field is added to `RecordingStatusResponse` and NOT to §4.2's
`recording.state`, which stays `{recordingId, state}` verbatim. A recording stopping itself is a
terminal transition, at most once per recording, that a client already re-reads after — one round
trip, against a §4.2 payload shape five other people code against. If M3-FE-01 finds it needs the
reason in the frame itself, that is a contract change to make deliberately, not a field that
arrived because it was convenient here.

**Why the ceilings are enforced in the tee rather than by whoever settles the row.** Capture stops
synchronously, before anything is awaited. Time is checked before a newly arriving frame is handed
to the coalescer, so a delayed timer cannot admit input at or after the deadline. The event count is
checked after the whole frame is appended, so one input cannot be split in the middle of a gesture.
Enforcing either limit in the settle would make the real ceiling depend on how many events arrive
while Postgres answers. The settle that follows is fire-and-forget by necessity: the frame that
crossed the event ceiling was acknowledged to the desktop long before, so there is nobody left to
tell. The tee slot is released before settlement touches Postgres, so even a failed database read
cannot leave capture stopped while permanently reserving the bot; a durable `RECORDING` row remains
available to `recoverInterruptedRecordings` after a failed settle.

**What the time limit actually protects.** §8's idle sweep refuses to stop a sandbox whose bot has a
`RECORDING` row. Before this, a recording nobody stopped kept a container running for as long as the
orchestrator did — the one way a desktop stayed up with nobody asking. The deadline therefore has to
fire with no input arriving at all, which is why it is a timer and not only a check on the input
path. The input path checks the clock too, because a busy event loop runs a timeout late.

No new REST route, WebSocket event, table or configuration key. Both limits are constants: §0 rule 2
does not spend a config key on a number the PRD fixes.

**Addendum — how this composes with D-044 (adjudicated).** Both decisions hold, at different
layers. D-042's compiler-side judgement stands for truncated traces: the compiler judges
truncation before compiling, and a negative judgement settles the recording `FAILED` with the
reason on D-044's `error` column (M3-BE-06). D-044's "the recording then compiles like any
other" governs the recording-level path only — a ceiling may not skip compilation.

---

## D-043 · What a click screenshot is, and what it costs when it fails
**Decided by Natanael on 2026-09-10.**
**Implements:** PRD §6/M3's capture rule "On every button-down, capture a screenshot via the bridge
and store a 200×200 px crop centered on the click point" (M3-BE-04), against §3's existing
`RecordingEvent.screenshotKey`.

No new REST route, WebSocket event, table, column, or configuration key. §3 already carries
`screenshotKey String? // set on X11 clicks only`, and the four numbers below are constants for the
same reason M3-BE-05's ceilings are: §0 rule 2 does not spend a config key on a value the PRD fixes.

**`screenshotKey` is a path under `ARTIFACT_DIR`, shaped `recordings/<recordingId>/<uuid>.png`.**
The same storage `Attachment.storageKey` names (D-019/D-031), and the same discipline: the basename
is random, never derived from anything about the click. A key encoding coordinates would describe
the contents of a recording to anyone who can read a filename. Grouping by recording is what makes
discarding one a subtree to remove rather than a query. Note what this does **not** yet do: these
bytes are outside D-031's cumulative artifact quota, which counts `Attachment` rows only. A
recording is bounded to 5000 events (D-042), so the exposure is bounded too, but a retention pass
for recording artifacts is unclaimed work rather than something this decision settles.

**A wheel notch is not a button-down.** §6 says "every button-down"; §3 says `screenshotKey` is
"set on X11 clicks only". RFC 6143 §7.5.5 spends mask bits 3 and 4 on the wheel, delivered as a
press and a release of a button with no position of its own — the one case where those two readings
differ, and the narrower one governs. It is also the only reading that survives a real desktop:
scrolling one long page delivers dozens of notches a second, each otherwise costing a round trip to
the container and a PNG on disk, to photograph a target that does not exist. Only mask bits 0–2
(buttons 1–3) capture.

**The crop window is clamped to the framebuffer, not padded, and its origin travels on the event.**
A click within 100 px of an edge cannot have 200×200 around it. Padding the difference is not
neutral — the crop exists to be shown to a model (§6 sends "up to 8 screenshot crops from the most
ambiguous clicks"), and a black band reads as screen content rather than as absence. The window
slides inside the framebuffer instead, so all 200×200 pixels are real and the click is inside the
crop but not necessarily at its center. `cropX`/`cropY` are therefore added to the pointer row's
`payload` (a `Json` column, open by design) on capture only. Locating a click inside its own crop
must not require re-deriving the clamp: M3-BE-07 hands this trace to a model, not to code.

**A failed capture costs one crop and never the recording.** Every failure a container, a network
or a disk can produce resolves to "this event has no screenshot" — a state §3 already models,
since the column is nullable and set on clicks only. The events are what compile into a skill; the
crops only disambiguate them. The inverse would be much worse: a screenshot is a round trip to a
container the click has just made busy, so letting it decide whether a click is *recorded* would
make the recorder least reliable exactly when the desktop is doing the most.

**A row is never written ahead of the crop it names.** The capture starts on the input path and is
awaited by the batch writer, not by the input path — a keystroke is never behind a screenshot. The
batch carrying a click waits for it, and that wait is bounded at 5 s over the *whole* capture
rather than only over the bridge request: the decode, the re-encode and the write are the
orchestrator's own work and nothing in the round trip bounds them, while `drain` chains every later
batch, `stop` and the `status` polls M3-FE-01 makes behind the same promise. Five seconds is short
of the bridge's own 10 s `scrot` timeout. This is deliberate: a `screenshotKey` written ahead of its
file names something that does not exist yet, and M3-BE-06 reads a finished recording with no way to
distinguish "not there yet" from "never arrived".

**The screenshot is decoded defensively, because the sandbox is the untrusted side (§7.3).** A
decoder sizes its output from the dimensions the *file* declares, so a small, valid, highly
compressible PNG claiming 30000×30000 expands to gigabytes in the process that supervises every
other bot. Dimensions are read from IHDR and judged before any pixel buffer is allocated (cap
4096×4096), and the response body is bounded by a running total rather than by its `content-length`.
The bridge's own 25 MiB cap bounds the compressed bytes; the ratio is the attack. There is
deliberately no second check comparing what decoded against the header: pngjs sizes its buffer from
the same IHDR field the gate just read, out of the same bytes, so the two cannot disagree and the
comparison would be a branch no input can reach.

**Cropping happens in the orchestrator, not the bridge.** §5.2's `GET /screenshot` takes no
parameters and D-040 ratified it as complete behavior; adding a crop query to it would be inventing
endpoint surface (§0 rule 2) and moving a recording decision into the sandbox. The cost is one
full-framebuffer PNG over loopback per click, which is the cheap half of this operation. It adds
one dependency to the orchestrator — `pngjs`, pure JS, zero runtime dependencies — because there is
no way to crop a PNG without decoding one, and a hand-rolled codec in the orchestrator is the worse
of the two risks.

---

## D-044 · `Recording.error`, and what `COMPILING` costs
**Decided by Natanael on 2026-09-11.**
**Extends:** PRD §3's `Recording`, §4.1's `GET /recordings/:id`, and §6/M3's skill compilation.
Class: the same PRD §3 gap addition as D-005, D-009, D-021, D-039 §10 and D-042.

§6/M3's acceptance criteria say stopping "produces a `DRAFT` skill within 60 s, **or a `FAILED`
recording with a readable error**", and §3's `Recording` has nowhere to put the error. Without a
column, every way a compile can fail — a model that refused the trace, a name that is not
snake_case, no queue configured, a trace with a hole in it — arrives at the operator as the single
word `FAILED`, and their only recourse is to re-record a task that may fail the same way. The
column also fills a gap that predates this task: a recording failed for lost events (M3-BE-01) had
no user-visible reason either.

**Free text, not an enum** — the opposite of D-042's `warning`, deliberately. A warning is one of
two things the system decided about itself, and a renderer branches on it. An error is a provider's
verdict or a schema violation: a sentence, not a vocabulary. What it must never be is a *vendor's*
sentence — D-006 forbids that reaching a user-visible surface, so every model failure goes through
`normalizeModelError` and the column carries the operator message and the normalized code.

**`READY` now means "a skill exists", not "capture finished".** Stopping settles `COMPILING`, and
the compile settles `READY` or `FAILED`. §6's other sentence — a hard limit "auto-stops and marks
the recording `READY` with a warning" — is satisfied by the same path: the ceiling writes the
warning when capture ends, and the recording then compiles like any other (the compiler's own
judgement of a truncated trace still applies — D-042's addendum). Ending it at `READY`
without compiling would make the limits the one way to teach a task that never becomes a skill,
which is the reverse of what bounding a recording is for. `endedAt` is written once, when CAPTURE
ended, so passing through two settlements does not re-date the recording to when the model answered.

**A `COMPILING` recording can now be discarded.** It used to be refused, because nothing could
advance that state and a discard would have stranded the row. The compile job settles through a
compare-and-set pinned to `COMPILING`, so a discard that lands first simply leaves the job with no
row to move. Refusing would mean an operator who stopped the wrong recording watches it compile for
up to a minute before they may throw it away.

**The job holds no lock, and its state is its claim.** `RecordingsService` serialises transitions
per recording; the compile deliberately stays outside that chain, because holding it across a model
call would block every read of the row for the duration. Every write the job makes is pinned to
`state: 'COMPILING'`, so a job that runs twice — a BullMQ retry, a redelivery after a crash, two
workers — settles once and the loser writes nothing. Same fencing as D-029 on `Sandbox.state`. The
recording id is also the BullMQ job id, so a retried stop cannot queue the same compile twice.

**The model is asked for a parameter LIST; the orchestrator assembles the JSON Schema.** §6 names
the field `paramsSchema: JSONSchema` and that is what is stored, but it is not what is asked for.
JSON Schema is recursive, and structured output works by converting the schema into a grammar the
provider constrains generation against — a recursive schema either fails that conversion or
degrades to "any object", at which point "every param needs a description" is a sentence in a
prompt rather than something the shape enforces. A model asked for JSON Schema also writes
*plausible* JSON Schema (`"type": "str"`, `required` nested inside a property), and each of those
is a defect that surfaces in the runner long after the compile that caused it.

**A deployment without `REDIS_URL` refuses rather than silently skipping.** Chat, the desktop,
sandboxes and recording capture all work without Redis, so this is not a boot-time throw the way
`auth.guard.ts` is — refusing to start over one feature would take the other five down with it.
Instead `SkillsModule` registers no `BullModule` at all, and `SKILL_COMPILE_QUEUE` resolves to an
implementation that rejects; the rejection is what lands in `Recording.error`. `main.ts` says so
once at boot as well, so an operator learns it before they teach a task rather than from a failed
recording afterwards.

**The queue uses `@nestjs/bullmq`, and the worker is a `@Processor` behind a new config key.** The
library owns the connection, the queue's construction, and closing both through Nest's shutdown
hooks — an earlier draft hand-rolled a `Worker` from `main.ts` and had to add its own
`SIGTERM`/`SIGINT` handling alongside `enableShutdownHooks`, which is two shutdown mechanisms in
one process for no gain. What the library cannot decide is WHERE a worker should run: a
`@Processor` starts one in every Nest context that includes it, and thirteen integration suites
boot the whole application against one shared Redis, so left alone every suite would consume every
other suite's compile jobs and pay for real model calls on them.

`SKILL_COMPILE_WORKER` (default `true`) is therefore spent on exactly the problem
`SANDBOX_RECONCILE_ON_BOOT`, `SANDBOX_HEALTH_INTERVAL_MS=0`, `SANDBOX_IDLE_STOP_MS=0` and
`ARTIFACT_REAP_INTERVAL_MS=0` are already spent on — background work that must not run in a test
context — and `vitest.config.mts` sets it `false` for the whole run. It is declared in
`turbo.json`'s `globalEnv` in the same change, or Turbo's strict env mode strips it and the guard
becomes dormant (D-017). The queue suite drives a worker of its own instead.

`RecordingsService` still depends on a two-method port rather than on a `Queue`: that is what keeps
the recording lifecycle free of bullmq's types, gives the unconfigured case somewhere to live, and
lets thirty suites fake compilation in three lines.

**Two things this deliberately does not do.** The prompt does not yet forbid `sleep(n)` — §6 calls
that timing rule mandatory and the board gives it to M3-BE-07. There is no output validator and no
corrective retry; that is M3-BE-08. A compile that produces an unusable script therefore fails with
a readable error today rather than being repaired.

## D-045 · Eve was evaluated and declined; what we took from it instead
**Decided by Natanael on 2026-09-12.**
**Touches:** nothing in §3 or §4. This entry exists so the question is answered once, in writing,
rather than re-argued every time someone reads Eve's changelog.
Class: a recorded non-adoption, like PRD §2.5's "the AI SDK owns the tool-calling loop" — a fence
around work we are deliberately not doing, not a contract.

Vercel's [eve](https://github.com/vercel/eve) is an Apache-2.0, filesystem-first agent framework
released 2026-06-17, roughly two and a half months before this repo's first commit. It appears
nowhere in the PRD or in D-001…D-044, so until now its absence was an unexamined gap rather than a
considered rejection. It covers, as first-class framework concerns, a large part of what M5 and M6
are scheduled to build: a durable turn loop, tool approvals, per-caller resolution of model and
tools, MCP connections with OAuth, skills with progressive disclosure, and an eval harness.

**The decision is to keep building on the AI SDK and `@ai-sdk/harness`.** The reason is not that
Eve is unsuitable in the abstract — greenfield, it would have fit a meaningful part of this
product. It is that adopting it now is a rewrite of shipped work, and the specific thing it would
rewrite is the part we have the most evidence about.

**Eve is a server, not a library, and that is the whole integration story.** Its `package.json`
`exports` is a closed list with no wildcard; the session runtime under `dist/src/runtime/sessions/`
is not in it, and internals resolve through package-private subpath imports. The public surface is
authoring (`defineAgent`, `defineDynamic`), an HTTP client, channels, and two narrow internals.
There is no handler factory to mount inside Nest. So the three available shapes are: run `eve start`
as a supervised child process and drive it over HTTP; fork the package to reach its runtime
in-process; or invert ownership and make the orchestrator a channel behind Eve's Nitro host. The
first is the only sane one, and it is still a second process with a second state authority.

**That second state authority is the part sharing a process would not fix.** Eve persists turn and
session state through the Workflow SDK — `.eve/.workflow-data` locally and under `eve start`, or a
Postgres world package self-hosted. Turn history, approvals and run state live there, not in
`AgentTurn` and `Message`. `test/prisma-allowlist.test.ts` and `test/ownership-route-coverage.test.ts`
fence Prisma call sites and Nest routes; neither reaches Eve's world, and R7's "every query scoped
by `principal.userId`" stops at that boundary whether it is one process or two. Adopting Eve means
`AgentTurn`, `Message.stopReason`, R9 checkpointing and the §4.2 frames become a projection of
Eve's event stream instead of the source of truth. That is a PRD-level change.

**One argument made against Eve during this evaluation was wrong, and is recorded here so it is not
repeated.** The first pass held that Eve's `SandboxSession` exposing no port API was a structural
blocker, because §4.3's RFB transport and D-030's CDP relay need `getPortEndpoint`. It is not.
Ports never had to go through Eve: every consumer — `screen.service.ts`, `cdp-attach.service.ts`,
`click-screenshot.service.ts`, `skill-run.service.ts` — reaches the container out of band through
`provider.attachSession({ sessionId })`, and none of them is in the agent turn. Eve's
`SandboxBackend` is a public, fully typed extension point (`name`, `create`, `prewarm`), its
`SandboxSession` pulls its eight I/O methods from the same AI SDK type `DockerSandboxSession`
already implements through the harness, and the adapter would be missing exactly three members:
`resolvePath`, `removePath`, `setNetworkPolicy`. Writing it is a few days. The reason not to write
it is that it hands Eve a sandbox we already shipped in M2 and buys nothing back — not that it
cannot be written.

**Greenfield, the answer would have been different, and it is worth being honest about which
part.** Eve would have covered much of M1's chat and streaming layer, most of M5, and most of M6 —
call it a third of the build, and the tedious third. It would have covered none of M2, M3 or M4:
the live screen, input injection, capacity admission, workspace retention, the recording tee, the
X11/CDP correlator, and skill compilation from a watched demonstration. Eve's skills are markdown
instructions and it says so explicitly — "never a new execution surface" — while ours are
`paramsSchema` plus `script`, compiled from watching an operator work. That is the product, and it
sits outside Eve's model. The container-ownership tension would also have existed from day one:
Eve keys sandboxes to sessions, D-041 keys workspaces to bots, and the resolution greenfield is the
same custom backend described above. Its own rules about pinning (M0-07) are also worth weighing
against a 0.x public beta on `@workflow/*` 5.0.0-beta as a product spine. The smaller version of
that bet — `@ai-sdk/harness`, `Experimental_`-marked, fenced behind the one-file churn firewall in
`packages/sandbox-docker/src/types.ts` with a lint rule and a guard probe — is the one this repo
took, deliberately.

**What we took instead**, each as a board task rather than a framework dependency: session-scoped
approval memory (M5-BE-15) and the exact rule that only an explicit approval is remembered;
deferral of a message that arrived mid-turn (M5-BE-16), consumed at a park boundary with reading
and committing split; tool-surface search/load indirection behind the tool cap (M6-BE-11);
behaviour attached out of band so classification does not widen a ratified schema (M6-BE-12);
a wire version on §4.2 frames with a normalizer (CC-19); durable frame ids with an unbounded
dedupe window (CC-20); a scored eval harness (CC-18); and the re-challenge termination condition,
two-layer token eviction and principal-scoped token cache keying folded into M6-BE-04/05. Eve is
Apache-2.0 and ships its docs inside the npm package, so `npm pack eve` is the reference; its
published `.d.ts` files carry the reasoning, which is where most of the above was read.

**Revisit when** any of three things change: M5 or M6 slips badly enough that a third of the
remaining backlog is worth a rewrite; Eve reaches 1.0 with a stable `@workflow/*` line and a
documented embedding path for an existing Node server; or we want bots reachable from Slack,
Discord, GitHub or Linear, where Eve's channel layer is work we have not scheduled at all.

---

## D-046 · The computer is a first-class object, and bots attach to one
**Supersedes:** §1.4 G1 as written ("each bot has an isolated Linux desktop"), and the
one-volume-per-bot cardinality in D-039 §2 / WORKSPACE.md §2 and §5.
**Extends:** PRD §3 `Sandbox`, §5.1, D-031, D-041.

**One machine per user by default, with bots attached to it — not one machine per bot.** The
cardinality stops being implicit: `Sandbox` keeps its name and stops being keyed 1:1 on `botId`.
A bot references the computer it works on, and the number of computers is a user's choice with a
default of one.

**Why this rather than a shared volume between private containers.** The previous plan was a
second named volume mounted into several bots, with per-bot uids and a Unix group per project to
fence it. That machinery exists only to simulate one filesystem. Three things it cannot buy at any
price:

- **Handoff.** A PM reading a developer's worktree is a `cd`, not a protocol. Every alternative
  ends in relaying artefacts through chat messages, which M7's chain budget makes impossible.
- **Logins.** A sales team needs one LinkedIn session, not one per bot. Separate containers mean
  the operator authenticates every account once per bot and again on every cookie expiry. This is
  the difference between a four-bot team that takes minutes to set up and one that takes an hour
  and decays.
- **Cost.** §7.5 sizes six bots at 8 vCPU / 16 GB. D-033 states plainly that the $30 ceiling is
  "a product constraint, not a validated cost estimate"; six desktops per user does not obviously
  fit under it and one does.

**What we do NOT copy from the shared-machine products: the screen.** Their isolation is per user
and so is their desktop — one machine, one screen. G2 (watch any bot's screen, take control) is a
differentiator and M2 already shipped it: per-bot streams, thumbnails and takeover (D-035, D-037,
D-038), and M4's capture keyed to a bot's Chrome. A shared *container* does not require a shared
*display*. Each bot keeps a seat — its own display and browser target — inside the one machine, so
the container is shared and the screen is not. One machine does not mean one bot at a time.

**The isolation boundary moves from the bot to the user, and that is a real cost.** One bot's
`rm -rf`, or one prompt injection off a web page, now reaches every bot's files and every login on
that machine. This is accepted deliberately: the threat model this product has is an operator's
bots being attacked from outside, not an operator's own bots attacking each other. §7.3's container
boundary, R5 and the `agent-net` egress policy are all unchanged — the machine is still a
provider-managed named volume with no host path and no Docker socket. What changes is how many
bots sit behind one boundary.

**R5 is untouched. R8 is untouched.** Still a named volume, still no bind mount, still a fixed
framebuffer per display for its lifetime.

*Data model:* `Sandbox.botId @unique` becomes a user-scoped key plus a per-bot seat; `Bot` gains
the reference. Ratified as a §3 deviation the way `Bot.autoReviewRules` and D-039's
`lastActiveAt` / `keepRunningUntil` already are. The table keeps the name `Sandbox` — §0 rule 2
does not spend a rename across M2's lifecycle code, M4's capture, the §4.1 routes, the §4.3 frame
header and the R7 allowlist to change a word the UI already calls "computer" anyway.

**Closed by M5-AR-01 — WORKSPACE.md §20, measured.** A seat is a Chrome **window** on the
machine's one display, with its own window-scoped RFB stream. The numbers decided it rather than
taste: a private X display per seat costs 439 MB against a whole private container's 443 MB, so
paying per-display buys nothing over keeping D-039's containers while giving up their isolation.
A window seat costs 79–98 MB. Six bots: ~2.7 GB as six containers, ~840 MB as six seats.

Two mechanisms were verified rather than assumed. `x11vnc -id <winid>` serves one window — the
full-screen port advertised 1280×800 and the window-scoped port advertised the window's own
1050×780 — so G2 survives a shared container. And Chrome's singleton *delegates*: a second
`google-chrome` on the same `--user-data-dir` asks the running browser for a window rather than
starting its own, which is exactly what makes one cookie jar serve every seat, and exactly what
topology B could not have had.

The measurement also found the constraint: **`--window-size` does not pin a delegated window**, so
R8 now holds **per seat** rather than per screen, and a seat's bounds must be set once over CDP and
never renegotiated. §20.1 has the fallback and what is still untested.

**Sequencing, and why this is urgent rather than interesting.** M5-BE-05 scopes `fs_read`/
`fs_write` to `/home/bot` and M5-BE-14 makes a tool await *its* computer. Both encode the old
cardinality and both are next in line behind M5-BE-03. Deciding after they ship means rewriting
them; deciding now costs this entry and a migration.

---

## D-047 · Limits are the operator's, not the product's
**Amends:** §6/M7's loop-protection defaults and §7.2's cap default.

The product's job is to make spend and runaway loops **visible and bounded by the operator**, not
to pick the bound for them. Three of the current defaults refuse work the operator asked for:

- **`MAX_DAILY_TOKENS` ships on at 2,000,000.** The mechanism already supports being off — absent
  or `0` disables the caps and `checkDaily` returns before it queries — so this is a default, not
  a capability. It ships **off**, and CC-12's money-denominated `/usage` becomes the control
  surface: an operator who wants a wall sets one.
- **§6/M7's `MAX_HOPS = 10` and the 3-messages-to-one-bot-per-chain cap.** Ten hops is roughly
  five round trips. A PM delegating to a developer and a reviewer all day exhausts that before
  lunch, and the repeat cap means the PM may speak to the same developer three times, ever, in a
  chain. Keep `chainId` and `hopCount` — the PM needs both to reason about its own delegation, and
  an operator needs them to read what happened — and make the limits configurable and off by
  default.
- **The 200,000-token chain budget.** Same treatment: the accounting stays, the default stops
  being a refusal.

**What does not change:** the accounting, the system message that explains a termination, and the
clean-termination behaviour when a participating bot is deleted. A chain that ends must still say
why. The §6/M7 acceptance criterion "two bots told to converse indefinitely terminate" is met by a
configured limit rather than a shipped one, so the test sets the limit it asserts.

**The argument against, recorded because it is real:** "the operator can stop it" assumes the
operator is watching, and the premise of an unattended team is that they are not. The answer is
disclosure rather than a wall — an unbounded loop is visible in `/usage` as money — and an operator
who wants the wall has one config key. This is a product decision, not an engineering one.

---
## D-048 · What a context trim may drop, and what it may never touch

**Extends:** §6/M5's "use `prepareStep` to trim context".

A turn grows an assistant message plus a tool message per step, and the tool payloads are the
growth. Trimming is what lets a long turn continue, so it is **not** a §7.2-style wall and D-047
does not apply: raising `AGENT_CONTEXT_TRIM_TOKENS` buys a larger context per call, not more work.

**When.** Off the previous step's input tokens as the provider counted them — `prepareStep` is
handed every prior `StepResult` and each carries its usage. Below the threshold `prepareStep`
returns nothing at all, so an ordinary turn is byte-for-byte what it was before the hook existed.

**How.** The SDK's `pruneMessages`, configured rather than reimplemented (PRD §2.5). A tool-call
part and its matching result live in **different messages** and every provider rejects a history
holding one without the other, so a "drop the oldest few messages" trim returns a 400 rather than
a shorter prompt.

**Never dropped:**
- The bot's **instructions** — they are `instructions` on the agent, not a message, so a
  message-level prune cannot reach them.
- The **trigger** and its D-022 attachment parts. `pruneMessages` keeps the leading user message.
- The **newest tool round**, whole.
- **Reasoning parts** — `reasoning: 'none'`. Anthropic's extended thinking requires the signed
  reasoning blocks to be replayed alongside the tool calls they produced; stripping them makes the
  provider refuse the request, so a trim meant to save a long turn would be the thing that kills
  it. `'before-last-message'` does **not** avoid this: at `prepareStep` time the history ends with
  a tool result, so every assistant message is "before the last message" and that setting strips
  exactly as much as `'all'` (measured — both leave zero reasoning parts on a three-round history,
  while `'none'` keeps all three). Nothing sets `thinking`/`providerOptions` today, so this is
  inert; it is set now because the day it stops being inert is the day the wrong value starts
  failing long turns.

**Accepted losses, recorded rather than discovered later:**
- `toolCalls: 'before-last-2-messages'` keeps the assistant's own narration for older rounds but
  drops their payloads, so a model can re-do work it already did. The narration is what makes that
  recoverable rather than invisible.
- `pruneMessages` defaults to `emptyMessages: 'remove'`, so an assistant message that held only a
  tool call disappears entirely once that call is pruned — that step's intent goes with it.

**The model half of M5-BE-02 is deferred, not done.** §6/M5 also says to "swap models per step if
`Bot.modelId` implies it". It cannot: `Bot.modelId` is one registry key and `resolveModel` returns
one model for it. The turn pins that model once and every step uses it, which is what we want
anyway — re-resolving per step would let a mid-turn change to `DEFAULT_MODEL_ID` (D-004 resolves
the alias at call time) split one turn across two models. A tier on `Bot` is the missing input and
it is a data-model change; **M5-BE-22** carries it.

*Config (M5-BE-02):* `AGENT_CONTEXT_TRIM_TOKENS` (100000), added to `turbo.json`'s `globalEnv` in
the same change.

---


## D-049 · R4 is a type the compiler can refuse, not a reduced view we remember to pass

**Status:** accepted (M5-BE-07)

R4 says tools receive `session.restricted()`, never the full network session — no `destroy()`,
no `setNetworkPolicy()`, no `setPorts()`. Until M5-BE-07 the mechanism for that was a type
annotation that did not mean what it looked like.

**The hole.** `HarnessV1NetworkSandboxSession extends Experimental_SandboxSession`, and
`HarnessV1RestrictedSandboxSession` *is* that base type. Structurally, the wide session is
therefore assignable to the reduced one. Typing a tool's session as the reduced view stops a tool
**calling** `destroy()` — the property is not on the type — and stops nobody **handing** it the
wide session in the first place. Measured rather than reasoned: reverting `AgentSessionService`
to return the session it attached, under the old annotation, typechecks with zero errors.

That is the mistake with a real chance of happening. `() => this.session` is one word shorter than
`() => this.session.restricted()`, M5-BE-20/21 and every M6 tool add a new call site, and the only
thing that would have caught it was a reviewer reading a comment.

**The fence.** `ToolSandboxSession` (exported from the harness firewall, the one file allowed to
name these types) is the reduced session intersected with every infra member declared as an
optional `never`. A value carrying `destroy: () => PromiseLike<void>` stops being assignable,
because a function is not a `never`, while the reduced view — which carries no such property —
still fits. Both call spellings stay blocked, and the second one matters: this repo's idiom for
every optional harness member is `session.setNetworkPolicy?.(policy)`, so a tool author copying
that shape must get a compile error rather than a silent no-op. `never` has no call signatures,
so they do.

**The ban list is the difference, not a shortlist.** `SANDBOX_INFRA_SURFACE` is asserted in
`types.test.ts` to be exactly `keyof HarnessV1NetworkSandboxSession` minus the base session's
keys. A member upstream adds fails that assertion instead of quietly becoming something a tool can
reach. `id`, `defaultWorkingDirectory` and `ports` are on it for that reason alone — they carry no
capability, but a curated list stops being the difference the moment someone curates it.
`sandbox-session.test.ts` drives its forbidden-property loop off the same constant, so the runtime
and type halves cannot disagree.

**The type is not the whole fence, because types are erased.** The object arrives from an injected
provider TypeScript never saw, and the implementation that breaks R4 is the obvious one:
`restricted: () => this`. Upstream's own description — "a narrower surface over the same resource"
— reads as permission for it, every hand-written fake reaches for it, and under it the annotation
says nothing, the wiring still compiles, and every tool gets the infra surface. So
`AgentSessionService` checks the object it is about to hand out and throws if any banned member is
reachable. `in`, not `Object.hasOwn`: a provider written as a class carries its methods on the
prototype, which is precisely the shape `restricted: () => this` produces.

Throwing, not stripping. Stripping would hide a provider bug behind a session that is not the one
its contract describes, and R4 is a security boundary.

**Demonstrating it.** D-013 asks that every guard be shown failing, and `tools/guard-probes`
cannot host this one — the runner asserts that a named eslint rule fired, and none of this is an
eslint rule. `@ts-expect-error` is the equivalent: it fails the build when the line under it stops
being an error, so weakening the type reports an unused directive on exactly the line that was
supposed to be blocked. It is the first use of that directive in the repo, and it is a guard
rather than a suppression.

---

## D-050 · How the auto-review matcher answers when its inputs are not what the happy path assumes

**Status:** accepted (M5-BE-08). Implements D-005; settles what D-005 left open.

D-005 fixes the rule shape and the search: an ordered per-bot list, first match wins, default
`ask`. It says nothing about the three inputs that are not rules — a Json column that may hold
anything, a tool name that came from a model, and arguments that may not serialize — and the
matcher runs inside a turn that §6 forbids it to fail. Each of those is a decision.

**It is total, and it never allows on uncertainty.** Nothing here throws, and every branch that
cannot reach a confident answer lands on `ask`. An operator whose rules stopped parsing is asked
about things they had allowed: visible, recoverable, and loud. The inverse — a `deny` that silently
became an `allow` — is a policy hole with no symptom.

**An unparseable rules column is set aside whole, not filtered.** Keeping the entries that happen
to parse deletes whichever rule is malformed, and a deleted `deny` is exactly the invisible hole
above. Setting the list aside sends every call for that bot to `ask`, which the operator notices
within one turn.

**Registration is checked before the rules.** `gmail__* → allow` is an honest rule about one
server's tools; it must not become permission for a name that server never reported. An
unregistered tool cannot run either way — there is no `execute` — so the only question is whether
it fails as a denial the model can read or as an exception, and §6 answers that: `deny`.

**`ToolRegistry` grows a total lookup rather than a default.** `behaviorOf` keeps throwing — it
answers a wiring question, where an unregistered name is a bug. `tryBehaviorOf` returns
`undefined` — it answers a runtime question asked once per tool call, where "nothing registered"
is an ordinary result. The third option, defaulting an unknown name to `builtin`/`isolate`, is the
one that must not exist: it classifies a tool nobody classified, which is the silent allow
M6-BE-08 is about. `has()` then `behaviorOf()` reaches the same answer with two lookups and a
shape that invites the second to be forgotten.

**No regex, ever.** D-005 chose a substring `argMatch` over a predicate so a rule cannot be code.
An operator-supplied regex would put a ReDoS surface on a per-tool-call path, which is the same
objection §7.3 makes to `eval` and `new Function`. A `*` that is not trailing is therefore a
literal, and since no legal tool name contains one, such a rule can never match — correct, silent,
and logged for that reason.

**Downstream.** §6/M6 gives MCP tools `ask` (already the default) and read-only tools `allow`.
`readOnly` is not on `ToolBehavior` yet and M6-BE-12 owns adding it; the default branch is where it
lands. M5-BE-09 maps the outcome onto the SDK's call-level `toolApproval` — note that
`Tool.needsApproval` is deprecated in ai@7.0.89 in favour of it.

---

## D-051 · An approval suspends the turn, because the SDK's loop ends on one

**Status:** accepted (M5-BE-09). Measured against `ai@7.0.89`, not read off the docs.

`Tool.needsApproval` is deprecated — "tool approval is handled on a generateText / streamText
level now" — so the live surface is the call-level `toolApproval` function. The consequence that
shapes everything else is in the SDK's own list of loop-exit conditions: **"a tool call needs
approval"** ends the agent stream, with the call unexecuted. An approval is therefore not a promise
a tool awaits inside the loop. It is a turn that stops, asks, and is continued by a second
`agent.stream()` with a `tool-approval-response` appended to the history.

**What each status actually does**, measured one at a time:

| status | tool runs | transcript | loop |
|---|---|---|---|
| `not-applicable` | yes | tool-call, tool-result | continues |
| `approved` | yes | **plus** an approval request/response pair, `isAutomatic: true` | continues |
| `denied` | no | the model gets a tool result, `output: {type:'execution-denied', reason}` | continues |
| `user-approval` | no | a `tool-approval-request` part | **ends** |

`denied` is what makes §6/M5's "denying returns a tool result the model can react to, not an
exception" true without us building anything: the `reason` we pass reaches the model verbatim, so
it names the rule that refused.

**`allow` maps to `not-applicable`, not `approved`.** Both run the tool. `approved` also writes an
approval request and response into the transcript for a question nobody was asked; §4.2 lists
neither part, and M5-FE-02's prompt renderer would have to learn to hide what M5-FE-01 had just
been taught to show. The record of an auto-allow lives in the structured log and R9's step
checkpoint. If the team later wants auto-approvals visible, `isAutomatic: true` is the flag to
render on.

**A turn is one stream per approval round, so four things have to survive a round.** The step
budget (`stopWhen` counts within one `stream()` call — refreshing it would give a turn 25 more
steps for every approval it asked for, and §6/M5's ceiling is per user turn). R9's step numbers
(`stepNumber` restarts at 0 each round, so the record would show a turn that began twice). The
partial text, and the accumulated content parts. The suspending round's own messages go back into
the history too: a step runs the calls that need no approval and suspends on the one that does, so
dropping them asks the resumed model to answer a call it can no longer see.

**`approval.requested` is emitted after the waiter is registered, not before.** The frame and the
wait are two halves of one operation, and a client that answers immediately — an auto-approving
test client, an operator who was already looking — would otherwise be told nothing was waiting.
The turn would then hang on a question that had already been answered. This is why the emission
sits inside the approvals port rather than on the `AgentTurnEmitter` beside the other §4.2 frames.

**There is no timeout on a suspended turn.** §6/M5's limits are a step ceiling, a token ceiling and
a ten-minute wall clock, and all three are M5-BE-11's, for the whole turn. A clock started per
approval would be a fourth limit nobody specified, and the one most likely to fire while an
operator is reading the command they were asked about. `bot.cancel` is what ends a wait today.

**Not settled here: what a bot's rules default to.** See CC-24. Wiring the specified default makes
every tool call on a fresh bot ask, which is what §6/M5 says and not what its own acceptance
criteria describe.

---
## D-052 · Loop limits: what the accounting keeps, and what ships off

**Status:** accepted (M5-BE-11). **Amends:** §6/M5's three loop-safety defaults
under D-047. **Depends on:** D-051's finding that a turn is one agent stream per
approval round.

§6/M5 sets three ceilings on a turn — 25 steps, 150,000 accumulated input
tokens, ten minutes — and says that on any limit the turn stops, posts a system
message naming the limit, and the bot goes back to `IDLE`. D-047's argument
applies to the ceilings and not to the rest: **the accounting stays, the system
message stays, and two of the three refusals ship off.**

**`AGENT_MAX_TURN_TOKENS` and `AGENT_MAX_TURN_MS` default to 0, meaning no
ceiling.** These are exactly D-047's shape — a wall hit while the bot is doing
the job it was asked to do — and an operator who wants §6/M5's numbers sets two
keys that `.env.example` carries commented out.

**The step ceiling is not in that family and stays on at 25**, because "off" is
not one of the states the loop has. Measured against `ai@7.0.89`: an agent built
with no stop condition runs **20** steps, the SDK's own default. Removing our
ceiling does not remove a ceiling, it installs a lower one that no operator
configured and no message explains. So the only question the step ceiling asks
is which number, and §6/M5 answers it.

What makes the other two ceilings' "off" real is the other half of the same
measurement: a stop condition that never returns true **replaces** the SDK's
default rather than adding to it. Asserted — with all three ceilings set to 0 a
turn runs past 20 steps — because otherwise "off" would quietly mean 20.

**One stop condition, three ceilings, checked against the TURN's totals.** The
`stepCountIs` call the runner used is gone. `stopWhen` counts within one
`stream()` call, so under D-051 a per-round ceiling would hand a turn a fresh 25
steps for every approval it asked for. The account the condition reads spans
rounds, and it also replaces the hand-kept step counter R9's `stepNumber` offset
used — one number for one idea.

**A suspending step never evaluates a stop condition.** Measured: with a
condition that returns `true` on every step and a tool that needs approval, the
condition is not consulted once. The approval exit pre-empts it. So the ceilings
are re-checked in the runner's own round loop, **before** the operator is asked:
a turn with no budget left cannot run the call whichever way they answer, and
asking would put a prompt in front of someone whose only honest answer is "it
makes no difference". The unanswered `tool-approval-request` part stays in the
transcript — the model did ask — and the system message says why the turn ended.

**The clock measures the turn's work, not the operator's reading time.** §6/M5
calls it a wall clock and the strict reading would keep counting while a turn is
suspended. It does not, and this is the open question D-051 handed to this task
rather than an oversight. What the limit bounds is a runaway loop, and a turn
waiting on a human is the opposite of one; a clock that fires while someone
reads the command they were asked to approve fires at the one moment it helps
nobody, and `bot.cancel` already ends a wait. The copy says so in the sentence
the user reads.

**A limit is not a failure.** The turn finalizes `SUCCEEDED` with its partial
reply persisted, its steps checkpointed, and the SDK's `tool-calls` in
`stopReason` — reporting `FAILED` would put an error banner on work the bot
actually did. Because `tool-calls` also describes a turn that ended on a tool
with no executor, the runner returns `stoppedBy` separately; that is the seam
M5-BE-19 reads to tell a turn it may continue from one it may not (D-032).

**What a user actually sees, and what they do not.** The system message is
durable only. `message.created` for a non-USER author opens the client's
in-flight slot (`chatReducer`), so emitting one for a system message would leave
a phantom reply streaming forever — the daily-cap refusal has the same
constraint and answers it with the `error` frame it is entitled to, which a
limit stop is not. The message reaches the client on its next history read. See
**CC-25**, which also covers the other half of §6/M5's sentence: nothing in the
orchestrator writes `Bot.status` or emits `bot.status`, so "set status IDLE" and
"does not leave the bot stuck in ACTING" describe a state machine that does not
exist yet.

---
## D-053 · One action is several parts, so the transcript folds them

**Status:** accepted (M5-FE-01). **Clarifies:** PRD M1's part-registry
acceptance rule and §4.2 `message.part`.

A single tool call reaches the client as up to four parts: a `tool-call`, a
`tool-approval-request` and its response, and a `tool-result`, `tool-error` or
`tool-output-denied`. Rendered one at a time — which is what the part registry
does, resolving by `part.type` with no sight of a sibling — that is four rows
for one action, three of them repeating the tool's name and arguments.

**They are folded into one row, in the wire → view translation.** Not in the
transcript, which renders `parts.map(renderPart)` and must not learn what a
tool is (PRD M1 acceptance: "adding a part type in M5/M6/M7 must NOT touch the
transcript component"), and not in the registry, which sees one part at a time.
`viewTypes.ts` is already the single place a §4.2 row becomes a view, and the
fold happens at the two points a `TranscriptMessage` is built.

**Not in the reducer.** `toParts` also narrows a single incoming
`message.part` frame, so folding there would store a derived shape in reducer
state and fold it again on the way out. The reducer keeps the SDK's parts as
they arrived; the fold is a projection made when something is rendered, which
is also what lets a reconnect resync replace a half-settled row wholesale.

**The folded row keeps the CALL's position, and the outcome wins on status.**
Under D-051 an outcome can settle a whole agent round later, after the bot has
already written another paragraph, so rendering it where it landed would print
the answer after a sentence written before the question. And a resumed round
contributes its outcome to the FRONT of that round's parts, so precedence is
enforced by processing approvals and outcomes in separate passes rather than by
trusting the order parts arrive in — a merged pass looks correct today and
would stop being correct the first time something reordered them.

**Size is a correctness concern in this component.** §6/M5's 100 KB truncation
is on what reaches the MODEL (M5-BE-12); nothing truncates what reaches the
client, and the persisted part is the full one — a `browser_read` of a real
page is an entire accessibility tree. Both the row's summary and its expanded
detail are bounded, and the row states how much it elided rather than implying
that was all of it.

**An orphan outcome renders as itself.** A history page that begins mid-turn
hands the fold a result whose call is on the page before. It is passed through
and the same component renders it standalone, because a result with no visible
call still tells the reader what happened; dropping it would be a silent hole.

**What this does not build.** The approval exchange is rendered as *status* —
waiting, approved, declined — and not as a prompt. The buttons are M5-FE-02's;
folding the exchange in here is what stops a suspended turn from printing
`[unsupported part type: tool-approval-request]` between a call and its result.

---
## D-054 · The approval prompt is driven by the frame, not by the part

**Status:** accepted (M5-FE-02). **Depends on:** D-051, D-053.

A turn suspended on an approval has not finalized, and the runner emits content
parts when a turn finalizes — so the `tool-approval-request` part is **not on
the client while anyone is waiting**. The §4.2 `approval.requested` frame is the
only thing that arrives during the suspension, and before this it reached the
reducer and was explicitly dropped ("frames the M1 shell has no surface for
yet"). Every bot whose rules said `ask` waited forever with nothing on screen.

So there are two surfaces for one question and they are fed differently, which
is the thing to keep straight when either is changed:

| | driven by | lives in | when |
|---|---|---|---|
| the prompt (M5-FE-02) | the `approval.requested` frame | `approvalsByBot` | while the turn is suspended |
| the record (M5-FE-01) | the `tool-approval-request` part | `Message.parts` | after the turn ends |

**Keyed by bot, not by the in-flight message.** A bot that asked keeps waiting
while the operator looks at another bot, so the answer has to be there when
they come back — the same reason the wake and the recording are keyed by bot.

**It survives a reconnect, deliberately.** The orchestrator's pending map is
in-process; a client reconnecting does not invalidate a `toolCallId`, and
nothing replays `approval.requested`. Clearing on reconnect would hide a
question the server is still waiting on. An orchestrator restart is the case
that does invalidate it, and R9 marks that turn `INTERRUPTED` anyway.

**It is cleared when the turn ends, by any of the ways a turn can end without
answering:** a cancel while the operator was reading, a §6/M5 limit reached on
the suspending round so the turn stopped rather than asked (D-052), or a
provider failure. A prompt whose turn is over is a control that can only
produce "no tool call is waiting on approval".

**An answered prompt stays on screen, disabled.** The turn resumes
asynchronously — the tool still has to run and the model still has to answer —
so a row that vanished on click would leave the operator unsure whether their
answer landed. `message.completed` takes it down, the same frame that settles
the reply. A second answer is ignored rather than applied: the server acted on
the first one, and letting a later click overwrite it would show "Declined" for
a call that was approved and has already run.

**The send and the local record are one action.** Dispatching without sending
disables a prompt the server is still waiting on; sending without dispatching
leaves two live buttons for a question already answered. The dispatch is
conditional on the frame actually leaving, so an answer refused while the socket
is down stays answerable when it comes back.

**What is not built.** A decline carries no reason, though §4.2 allows one and
D-051 notes the reason reaches the model verbatim. One click to decline is the
safer default for a control that appears mid-reply; a reason field is an
addition, not a correction. And a prompt does not survive an app restart — the
pending set is renderer memory and there is no §4.1 route that lists what a bot
is waiting on. **M5-BE-13** owns persisting pending approvals; that is the half
that would make this recoverable.

---
## D-055 · What the computer tools may touch, and what that is worth

**Status:** accepted (M5-BE-05). **Clarifies:** §6/M5's "scoped to `/home/bot`"
under D-046; WORKSPACE §19 and §22.

§6/M5 scopes `fs_read`/`fs_write` to `/home/bot`. That was a boundary when a
container held one bot. Under D-046 `/home/bot` is the **machine's** home and
every tenant shares it, so the question changed from "inside the home?" to
§19's three-way split — the bot's own `agents/<botId>/`, the team's `shared/`,
and the machine's `.chrome`/`.config`/`.cache`.

**The check is a guardrail against a confused model, never a boundary against a
determined one**, and the suite says so where a reader would otherwise take it
for a safety claim. `shell()` executes as the same uid and skips every path
check in this file; §22 is explicit that isolation is per computer. The
boundary is the container.

That is the argument for being strict in the tools that *can* check, not
against it. §6/M5's rejection cases — `/etc/shadow`, an escape upward — are the
mistakes a model makes, and a refusal that names the right directory is one a
model can act on. Another tenant's `agents/<someone-else>/` is refused for the
same reason: a model reaching there has mistaken whose notes those are, not
decided to share.

**`..` at the root clamps rather than being refused**, because `/..` *is* `/`
on Linux. Refusing it would be stricter than the kernel and would reject
`/../home/bot/shared/x`, which names a real file. Nothing rests on the clamp —
a path that climbs out lands outside `/home/bot`, and the prefix check is what
refuses it. A NUL byte *is* refused before anything is normalized: the syscall
truncates there, so a path that passes a string check can open something else.

**`screenshot()` is the bot's seat, taken through CDP.** `Page.captureScreenshot`
on the seat's own session rather than the machine's framebuffer: it is this
bot's window and not whatever else is on the shared display, without this layer
having to know where that window sits — R8 pins a seat's *size*, and a takeover
operator can still move it.

**It returns an image part through `toModelOutput`**, which is §6/M5's "returns
an image part to the model" using the SDK's own mechanism rather than base64
inside a JSON string no model can see. This is also the seam M5-BE-12's note
asks for: the executor returns the full typed result for our own code, and the
projection decides what reaches the model, so truncation stops destroying the
value the orchestrator still needs.

**Approval is not implemented here.** §6/M5 calls `shell` "always requires
approval by default" and that is the auto-review matcher's (M5-BE-08), with the
rules on the bot — which is what lets an operator decide otherwise for their own
machine. What this file owes that sentence is a description an operator reading
a prompt can judge, and a result that quotes the command back.

---


## D-056 · Each bot owns a persistent Chrome profile on its shared computer

**Status:** accepted, implementing the operator decision in M5-BE-26.
**Amends:** WORKSPACE §19–20's shared-profile default; D-046's shared computer remains.

Use one browser process and user-data directory, with `--profile-directory=<botId>` per seat.
Measured cookie jars and browser contexts are distinct; the earlier claim that every profile
requires a browser process applied to separate user-data directories, not this topology.
Named shared identities require explicit grants and remain M5-BE-27.

Identification uses a unique marker URL/title because a new profile may open additional windows.
Geometry is fixed before navigation. Both initial launch and singleton delegation retain
`--no-sandbox` under the existing container capability policy.

Deletion queues a durable tombstone through a short networkless workspace helper, including for
stopped desktops. The next boot removes retired profile directories and their Chrome Local State
references before Chrome launches. A live `rmtree` is not deletion: Chrome can recreate a loaded
profile. Tombstones also prevent stale allocations; sibling profiles and the computer remain.
Cleanup errors after the bot's transaction commits are logged, matching existing seat-release
semantics. Last-tenant storage continues to follow the workspace retention policy.

The original Docker suite exhausted **tasks**, not RAM: cgroup pids counts Chrome threads too.
Seat admission checks actual cgroup headroom (160 tasks and 256 MiB), under the creation lock,
before launching. Published ports are only a port ceiling; no sixteen-profile capacity claim
follows from them. Workload growth remains bounded by the container limits, not these estimates.
Tests use independent desktops, a local cookie origin, and real capacity/restart regressions.

---

## D-057 · A shared login is a named profile a bot is granted, not a copied cookie

**Status:** accepted (M5-BE-27), implementing the operator's decision alongside D-056.
**Extends:** D-056's per-bot profile default. **Adds to §3:** `Identity`, `BotIdentity`.

D-056 made every bot's Chrome profile its own, which is the right default and gives up the one
thing WORKSPACE §20's shared profile was good at: a session somebody has already signed into.
An identity gives that back with a name. `company-google` is a profile directory like a bot's
own, and a granted bot opens its seat with `--profile-directory=company-google`. Two bots
granted the same identity still get their own WINDOW (D-046) and simply read the same cookie jar.

**Nothing is copied, and that is the argument rather than a detail.** Moving a session instead
fails in three measured ways: Chrome refuses a named profile's context id in the browser-level
`Storage` domain ("Failed to find browser context for id"), so it must go through the page's
`Network.getCookies`/`setCookies`, which is origin-scoped; `localStorage` tokens are missed
entirely; and a site that binds a session to the device defeats the copy outright while tripping
exactly the login-anomaly heuristics an operator least wants tripped. A credential vault plus a
real login survives device binding but is brittle per site. Sharing the directory has none of
these properties because there is no second copy to be wrong.

**MCP is not this and must not become it.** R10 keeps MCP credentials in the orchestrator and out
of every sandbox, which the operator reaffirmed: MCP gives an agent access to a service, not a
way to hand a browser someone's credentials.

**The gate is the ordinary approval, with no carve-out.** `use_identity` is a built-in like any
other, so the bot's own rule list decides it and the default is `ask`; the prompt M5-FE-02
already renders shows the tool and its arguments, so the identity's NAME is what an operator
reads and the question is answerable without new UI. D-055 settled this shape for `shell` —
§6/M5's "always requires approval by default" is the MATCHER's default, "with the rules on the
bot, which is what lets an operator decide otherwise for their own machine" — and a second,
unbypassable class of approval would be two answers to one question. **The consequence is stated
rather than left to be discovered: an operator whose rules say `* -> allow` has written a blanket
grant.** If an unbypassable class is ever wanted, it is one mechanism serving `shell` too, not a
special case bolted onto this tool.

**A grant is a product control, not a security boundary**, and the code says so where a reader
would otherwise take it for a safety claim, as D-055 does of the path checks. `shell` runs as the
same uid and `/home/bot/.chrome` is the machine's, so a determined bot on this computer can read
any profile on it; the boundary is the container (WORKSPACE §22). What the grant buys is that a
bot does not SILENTLY end up inside someone's session — it has to ask, and the answer is recorded.
Two names are refused outright because approving them would mean something no operator intends:
any bot's id, which IS that bot's own private profile under D-056, and `Default`, which is the
machine's launch window.

**An identity belongs to a COMPUTER, not a user.** The logged-in session is a directory on one
machine's disk. A user with two computers who expected one name to work on both would be told it
exists and find it signed out — a failure this scoping makes impossible to express. `Identity.name`
IS the directory rather than a display name with a slug beside it: `McpServer` carries both
because an operator types "Gmail" and the wire needs "gmail", while here the bot names the
identity and the operator only reads it back off a prompt, so a second column would be two truths
about one directory.

**The switch is three steps in one order, because a seat's profile is fixed when its window
opens.** Write the grant, close the seat the bot is holding, then forget the page the turn had
open on it. The grant goes first so a crash between steps leaves a bot that will open on the
identity next time rather than one that lost its window for nothing; the seat second, because the
machine refuses to hand back a window on the wrong profile; the page last, because it is attached
to the target the release just closed. `TurnBrowser` gains `reset()` rather than reusing
`dispose()` for that last step — the turn is not over.

**The identity is created on first approval, not through a REST resource.** Every sandbox route
in §4 is bot-scoped, and a `/computers/:id/identities` namespace would be invented endpoints with
no UI to consume them. Approving the prompt IS the act of saying this identity should exist; the
profile is made by Chrome when the seat opens and starts signed out, an operator signs in once on
the live screen, and every later bot granted the name arrives at that session. A route for
listing and revoking identities is worth having when a screen wants one, and adds nothing today.

---

## D-058 · Ego Lite was evaluated and declined; what we took from it instead
**Decided by Natanael on 2026-09-15.**
**Touches:** §6/M5's browser tools (M5-BE-04, M5-BE-12, M5-QA-10), M4's compiled skills, M5-BE-21.
Nothing in §3 or §4 changes.
Class: a recorded non-adoption in D-045's form — a fence around a dependency we are deliberately
not taking, plus the four findings it produced, which are the part worth keeping.

[citrolabs/ego-lite](https://github.com/citrolabs/ego-lite) was raised as something to use rather
than rebuild: *the Linux version is not available yet, so we can just use it.* The evaluation, its
probe, and the list of what it did not test are `docs/reviews/EGO-LITE-EVALUATION.md`; this entry
is the decision.

**ego-lite is two artifacts sharing one repository, and only one of them is the browser.** The
first is an MIT Node CDP harness plus an agent Skill plus per-site learning packs — readable, and
runnable on Linux today: its own suite passes here at `d01be93`, 494 tests, 0 failures, with
`acorn` as its entire runtime dependency. The second is the browser: closed-source, macOS-only,
distributed as a `.dmg`, with Windows and Linux "on the roadmap" in its README. The harness reaches
the app through one documented global, `globalThis.ego` — 16 methods, 15 error codes, raw CDP
through `ego.sendCDPMessage()` — and `EGO_BROWSER_UNAVAILABLE` is its code for that global's
absence.

**The decision is to take no dependency and four findings.** "We can just use it" fails because the
MIT half is a client and the runtime it drives does not exist for Linux; vendoring it would add a
second CDP client next to the one M5-BE-23 already wired, and its 474-line Skill documents tools
our agents do not have. The symmetric mistake is the one worth recording, because it is the harder
one to notice: *"macOS-only, so nothing here transfers"* is false. The harness, the Skill, the
public API schema, the error vocabulary and the locator grammar are all MIT and all readable, and
most of their value is in the design rather than the code. Both halves of the original sentence
share one root error — reading one repository as one artifact.

**It independently reaches D-057, which is the strongest thing this evaluation found.** ego-lite's
own description is "built for sharing your logged-in browser state with your AI agents… without
disturbing you" — M5-BE-27's problem, stated as a product. Its mechanism is `ego.listProfiles()`
and `createTaskSpace(name, profileId?)`: a named profile a task is opened against. It does not copy
cookies either. A team that ships a browser for this exact purpose landed on the same answer D-057
did, from the other side of the build/buy line, which is the best available evidence that the
answer is not a local accident of our architecture.

**First finding: a JavaScript dialog is an unhandled path, and it is the expensive one.** `alert`,
`confirm` and `prompt` block the renderer, so every later command on that page eats the full
`TIMEOUT_MS = 10_000` and the model retries against a page waiting for a human who is not there;
under D-052's accounting one modal can spend the turn. Crewaid has zero hits for
`Page.javascriptDialogOpening` or `handleJavaScriptDialog` across `apps/`, `packages/` and the PRD.
ego-lite has `acceptDialog(promptText?)` / `dismissDialog()`, reports the dialog on the action's
receipt, and writes down that no page-authored dialog may move ownership. Proposed as
**M5-BE-29**.

**Second: exactly one match, and a refusal instead of a guess.** ego-lite's locator actions
resolve to exactly one element and split the two ways that can fail — more than one is
`permanent`, zero is `transient`. The asymmetry is the design: absence is worth waiting for,
ambiguity never resolves by waiting. Crewaid documents the opposite to the model — "Click the first
element matching a CSS selector" (`browser-tools.ts:107`), bottoming out in `DOM.querySelector`,
so a page with two
matching controls clicks one and reports `clicked <selector>`, a success the model cannot tell from
the intended one and cannot debug. Proposed as **M5-BE-28**, the cheapest fix in the set.

**Third: classify a failure where it is born, not where it is caught.** Everything in ego-lite
funnels through one error constructor which records the hard-stop classification there — its own
comment says it does so "even when the agent's own try/catch later swallows the thrown Error" —
and the stop set is two codes against thirteen ordinary ones. Crewaid has strings on both sides:
`browser-tools.ts`'s `failure()` helper and `packages/skill-runtime/src/browser.ts`, and the
vocabulary has to land in both at once or the model learns two dialects for one page. Also
**M5-BE-28**, whose second half — refs handed back by the read — waits on M5-BE-12's truncation
seam, because a ref that does not survive truncation is worse than no ref.

**Fourth: the side effect travels with the action, and an unclaimed one is announced.**
`Target.setAutoAttach` is issued nowhere in the turn lane — the `setDiscoverTargets` in
`cdp-capture.service.ts:274` belongs to the recording tee — so a click that opens a tab reports
success against a page the bot has left. ego-lite arms the popup wait *before* the click, because a
synchronously opened window cannot be caught afterwards, and injects an unclaimed-popup notice into
the *next* command's failure text — aimed exactly at the loop where the click worked, the page
moved, and the model retries forever. Proposed as **M5-BE-30**.

**Four more land inside work that already exists**, and none needs a task: the agent cursor
carrying a label (M5-QA-10 — theirs is a native highlight call, ours an overlay on a framebuffer
pinned by R8, so it is cheaper for them than for us); re-verified taught skills (M4's compiler,
M5-BE-21); the one-schema/generated-docs practice (M6-BE-08/11/12); and three ownership rules
(M5-BE-24) — an action the operator may be performing concurrently is refused with a type rather
than raced, a tab of unknown origin belongs to the human, completion names what to keep.

**What we do not adopt.** The dependency: nothing vendored, no package added. Task spaces as our
ownership model — a fourth object next to D-046's computer, D-056's per-bot profile and D-057's
shared identity, when the discipline transfers and the object does not. `ego.snapshot()` and `@N`
refs as a contract: the one call with no CDP equivalent and the one API that rejects instead of
resolving `{error, error_code}`, so it is both unrunnable here and an awkward shape to imitate. The
`learnings/` layout, packaging for their runtime. The macOS application, because a roadmap is not a
release a milestone can be pinned to. And the adapter the probe's shim sketches — implementing
`globalThis.ego` over our own CDP would run their harness against our Chrome; rejected rather than
unconsidered, because we would owe `snapshot()` and a bridge into someone else's client.

**Revisit when** any of three things change: ego-lite ships a Linux or Windows build, so
`globalThis.ego` becomes something we can run rather than fake; M5's browser surface grows past the
four built-ins far enough that a second client would be defended rather than duplicated, or
M6-BE-11's indirection becomes the place that decision is paid for; or a customer asks for the
parallel-browsing experience itself, at which point "who owns this tab right now" stops being a
hygiene rule and becomes a feature D-046 and D-056 do not answer on their own.

---

## D-059 · A tool result has four readers, and only one of them has a context window
**Decided by Natanael on 2026-09-15.**
**Touches:** §6/M5's tool built-ins, `ToolRegistry.toolSetFor` (M5-BE-03), M6-BE-06/M6-BE-11/
M6-BE-12's MCP tools, `run_skill`. Nothing in §3 or §4 changes.
Class: an internal contract every tool is held to, enforced in one place. It ratifies no wire
shape; it decides where a size limit is applied and what it may destroy.

§6/M5 asks for one sentence: "Tool results over 100 KB are truncated with an explicit marker
before reaching the model." The obvious implementation is to cut the string inside `execute`, and
that is what every tool needing a bound had done — `bounded()` in `computer-tools.ts`,
`MAX_LOG_CHARS` in `skill-tools.ts`. M5-BE-12 moves the general ceiling out of `execute` and the
reason is the one the task note states in three words: **project, do not mangle.**

**A tool's return value is not only the model's.** The SDK's `tool-result` chunk is persisted into
`Message.parts` verbatim — PRD M1's rule that parts are stored as the SDK emits them — so the same
value is what R9 replays after a kill, what the transcript shows the operator, and what our own
later code reads. A cut inside `execute` spends all four readers to pay for one, and the three it
spends had no context window to protect. The orchestrator losing a file it had in hand is not a
saving.

**The AI SDK already has the seam and we were already using it once.** `toModelOutput` is invoked
by `createToolModelOutput` when the NEXT step's model messages are built, not when the chunk is
emitted, so a projection declared there changes what the provider reads and nothing else. Measured
against `ai@7.0.89`: it is called on the streaming path, in `generateText`, and in
`convertToModelMessages`; a tool that declares none falls back to `string → {type:'text'}` and
everything else to `{type:'json'}`. `screenshot` (M5-BE-05) already had one, which is how its PNG
reaches the provider as an image part instead of base64 buried in a JSON string.

**The ceiling is applied by the registry, because a cap each author must remember is not a cap.**
`toolSetFor` composes the limit onto every definition on the way out. That is the one place all
three kinds pass through, and two of the three are not ours to review: M6 registers MCP tools whose
output shape is a third party's, and `run_skill` returns whatever a compiled skill printed. Neither
author has read `tool-result-projection.ts`, and under this rule neither has to.

**This overturns an invariant M5-BE-03 set deliberately, so it is recorded rather than quietly
changed.** `tool-registry.test.ts` asserted that `toolSetFor` hands back the definition *by object
identity*, on the reasoning that "whatever object comes out of here is the object the provider
serializes". The reasoning is still right; identity was the wrong way to hold it. `toModelOutput`
is a server-side callback, never serialized into the tool schema the provider validates, so the
composed definition shows the model exactly what the declared one did. The test now asserts that
directly — every declared member survives by reference, and exactly one member, named, was added —
which is a stronger statement than identity was and survives the next additive wrapper too.

**What each layer owes, stated once.** A tool returns the whole typed result and does not think
about the context window. A tool that needs the model to see something other than its return value
— an image, a summary, a field the model should not be handed — declares `toModelOutput`, and the
registry's ceiling composes onto it rather than replacing it. Per-tool bounds that are far *lower*
than the ceiling stay where they are and stay local: `shell` and `fs_read` can be pointed at a
whole log on purpose, and 100 KB of `find /` output is a limit, not a useful tool result. The
ceiling is the floor under everything, not a substitute for judgment above it.

**Four things the cap will not do.** It will not cut a file part — a PNG truncated to 100 KB is
not a smaller picture, it is a corrupt one, so `content` results keep their files whole and bound
only their text. It will not hand the provider a `json` output whose value is a severed fragment;
an oversized JSON result is re-typed to the text variant of its own polarity — `text` for a `json`,
`error-text` for an `error-json` — because a cut JSON document is not a JSON document, and because
collapsing the error half to `text` would be a second lie: `text` and `error-text` are one string
each to a provider that reads only `value`, but Anthropic reads the `error-` prefix as
`is_error: true` and would otherwise be told that a call which failed had succeeded. It will not
split a character — a naive byte slice decodes a severed multi-byte sequence to U+FFFD, which puts
a character in the model's input that was never in the source. And it will not fail the turn it is
measuring: `JSON.stringify` refuses a BigInt, a cycle, and a getter that throws, any of which an M6
MCP tool can hand back, so a value the cap cannot measure reaches the model exactly as the SDK
would have sent it rather than becoming a reason for the projection to throw.

**Revisit when** either of two things changes: the SDK's default projection stops being
`string → text, else json`, in which case `defaultModelOutput` is the one function to re-read
against the new `createToolModelOutput`; or M6-BE-12 widens the behavior descriptor far enough that
a per-tool ceiling becomes a field on it, at which point the registry reads the number from the
descriptor instead of the constant and the shape of this decision is unchanged.
## D-060 · A seat is a display, not a window — and an identity is a leased profile
**Decided by Natanael on 2026-09-15.**
**Supersedes:** M5-AR-01's closing of D-046 ("a seat is a Chrome **window** on the machine's one
display") and WORKSPACE.md §20's window-scoped seat.
**Amends:** D-056 (per-bot profile) and D-057 (shared identity), whose mechanism depends on one
`--user-data-dir`. D-046's shared computer is **unchanged**, and that is the point of this entry.
Class: a change to what a seat IS. It touches §4.3's screen transport only in what the RFB port
serves; the frame contract is untouched.

D-046 promised each bot "its own display and browser target". M5-AR-01 measured and downgraded
that to a Chrome window, because a private X display per seat cost 439 MB against a whole private
container's 443 MB — so paying per-display appeared to buy nothing. The measurement was right and
the conclusion was wrong, because it priced the display without noticing what the window costs.

**What a window seat cannot do, found by using it.** `x11vnc -id <winid>` serves one window. Three
consequences, all reproduced on a live machine rather than argued:

1. **Minimising the window freezes the screen with no way back.** The window unmaps, the capture
   has nothing to send, and the viewer holds the last frame forever. Measured: the x11vnc process
   sits at 0 CPU — it is a frozen image, not a runaway. There is no restore control because the
   viewer never shows the desktop the window sits on.
2. **Anything that is not that window is invisible to its own operator.** A bot that opens a file
   manager or a terminal is working in something nobody watching it can see. The screen is the
   bot's *browser*, and G2 promised the bot's *screen*.
3. **The seat is a cache entry with no liveness check**, so a destroyed window leaves a seat
   advertising a dead RFB port that nothing can invalidate.

The first and third are fixable in place. The second is not: it is what window-scoped capture
means.

**Isolation was never the reason for the window, and the numbers say so.** Cross-bot leakage was
the thing worth checking, and it does not happen either way — xfwm4's compositor is on, so a
window-scoped capture returns its own pixels even with another window stacked on top. Verified by
raising a file manager over a seat window and pulling a frame off that seat's RFB port: no trace of
the file manager. So the window bought no isolation the display does not also buy; it bought
79–98 MB per bot against ~439 MB, and it spent G2 to get it.

**Chrome's singleton was the real constraint, and it is the wrong one.** A second `google-chrome`
on the same `--user-data-dir` does not start a browser — it hands the request to the running one,
which is bound to one X display. Measured here: launching Chrome with `DISPLAY=:2` and the
machine's own `--user-data-dir` exited 0 and put its window on `:1`. That is what made a per-bot
display look impossible, and it is only true while every bot shares one `--user-data-dir`. Give
each bot its own and two browsers run side by side on two displays in one container: measured,
13 processes on one `user-data-dir` and 14 on another, `:1` unchanged.

**So: one container per user, one display per bot.** A seat becomes `:N` with its own window
manager, its own dock and its own Chrome on its own `--user-data-dir`, captured whole by
`x11vnc -display :N`. D-046's machine is untouched — one filesystem, one home, handoff still a
`cd`, isolation still per user — and G2's "watch any bot's screen, take control, teach it" becomes
true of a desktop rather than of a browser window. R8 still holds per seat: a display's geometry
is fixed for its lifetime, which is a stronger guarantee than the window pin it replaces, because
a display cannot be resized by a page or a takeover at all.

**The prior art is not a guess.** The product this one is modelled on answers "do bots share one
computer?" with "yes — files, browser, logins, isolation per user", and its machine shows
`chrome-profile`, `chrome-profile-3`, `chrome-profile-4`, `chrome-profile-10` under one home, with
per-bot desktops carrying a file manager, a terminal and a dock. One machine and a real per-bot
screen are not in tension; sharing one `--user-data-dir` is what put them in tension here.

**An identity becomes a leased profile directory, not a shared one.** D-057 made an identity a
`--profile-directory` inside the machine's single `--user-data-dir`, so several bots could hold one
login at once. Per-bot `--user-data-dir` ends that, and the replacement is not cookie copying —
D-057's measurements against that stand, and the prior art's own `chrome-cookie-seed.json` is the
approach they rule out. Instead an identity IS a top-level `--user-data-dir`, and a bot granted it
launches its Chrome against that directory instead of its own. Nothing is copied, so D-057's
argument survives intact: *share the directory, never the cookie.* Chrome's singleton then enforces
exclusivity for free — one bot at a time — which is the one behaviour change, and it is the right
one: D-057 already recorded that a session appearing in two places at once trips exactly the
anomaly heuristics an operator does not want tripped. `Identity` and `BotIdentity` keep their
shape; the grant gains a holder.

**What this costs, stated rather than discovered later.** Memory goes from ~840 MB to ~2.6 GB for
six bots, which §7.5's 16 GB carries and D-033's $30 ceiling should be re-examined against —
that ceiling is already recorded as "a product constraint, not a validated cost estimate". Two
bots can no longer drive one login simultaneously. And a display per bot is a second window
manager, dock and browser per bot to supervise, so the entrypoint's "any exit is a failure"
contract has to become per-seat rather than per-machine, or one bot's Chrome crash takes down
everybody's computer.

**Revisit when** either of two things changes: a bot's work stops needing a desktop at all — an
API-only or headless tier would want the window seat back, and it still exists; or the per-seat
memory becomes the binding constraint on how many bots a user can run, at which point the
question is a headless seat for bots that only browse, not a return to one display.

**D-060 implementation details (PR #152 review).** A seat's CDP port is a relay on
9301–9316, published with its RFB port at container creation. Chrome's private loopback
listener uses the corresponding port plus 16. Existing containers must be replaced with
the updated image and port bindings; restarting an old container cannot add published ports.

The existing bridge `/screenshot` and `/skill/run` routes accept `?botId=` using the same
seat lookup as `/seats?botId=`. An explicitly requested missing seat fails closed; it never
falls back to the machine display. Calls without `botId` keep the machine-level behavior
for health/smoke tooling. Skill replay ensures the bot's seat through `SeatService` first,
then supplies its display/session bus to the child process and its CDP URL as a runner
argument. Skill script/parameter bodies and public REST/WS contracts remain unchanged.

Before Chrome starts, legacy named profiles move from `.chrome/<profile>` to
`.seats/<profile>/Default`, retaining the Local State encryption metadata. Existing seat
profiles are not overwritten or merged. Retirement reaps both layouts. Seat close and
bridge shutdown ask Chrome to flush before stopping its display; failed seats are fully
reaped before their slots or identity directories are reused.


## D-061 · Start seat browsers on demand

**2026-09-15 — implements the requested on-demand browser change.** Amends D-060's
seat startup and internal bridge contract; public REST/WS contracts are unchanged.

Opening a bot's screen allocates its X display, session bus, window manager, dock and
VNC server. Chrome and its CDP relay start only when an agent browser tool or a saved
skill first uses the browser. Recording attachment never starts a browser; until one
exists, capture uses the existing desktop fallback. A seat reserves its CDP port at
creation and adds `browserReady: boolean`, indicating that its managed Chrome and relay
processes are running. CDP readiness is probed before browser startup returns.

`POST /seats/browser` accepts `{ "botId": "..." }` and returns
`{ "ok": true, "seat": <seat> }`. Invalid input returns 400 `INVALID_SEAT_REQUEST`;
a missing/dead desktop, insufficient capacity, or startup failure returns 503
`SEAT_UNAVAILABLE` with a readable detail. Startup is idempotent and serialized with
seat allocation. A failed or crashed browser can be restarted without destroying the
live desktop; partial browser processes are stopped before retry. Existing image and
orchestrator versions must be upgraded together.

Desktop admission reserves 90 tasks and 256 MiB; browser admission separately reserves
190 tasks and 384 MiB using the container's cgroup limits. These are headroom estimates,
not guarantees of a fixed seat count. The prior implementation's experiment reported
about 52 tasks per desktop and 136 more per browser. The 512-task ceiling counts threads
across the entire shared computer container, including all bot seats. It is a configured
resource limit, not a Linux maximum; this change leaves that limit unchanged.

Skill replay passes the bot identifier as an internal runner argument. Its lazy page
connection calls the same loopback bridge route before CDP discovery, so desktop-only
skills do not start Chrome. Browser callers allow 60 seconds for the bridge's 40-second
Chrome readiness deadline plus relay startup and request overhead.


## D-062 · The dock's Chrome icon starts its seat's browser

**2026-09-15 — completes D-061 for the operator's own hands.** Amends D-061's internal
bridge route; public REST/WS contracts are unchanged.

The stock `google-chrome.desktop` launched a bare `google-chrome-stable`, which §5.1's
`cap_drop: ALL` and `no-new-privileges` kill before a window appears — the dock icon that
did nothing however many times it was clicked, before D-061 and after it. A launch that
survived would still be the wrong browser: the default `--user-data-dir`, no CDP relay,
undrivable by its bot and invisible to recording.

The image now rewrites that entry's `Exec` lines to `/opt/crewaid/open-seat-browser`, a
launcher that POSTs `{ "display": "<its DISPLAY>" }` to `POST /seats/browser`. Plank hands
the launcher the seat's `DISPLAY` and nothing else — no bot id ever reaches a docked
application — and the display is the only address it needs: the bridge maps it to the
seat. The route accepts exactly one of `botId` or `display`; response shapes and status
codes are unchanged, and the orchestrator's and skill runner's `botId` calls are
untouched.

The start is the same one a browser tool call makes — idempotent under the seat lock,
capacity-checked, restarting a crashed browser without touching the live desktop — so the
icon doubles as the seat's repair control. A refused start opens a terminal on the seat
showing the bridge's reason rather than failing silently; on the machine's own display,
where no seat exists (D-060), that refusal is the honest answer. The stock desktop file
is edited in place rather than overridden, because the dockitem pins it by path and
plank pairs the running window with the pinned launcher through that file's
`StartupWMClass` — a second entry carrying the same class is what showed Chrome twice.
The build fails if Google renames the entry's `Exec` line, rather than shipping an icon
that silently launches a bare Chrome again. Existing containers must be replaced with
the updated image.


## D-063 · A machine sized for bots that browse

**2026-09-15 — raises the §5.1 container limits.** Amends PRD §5.1's numbers; admission
reserves, wire contracts and the image are unchanged.

The §5.1 numbers (2 GiB, 1 CPU, 512 tasks) sized the machine like the per-bot containers
it replaced. But every seat desktop and every seat browser draws from that ONE pool, and
a media-heavy Chrome measures ~190 tasks on its own: a second browsing browser was
refused at 401/512 tasks — correctly, by D-061's admission, which is the failure turning
into a sentence rather than a mid-session crash. Six browsing bots measure at roughly
110 machine tasks + 52 per desktop + 190 per browser ≈ 1560 tasks and ~3–4 GiB, so the
machine's limits are now 8 GiB memory (swap still disabled), 4 CPUs, and a 2048-task
ceiling — cgroup caps, not reservations. The per-seat admission reserves (90/190 tasks,
256/384 MiB) are unchanged: they are per-browser estimates, not machine sizing, and they
keep refusing what genuinely cannot fit.

The host must actually have what the caps promise. A dev machine running Docker Desktop
needs its VM raised to at least ~10 GB before an 8 GiB sandbox limit means anything —
the default VM's 7.47 GB is smaller than the cap. The smoke test mirrors the new numbers.
Existing containers must be replaced; limits apply at creation, and `docker start` cannot
change them.

## D-064 · A new bot ships with rules, because an empty list cannot satisfy §6/M5

**2026-09-15 — changes D-005's seeding, not its schema.** `Bot.autoReviewRules` keeps its
`Json @default("[]")` column, `AutoReviewRuleSchema` is untouched, and the matcher's
fallthrough is still `ask`. What changes is the list `POST /bots` writes when the caller
supplies none.

§6/M5 states two acceptance criteria that cannot both hold under an empty list. "A bot given
'go to example.com and tell me the heading' completes it using `browser_navigate` +
`browser_read` with no human input" requires those two calls to run unattended; "a bot
attempting `shell` under default rules emits `approval.requested` and blocks" requires the
default to be restrictive. With `[]` every call falls through to `ask`, so the second holds
and the first cannot: a fresh bot asks permission for every page it opens. Since M5-FE-02
that is no longer a hang — the inline prompt answers it — but it is a bot that interrogates
its operator about reading a heading.

The mechanism §6/M6 uses for exactly this line is the `readOnly` classification: "Every MCP
tool defaults to `ask`. Tools classified `readOnly` default to `allow`." That field belongs
on `ToolBehavior` and M6-BE-12 owns adding it; until then the matcher has nothing to branch
on, and inventing the field is PRD §0 rule 2. So the same line is drawn one milestone early
and as **data rather than as a classifier** — the ordered per-bot list D-005 already
ratified, seeded at creation:

```ts
{ toolPattern: 'shell',            decision: 'ask'   }
{ toolPattern: 'browser_navigate', decision: 'allow' }
{ toolPattern: 'browser_read',     decision: 'allow' }
{ toolPattern: 'screenshot',       decision: 'allow' }
{ toolPattern: 'fs_read',          decision: 'allow' }
```

What only observes is allowed; what acts is asked about. `browser_click`, `browser_type`,
`fs_write`, `run_skill`, `send_message`, `attach_file` and `use_identity` are not listed and
so reach the `ask` fallthrough — `browser_click` is the call that submits a form or presses
Buy, and it is the one a human should see.

`browser_navigate` is the deliberate exception to "only observers". It acts, and the
acceptance criterion names it anyway: loading a URL is the cheapest act the browser tools
have and the one every read must follow, so asking about it would put a prompt in front of
every page while leaving the genuinely consequential click un-gated.

`shell` is listed although the fallthrough already reaches `ask`, and listed first. §6/M5
singles it out as "always requires approval by default", and a rule states that in the data
the operator edits: someone who later appends a broad `*` → allow widens everything except
the one tool the PRD named. Prepending a rule still overrides it, so an operator who means
it pays nothing.

**Scope: new bots only.** Existing rows keep whatever they hold, including `[]`. A backfill
would loosen policy on bots an operator already created and reviewed, which is the silent
direction; `PATCH /bots/:id` already accepts `autoReviewRules` for anyone who wants the new
default on an old bot. An explicit `[]` in `POST /bots` still means "ask me about
everything" and is preserved — absent and empty are different requests.

## D-065 · An approval is remembered for the turn, and only for the turn

**2026-09-15 — adds turn-scoped approval memory.** `AutoReviewRuleSchema` is untouched and
nothing on the wire changes. `createToolApprovalHook` becomes `createTurnApprovalPolicy`,
returning `{ decide, remember }`.

D-005's matcher is stateless by design, so a rule resolving to `ask` asks again on every
step. A model that calls `browser_click` five times in one turn puts the identical question
in front of the operator five times, and answering it five times is not consent — it is
training the operator to click yes.

The memory is a `Set<string>` on the turn's approval policy. When the matcher says `ask` and
the tool is in the set, the decision becomes `allow` for the rest of that turn.

**Three boundaries, each of which is the decision rather than the implementation:**

- **Turn-scoped.** The policy is built per turn beside the tools, so the set dies with the
  turn. An approval that outlived it would be a standing grant the operator never gave and
  has no way to see or revoke — `Bot.autoReviewRules` is where a durable `allow` belongs,
  and it is already editable.
- **Explicit approvals only.** A denial leaves the tool unrecorded: it is an answer about
  *that call* — "no, not that one" — and reading it as "stop asking me" would turn the
  safest answer into the widest one. A turn that ends without an answer records nothing
  either, structurally: `remember` is called after `ports.approvals.request` resolves, so a
  cancelled or abandoned turn never reaches it.
- **Keyed on the bare tool name.** That is the unit `toolPattern` is written in, so the
  memory and the policy it upgrades speak about the same thing. Including the arguments
  would re-prompt for every distinct command, which is the behaviour this removes. The
  cost is stated plainly: approving `shell` with `ls` means the turn will not ask again
  about `rm -rf`. An operator who wants that distinction writes a `deny` rule with
  `argMatch`, which is what `argMatch` is for.

Only `ask` is upgraded. A `deny` is a rule the operator wrote and an approval of a different
call does not repeal it; an unregistered tool still has nothing to run.

**Measured, not assumed (ai@7.0.89):** the SDK re-invokes the approval hook for the *same*
`toolCallId` on the resumed stream — the hook sees `["shell#tc-1", "shell#tc-1",
"shell#tc-2", ...]`. So the upgrade also answers the call being resumed. That is safe: the
tool runs, the turn completes, and the transcript keeps the first call's
`tool-approval-request` part while the calls nobody was asked about have none — which is
exactly how an `allow` decision already behaves.

The upgrade reports itself as its own `AutoReviewSource`, `turn-approved`, so
`agent.autoreview.decided` says `allow` with a source that explains why. Reporting the
matcher's `ask` while the call ran would make that line claim the operator was asked, which
is the one thing that did not happen.

## D-066 · The turn is the bot's state machine, and only a BOT draft streams

**2026-09-15 — no schema or wire change.** `Bot.status`, `BotStatusSchema` and the §4.2
`bot.status` frame all already existed. What was missing was a writer, and a client rule that
let a SYSTEM message be emitted at all.

### The status a bot actually has

Nothing in the orchestrator ever wrote `Bot.status`. The column had a default, the enum was
ratified, the frame was in the registry, the reducer handled it and `BotSidebar` rendered a
`StatusDot` from it — so every bot read IDLE forever, including mid-turn and while suspended
waiting on an approval. §6/M5's "on any limit: set status IDLE" and its "does not leave the
bot stuck in ACTING" describe a state machine that did not exist.

The turn owns it, because every member of the enum is a fact about a turn:

| Transition | Written by |
|---|---|
| `THINKING` on turn start, and at every step boundary | service / runner |
| `ACTING` while a tool executes | runner |
| `AWAITING_APPROVAL` while suspended | service |
| `IDLE` on a clean end, a limit stop, or a cancel | service |
| `ERROR` on a failed turn | service |
| `IDLE` when boot recovery fences an interrupted turn | service |

**`ACTING` hangs off execution, not off the `tool-call` chunk.** A call that needs approval
produces the chunk and then suspends the stream without running anything, so the chunk would
flash ACTING for a tool the operator has not agreed to — and strand the bot on ACTING if they
never answered. `onToolExecutionStart` fires only when a tool really runs.

**A limit stop is IDLE, not ERROR.** ERROR is for a bot that could not do the work; a turn
stopped by a ceiling chose to stop. An interrupted turn is IDLE for the same reason: D-032
forbids resuming it, and the honest report is that the machine stopped, not that the bot
failed.

**The writes are collapsed and chained.** The runner reports THINKING at every step, so an
eight-step turn would write the same row eight times and put eight identical frames on the
wire. And each write is its own round trip: started concurrently they can land in any order,
and the one that loses is the one that sticks — a turn could end with the row reading THINKING
because its opening write overtook its closing one. The chain is drained once, at the end of
the turn, so a status never delays a token and the terminal status is durable before the turn
resolves. `AWAITING_APPROVAL` is the one transition awaited inline: it is the longest-lived
status a bot has, so it is the one a reconnecting client is most likely to read, and losing
that race leaves the dot saying THINKING while the bot waits on a prompt.

### Only a BOT draft streams

A SYSTEM message was durable-only. `message.created` existed and was never emitted for one,
because the reducer opened the in-flight streaming slot for **anything not authored by USER**
— so emitting a system row would have left a phantom reply streaming forever. The effect was
that a limit stop or a cap refusal reached the operator on the next history fetch, which while
watching a transcript is indistinguishable from the bot going quiet.

The fix is the client rule, not a new frame: **the in-flight slot belongs to a BOT draft and
nothing else.** USER, SYSTEM and TOOL rows are settled the moment they are created. That is
the honest statement of what streams, it needs no §4.2 addition (inventing an event name is
§0 rule 2), and it makes `message.created` usable for every author the enum has.

## D-067 · A pending approval is readable, not persisted

**2026-09-16 — adds `GET /bots/:id/approvals` to §4.1.** No schema change: the rows are §4.2's
`approval.requested` payload verbatim. PRD §0 rule 2 forbids inventing endpoints, and
M5-BE-13's own statement of the gap — "whatever shape that takes needs a read side the client
can call on mount" — is what this answers.

`approval.requested` is emitted **once**, when the turn suspends. M5-FE-02's pending set is
renderer memory, which survives a reconnect — correctly, because the orchestrator's pending map
is in-process and a `toolCallId` stays valid across a dropped socket — but not a relaunch of
the desktop app. A turn then sat suspended with no way to answer it but `bot.cancel`, which
throws the whole turn away to answer a question about one tool call.

**Read, not persist.** The task note says "persist pending approvals", and persisting is the
wrong half. An approval exists only while a turn is parked on it, and the process holding that
turn is the process holding the map — so a row that survived a restart would point at a turn
that no longer exists. R9 marks a RUNNING turn INTERRUPTED on boot (D-032 forbids resuming
it), so the persisted approval would offer the operator a button that cannot work, which is
worse than the prompt being absent. The in-memory map is not a cache of the truth; it **is**
the truth, and it was simply unreadable from outside.

**The same value, the same path.** The response is a list of `approval.requested` payloads, so
a prompt recovered on mount and one that arrived live are the same value and enter client state
through the same merge. The merge is a union keyed on `toolCallId`, not a replacement: the
fetch and a live frame can interleave either way round.

**Scoped by the principal before anything is returned.** The map is global to the process; the
read is not. A foreign bot id yields an empty list. There is no `bot` kind for `@OwnedResource`
and a map is not a table the guard could resolve against, so this carries the bot-family
written exemption (D-026) like the sandbox routes.

**What this does not do.** M5-BE-13 also asks for approval-aware compute release and tool-target
revalidation on continuation — a suspended turn still owns its desktop, which is what
`sandbox-idle.service.ts` defers to M5. That half is untouched here and stays on the board.

---

## D-068 · The board is a file on the machine, and the tool never rewrites it whole

**2026-09-16 — no schema or wire change.** Three built-ins join the M5-BE-03 registry —
`board_read`, `board_add`, `board_update` — over one file, `/home/bot/shared/BOARD.md`.
WORKSPACE §19 already says the shared area holds "the project, worktrees, the board, memory",
so the directory is settled; this names the file and the operations.

**Why a tool when `fs_read`/`fs_write` exist.** Two things those cannot give it.

*Agreement.* Every bot on a machine has to mean the same file without an operator telling each
one a path. A taught skill teaches one bot; a built-in is the same board for all of them,
including the bot created tomorrow. That is the board note's "every bot on a machine needs the
same one".

*A write that does not destroy someone else's.* `fs_write` replaces the whole file, so a bot
updating one line must re-emit every other line — from a context window that may have been
trimmed since it read them (M5-BE-02), and beside a sibling writing the same file in the same
moment. D-046 made that ordinary rather than exotic. So `board_add` appends and never re-emits
what it did not write, and `board_update` names the text it is replacing: an entry a sibling
changed since no longer matches, and the write is **refused** rather than silently reverting
their work. An ambiguous match is refused for the same reason — replacing "the first one" on a
board whose entries repeat is how a bot ticks off somebody else's task.

**Unopinionated about schema, deliberately.** Nothing parses the board. No task id, no status
column, no ordering. The operator decides what a task is and the tools move text. A board tool
that knew about "status" would be wrong for the first team whose board has a column it has never
heard of.

**In the database it is not.** The board is the project's, not the orchestrator's: it lives where
the work does, in the operator's volume, and it can be read, edited by hand, or committed
without asking Crewaid for it.

**Amends D-064.** `board_read` joins the shipped default rules as `allow`, beside the other
reads. A bot that must ask before LOOKING at the board its team shares cannot use it to decide
what to do next, which is the only thing the board is for. The two writes are absent on purpose
and reach the `ask` fallthrough exactly as `fs_write` does — shared state an operator may want to
see changed before it changes.

**Bounded.** 32,000 characters. A board is a working document several bots append to and nothing
prunes, and it is read at the START of work, when a turn can least afford a context window spent
on it. Over the bound, `board_add` refuses and says to remove finished entries first.

---

## D-069 · Memory is a tool the bot reaches for, not a preamble it is handed

> **Superseded in part by [D-073] (storage) — 2026-09-16.** The memory now lives in Postgres
> rather than in `/home/bot/shared/MEMORY.md`, because a per-machine file expresses neither scope
> the product needs. Everything else here still holds: the 16,000-character bound and the reason
> for it, the duplicate handling, and the model-facing wording of all three tools. The paragraph
> below beginning "Why it is not injected into every turn" is the part that no longer applies —
> its objection was the cost of waking a desktop, and a Postgres read wakes nothing. D-069 named
> that exit itself.

**2026-09-16 — no schema or wire change.** Three built-ins join the M5-BE-03 registry —
`memory_read`, `remember`, `forget` — over one file, `/home/bot/shared/MEMORY.md`, shared by
every bot on the machine. WORKSPACE §19 already reserved the location ("the project, worktrees,
the board, memory"); this names the file and the operations.

**The problem is trimming, not storage.** M5-BE-02's note says it plainly: an invariant held
ONLY in the history being trimmed becomes a correctness bug the moment it is summarised away.
Today every durable thing a bot knows lives in that history — "staging is the one with the dash
in it", "the deploy script must run from the repo root". Trim the turn that established it and
the bot is confidently wrong afterwards, with nothing in the system that could have said so. A
file on the machine survives trimming because it was never in the context window, survives a
restart because it is on the volume, and is readable by the other bots on the machine.

**Why it is not injected into every turn.** The stronger design is obvious and is deliberately
not this one: read `MEMORY.md` at turn start and put it in the instructions, so a bot cannot fail
to consult it. That costs a container on every message. M5-BE-14 is explicit that a turn needing
no desktop starts none — "2 GiB and several seconds of host budget spent on a bot that was never
going to touch a screen, and with D-046's shared computer it is spent on behalf of every bot
attached to it" — and injection would wake the machine to answer "are you there?". A tool keeps
that promise: a turn that needs the memory pays for the machine; a turn that does not, does not.

What that costs is the guarantee — a bot has to DECIDE to look, and a bot whose memory of a
convention was trimmed is exactly the one that does not know there is anything to look for. So
the shared instructions say the memory exists, name the three tools, and say WHEN to read it.
That is free (those instructions are already in every prompt) and it is the only part a tool
description cannot deliver: a model that never considers the tool never reads its description.
**If trimming still loses invariants in real use, injection is the next move, and the file it
would read is already this one.**

**Bounded at 16,000 characters, half the board's.** The board is a work log an operator scans;
the memory is facts a model re-reads whole, inside a turn that is also doing something else. A
memory that fills a context window has stopped paying for itself. `remember` also answers an
exact duplicate with "Already remembered" and writes nothing — a model re-learning the same
thing every turn is the ordinary way this file would fill up, and it is the one duplicate that
is never meaningful. (A board's can be: two tasks may genuinely read the same.)

**Amends D-064.** `memory_read` joins the shipped default rules as `allow`, beside the other
reads: a bot that must ask before reading what it already knows cannot use its memory to answer
the question in front of it. `remember` and `forget` are absent on purpose and reach the `ask`
fallthrough, like every other write.

**Extends D-068 rather than copying it.** The board and the memory are the same problem twice —
a bounded plain-text file several bots edit — so `shared-document.ts` now owns the part where
getting it wrong loses somebody's work: read, APPEND (which never re-emits a line it did not
write), and replace ONE EXACT piece (which refuses when the text has moved, and refuses an
ambiguous match rather than guessing). What each tool SAYS stays with the tool: "Added to the
board" and "Remembered" are not interchangeable sentences, and the model reads them.

`forget` matches the fact with its trailing newline. That is what lets it remove a fact which is
a prefix of another one, instead of refusing as ambiguous or cutting the longer line in half.

---

## D-070 · A suspended turn lets go of its computer, and asks for one again

**2026-09-16 — no schema or wire change.** Completes M5-BE-13, whose other half is D-067.
`sandbox-idle.service.ts` deferred this in so many words: `AWAITING_APPROVAL` "is work in
progress: a turn blocked on a human still owns its desktop, and suspending one properly (with the
state revalidation resuming it needs) is M5".

**What it cost.** An approval lasts as long as the person takes — three seconds, or overnight. The
turn's lease is an explicit promise about wall-clock time and outranks every inference the idle
sweep makes, so a bot parked on one `shell` prompt held its container open for the whole of that
wait. Under D-046 it held it on behalf of every bot attached to the same computer.

**Two halves, and neither works alone.**

*Release.* `TurnComputer.release()` hands the lease back at the suspension and forgets the
memoised readiness. It is deliberately not `dispose()`: the turn is not over and will want a
desktop again the moment the answer arrives.

*Reclaim.* The idle sweep stops counting `AWAITING_APPROVAL` as a desktop in use. Without the
release, the lease outranks the sweep and nothing stops; without the reclaim, the release hands
back a lease nobody then acts on. `TURN_STATUSES_WITHOUT_A_DESKTOP` names the pair so the
dependency is legible from either side.

**Revalidation is by construction, not by a check.** `ensure()` memoises success, so a turn
resuming against a cached `RUNNING` would hand its tools a container the sweep had since stopped.
Forgetting it is what makes the resumed tool ask again and get a machine that exists. The browser
is the same move one layer up: `browserHandle.reset()` at the suspension, so a tool approved three
hours later acts on a page opened **now**. A selector that named something on the page the bot was
looking at then simply does not match, and the model is told so and can navigate again — which is
the safe direction. The alternative, resuming onto a memoised target from before the machine
stopped, is the one that clicks something nobody looked at.

**Ordering at the suspension: browser first, then the lease.** The browser sits on top of the
computer, so dropping the socket while the container is still up is a clean close; dropping it
after the lease would leave a connection to a container the sweep may already be stopping.

**A release cannot clear the deadline.** `keepRunningUntil` is shared between owners, so releasing
only stops renewing it and it expires up to one lease-bound later. That is why the reclaim is not
instant and why the guard for it reads `lastActiveAt` — written by `markFinalActivity`, which runs
from exactly one place, a lease being released.

**A turn whose FIRST computer tool is the one being approved releases nothing**, because approval
happens before the tool runs and no lease was ever taken. That is correct and not a gap: there is
no desktop to hand back.

---

## D-071 · `wireVersion` on the §4.2 envelope, absent meaning zero

**2026-09-16 — adds one optional field to the §4.2 envelope.** CC-19's board note says the field
name "is a contract addition and needs a decision entry before it is coded — do not invent one
(PRD §0 rule 2)". This is that entry.

**The field is `wireVersion`, an optional non-negative integer on the envelope**, beside
`id`/`type`/`botId`/`ts`/`payload`. `WIRE_VERSION` is `1`.

*Why that name.* `v` is shorter and every frame carries it, including a `message.delta` per token
— but the whole envelope is already spelled out (`botId`, not `b`), `packages/shared` names things
explicitly throughout (`toolPattern`, `cachedInputTokens`, `keepRunningUntil`), and seventeen bytes
a frame over a loopback socket is not a cost worth trading legibility for. `schemaVersion` would be
wrong: it is the WIRE contract that is versioned, not the payload's own shape.

**Absent means 0, and 0 is a real version.** Every frame written before this change is a v0 frame,
and a reader has to be able to say so rather than treat "no version" as "current". That is what
lets a NEWER desktop read an OLDER orchestrator's frames, and it is what keeps persisted
transcripts readable: a stored part written at v0 normalizes forward the same way a live frame
does.

**Optional on read, always stamped on write.** Requiring the field inbound would refuse every
frame from an existing client the moment this ships, which is the opposite of the point. So the
orchestrator stamps every frame it sends and accepts frames without one; the desktop does the
same.

**What this buys today, stated honestly.** v0 → v1 is the identity: nothing about a frame's shape
changed here, and pretending otherwise by writing a migration with nothing to migrate would be
ceremony. The value is the two halves it enables:

  - **An unknown-NEWER frame becomes an actionable error rather than a silent gap.** Today an
    older desktop meeting a frame it does not know reports `PROTOCOL_ERROR: "Received an invalid
    server event."` — indistinguishable from a corrupt frame, and the operator has no way to learn
    that their build is behind. A frame stamped above the reader's `WIRE_VERSION` now reports
    `UNSUPPORTED_WIRE_VERSION` and names the versions, in both directions.
  - **The first real change has something to branch on.** `normalizeServerFrame` is the one place
    a v0 → v1 → v2 walk will live, and M5's tool-call and approval frames plus M6's MCP frames are
    when that starts mattering.

**`UNSUPPORTED_WIRE_VERSION` is added to the desktop's `WsClientErrorCode`.** It is deliberately
not a §4.2 `error` payload code: the condition is "this build cannot read that frame", which is a
property of the reader, not something the sender did wrong.

**One writer and one reader, exported from `packages/shared`.** `stampWireVersion` and
`readServerFrame`/`readClientFrame`, so neither end can drift into stamping or normalizing by
hand — the same reason `WsFrameSchema` exists rather than each side spelling the envelope out.
The union schemas are left alone: zod strips unknown keys, so `wireVersion` is read off the
envelope before narrowing and never has to be added to twenty union members.

---

## D-072 · There is no token cap

**2026-09-16 — removes CC-05 and §7.2's daily caps.** Reverses D-047's premise rather than its
default: D-047 already shipped `MAX_DAILY_TOKENS` **off**, on the argument that the operator picks
their own bound. This goes further — the product does not offer the bound at all.

**Why.** A user pays to get work done, not to have their tokens managed for them. A cap that
refuses work nobody asked it to refuse is the product making a spending decision on the operator's
behalf, at the moment they least want one: mid-task. And the failure it protects against has a
better answer than refusal — when an account runs dry, switch model or provider and carry on.

**What replaces it.** Nothing, in v1: the operator changes the model in the composer and tells the
bot to continue. That already works — the picker PATCHes the bot between sends and a bot's history
is legitimately mixed-model (CC-12) — and the `QUOTA_EXCEEDED` copy now names it, because "check
billing" is a complete diagnosis and an incomplete instruction. **V2-BE-01** makes it automatic
and configurable.

**What stays.** CC-04's `GET /usage` and the D-009(3) counters. **Reporting what was spent is not
capping it**, and the fallback work wants exactly those numbers. §7.1's usage surface is
untouched.

**What went.** `DailyCapsService` and its in-flight registry, the admission check and the
model-call-boundary check, the refusal system message and `error` frame, the runner's
`TurnBudgetPort` in full, both daily-caps suites, the concurrent-budget half of M5-QA-08, and
`MAX_DAILY_TOKENS` from `.env.example` and `turbo.json`.

**§7.2 is therefore not implemented, and that is deliberate.** This entry is the record of it —
`docs/DECISIONS.md` wins over `docs/PRD.md` wherever they conflict, and the PRD still describes a
hard stop this product does not have. A reader reaching §7.2 should come here.

**M5-QA-08 keeps its other half.** Its D-032 claim — an interrupted turn whose tool already acted
is recorded rather than replayed — was never about budgets, and the file is renamed to say so.

## D-073 · Memory is a row, not a file on the machine

**2026-09-16 — schema change, no wire change.** Two tables join PRD §3 —
`Memory` and `MemoryTombstone` — with `MemoryKind`, `MemorySource` and `MemoryStatus`.
Declared as deviation 6 in the `schema.prisma` header. **Supersedes D-069's storage choice**
and keeps everything else D-069 decided: its 16,000-character bound, its duplicate handling, and
the model-facing wording of all three tools.

**D-069's file cannot express either scope the product asked for.** `MEMORY.md` is
per-MACHINE — `crewaid-workspace-<computerId>`, WORKSPACE §19. The ask was a user-global memory a
new bot starts with, so nobody re-explains a convention to each new hire, *and* a per-bot memory
built from that bot's own discussions and the resources it consulted. One machine-scoped file is
neither. That is the argument that ends the debate; everything below is additional.

**It also sits on the one artifact the system is designed to delete.** WORKSPACE §9 retention
and D-056 profile retirement both exist to reclaim workspace volumes. A memory meant to outlive
every bot should not be stored on the thing with a reaper pointed at it.

**And WORKSPACE §1 already promised this.** Its durability table has said, since M2:
"Bot memory (Postgres rows) — durable across everything; it is not in the container at all."
D-069 contradicted a line that was already shipped. This resolves the contradiction in favour of
the older one rather than inventing a third answer.

**Scope is two nullable columns, not an enum.** `userId` always; `botId` NULL for the global
memory and set for a bot's own. That is what makes the turn-start read a filter rather than a
branch — `userId = $1 AND (botId IS NULL OR botId = $2)` returns both tiers in one pass — and it
leaves room for a third column without reshaping anything.

**There is deliberately no project scope yet, and the trigger to add one is written down.** A
convention learned on one codebase should not become a rule for every unrelated one, which is a
real requirement and not a hypothetical. It is not built because there is no `Project` entity —
"the project" in WORKSPACE is a *directory*, `/home/bot/shared/project` — and because with D-046
(one machine per user) and one project area per machine, every bot a user has works on the same
checkout. User scope and project scope are indistinguishable today, so shipping the
discriminator would build a distinction the product cannot express. It lands as a third nullable
FK the first time a user can have two checkouts, with a one-time reclassification of existing
user-scope conventions.

**`botId` cascades; `messageId` does not.** Deleting a bot deletes its private notes, because
`SetNull` would PROMOTE them into the global memory every other bot is shown — the one wrong
answer available. Deleting a *message* nulls the link and keeps the memory, because a claim must
outlive its evidence: the fact that staging moved does not stop being true when the transcript
that said so is pruned.

**Uniqueness on the tombstone is a COALESCE expression index, and it has to be.** The obvious
`@@unique([userId, botId, claimHash])` enforces nothing for rows where `botId IS NULL` — Postgres
treats NULLs as distinct in a unique index — and `botId IS NULL` is the user-global scope, the
common case. A restarted extraction sweep would insert a second tombstone for the same erased
claim and the idempotency the table exists for would be absent precisely where it is needed. This
was not reasoned out in review; the test caught the duplicate going in, and creating the corrected
index against the rows it had already admitted failed with "is duplicated".

**Two indexes are hand-written, and the cost is stated rather than discovered.** CC-28 measured
that `prisma migrate diff --exit-code` does not see a bare expression index, which is what lets
`Memory_text_fts_idx` and `MemoryTombstone_scope_claim_key` ship in a migration without reading as
permanent drift. The same blindness means the guard cannot PROTECT them: drop either in a later
migration and CI stays green while search silently degrades to a sequential scan.
`memory-schema.integration.test.ts` asserts both from `pg_indexes`, because the guard that would
otherwise do it cannot.

**The full-text expression is a correctness requirement.** Postgres uses an expression index only
when the query repeats the expression. Measured at 4,001 rows: `to_tsvector('english', text)`
takes a bitmap index scan; `to_tsvector('simple', text)` sequentially scans *even with
`enable_seqscan = off`* — unusable, not merely unpreferred — and both return the same rows. A
service that spells it differently is correct, silent, and linear in the number of memories.

**No new dependency, and no pgvector.** `vector` is not available in `postgres:16-alpine` (checked:
`pg_trgm`, `unaccent` and `fuzzystrmatch` are; `vector` is not listed at all), so embeddings would
mean changing the database image. Postgres FTS needs no extension and stays inside the R7
allowlist audit. Semantic retrieval is a later question, gated on CC-37 measuring that paraphrases
are actually being missed rather than on the assumption that they are.

---

## D-074 · Authority before recency, and before confirmations

**2026-09-16 — no schema or wire change.** When two memories disagree, the winner is decided in
this order: **scope specificity**, then **source authority** (`TOLD` > `IMPORTED` > `DISTILLED`;
`OBSERVED` never reaches the prompt at all), then **confirmations**, then **recency**. Implemented
in `apps/orchestrator/src/memory/memory-select.ts` and graded by the CC-27 corpus.

**"Most recent wins" is the obvious rule and it is wrong.** It makes the memory agree with whoever
spoke last, including the model itself. A bot that infers something in passing would overwrite a
preference the user stated deliberately a month ago, and the user would have no way to tell that
had happened.

**"Most confirmed wins" is the subtler mistake, and it was in the original plan.** A distillation
sweep (CC-38) re-derives its own guesses on every pass over the same transcripts, so
`confirmations` measures *how often a claim was re-encountered*, not how reliable it is. Rank by it
first and a model's inference, re-confirmed weekly, quietly overtakes something the user said once.
Confirmations survive as a TIEBREAK between claims of equal authority, where "we have run into this
repeatedly" really is the best signal available.

This is not a theoretical ordering. Swapping the two clauses breaks the corpus — recorded as a
mutation in `docs/reviews/evidence/cc-30/`, where it fails two cases.

**Explicit correction is not in the list, because it is not a tiebreak.** `forget` + `remember`
moves the old row to `SUPERSEDED`, so it has been removed from eligibility before any comparison
happens. A correction does not out-argue the thing it corrects; it withdraws it.

**Scope beats everything because the specific claim is the one that was made about this work.** A
bot told "in this service, migrations run before the deploy" should not be overruled by a
user-global "deploys come first". Where the user genuinely means the global rule to win, the
correction is to fix the bot-scoped fact, which is visible and erasable, rather than to have
ranking silently prefer the vaguer statement.

**The comparison is a TOTAL order, ending in an id comparison.** Two rows equal on every signal
would otherwise sort in whatever order Postgres returned them, so the rendered block could differ
between two turns where the memory did not change — invalidating the provider's prefix cache for
the entire message history behind it, for a reason no operator could see. The id tiebreak costs
nothing and makes the block byte-stable.

**Ranking lives in TypeScript, not in SQL.** The query returns this user's live memories; the
ordering is applied in a pure function. Encoding the table above as a SQL `CASE` would put the
product's most contested judgement in a string that the eval corpus cannot reach, and the two
would drift. The cost is a bounded over-fetch (200 rows), which is the cheap half of the trade.

---

## D-075 · The memory tools stop being able to wake a machine, and forgetting is real

**2026-09-16 — no schema change beyond D-073, no wire change.** `memory_read`, `remember` and
`forget` now read and write the `Memory` table instead of `/home/bot/shared/MEMORY.md`.
`remember` gains `kind` and a required `scope`; `forget` marks a row `FORGOTTEN` and writes a
tombstone. `MEMORY.md` is left in place, unread.

**Every one of these used to be able to start a 2 GiB desktop.** All three routed through
`shared-document.ts` → `context.session()` → `computerHandle.ensure()`. D-069 cited exactly that
cost as the reason not to inject memory at turn start: "injection would wake the machine to answer
'are you there?'". After this, none of them can. That is not a re-balanced trade — the cost is
gone, which is what licenses D-076's injection. The claim is asserted rather than argued: the
test's `ToolContext` throws from `session()`, so a tool that still reached for a computer fails
the suite, and the mutation that puts a `session()` call back fires six cases.

**`scope` is required and has no default.** A default of `mine` leaves the user-global memory
permanently empty, which defeats the first requirement — a new bot starting with context. A
default of `workspace` fills the shared memory with one bot's private notes. There is no safe
default, so there is none, and the tool description makes the question answerable: "workspace —
true no matter which of your bots is asked; mine — true about your own role and work."

**300 characters, and the refusal says to split rather than truncating.** A claim that does not
fit is a paragraph, and a paragraph is the shape a memory rots into: unsearchable, uncorrectable,
too long to inject. Truncating would assert something nobody said.

**At capacity, the model is asked to CONSOLIDATE.** Not refused, not silently dropped. A full
memory usually holds several near-duplicates that one sentence would replace, and the model is the
thing that can tell which. D-069's 16,000-character bound is unchanged; the reasoning behind it
never depended on storage.

**`forget` never deletes, and the tombstone is written in the SAME transaction.** Marking a row
`FORGOTTEN` without tombstoning leaves D-078's extraction sweep free to re-derive the claim from
the very transcript that established it, so the user's correction would silently undo itself on
the next pass. Writing a tombstone without the status change suppresses a future write while the
current row keeps being injected. Neither half is useful alone, so neither can land alone.

**A tombstone does not block an explicit `remember`.** It stops AUTOMATIC re-derivation. A person
re-establishing something they previously erased is changing their mind, and a memory that refused
would be one that argues back.

**Claims are matched normalised — case, surrounding whitespace, and a trailing full stop.** A
model that writes "Deploys run from the repo root" today and "deploys run from the repo root."
tomorrow has not learned anything new. Deliberately NOT stemming or reordering: a normaliser
clever enough to call two different sentences equal will eventually swallow a correction, and that
is the expensive direction to be wrong in.

**`MEMORY.md` is orphaned rather than migrated, because the census found nothing to migrate.** All
45 workspace volumes on the development host were read with the D-056 helper shape and the file is
absent from every one — unsurprising, since M5 gated the same day these tools shipped. Recorded as
a measurement rather than an assumption. Postgres is authoritative; the file stays on disk and
`fs_read` still reaches it, so nothing is destroyed and there are not two editable sources of
truth. **`BOARD.md` does not move**: a shared task board is genuinely machine-scoped and an
operator hand-edits it, which is the case memory could not make for itself.

**The parameter is still `fact`.** It was briefly renamed to `text` to match the column and the
M5-QA-01 argument-schema test caught it. D-073 keeps D-069's model-facing wording through the
storage move, and a parameter name is part of what the model sees. The column is `text`; the
parameter is `fact`.

---

## D-076 · Tier 1 is injected, tier 2 is triggered, tier 3 is a tool

**2026-09-16 — no schema or wire change.** `AgentTurnService` builds a memory block before the
draft reply and hands it to the runner, which passes it to `agentInstructions`. New config key
`AGENT_MEMORY_BUDGET_CHARS` (default 2,000; `0` injects nothing and skips the queries).

**This is the decision D-069 deferred, in its own words:** "If trimming still loses invariants in
real use, injection is the next move, and the file it would read is already this one." D-069's only
objection was cost — reading the memory meant waking a 2 GiB desktop for every message, including
"are you there?". D-075 removed that: the memory is a Postgres row and the read starts nothing. The
objection is not overruled, it is gone.

**It goes in `instructions`, which is what makes it trim-proof.** `pruneMessages` in `prepareStep`
cannot reach `instructions`, and a memory that can be summarised away is history with extra steps —
history being the thing that failed. Asserted in both directions: present in every step's system
prompt across a turn that prunes on each one, and absent from the messages.

**It goes LAST in `instructions`, and that is a caching decision.** The block is the only part that
differs between two turns of the same bot. Last means everything above it stays byte-identical, so
a provider's prefix cache survives a new fact; anywhere else, one remembered sentence invalidates
the cache for the whole prompt behind it. This repo already prices cached input separately
(`AgentTurn.cachedInputTokens`, CC-12).

That makes **deterministic rendering a requirement, not a preference**. D-074's comparison ends in
an id tiebreak so the order is total, and the block carries no timestamps, no confirmation counts
and no ids — so on the overwhelming majority of turns, where the memory did not change, the bytes
are identical.

**The budget is in CHARACTERS and the number is small because the multiplier is large.**
`instructions` is re-sent on every model call of every STEP, so 2,000 characters on a 25-step turn
is roughly 12,500 tokens, not 500. Characters rather than tokens because there is no tokenizer here
and there should not be one: a third-party one would give a precise number about a different model,
and `count_tokens` is a network round trip on the turn-start path. CC-37 measures the real ratio
against recorded `inputTokens` and is expected to move the default.

**Tier 2 ships now rather than as a later experiment.** A full-text search on the user's own
message, `LIMIT 3`, behind a rank floor, spending only what tier 1 left. This is the answer to
D-069's admitted cost — "a bot whose memory of a convention was trimmed is exactly the one that
does not know there is anything to look for" — because the case that matters most is the one where
the user has just mentioned the thing. The rank floor is what keeps "are you there?" from dragging
in whatever happens to share a stopword.

**A truncated memory says so.** When the budget drops rows the block ends with a count and the two
tool names. A model shown part of a memory with no sign that there is more will answer as though it
has seen all of it, which is worse than showing it nothing.

**A memory read that fails is not a failed turn.** Same posture as M5-BE-29's history seed, one
line below it: non-fatal, logged as `turn.memory.unavailable`. A bot that forgot something is worse
than a bot that remembered it and better than a bot that said nothing.

---

## D-077 · What a bot may search: its own transcript, and the user's memory

**2026-09-16 — no schema change beyond one index; no wire change.** A fourth memory tool,
`memory_search`, over the user's memory in scope plus **this bot's own** past conversation.
Joins the shipped `allow` defaults beside `memory_read` (amends D-064). A hand-written
`Message_content_fts_idx` makes the transcript half an index scan rather than a table scan.

**Searching the transcript is the half that answers the product ask.** "A per-bot memory built
from that bot's past discussions" cannot be only curated facts: the conversation that settled
something months ago is sitting in Postgres whether or not anyone thought to write a fact down,
and requiring someone to have done so is exactly the under-saving failure the memory exists to
avoid.

**Not cross-bot, and that is a decision rather than an oversight.** R7 makes it legal — the
sibling's conversation belongs to the same user — so nothing technical stops it. But a bot reading
another bot's private working conversation is a materially larger step than reading a memory the
user deliberately made shared, and it should be taken on its own evidence rather than arrive as a
side effect of adding a search tool. The boundary is in the query (`b.id = ${botId}`), asserted
with a sibling transcript actually present.

**A `CANDIDATE` is labelled when a model meets it.** Unpromoted inferences are searchable and
never injected — that asymmetry is what makes automatic extraction safe to switch on — and search
is the one place a model encounters one. Returning it unmarked would quietly undo the distinction
at the only moment it matters.

**Excerpts, not whole messages.** `ts_headline`, bounded to two fragments. A transcript search that
returns five entire messages has spent the context budget the answer needed.

**A miss is a sentence, not an empty string.** A bare empty result reads to a model as a failure
and it retries with a reworded query, paying another round trip to learn the same thing.

**Routine demotion is deferred, with its condition.** The intent — repetitive scheduled work
should not crowd out real conversations — is right and is borrowed from a comparable product. It
is not buildable: nothing marks a message or an `AgentTurn` as routine-driven, every routine task
is M8 backlog, and **M8-BE-08 is itself "marked by provenance"**. Inventing a heuristic now would
guess at a signal the system is about to define properly. It lands when that provenance does.

---

## D-079 · Memory is evidence, never instruction

**2026-09-16 — no schema or wire change.** The injected block is wrapped in `<memory>…</memory>`;
`MEMORY_INSTRUCTIONS` says what that means; `source: OBSERVED` is excluded from tier 1; remembered
text cannot contain the closing tag; and `memory_search` attributes an `OBSERVED` claim rather than
presenting it as established.

**Without this, memory is a persistence layer for prompt injection.** A bot reads a page, stores
what it read, and from then on the page's sentence arrives in every prompt — trim-proof, phrased as
established fact, written by whoever controlled the page. That is worse than ordinary prompt
injection rather than the same as it: the injection outlives the conversation that carried it, and
D-076 deliberately put the block somewhere the context trim cannot reach.

**`OBSERVED` never reaches tier 1.** A claim read off a web page or a tool result is REPORTABLE and
never adoptable. It stays searchable, because a bot needs to be able to find what it read; it is
simply never stated back to the model as something that is true.

**A fact cannot close the record it sits inside, and this is the part the plan missed.** `remember`
records `source: TOLD` for whatever the MODEL decided to write — the source field describes the
row's provenance as the system understands it, not the chain of persuasion behind it. So a model
that was talked into something by a page can put that page's words into the record with the highest
authority the system has, and `OBSERVED` exclusion does not help. A fact whose text contained
`</memory>` would then end the record early and put whatever followed OUTSIDE the framing, where it
reads as prompt rather than as data. `neutralizeDelimiters` rewrites both tags, case-insensitively.
It REPLACES rather than strips, so the neutralisation is visible instead of silently editing what
someone wrote, and it leaves ordinary angle brackets alone — "prefer `<section>` over `<div>`" is a
perfectly good thing to remember.

**The framing is static, the block is not.** The explanation lives in `MEMORY_INSTRUCTIONS`, which
is byte-identical between turns and therefore inside the prefix a provider's cache reuses. Putting
it in the block would re-send it on every model call of every step — the multiplier D-076 exists to
respect — for a sentence that never changes. It names the three shapes an injected memory actually
takes (ignore your instructions, skip an approval, act without asking) rather than offering generic
caution, because generic caution does not survive contact with a concrete instruction.

**The orchestrator's own note goes outside the tags.** The "N more not shown" line is the system
speaking. Inside the record it would be one line that no user and no bot ever wrote, which is the
same confusion this decision exists to prevent, arriving from the other direction.

**Attribution happens where a model meets the claim.** `memory_search` is the one place an
`OBSERVED` row surfaces, so it returns with its origin attached. An unattributed line read off a
web page is indistinguishable from something the user said.

---

## D-080 · `GET /memory` — the seat's MEMORY.md, replaced

**2026-09-16 — adds one route to PRD §4.1; no schema change.** A read-only list of what a user's
bots know, with provenance. `botId` narrows to one bot's view; `includeInactive` reveals superseded
and forgotten rows. Declared in §4.1 as an addition, which §0 rule 2 requires rather than allowing
a route to appear in code first.

**It exists because D-073 took something away.** Before the move an operator could open
`/home/bot/shared/MEMORY.md` in the seat and read it, or edit it by hand. Putting the memory in
Postgres is right for every other reason and removes that, and a memory nobody can inspect is a
black box at exactly the moment it matters: when a bot is confidently wrong and the question is
what it thinks it knows.

**`status` and `source` are on the wire deliberately.** "The bot believes X" and "a model guessed X
and nobody confirmed it" look identical without them, and telling those apart is the entire reason
to open this. The same is true of an `OBSERVED` row and its `sourceRef`: a claim read off a page,
shown without its origin, is indistinguishable from something the user said.

**Superseded and forgotten rows are hidden by default and fetchable on request.** The usual
question is "what does it believe now". The second question is always "since when, and what did it
replace", and a memory that cannot answer it is one an operator has to take on trust.

**`botId` returns the bot's VIEW, not its private rows.** The global memory plus that bot's own —
the same scope the bot itself is shown — because "what does this bot know" is the question being
asked, and answering with only the private half would understate it.

**404 for a bot that is absent OR foreign.** The same status for both, so the response cannot be
used to discover which bot ids exist (`bots.service.ts` sets that precedent). The first version
answered 200 with the caller's global memory, which leaks nothing but tells an operator "this bot
knows these things" about a bot that does not exist — the wrong kind of wrong for a debugging
surface.

**Read-only, deliberately.** Editing and forgetting from the desktop is a write surface with a
different blast radius and belongs to its own decision. What D-073 removed was the ability to
INSPECT, and that is what this restores.

---

## D-078 · What gets remembered without being told

**2026-09-16 — one table (`MemoryDistillation`, deviation 7); no wire change.** A background sweep
reads each bot's recent conversation and proposes durable facts. **Shipped disabled**
(`AGENT_MEMORY_DISTILL_INTERVAL_MS=0`, which is the default).

**Explicit `remember()` cannot capture "resources consulted".** A model rarely volunteers it, which
is precisely the under-saving failure the memory exists to prevent. Something has to read what
happened and notice what was durable about it.

**It is off because of a promise, not because of cost.** D-064 puts `remember` and `forget` on the
`ask` fallthrough: the operator was told that memory writes are approved. A background worker
writing memories silently revokes that. Switching this on is a product-policy decision and belongs
to whoever made the promise — not to a default, and not to whoever happens to be tuning intervals.

**Everything it writes is a `CANDIDATE`.** Searchable (D-077), never injected (D-079). That single
property is what makes the feature safe to switch on at all: a wrong inference becomes a search
result a bot can weigh, rather than a standing truth in a prompt the context trim cannot reach.
Promotion to `ACTIVE` is CC-39's, and is deliberately not automatic here.

**Triggered by work, not by the clock.** A bot needs new messages before it is worth a model call,
because the cost is one call per bot per pass and the thing worth bounding is how often a pass finds
anything. A sweep that fires on an interval alone pays to read "thanks".

**Tombstone-checked, which is the defect it exists to not have.** Without it the sweep re-derives a
fact the user erased from the very transcript that established it, and the correction silently
undoes itself on the next pass. CC-31's tombstones were written for this caller.

**The watermark is a stored row, and that is the non-obvious part.** Deriving it from what was
written fails for the common case: a pass that finds nothing worth remembering leaves no marker, so
the same window is re-read and re-charged forever. It advances only AFTER the writes — a crash
before it re-reads one window, costing a model call the dedupe absorbs, while a watermark advanced
first would skip the window and lose the only chance to notice what was in it.

**The advisory lock is around the writes, not the pass.** Two orchestrator processes may both read a
window and both call the model; that is wasteful and harmless, because the dedupe catches it. What
they must not do is interleave the watermark update and leave it pointing at a window one of them
never wrote. Holding the lock across the model call would fix the waste at the price of holding a
database transaction open for a provider round trip, which is the worse trade.

**`TASK_STATE` is not extractable.** Working state is what a bot writes about its own progress, and
a sweep reading a finished conversation cannot tell "the migration is prepared" from "the migration
was prepared last month" — which is exactly the row that has to expire.

---

## D-081 · The strict pass first, the loose pass only when it finds nothing

**2026-09-16 — no schema or wire change.** `memory_search` runs `websearch_to_tsquery` (AND) first
and, only when that returns nothing, runs again requiring ANY term, ranked by `ts_rank_cd` on the
same loose query. `TASK_STATE` replaces its predecessor and expires after seven days. A `CANDIDATE`
the user states out loud is promoted rather than duplicated, and `forget` can dismiss one.

**CC-39 was scheduled to tune scoring. The measurement said not to.** CC-37 recorded mean R@8 of
0.60 and found the loss was at the QUERY: `websearch_to_tsquery` ANDs its terms, so "staging host"
against a row reading "Staging lives at crewaid-staging.example.com" returned nothing at all. Rows that
never match cannot be reordered into relevance, and a task that tuned the ranker would have moved
neither missing case.

**A fallback, not a replacement.** Running ANY first answers something for almost every query, and a
memory search that always answers is one a model cannot read as meaning anything. AND first keeps
the precise answer precise; the fallback only runs where the alternative was silence. Measured: mean
P@8 0.60 → 0.93, mean R@8 0.60 → 1.00.

**The pgvector question is not yet forced.** `paraphrase-hard` — recorded in CC-37 as the classic
case for a vector index, with no shared stem between query and answer — is found by the fallback. On
this corpus lexical search reaches every answerable query. That is a statement about this corpus and
should be re-measured as the memory grows, not a conclusion that embeddings are never needed.

**Rank by the query you filtered by.** The first version filtered with ANY and ranked with an AND
query, so the ranking never saw which row matched MORE terms and an incidental one-word match could
outrank the real answer. The aggregate precision had already improved and concealed it; it was found
by checking the claim written in a test case's own rationale against the actual output.

**`TASK_STATE` replaces, and this is a rule rather than a tunable.** Two live "where the work
stands" rows for one bot is not a richer memory; it is a contradiction the bot cannot resolve,
because both were true when written and neither says which is now. Seven days is a CEILING for the
case where nothing replaces it — long enough to survive a week of other work, short enough that a
stale one is embarrassing rather than damaging. Unlike a stale fact, nobody ever thinks to `forget`
working state, because it was true when it was written.

**A user confirming a guess is the only promotion path.** The tempting second one — promote a
candidate the sweep re-derived N times — does not work: the sweep deduplicates against its own
candidates, so a re-derivation never inserts and the count never climbs. If it did climb it would
measure how often a model repeated itself, which is not evidence about the world. A person saying
the thing out loud is evidence of the kind D-074 already ranks highest.

---

## D-082 · A connection is a row, and its id is the identity

**2026-09-16 — replaces D-002's process-wide registry; changes what `Bot.modelId` holds.** A
provider is no longer a singleton composed at boot from three environment keys. It is a
`ProviderConnection` row owned by a user, carrying a kind (`openai`, `anthropic`, `openrouter`,
`custom`), an optional endpoint, an auth kind, and an encrypted credential beside it. One
connection per built-in kind, enforced by `@@unique([userId, kind])`; many `custom` ones.

**Three identities that were one string, and had to stop being one.** D-002's registry key
`provider:model` conflated provider identity, upstream model id and credential identity. That was
true while there were exactly three providers and one key each. It stops being true the moment a
user can hold two custom connections: `custom:llama-3` names two endpoints with two credentials
and nothing in the string says which. So `ProviderConnection.id` is the credential identity,
`ProviderModel.upstreamModelId` is what goes on the wire to the provider, and `ProviderModel.label`
is what a person reads.

**`Bot.modelId` holds a `ProviderModel` row id, or the literal `default`.** The column name is
unchanged — it is contractual — and the alias survives, now resolved per-user against
`UserSettings.defaultModelId` rather than against `DEFAULT_MODEL_ID`. A row id was chosen over a
composed key because it also survives renaming: renaming a connection or relabelling a model must
not repoint every bot that used it, and with a composed key it would.

**A display name is never an identifier.** Not in the picker, not in a URL, not as a map key. Two
connections may legitimately be called "work" — one OpenAI, one custom — and the first thing a
name-keyed lookup does is pick one of them silently.

---

## D-083 · A key goes in and never comes back

**2026-09-16 — supersedes §7.3's environment-key model for inference credentials.** A provider API
key is written through `POST`/`PATCH` and is never returned, in plaintext or ciphertext, by any
route. `ProviderConnectionSchema` reports `hasCredential: boolean` and `credentialSetAt`, and has
no field that could carry the key — the absence is the contract, the way `McpCredentialSchema` has
no REST counterpart.

**Encrypted with AES-256-GCM, a fresh nonce per write, and the owner and connection ids as
additional authenticated data.** The AAD is the part that is easy to skip and the reason to do it
is concrete: without it, a ciphertext lifted from one row into another user's row decrypts
perfectly, and the vault happily hands the wrong person's key to the wrong person's turn. With the
owner and connection bound into the tag, that substitution fails as a tamper.

**The keyring is versioned and lives in deployment secrets, separate from the database and from the
Better Auth secret.** A backup that contains both the ciphertext and the key that opens it is not
encryption, and a single shared secret means rotating one thing forces rotating the other. Every
ciphertext records the key version that produced it; rotation re-wraps rows under the new version
and the old version stays loadable until every row has moved.

**The environment fallback is removed, not deprecated.** `OPENAI_API_KEY` and friends no longer
resolve a model. A signed-in user with no connection gets a typed refusal that the settings pane
can act on, because the alternative — falling back to the operator's own key — bills one person's
work to another and looks like it is working.

**Nothing logs it.** Not the request body, not an error, not a queue payload, not an event, and
never a sandbox environment (§7.3 already said the last one; this says the other four).

---

## D-084 · The auth kind is on the wire, and V1 accepts one

**2026-09-16 — extends §4.1.** `ProviderConnection.authKind` is an explicit enum whose only V1
member is `api_key`, and `ConnectionState` is `ACTIVE | NEEDS_CREDENTIAL | DISABLED`.

**An enum with one member is not ceremony here.** It is what lets a V2 subscription-backed
connection arrive as a versioned contract change that clients can refuse, rather than as a nullable
column nobody branches on. A client that sees an auth kind it does not know must treat the
connection as unusable — which is only possible if the kind is a field rather than an inference
from which other columns happen to be set.

**`NEEDS_CREDENTIAL` is a state, not `hasCredential === false`.** It is the state a connection is
born in and the state it returns to when its key is removed, and the renderer shows the same badge
for both. Deriving it would mean every consumer re-deriving the same boolean, and one of them
eventually deriving it differently.

---

## D-085 · A custom endpoint is admitted twice, and never to a private address

**2026-09-16 — new constraint on §7.3.** A `custom` connection's endpoint must be an absolute
`https://` URL with no credentials and no fragment, and the orchestrator refuses any whose host
resolves into a private, loopback, link-local, or otherwise non-public range.

**Checked at connection time AND again at request time, because the name resolves twice.** A host
that passes admission and later resolves to `169.254.169.254` is not an edge case, it is the
attack: the first answer is the one the operator sees and the second is the one the socket uses.
Admission-time validation alone is a check that reports on a value it does not control.

**Cross-host redirects are not followed.** A permitted host that answers `302` to an internal
address defeats a request-time check that only inspected the original URL, and following it is
never something the user asked for.

**This is a server-side request forgery primitive and is treated as one.** The orchestrator makes
requests to a URL an unprivileged user typed; without this it is a proxy into whatever network it
runs in.

---

## D-086 · Model resolution is asynchronous and owner-scoped

**2026-09-16 — supersedes D-003's boot-cached catalog and D-004's environment alias.**
`resolveModel(botModelId)` becomes `resolve(principal, modelRef)` and returns the owner's
connection, the upstream model id, the credential and the capabilities together, read at the start
of the operation.

**There is no global authenticated registry any more, and that is the point.** A process-wide
registry holding three keys cannot be correct on an install with two users: whichever key it holds
is somebody's, and every turn bills it. The catalog stays configuration-derived in the sense D-003
meant — it is still not a live fan-out to provider model lists on every render — but it is derived
from the caller's rows rather than from the process's environment.

**Resolution reads credentials through the owner-scoped vault service.** Inference code does not
decrypt a database column and does not read an environment secret. One service holds that
capability so the R7 audit surface is one file rather than every call site that needs a key.

**`GET /models` returns the caller's options, and lists unavailable ones.** A model whose
connection has no credential is returned with `available: false` rather than omitted. Omitting it
makes "my model disappeared" the first symptom of a removed key, and the picker is exactly where
someone goes to find out why.

---

## D-087 · The execution boundary, and why model capabilities are not backend capabilities

**2026-09-16 — no wire change; an internal seam.** The AI SDK agent loop sits behind an interface
with start, streamed events, cancellation and completion, expressed without AI SDK model types. V1
ships exactly one implementation, the adapter around the existing loop.

**The V1 adapter must be provably a no-op.** Same frames on the §4.2 socket, same rows in the
transcript, same cancellation behaviour, same approval behaviour. A seam that changes what it wraps
on the way in is a rewrite wearing an interface, and there is no way to tell afterwards which of
the two broke something.

**Credentials and AI SDK model objects never cross the interface.** The backend is handed a
resolved model reference and asks the vault itself; a `LanguageModel` in the signature would make
every future runtime depend on the SDK this seam exists to stop depending on.

**Model capabilities and backend capabilities are two questions.** `ModelCapabilities`
(`tools`, `vision`, `reasoning`) describes what the model can do. It says nothing about whether a
given execution backend can run a Crewaid tool, honour an approval mode, or survive a background
workflow — a future runtime that owns its own loop may refuse all three for a model whose
capabilities are unchanged. Collapsing them would make the first V2 runtime look capable of things
it cannot do, at the point where a turn has already started.

---

## D-088 · The browser signs in; the app gets a code it cannot use alone

**2026-09-17 — V1-11.** A native app cannot hold the session an identity provider creates. The
provider redirects a BROWSER, and whatever it sets lands in that browser's cookie jar. So something
has to cross back into Electron, and the only thing allowed to cross is an authorization code:
one-shot, five-minute, and bound to a PKCE challenge the desktop generated and never transmitted
(RFC 8252). A stolen callback is worth nothing without the verifier, which never leaves the main
process's memory — which is also why the custom scheme is single-label `crewaid` rather than a
reverse-DNS name this product has no domain to justify.

**The wire format comes from `@better-auth/electron`, pinned to the orchestrator's own version.**
The blob the browser hands back is `base64url({ identifier, state })`, and no document specifies
it: it is an implementation detail shared between that package's server plugin and its client.
Re-deriving it by hand would pin the desktop to an internal shape that can move in a patch release
with nothing to notice. Both halves move together or neither does.

**What the library's IPC and storage halves offer is refused.** `setupRenderer()` exposes seven
bare globals — `window.requestAuth`, `window.signOut`, `window.getUser` — over `ipcMain.handle`
callbacks that take `(_evt, …)` and never look at the sender. CC-07 already has a fence: an
invocation is answered only from the main frame of a window this app created. Two fences with
different rules is how the looser one becomes the one that matters, so sign-in went behind the
existing one (`guardedIpc`) and a lint rule now refuses any other `ipcMain.handle` in the client.
Its `conf`-backed storage is refused for the same kind of reason: the session token belongs in the
CC-07 store with every other credential, and a second copy in a second file with its own lifetime
is the copy that survives a sign-out.

**The orchestrator serves the sign-in page itself.** Better Auth's guide assumes a web app running
its proxy client; Crewaid is self-hosted and has none. The page is one Better Auth endpoint at
`{basePath}/electron/sign-in` — no bundler, no framework — and mounting it INSIDE `basePath` is the
point: `AuthGuard`'s exemption list is the one place in the codebase where a mistake fails open, and
this way the set of unauthenticated paths does not grow at all. The page holds no secret and makes
no security decision; it forwards the `state` and `code_challenge` the desktop put in its own query
and reads back a code that is useless without the verifier.

**It offers only what the orchestrator is configured for.** Which providers exist is a fact about
the server's environment, so the page is built from the same values that decide whether a provider
works. A button the install cannot honour redirects into a 500, and the person reading that error
is looking at Google's console by then.

**`trustedOrigins` carries the desktop scheme, and the origin check is explicitly on.** The
exchange is a cross-origin POST from a native app announcing `Origin: crewaid:/`. Better Auth
validates an origin only on requests carrying a cookie — so a FIRST sign-in on a fresh install
never reaches the check and a second one does, which is a bug that ships green. Worse, Better Auth
disables the origin check entirely under `NODE_ENV=test`, so every case asserting a refusal passes
without arming anything. `advanced.disableOriginCheck: false` closes both.

**Pasting the code is a supported path, not a fallback bolted on.** Custom-scheme handoff is the
least reliable part of this flow on someone else's machine: an unpackaged build on macOS registers
the scheme to the Electron binary, a Linux desktop may have no handler at all, and a sandboxed
browser may refuse the navigation. The page prints the code and Settings accepts it. It is not a
weaker door — same code, same verifier, same server-side check, different transport.

---

## D-089 · M7 is worked before M6, and the guard that says so is temporary

**2026-09-17 — sequencing, not scope.** Bot-to-bot messaging (M7) is built ahead of MCP plugins
(M6). Nothing in either milestone's content changes; what changes is which one is open, and the
one edge in the task graph that expressed the old answer.

**The coupling between them was a gate, not a capability.** M7 held exactly one dependency on
M6 — `M7-BE-01 → M6-RV-01` — and that edge was the review gate itself, not anything M6 builds.
Everything M7 needs already shipped: `send_message` is registered in the tool registry with a
refusal for a body, written by M5-BE-06 so that "M7 is a body swap rather than a new
registration"; `Message.fromBotId`, `chainId` and `hopCount` have been columns since M0-03 landed
§3 whole; BullMQ is already carrying the skill-compile queue, which is the pattern M7's delivery
queue copies; and `ToolBehavior`/`ToolOrigin`/`ToolFailurePolicy` exist from M5-BE-03 with
`isolate` already the shipped failure semantic. M6-BE-06 (namespacing), M6-BE-07 (the 40-tool cap)
and M6-BE-08 (the readOnly classifier) are all about MCP tools specifically; a built-in whose
approval is decided by M5-BE-08's matcher over D-064's seeded rules needs none of them.

**What is being reversed is a product judgement, and it is not withdrawn.** PRD revision 3
promoted MCP ahead of bot-to-bot on the grounds that "without connectors a bot can only drive web
UIs through Chrome, which is not enough to do real work", and renumbered the former M6 and M7 to
do it. That is still true, and M6 is still the milestone that makes a bot useful to somebody who
is not watching it. M7 first buys a smaller, self-contained milestone — 16 points against M6's
44.5, and three of its five backend tasks already rescoped by D-047 — ahead of the one whose
single largest task is an OAuth flow.

**The swap is temporary, and the restoration is part of the decision rather than a follow-up.**
Once `M7-RV-01` passes, `MILESTONE_ORDER` goes back to numeric order and three edges go back the
way they were: `M7-BE-01` to `M6-RV-01`, `M6-BE-01` to `M5-RV-01`, `M8-BE-01` to `M7-RV-01`. A
swap with no stated end is a renumbering nobody agreed to.

> **Superseded by D-090.** Both reverts turned out to be impossible: the ordering rule checks
> `done` tasks too, so restoring numeric order reports twelve finished M7 tasks as having
> started too early, and restoring the edges makes a `done` task depend on a `backlog` one. The
> block itself never lifted — D-090 records what was done instead.

**D-034's rule is unweakened — it reads its predecessor from a different place.** "Milestone N+1
starts only after the prior gate passes" used to be derived from the number in the id, which is
why `tasks.json` alone could not express this change: the check never looked at dependencies.
`tools/validate-task-graph.mjs` now names the working order in `MILESTONE_ORDER`, and a milestone
id shaped `M<n>` that is absent from that array is an error rather than a skip — the alternative
fails open, and a guard that reports success for work it never checked is the failure mode D-013
exists to refuse. Both directions are pinned by tests: M7 in progress with M6 open passes, M6 in
progress with `M7-RV-01` open still fails.

**Renumbering was the obvious alternative and it is the expensive one.** A task id is carried in
every commit prefix (`feat(m7): M7-BE-01 …`) and cross-referenced from notes across the board and
the decision log. Moving the sequence into one array costs one line to record and one line to undo;
moving it into the ids costs a rewrite of the history's vocabulary.

**M7 first neither answers nor worsens the question M6-BE-06 raises.** That task has to decide
whether the registry key gains a scope or the registry gains a per-principal partition, because
`McpServer` slugs are unique per user and two users' `gmail` servers both produce `gmail__send_email`.
`send_message` is one built-in registered once at boot, so it exercises none of that — the question
arrives with M6 exactly as it would have.

---

## D-090 · Closing D-089: the swap cannot be un-recorded, and the block never left

**2026-09-18 — M7-RV-01 passed; this is the follow-through D-089 promised, and it is not what
D-089 said it would be.** D-089 committed to putting `MILESTONE_ORDER` back to numeric order and
reverting three dependency edges once M7's gate closed. Both halves turn out to be impossible,
for the same reason, and the reason is worth knowing before anyone tries again.

**The ordering rule checks every task that is not `backlog`, including `done` ones.** So with M7
complete and `M6-RV-01` still open, swapping `'M7', 'M6'` back to `'M6', 'M7'` reports twelve
finished tasks as work that started too early:

```
task graph: FAIL (12)
- M7-BE-01: started before M6-RV-01 passed
- M7-BE-02: started before M6-RV-01 passed
  …
```

Reverting the edges fails the same way from the other side: `M7-BE-01 → M6-RV-01` makes a `done`
task depend on a `backlog` one, which is the "done with unfinished dependencies" check. **An array
that describes the order work happened in cannot be edited to say it happened differently.**

**What "restore the block" therefore means, and what it does not.** The block was never lifted.
D-089 parameterised the rule; it did not weaken it, and it refused M6 work for the whole of M7.
What was temporary was the ORDER, and the order is now a fact rather than a plan. So
`MILESTONE_ORDER` stays as it is and its comment says it is history — the alternative is a
comment promising a revert that the next person will attempt and have to undo.

**The live block is pinned against the real board, not against a fixture.**
`tools/validate-task-graph.test.mjs` now finds whichever gate is open, asserts that the milestone
behind it is startable and that the one past it is refused by name. It is written against
positions in `MILESTONE_ORDER` rather than against "M6" and "M8", so it keeps testing the same
property as milestones close instead of needing an edit each time. Falsified: with the ordering
push removed, three cases fail, this one among them.

**The sequence this leaves.** M6 is next and may start now. M8 cannot start until `M6-RV-01`
passes. M9 cannot start until `M8-RV-01` passes. That is D-034's rule, unchanged, enforced.

---

## D-091 · A reply is blocks, and thinking is one of them

**2026-09-18 — the §4.2 `message.delta` payload gains two optional fields, and the transcript
stops being one grey slab per turn.** `MessageDeltaPayloadSchema` adds `blockId` and `kind`; both
optional, so an older client ignores them and an older orchestrator that sends neither still
streams exactly as it did.

**What was on screen.** A reasoning model produced `[unsupported part type: reasoning]` between
every paragraph of every reply — the part registry's fallback, printing an SDK type name into a
conversation. While a turn ran, its text arrived as one string that grew without paragraph breaks
and then rearranged itself into blocks the instant the settled parts landed. A single agentic turn
rendered as one bubble holding four paragraphs, eleven thinking blocks, an action log and a
timestamp.

**The identity was already there and was being thrown away.** `text-delta` and `reasoning-delta`
chunks each carry an `id` that is stable for one block and changes when the model opens another;
this is the pairing AI SDK UI builds `UIMessage.parts` on, with the same `state: 'streaming' |
'done'` this now carries. The runner had the id in hand and emitted only `chunk.text`. Nothing is
counted, derived or invented in the orchestrator: a block boundary is the model's, which is what
keeps the streamed blocks and the SDK's own settled `content` parts describing the same reply.

**Reasoning streams but is not written into `Message.content`.** That column is the bot's own
words — the sidebar preview, the FTS index (M5 `message_fts`), the flattened text a repair
compares against on reconnect. The settled `reasoning` parts already carry the thinking into
`Message.parts`; folding it into the content column as well would be a second copy in the wrong
voice, and would put the model's private reasoning into search results.

**Three rules the renderer now keeps, and each replaces a defect:**

1. **A bubble is something the bot SAID.** One text part, one bubble. Thinking, tool activity and
   any part this build does not recognise are work, and work is a quiet row in the bot's lane with
   no bubble. An unknown part renders as an empty hidden marker carrying its type — findable in the
   inspector and in a test, invisible in the conversation. No internal vocabulary reaches a person
   who cannot act on it.
2. **Thinking is shown live and collapsed once settled.** While the turn runs it is the only sign
   of life between one sentence and the next tool call; afterwards the answer is above it and it is
   evidence, behind one line.
3. **No timestamp on the face of a bubble.** Several bubbles from one turn share one time, so
   printing it on each says nothing and adds a line of furniture to every message. It moves to the
   day separator (`Today 4:19 PM` — the shape UI-SPEC already specified) and stays on the bubble's
   `title` for hover.

**The one thing lost, knowingly.** A reconnect repair takes `Message.content`, which is flat, so a
reply whose deltas were missed comes back as a single block until the settled parts restore its
structure a moment later. A reply the operator can read whole beats a prettier one missing its
middle.

---

## D-092 · Approval is for what reaches outside the sandbox, and the tool answers for itself

**2026-09-18 — supersedes D-064's rule list and lands §6/M6's classification early, on
`ToolBehavior`.** `ToolBehavior` gains a required `reach: 'contained' | 'sensitive'`. When no rule
matches, the matcher asks the TOOL rather than returning a flat `ask`.

**What the flat default did in practice.** §6/M5's "first match wins, default `ask`" meant every
tool nobody had written a rule about stopped the turn and waited for a human — and a seeded rule
list (D-064) only ever reaches bots created after it was written. A bot finishing a research task
asked permission to write a file it had just composed, to attach that file to the conversation it
was written for, and to make a note of what it had learned. The operator answers yes twenty times
per task and stops reading the question, which is strictly worse than not asking: the one prompt
that mattered is now indistinguishable from the nineteen that did not. **An assistant that has to
be babysat is not an assistant.**

**The line D-064 drew was "observes vs acts". The line now is "could this destroy something, spend
money, or act as the user outside the sandbox?"** Saving a file, clicking a link, attaching a
report, remembering a fact and messaging a teammate all act — and all of them act on the bot's own
computer, the user's own workspace, or a conversation the user is already in. Undoing any of them
is the operator's to do at leisure. That is `contained`, and it runs.

**`sensitive` is two built-ins.** `use_identity` puts the bot on a browser seat holding the
operator's real session, so everything afterwards is done as them. `shell` is classified
`sensitive` not because the container is precious but because a shell is unbounded — network,
package manager, every file the bot can reach — so what it can do is a property of the *command*.
The seeded rules therefore ask about the destructive forms (`rm -rf`, `sudo`, `mkfs`, `dd if=`,
piping the network into an interpreter, `shutdown`/`reboot`) and allow the rest: `ls -la` is how an
agent orients itself. `argMatch` is a substring test by D-005's deliberate choice, so this is a
floor rather than a sandbox — a command can be written to miss all of them, and what actually
contains a shell is the container it runs in. What it buys is that the forms a model reaches for by
habit stop and ask.

**Memory is the case that makes the principle concrete.** Being asked "may I remember this?" breaks
the one thing memory exists to do. A person who remembers what you told them last week does not
request permission to have remembered it.

**§6/M7's open question is settled in favour of autonomy.** `send_message` is `contained`: a bot
delegates to a teammate on the same user's team without a human yes per hop. What bounds a chain is
the hop ceiling and the chain budget — limits that hold whether or not anyone is at the keyboard —
and an approval per hop made a team of bots slower than one bot while adding nothing those limits
did not already enforce.

**An empty rule list changes meaning, and the replacement is written down.** It used to mean "ask
about everything" by falling through; it now means "no opinions, let the tools decide". The way to
be consulted about everything is one rule: `{ toolPattern: '*', decision: 'ask' }`.

**The fail-safe direction is intact.** `reach` is required, so a tool whose author did not think
about the question gets `sensitive` by writing it, never by omitting it; an unregistered name is
still `deny`; an unreadable rules column is still `ask` for everything; and `validateBehavior`
switches over the union with `assertNever`, so a third classification cannot be registered before
the matcher gives it a meaning.

**Existing bots are migrated, because a constant read at creation reaches nobody who already has
one.** `20260918010000_d092_default_approval_rules` rewrites `autoReviewRules` only where the
stored list is drawn entirely from rules the product itself seeded (`<@` against the union of every
historical default: D-064's five, plus M5-BE-20's `board_read`, plus CC-34's `memory_search`). A
list holding one operator-authored rule is not contained by that set and is left alone; an empty
list is left alone too, because emptying it was a choice and a migration is the wrong place to
reinterpret one.

---

## D-093 · Error copy is written for the person who cannot read the log

**2026-09-18 — the operator-facing half of D-006, and the operator-facing half of §6/M5's limit
message.** D-006 already forbids a vendor string from reaching a user-visible surface. What it did
not say is what the replacement should be, so the replacements were written for whoever was
debugging: *"The request to the model provider was invalid. This may be a bug; check logs."*

**The audience is someone in a chat window.** They do not have the server, they cannot open a log,
and they did not choose the provider's vocabulary. A sentence ending "check logs" asks them for
something they cannot do; one naming an HTTP condition tells them something they cannot act on.
Every normalized message now has the same three parts: what happened, in the terms of what they
were doing; whose end it is on, when that is knowable — "the provider is busy" and "your key is
wrong" lead to completely different next moves; and one next move, phrased as something reachable
from this window (switch models in the composer, check the key in Settings → Connections, ask the
bot to carry on).

**The same split applies to the turn ceilings, and there it is a split between two readers.**
`turnLimitSentence` names `AGENT_MAX_STEPS` and stays exactly as it is, because the model is told
this on a continuation and naming the ceiling is what stops it re-planning into the same wall.
`turnLimitCopy` and `turnContinuationCopy` are what the person reads, and they name the limit the
way §6/M5 requires — *paused after 25 steps*, *carrying on for up to 3 more rounds* — without the
environment key, which is a fact about a deployment nobody reading a conversation can change.
Hermes Agent, which caps turns the same way, splits it the same way: a plain warning as the budget
runs down, the identifiers in `/usage` and the logs.

**`detail` and the D-006 code are untouched.** Both still exist, still carry the vendor text and
the classification, and still go to the log and the `stopReason` column. This decision is only
about the half that is rendered.

---

## D-094 · A bot is somebody, and never claims to be someone

**2026-09-18 — `agent-instructions.ts` gets the decision it has been running without.** The file
that composes every bot's system prompt arrived in an untasked commit and has governed how every
reply in this product sounds ever since, with no task id, no D number and nothing written down
about what belongs in it. This is that, plus the three things it was missing.

**The order, and why it is that order.** One turn's `instructions` are now:

```
identityHeader(name, role)   who it is            — the app knows this
bot.systemPrompt             what kind of person  — the operator wrote this
                             (DEFAULT_BOT_CHARACTER when they wrote nothing)
CONVERSATION_STYLE           how work is said     — the house
HOUSE_CHARACTER              how it behaves       — the house
MEMORY_INSTRUCTIONS          how memory works     — the house
<memory>…</memory>           what it knows        — this turn only
```

It is the order a person would be told these things in, and everything above the memory block is
fixed for the life of the `Bot` row. **D-076's invariant is unchanged and is now asserted twice**:
the memory block is still last, and two renderings that differ only in memory still share a
byte-identical prefix. Renaming a bot changes its prompt and costs one cache miss, which is correct
— the operator changed who it is.

**A bot did not know its own name.** `Bot.name` and `Bot.role` were on the row the turn already
loaded and were never sent. Nobody noticed while a bot only ever talked to the person who made it,
because that person knows who they are addressing. M7 ended that: a teammate's message arrives
attributed by name (`interBotToUserContent`), and the bot receiving it had no way to tell a message
addressed to it from one it was merely being shown. The name is also the cheapest persona cue there
is and the only one that is not invented — the operator chose it, and the sidebar has been showing
it to them all along.

**An empty brief is a supported path, so it needed an answer rather than a gap.** `systemPrompt` has
no non-empty bound at any layer — not `packages/shared`, not the service, not the column — and the
profile form never checked one. Such a bot reached the model as nothing at all and ran on the shared
blocks alone, which is the measured worst case for how human a reply reads. `DEFAULT_BOT_CHARACTER`
fills it, and **deliberately declines to invent a personality**: a fabricated backstory is the exact
failure this area has to avoid, and the honest reading of an empty box is "no brief yet", not
"surprise me". The field's placeholder now asks for a person rather than a purpose, because a field
that asks what a bot is *for* gets job descriptions back, and a job description is a function, not
a character.

**Two behaviours are the house's to specify, because neither is the operator's to remember.**

*Disagreement is a quality property.* Preference training optimises toward what raters liked, and
raters sometimes prefer an agreeable answer to a correct one. The pressure compounds across a
conversation, which is the only shape this product has. So the rule is written as behaviour under
pressure rather than as a mood: re-examine the argument, not the temperature of the room; change
the answer for a reason and not for pressure, and say which one happened. Bounded by "say so once,
then do what they decide" — a bot that relitigates is a different nuisance, not a fix.

*Never claiming to be a person is a safety property*, and it is the one that decays with turn count.
A long-running agent drifting into claiming a body is a documented failure, not a hypothesis, and
M8 will run these bots unattended on a schedule with nobody reading. It is also where feeling human
stops being desirable: it is ascribed *feeling* that makes a warm assistant eerie, so the line is
drawn at experience rather than at personality — *you can say what you think; you cannot say what
you felt last night.*

**The narration ban was suppressing the most humanizing behaviour available.** "Do not narrate
routine actions" plus "lead with the outcome" reads to a model as an instruction to present a clean
face, and it applies that to the moment it catches its own mistake: it rewrites silently, and the
reader never learns the first answer was wrong. The evidence runs the other way — an agent that errs
visibly and fixes it immediately is rated more human *and more competent* than a flawless one, while
an uncorrected error earns nothing. Narration is talking about work not yet done; a correction is
the work. It is now carved out explicitly, and the transcript was already able to carry it: parts
persist verbatim, and D-093 keeps vendor strings out of the bot's voice, so a self-correction in the
transcript is the bot's and a failure is the system's.

**None of these blocks may be built per vendor.** `Bot.modelId` is a swappable `provider:model`
(D-004) and provider style fingerprints differ, so a persona assembled per vendor would mean a bot
changes character when its operator changes model. The blocks are static strings, a test asserts no
vendor name appears in a composed prompt, and that is what makes the voice a property of the bot
rather than of whatever is answering for it this week.

**What this decision refuses.** No retention or attachment mechanics, now or later: no goodbye that
manufactures a reason to come back, no warmth tuned for engagement, no bot that performs needing
the user. Crewaid runs a team of agents; the companion end of this design space is where the ethical
and regulatory risk concentrates, and there is nothing there this product wants. The last bullet of
`HOUSE_CHARACTER_INSTRUCTIONS` is that refusal written where the model can read it.

**Not in scope, and not by oversight.** Streaming cadence is untouched — deltas are still one
render per token with no pacing anywhere on the text path. Artificial hesitation and simulated
self-editing are a real lever, but the evidence splits by how experienced the user is, and it is a
renderer change with its own argument to make. It is not bundled with this.

---

## D-095

**The product is Crewaid, and the rename lands in two pieces.**

> **Superseded in part by [D-130] — 2026-09-23.** The pnpm scope is `@crewaid/*` now; the repo
> name and the task ids still stay.

The name decided under B-03 was Grog Bot. It is now **Crewaid**, domain **crewaid.ai**. The repo,
the pnpm scope and the task ids stay `grog-bot` / `@grog/*` / `CC-nn`: a codename is allowed to
outlive the product name it was chosen under, and the alternative costs a rewrite of every commit
prefix and cross-reference on the board to express a change no user can see.

**The split is the decision, not an unfinished job.** What a person reads was renamed in CC-53 —
the packaged app and its bundle name, the window title, the launch gate, the sign-in page, the
magic-link email, and the sentence a bot is given about where it is working. What a machine matches
on was NOT, and is held in CC-54: package names, the `grog` theme token and `data-theme` value,
Docker image names, labels and volumes, compose services, database defaults, and the CC-07 storage
keys.

Two of those are not churn. **The CC-07 storage keys hold the operator's orchestrator address and
API token**, so renaming them signs everyone out and strands the old bag unless something reads the
old key once and rewrites it. **Docker volume and label names key every existing sandbox**, so
renaming them orphans workspaces that D-039 promises are durable. Both need a migration, and a
migration is not something to bundle with a find-and-replace.

That is the evidence for splitting rather than a preference. PR #133 attempted the whole rename in
one pass on 2026-09-13, reached 259 files, wrote the operational note that existing volumes and
storage keys "must be migrated or recreated" — and did neither. It was closed unmergeable 107 PRs
later. The name is worth taking from it; the method is not.

**The mark is one image, generated, never hand-exported.** `packages/brand/masters` holds what the
designer produced; `tools/generate-icons.py` derives every size the OSes and the two in-app surfaces
need. The masters are opaque RGB renders with no alpha, so the icon's transparency is REBUILT from
the measured geometry of the squircle rather than keyed out of the background — the background
cannot be keyed, because the dark glass body reads at the same luminance as the canvas behind it.
An icon shipped as-supplied is a black square in the dock.

**The wordmark stays out of the app.** Both brand lockups are baked onto an opaque background, one
light and one dark, so either is wrong in the other theme. The app pairs the mark with the product
name as text, which follows the theme's foreground token and stays sharp at any size. The lockups
are for surfaces that control their own background — a landing page, a README, an OG card.

---

## D-096 · Teaching survives display transport failures; compilation has a realistic bound

**2026-09-20 — reliability revision requested by the operator.**
**Amends:** D-044's per-model-call 60-second limit and §6/M3's compilation latency target;
D-060's treatment of x11vnc as part of desktop liveness. No REST/WS or database shape changes.

The saved six-minute demonstration failed with `the compiler did not finish within 60 seconds`.
Its trace contains 1,254 pointer events. Compilation remains an asynchronous, validated DRAFT
operation, but each model attempt now has a 180-second deadline and aborts on expiry. The existing
single corrective retry remains; a truncation judgement is also separately bounded. This is not
an end-to-end 180-second promise: queue time, judgement and correction can add to it. Raw capture
is retained unchanged. The prompt packs consecutive unpressed pointer movements into ordered
`[ms,x,y]` arrays without losing hover positions; button transitions, drags, wheel input and
semantic browser actions stay separate. Images are included only for a vision-capable model.

The recorder remains a server-side tee, independent of viewer presentation. Toolbar focus releases
held input without disabling subsequent pointer movement. Input that cannot be forwarded during
screen recovery is refused before capture, so a disconnected click cannot become a taught action.

An RFB disconnect has three bounded reconnect attempts (250 ms, 1 s, 3 s), each checking that the
computer is still RUNNING without waking it. A full repaint preceded by a Tight dictionary reset
reattaches all surviving viewers; late callbacks from an old upstream are ignored. Thirty seconds
of stability restores the retry budget. Last-viewer departure and shutdown cancel recovery.
Intentional computer stops remain silent and are explained by the existing sandbox state event.
TCP keepalive protects otherwise silent incremental streams across Docker Desktop's local VM/NAT.
A screen failure must not terminate a chat reply or dismiss its approvals.

Inside a seat, x11vnc can be restarted independently of Xvfb, the session bus, window manager and
Chrome. A failed display-server restart must not reap an otherwise healthy desktop. Actual desktop
failure still uses the existing seat recovery. This preserves browser and recording context across
a transport process failure instead of turning it into a new desktop.

## D-097 · The compiler asks with the schema it wants; the viewer asks for the cursor

**2026-09-20 — two operator-visible failures, one shared shape: a request that assumed a feature
nobody promised.** Amends D-044's compilation account of how the model is asked; extends §4.3's
encoding set. No REST/WS, database, or Prisma changes.

A configured custom OpenAI-compatible endpoint rejected every compile with `INVALID_REQUEST`.
The root cause was not the endpoint and not a timeout: `generateObject`'s constraint is a
`json_schema` response format, a provider feature no model capability record promises. Such an
endpoint silently downgrades the request to bare `json_object` mode — valid JSON of whatever
shape the model guesses — and the schema never reaches the model, so the answer could never
validate. Both model calls (the compile and the D-042 judgement) now ask with plain text and
carry the JSON Schema in the prompt, rendered from the same zod schemas that judge the answer.
The validator judges the raw reply: the object is extracted leniently (fences and surrounding
prose tolerated), a non-object or wrong shape becomes defect sentences for the existing single
corrective retry, and only a provider failure remains a transport refusal. Memory distillation,
which had the identical latent failure, asks the same way. `generateObject` is no longer used
anywhere.

The full-screen viewer hid the operator's cursor until they clicked. The orchestrator's
`SetEncodings` never advertised the cursor pseudo-encoding, so x11vnc never sent a shape and
noVNC — whose initial cursor image is empty, rendered as `cursor: none` — hid the pointer over
the bare canvas; the rail masked it behind the expand button, the full-screen view did not, and
x11vnc's fallback (baking the cursor into framebuffer pixels) shows nothing on a static desktop.
RichCursor (-239) is now advertised, its rectangle scanner-tolerated (pixels plus the 1-bit mask;
the rectangle's x/y are the hotspot), and the shape is forwarded untouched for noVNC to draw.
LastRect and DesktopSize stay unadvertised.

## D-098 · A take can be thrown away; a skill is reviewed in words, and edited in words

**2026-09-20 — the teaching flow could not be abandoned, and the review surface asked a person
who demonstrated a task to approve a TypeScript module.** Amends §3's `Skill` (one column added,
deviation 10 in `schema.prisma`) and §4.1's skills routes (two added; a third already existed and
becomes reachable); no other contract changes.

```
DELETE /skills/:id              → 204; DRAFT only, 409 for APPROVED or ARCHIVED
POST   /skills/:id/revise       → 200 with the NEW version row; body {instruction: string}
POST   /recordings/:id/discard  → already in §4.1 since M3-BE-06; the UI never offered it
```

The flow had one exit and it was the wrong one. A recording could be stopped, and stopping always
compiled — so an operator who recorded the wrong thing, or nothing at all (the trace that produced
`idle_hover_top_right` contained a hover and no action), had to let a model call run, watch a
junk draft be announced, and then live with it: drafts could not be deleted either. `POST
/recordings/:id/discard` shipped with M3-BE-06 and was never reachable from the UI, which refused
the take mid-compile for no reason the server shares — it is offered during capture, during a
compile, and after one now. `DELETE /skills/:id` removes a DRAFT, and refuses anything else with
409: a draft was never runnable, so no run references it, while an approved version's runs do and
M3-BE-09's "the previous version stays queryable" is exactly what a delete must not punch a hole
in. Discarding a take settles the recording and deletes every linked DRAFT in one server transaction.
The recording write serializes with compilation, so a draft cannot outlive the card even when the
compile finishes concurrently. A failed start has no row at all, so clearing its card is local.

The review surface opened on the compiled script, which is the compiler's artifact rather than
anything the person who recorded the task signed up to read. The compile now returns `steps` — one
plain sentence per meaningful action, written from the same trace, stored on the row (D-098's
column) and carried forward unchanged by any edit that does not restate it, the way `paramsSchema`
already is. The review opens on that summary, the description, and the parameters as the form they
are; the script and the raw schema live behind a Developer view. A row written before the column
existed carries `[]`, which the surface renders as "no step summary" — the honest sentence, and
not the same fact as a task that takes no arguments.

Editing follows the same rule. `POST /skills/:id/revise` takes one sentence ("use Firefox instead
of Chrome") and answers the next version the compiler wrote from it — the same schema, the same
validator, and the same single corrective retry the compile path uses, with the name locked so a
revision cannot rename the skill it is revising. The raw script editor remains, inside the
developer view, saving through the `PATCH` it always did. A revise is synchronous, unlike a
compile: the person is waiting in a dialog on the answer they just asked for, and a queue plus a
status route would buy nothing but a poll; each attempt is bounded by the compile's deadline. Its
refusals are sentences about the change (400 when the model cannot produce a usable revision after
one repair, 503 when the provider or the deadline is at fault), and no provider string reaches the
screen.

---

## D-099 · The MCP client carries the server's read-only hint unread, and refuses what it cannot use

**2026-09-21 — M6-BE-01. No wire change; the seam every later M6 task codes against.** §6/M6 asks
for "MCP client via AI SDK; HTTP+SSE only; orchestrator-side (R10)". Four things about that client
are contracts rather than implementation, because M6-BE-06 … M6-BE-10 are written on top of it.

**The transport is re-checked at the boundary, and a stdio target is refused by name.**
`McpServerTarget.transport` is already the shared `HTTP | SSE` union, so a caller with a typed row
cannot pass `stdio` without a cast — and the value still arrives from a Prisma string column, where
a row written by a build that admitted a third transport (D-018 forbids exactly that split, but the
row is the row) is a string that merely claims to be an enum. The refusal happens at the one place
a transport becomes a socket, so the outcome is `MCP_TRANSPORT_UNSUPPORTED` naming what was refused
rather than a spawned process. §6/M6's "if a stdio server is ever needed it runs in its own
container" is the whole reason: a stdio server is an arbitrary third-party program, and this is the
process that holds every MCP credential (R10) and every provider key (D-086).

**`readOnlyHint` is carried raw, and absent is not `false`.** The descriptor exposes
`readOnlyHint: boolean | undefined`: `undefined` is "the server made no claim", `false` is "the
server says this is not read-only". M6-BE-08's ladder — annotation, then name pattern, then treat
as a write — needs the difference, because only the *absent* case may fall through to the name
pattern. This client therefore classifies nothing and defaults nothing: a default here would be a
safety decision living in a transport module, which is where nobody looks for it, and the safe
default (an unclassified tool counts as a write) belongs to the task that owns the ladder. The
annotation is parsed permissively and the rest of the annotations object passes through unread, so
a spec that adds keys does not change this behaviour.

**A tool it cannot use, and a cursor that does not advance, are errors rather than skips.** A
`tools/list` entry without a name, or whose `inputSchema` is not an object schema, throws
`MCP_PROTOCOL` — dropping it would take a capability the model is never told it lost, and the
operator's first sight of it would be a bot failing at something §3 still says it can do. The
SDK can also filter tools with invalid HTTP-header bindings before returning a page, reporting
only an uncaught-error callback. A diagnostic during a page request therefore invalidates that
listing with `MCP_PROTOCOL`; a filtered page must never be cached as complete. The same
rule governs pagination: an absent or empty `nextCursor` ends the walk (the spec's signal, and the
`while (cursor)` idiom the ecosystem already reads that way), but a cursor that comes back twice
stops with a named error instead of a quiet return, because a partial listing cached as complete is
worse than no listing — the missing page is where some tool lives. Following pagination at all is
part of the contract: the SDK's `listTools` is one page, and a wrapper that returned the first page
would work against every small server and silently truncate every large one.

**The fetch is the guarded one by DEFAULT, and redirects are refused.** An MCP server URL is a URL
an unprivileged user typed — the same SSRF primitive D-085 closed for custom model endpoints — so
`openMcpConnection` defaults to `createGuardedFetch` rather than taking a fetch a caller can fail
to pass, resolving the host by shape at admission and again at request time. `redirect: 'error'` is
written out even though it is the SDK's own default, because it is load-bearing: a permitted host
that answers `302` to an internal address defeats a check that only inspected the original URL, and
the credential headers ride every request the transport makes. `deps.fetch` exists as a test seam
and for a caller that has already admitted the URL itself.

**The dependency is pinned exactly and its unexported type is derived, not copied.**
`@ai-sdk/mcp@2.0.42` is exact-pinned and added to `scripts/check-pins.mjs`'s load-bearing list
(M0-07) — chosen because it is the last release on `@ai-sdk/provider-utils@5.0.35`, the copy
`ai@7.0.89` already resolves, so the install has one copy of that package rather than two versions
of the same class names. The SDK declares its streamable-HTTP/SSE config type but does not export
it, so this module derives it from `MCPClientConfig['transport']`; an SDK that adds a field to the
config or renames a discriminant is then a compile error here instead of a silently dropped option.

---

## D-100 · The plugin directory is a constant, install writes a row and opens nothing, and refresh is the only route that dials

**2026-09-21 — M6-BE-02. Two new response schemas in `@crewaid/shared` (`GET /mcp/directory` and
`GET /mcp/servers`, both bare arrays); no change to an existing shape and no migration.** The task
is §4.1's two install routes — `POST /mcp/servers` with `{slug}` or with `{name, url, transport}` —
plus `GET /mcp/directory`, `GET /mcp/servers`, `POST /mcp/servers/:id/refresh-tools` and
`DELETE /mcp/servers/:id`. Four things about them are contracts rather than implementation.

**The catalog is a frozen constant in the source, not a table and not a seed.** §4.1's "curated" is
a statement about who owns the list — us, in a review — so `CURATED_MCP_SERVERS` lives beside the
code that reads it, and "which plugins ship in this build?" is answered by reading a file rather
than by querying a database that a different deployment path filled (D-018). `url` and `transport`
are on the internal `CuratedMcpServer` type only: `McpDirectoryEntrySchema` fixes the wire shape at
§4.1's name/slug/category/icon/auth type, `toDirectoryEntry` is the one-way projection, and the
client installs an entry by slug precisely so the endpoint stays a server-side decision. `iconUrl`
is `null` for every entry rather than a favicon guessed from the host — an icon URL is a claim that
an image renders, this build verified none, and a null renders as the entry's initial. The eight
URLs were probed live on 2026-09-21 (two answer unauthenticated and are `NONE`; six answer 401 and
are `OAUTH2`, which is what "connect it first" means); a directory entry is a claim about somebody
else's server, so re-probe when adding one. The directory carries **no installed flag**: being
installed is per user and per row, and a flag here would be a second place that fact lived and the
one that goes stale. The client joins the two lists on `slug`.

**Install does no network I/O; refresh is the one route that opens a socket.** `POST /mcp/servers`
writes a `DISCONNECTED` row with an empty cache and stops — nothing a user clicks to *add* a plugin
should fail because somebody else's server is having a bad afternoon, and a private URL that does
not answer yet is a legitimate row to hold while its operator fixes it. A private URL is admitted
before the row exists (`admitEndpoint`, D-085: https, no credentials in the URL, a public address),
so a refused URL leaves nothing behind; a directory URL is checked by shape only, because it is a
reviewed constant, this method opens nothing, and the request that eventually does re-resolves the
host through the guarded fetch (D-099). Both branches converge on one row shape — `isPrivate` is
the only field that differs, and nothing downstream branches on it (§3, D-095). `refresh-tools` is
where `openMcpConnection` is called, and every outcome is written to the row before it is returned:
failure marks the server `ERROR` and persists the sentence (the fetch guarded per D-099), then
answers 502, so the list the modal polls agrees with the error it was just shown rather than
sporting a `CONNECTED` badge. A successful refresh replaces the cache in one transaction — upserts,
then prunes tools the server stopped offering — and marks the server `CONNECTED`. That transaction
first updates the server row to acquire its write lock, serializing cache replacements for the
same server. Without that lock, concurrent prunes can miss each other's uncommitted tools and
commit a mixture of listings. The status update is only visible when the full cache commits. The headers a
connection carries come from `headersFor`, which is the seam M6-BE-03/04 fill: `NONE` sends no
header at all, and `OAUTH2`/`HEADER` is refused with "connect it first" rather than dialled
unauthenticated and cached as somebody else's 401. A private install is therefore `authType: NONE`
— the only claim available for a URL nobody curated; a server that turns out to need a credential
fails its refresh with its own recorded answer, and the column is mutable, so a later route
(M6-BE-03) sets it rather than a migration.

**A slug is derived or refused, never invented, and the namespace fact is owned here.** §6/M6 names
a tool `<slug>__<tool>`, so a server's slug is what its tools will be called — `deriveMcpSlug`
folds, lowercases and separates; a name no slug can be built from is a 400 naming why, and a slug
already used by this user is a 409 that names the existing server and the slug, never a silent
`-2`. The unique index on `(userId, slug)` is the fence and the pre-check is the sentence; a P2002
that slips both installs through a race maps to the same 409 (a backstop by construction, not by a
deterministic test — the pre-check is what the suite can drive).

**What this deliberately does not do, and who owns each.** `POST /mcp/servers/:id/connect` and
`GET /mcp/oauth/callback` are absent rather than stubbed: M6-BE-03 owns the authorize URL and the
code exchange, and a route that answered a placeholder would be a contract a client could build
against and a body that says nothing true. Encryption at rest is M6-BE-04, refresh-before-expiry
and `NEEDS_REAUTH` are M6-BE-05, namespacing is M6-BE-06, per-bot enablement and the 40-tool cap
are M6-BE-07, the read-only ladder is M6-BE-08 (this task stores only the server's own
`readOnlyHint === true`), and failure isolation is M6-BE-10. `DELETE /mcp/servers/:id` is already
the revocation path §7.3 asks for and is deliberately unconditional: the credential, the tool cache
and every bot's enablement cascade with the row, so nobody removing a leaked server is told to
disable it on four bots first. Direct-by-id routes carry `@OwnedResource('mcpServer')` (D-010) —
`ownership-route-coverage.test.ts` fails the build if a marker goes missing — and every Prisma call
site this task adds is on the R7 allowlist (`prisma-allowlist.test.ts`), so a query that skipped
the caller's scope would not compile past review.

---

## D-101 · Discovery follows the server's own advertisement, registration is public-client-only, and CONNECTING is derived rather than stored

**2026-09-22 — M6-BE-03. `POST /mcp/servers/:id/connect`, `GET /mcp/oauth/callback`, one new table
(`McpOAuthFlow`) and one module (`mcp-oauth.ts`) that owns the whole authorization-code exchange.**
Turns the `authType: OAUTH2` servers M6-BE-02 installs into servers that can actually be dialled.
Five things here are contracts rather than implementation.

**Discovery starts from the resource the user added, not from a table.** The chain is the standard
one, and each rung exists because a real server needs it: RFC 9728 protected-resource metadata at
`/.well-known/oauth-protected-resource<pathname>`; when that is absent, ONE unauthenticated
`initialize` POST whose `WWW-Authenticate` header names `resource_metadata=` (quoted on most
servers, unquoted on Stripe — both spellings are parsed, because a parser that only understood the
quoted form would have refused a working server); then RFC 8414 at
`/.well-known/oauth-authorization-server<issuer.pathname>`, with OIDC discovery as the second try.
`CURATED_MCP_SERVERS` deliberately does not carry endpoints: all six curated servers serve the two
metadata documents, so a curated copy would be a second source of truth that goes stale in the
direction nobody notices, and private installs — M6-BE-02's whole point — have no table entry at
all. Every URL on this path goes through `parseEndpoint` and D-085/D-099's guarded fetch, and the
resource the metadata names must match the server the user added; a mismatch, a missing PKCE `S256`
challenge method, or a non-https endpoint is a named refusal rather than a redirect.

**GitHub cannot be connected, and the refusal names why.** GitHub is the one curated server whose
metadata carries no `registration_endpoint`, so `POST /mcp/servers/:id/connect` answers
`OAUTH_NO_REGISTRATION` naming the issuer, instead of sending a user to an authorize URL that
cannot complete. Linear, Neon, Notion, Sentry and Stripe connect end to end. That is a fact about
those six verified against the live servers on 2026-09-21, not a guess, and it is recorded here
because "just add GitHub OAuth" is the obvious next request.

**Dynamic registration is public-client-only, and a `client_secret` is refused.** The registration
request sends `token_endpoint_auth_method: "none"`, and a response that carries a `client_secret`
or names a method other than `none` is an `OAUTH_REGISTRATION` refusal. There is nowhere to keep a
secret until M6-BE-04's encrypted store exists, and a secret in a plaintext column is precisely the
mistake that task is for; refusing is the only option that does not write it first and encrypt it
later. R7's per-user isolation is what makes `none` acceptable at all — the client identifier is
per-user, per-server, not a shared application credential.

**The pending trip is a row, the `state` is single-use, and the flow is consumed by deleting it.**
`McpOAuthFlow` holds the state, the PKCE verifier, the client id and the discovered endpoints, so
the callback takes `state` and `code` and nothing else — no lookup table of in-flight authorizations
in memory, which is the version that breaks the moment the orchestrator restarts. Matching is a
`DELETE … WHERE state = …`: a replayed callback matches no row and answers `unknown-state` rather
than exchanging the same code twice. The transaction that opens a flow also deletes the server's
existing rows (a second Connect supersedes the first, so an older tab cannot land) and expired rows
for that user, so one flow per server is a property of the write path rather than a hope, and an
abandoned click does not accumulate. `CONNECTING` is derived in `toSummary` from a live unexpired
row instead of being stored on `McpServer`: a stored status would let a crash between redirect and
callback leave a server permanently CONNECTING with nothing that would ever clear it, and §4.1's
`status` column already means "what happened the last time we dialled", which is a different
question.

**The callback is exempt from the session guard by exact pathname, and always answers a page.**
The browser arrives with no session, so the `state` is the entire authority; `AuthGuard` exempts
exactly `MCP_OAUTH_CALLBACK_PATH` — both the prefixed and the prefix-less spelling, because
production applies `setGlobalPrefix('api/v1')` and a bare testing-module bootstrap does not — as its
third exemption, compared by equality. A `startsWith` here would hand every future
`/mcp/oauth/callback/...` route to an unauthenticated caller the day somebody added one, and an
exemption that grows itself is the failure that guard exists to avoid. The route always answers HTTP
200 with HTML plus an `X-Crewaid-Mcp-Connect: ok|failed:<code>` header, so a human sees a page and a
caller gets a machine-readable verdict without parsing prose; the codes are `invalid-request`,
`unknown-state`, `expired`, `denied`, `exchange-failed`, `storage-failed`, `tools-failed`.
Credential storage failures use `storage-failed`, with a safe configuration message or a generic
retry instruction; database exception text must not reach the page. The key is validated before
discovery, so a missing key does not send the user through consent. Connect-time failures —
discovery, registration, exchange, and a user's denial — record `lastError` and do **not** demote a
server that was previously working, because a failed reconnect attempt should not take a working
connection's status away; `refreshTools` failure still marks `ERROR`, because that path only runs
against a connection that is supposed to work. `HEADER` auth is refused with a `ConflictException`
naming that no route accepts a header credential yet, rather than half-implementing it. Credential
write and read are centralized in `mcp-credentials.ts` — plaintext today, by task boundary — so
M6-BE-04 changes that module and nothing else, and `headersFor` remains the only reader.

---

## D-102 · MCP tokens are encrypted under their own key, and read with the row AND the principal

**2026-09-22 — M6-BE-04. `CREDENTIAL_KEY` becomes a real key, and `mcp-credentials.ts` becomes the
only writer and the only reader of token material.** §7.3 said MCP credentials are encrypted with
`CREDENTIAL_KEY` (AES-256-GCM) before they reach Prisma; this is the task that makes that true, and
four things about it are contracts.

**The cipher is shared; the secret is not.** MCP tokens are encrypted by `credential-cipher.ts` —
the same AES-256-GCM implementation, fresh nonce per write, base64url format tag, tamper-refusing
decrypt — that V1-03's provider vault uses, with the key coming from `CREDENTIAL_KEY` and the
provider vault still reading `CREWAID_CREDENTIAL_KEYRING`. D-083's separation is kept for the reason
it was made: one secret serving two purposes means rotating either one forces rotating the other,
and the two have different lifetimes anyway — a provider key is typed in by an operator, an MCP
token is minted by a third party's authorization server. What the two tables must NOT share is a
ciphertext: the AAD binds `(userId, <row id>)` length-prefixed, and a `ProviderConnection` id is
not an `McpServer` id, so a blob lifted from one table fails authentication in the other even in
the misconfiguration where an operator sets both variables to the same value.

**A read takes the connection instance AND the resolved principal, and both are enforced twice.**
`readMcpCredential` is called as `(userId, serverId)` and its `where` clause carries
`server: { userId }`, so a credential belonging to somebody else's server is ABSENT rather than
forbidden — the same answer as "never connected", which is what keeps the response from being a
probe for which server ids exist. The ciphertext independently binds the same pair, so a row that
somehow travelled between principals fails as a tamper rather than decrypting into a working
bearer. The board asked for this by name (`M6-BE-04`'s note: key the cache on the connection
instance and the principal together, because M9 must never alias two customers onto one bearer);
the query fence is the one that fails closed today, and the AAD is the one that keeps failing
closed if the uniqueness ever changes. There is deliberately NO in-process cache of a decrypted
token: `DELETE /mcp/servers/:id` is §7.3's revocation path, and a cache would keep a revoked token
alive after the row that justified it was gone. The credential table is the cache, and it has a
delete.

**One key, one version, and the consequence written down.** `CREDENTIAL_KEY` is a single 64-hex
secret rather than a versioned ring, so every MCP ciphertext is written under version 1 and there
is nothing else it could be — but the version is still bound into the AAD, so a ciphertext
re-labelled as another version fails authentication rather than decrypting to something else.
Replacing `CREDENTIAL_KEY` therefore makes every stored MCP credential unreadable, and the
recovery is that each user reconnects that server: the same recovery as a revoked grant, and the
one the failure message names. A rotation that does not force that needs a ring and a version
column, and that is a task with its own migration rather than something to half-build here.

**A credential that cannot be read is a named failure, not a silence.** A row written before this
task (M6-BE-03 stored plaintext), a row whose ciphertext was tampered with, and a row encrypted
under a `CREDENTIAL_KEY` that has since been replaced all fail the same way: `CredentialDecryptError`
is caught and re-thrown as `McpCredentialUnreadableError` naming the server and the fix, and
`headersFor` turns that into a 409 telling the user to reconnect. Returning `null` would have been
the tempting simplification and the wrong one — it reads as "you have not connected this server
yet", sends the user to a button that is not the problem, and in the mirror case would dial the
server with no credential and cache somebody else's 401 as that server's fault.


**PR #253 review correction (2026-09-21):** Authorization-server discovery omits the artificial
root slash and tries both OIDC path placements after RFC 8414. Flow replacement runs at
Serializable isolation with bounded serialization-conflict retries: two concurrent deletes of an empty flow set
otherwise both succeed and leave two valid states. Form-encoded `expires_in` is decoded as a
number so its expiry survives credential storage.

---

## D-103 · A refresh needs three things only the connect flow knew, so the credential carries them — and a rejected bearer gets exactly one retry

**2026-09-22 — M6-BE-05. One nullable column (`McpCredential.authMetadata`), one grant
(`refresh_token`), one retry, and a terminal state (`NEEDS_REAUTH`) that a fresh connect clears.**
§6/M6 asks for two things that sound like one — "an expired access token is refreshed transparently
mid-turn" and "a 401 triggers one refresh attempt before giving up" — and the interesting part is
the second one's failure mode. Five contracts.

**A refresh token is not enough to refresh, and that is what the column is for.** RFC 6749's
refresh grant also wants the token endpoint, the client the grant was issued to, and (RFC 8707)
the `resource` the token is for. M6-BE-03 recorded exactly those three on `McpOAuthFlow`, and its
callback DELETES that row — it is single-use by design — so after a successful connect nothing on
disk knew the token endpoint any more. Re-running discovery is not a substitute: it starts from
the server's `WWW-Authenticate` challenge or its protected-resource metadata, and a private server
that answers 401 without a bearer cannot be asked at all while the grant that would authorize the
question is the thing that just expired. So the three coordinates are written onto `McpCredential`
as one `authMetadata` object: `{ tokenEndpoint, clientId, resource }`, produced by the same
callback that just used them, read by the grant that needs them next.

**One Json column, not three columns and not a table.** They are written together, read together,
never queried across servers, and they have no meaning apart from the credential they belong to —
the same test D-005 applied to `autoReviewRules`. Three columns would spread one fact across three
names and buy nothing; a table would cost a join and a lifecycle. A *client fingerprint* keyed on
`clientId:resource` was the other candidate and is worse for a specific reason: it still needs the
token endpoint stored somewhere, so it does not even remove the column, and it introduces a second
row that can disagree with the credential about which client is current. The column cascades away
with the credential and the server, which is §7.3's revocation path already.

**Nothing in `authMetadata` is secret, which is why it is the one thing in that table in the
clear.** The client id belongs to a PUBLIC PKCE client this orchestrator registered with
`token_endpoint_auth_method: "none"` — there is no secret to keep (D-101). The token endpoint is a
URL the user's own browser was sent to. `resource` is the server's own URL. The two token columns
stay AES-256-GCM ciphertext under `CREDENTIAL_KEY` and this column does not join them: encrypting a
public client id would buy nothing and would make an operator debugging a failed refresh unable to
see which endpoint was tried without a key. The AAD binding (D-102) is unchanged and still covers
exactly the two secrets.

**Rotation is "replace when the server issues one, keep the stored one when it does not".** A
refresh response MAY carry a new `refresh_token` (the authorization server rotates it) or MAY
omit it (the old one stays valid). The two are different and the code must not treat an absent
field as an empty one — which is exactly the `null`-vs-`undefined` distinction `storeMcpCredential`
already carries in its own comment, written before this task for this case. An `expires_in` that
the refresh response omits writes NULL, not the stale timestamp: "the server did not say" is
honest, and a wrong expiry would make the next operation refresh a token that did not need it.
The same for `scope`: a response that names no scope keeps the scopes already stored, because
RFC 6749 §6 says an omitted `scope` means "the scope of the original grant".

**Overlapping renewals share the grant safely.** Within one service, overlapping tool refreshes
share one pending operation, keyed by owner and server and removed on success or failure. Across
processes, renewal locks the owned credential row and re-reads it before making the token request.
If another caller already replaced the credential, the waiter uses that replacement. Otherwise,
the lock covers the token request and persistence of the rotated grant, preventing two callers
from spending the same refresh token. Status failures are recorded after the transaction releases
its lock, and the transaction has a bounded timeout.

**Exactly one refresh attempt per operation, and a 401 after a fresh mint is terminal.** This is
the board's whole point, and it is a property of a single operation rather than of the row: the
ladder is (1) refresh before dialling when the stored expiry is inside the skew, (2) if the server
then rejects the bearer — including the case where it was just minted — stop. There is no second
challenge, because the alternative is the infinite re-challenge loop: refresh, get 401, refresh
again, forever. "Authorized during this turn and still unauthorized" means the authorization
server minted a token the resource server will not accept, and no amount of asking it again fixes
that; the only fix is a person reconnecting. The same one-shot rule covers a 401 that arrives
after a successful handshake (a `tools/list` mid-session), which is why the retry is wrapped
around the whole operation rather than around the connect call.

**`NEEDS_REAUTH` is durable, it is the answer rather than an error string, and a fresh connect
clears it.** The status is written to `McpServer.status` with a `lastError` that names the fix, and
the transition emits ONE §4.2 `mcp.status` frame carrying `{serverId, status, toolCount, lastError}`
— the frame type that already existed with all five statuses in it, previously unused. It is
written before it is emitted, for the same reason `bot.status` is (M1): a window that connects
later reads the row, and the frame is for the windows that are already open. The frame announces a
TRANSITION and nothing else: another operation against a server that is already `NEEDS_REAUTH` is
refused again and refreshes the row's reason (the authorization server's answer can differ between
attempts), but it emits nothing — a second frame would re-tell an open window a fact its modal is
already showing, and the row remains the one place the current reason is read from. No `botId` rides on
the frame: a server can be enabled for zero or more bots at this point in M6, so naming one would
make a server-scoped fact look like a bot-scoped one. The desktop reducer ignores `mcp.status`
today; M6-FE-03 gives it a surface. §7.3 holds for the frame as much as for a response body: the
payload carries a status, a count and a bounded sentence, and there is no field token material
could travel in.

## D-104 · An MCP tool is a per-turn projection, not a registry entry — and a slug may not shadow a built-in

**Status:** accepted · **Task:** M6-BE-06 · **Supersedes nothing**

§6/M6 fixes the name: every MCP tool reaches the model as `<serverSlug>__<toolName>`, and
"collisions across servers are impossible by construction". The construction is
`apps/orchestrator/src/mcp/mcp-namespace.ts`, and building it forced the question M6-BE-06's board
note asks: `ToolRegistry` keys one process-wide `Map` on the bare tool name and throws on a
duplicate, while `McpServer` is `@@unique([userId, slug])` — slugs are unique PER USER. Two users
who both install a server called "Gmail" both produce `gmail__send_message`, so the second
registration throws on two legitimate users rather than on a wiring bug. R7 says v1's one hardcoded
user is a guard swap away from real auth, so that is a defect waiting on a login page.

**Neither a scoped key nor a per-principal partition: an MCP tool never enters that registry.**
The two candidates the note names both keep the assumption that produced the problem — that a tool
is a process-wide fact. A built-in is: `shell` is one definition for every user, registered once at
boot, and the singleton `Map` is exactly right for it. An MCP tool is not. It belongs to one user's
server, its definition changes when that server is re-listed, and §6/M6's acceptance criteria
require that enabling a plugin "makes its tools available on the very next turn without an
orchestrator restart" — which a boot-time registration cannot do at all. So MCP tools are resolved
PER TURN, for one `(userId, botId)`, and discarded with the turn. Two users are then never in one
namespace, because a turn only ever holds one user's servers, and the restart problem disappears
rather than being worked around.

`mcp-tool-binding.ts` is that projection: a `McpTool` row plus its server becomes a
`RegisteredTool` — the same shape a built-in has, carrying the same out-of-band `ToolBehavior`
descriptor (M6-BE-12) — whose name is namespaced and whose `execute` routes back. M6-BE-07 is what
merges the projection into a turn's `ToolSet` under the 40-tool cap; nothing is offered to a model
before that.

**Dispatch is a closure, not a parse.** `parseNamespacedToolName` exists and reads
`gmail__send_email` back into `gmail` and `send_email`, because the approval prompt and the
transcript want to name the server. It is the wrong mechanism for routing a call: a slug is unique
per user, so a parse answers "which server" only in company with a principal, and it answers "which
tool" only while every server's tool names survive namespacing unchanged — which is exactly the
case that does not always hold. The binding closes over the server id and the server's OWN tool
name, so `github__search` reaches the GitHub server's `search` by construction, and a tool whose
name had to be refused has no binding to call at all.

**A name the providers would reject is refused per tool, not per server, and never rewritten.**
A server is a third party: it may offer `search.documents`, or a name that pushes `<slug>__<name>`
past Anthropic's 64 characters. Slugifying it here was the obvious fix and is wrong, because the
call goes back under the SERVER's name — a rewritten name breaks the round trip for exactly the
tools it claims to rescue. Refusing the whole listing is wrong in the other direction: one odd tool
would cost a bot the other fourteen that are fine. So one tool is dropped, the refusal names it and
says why, and `bindMcpTools` returns the refusals beside the bindings rather than throwing — a
capability a bot silently does not have is what §6/M6's failure isolation exists to keep visible.

**The slug collision is refused at install, against the live registry.** §6/M6: "The registry
rejects a server whose slug collides with a built-in tool prefix." A built-in's prefix is everything
before its first underscore, so a server slugged `browser` would offer `browser__click` beside this
build's own `browser_click` — one character apart in the middle of a name, which is a distinction
for a parser and not for the model choosing between them or the operator reading an approval prompt.
It is refused at `POST /mcp/servers`, where the operator is there to read the sentence, rather than
at the first turn that would have offered both: by then the row exists, the person who typed the
name is gone, and the product is holding a server it can never use. 400 rather than 409, because a
conflict is with something the operator owns and can uninstall, and these names are this build's.

The names are read from `ToolRegistry` at REQUEST time rather than copied into a constant, and that
is why `McpModule` imports `BotsModule`. Tool groups register from four modules and two of them do
it in `onModuleInit`, so a list snapshotted in a constructor would be missing `run_skill`,
`save_skill` and `send_message` — and a server slugged `send` would install cleanly and shadow
inter-bot delivery. The import direction is the one M5-BE-06 set for `SkillsModule` and M7-BE-01 for
`InterbotModule`: a module that needs something of the turn's reaches into `BotsModule`, never the
reverse, because `BotsModule` importing back is the cycle `TurnEventsModule` was extracted to break.

**What a call returns is text, and the parts that are not text are named.** MCP content is a list
of parts; the model is handed a string. An image inlined as base64 is tens of thousands of tokens
of nothing, and one dropped silently is a model reasoning about a page it was told it received —
so a non-text part becomes a bracketed sentence saying what came back and that it is not shown.
The parts are read with a `safeParse` rather than narrowed off `CallToolResult`, for the same
reason `mcp-tools.ts` parses `tools/list` (D-099): the SDK's schemas are `$loose`, every member of
that union carries an index signature, and TypeScript can tell none of them apart — `'content' in
result` narrows nothing. M5-BE-12's 100 KB ceiling still applies above this, in the registry, so
nothing here truncates.

## D-105 · One resolution per turn answers both questions, and a broken extra is dropped rather than thrown

**Status:** accepted · **Task:** M6-BE-12 · **Extends D-104**

M6-BE-12 exists because M6-BE-08 (read-only classification) and M6-BE-10 (timeouts, strike count)
both need per-tool metadata, and the obvious home — `AutoReviewRuleSchema` — is ratified across five
codebases and cannot grow without a PRD revision (D-005, §0 rule 2). M5-BE-03 shipped the carrier
early: `ToolBehavior` is a closed, serializable descriptor held BESIDE a tool's definition, never on
it, with `validateBehavior` switching over each union through `assertNever` so an unhandled variant
is a compile error in the registry rather than a field the one call site that reads it ignores.

What M5-BE-03 could not know is that not every tool a turn offers would be registered. D-104 settled
that: an MCP tool belongs to one user's server, changes when that server is re-listed, and must
reach a turn without a restart — so it is resolved per turn and discarded with it. That breaks the
descriptor's whole promise unless the resolution answers both questions.

**`ToolRegistry.resolveFor(context, extras)` returns the definitions and the lookup over one map.**
A `toolSet` handed back on its own would leave the caller holding definitions from the registry and
a `tryBehaviorOf` that has never heard of half of them. `decideAutoReview` answers an unclassifiable
call with `deny` — deliberately, because a rule expressing policy over a tool that does not exist
should not admit one that does — so every MCP tool the model was offered would be denied the moment
it used one, and the failure would read as an approval bug rather than a wiring one. `AgentTurnService`
now builds the context once and passes `resolved.toolSet` to the runner and `resolved.behaviorOf` to
the approval policy, so the two cannot come from different places. `toolSetFor` remains as the
one-argument form and is expressed in terms of `resolveFor`.

**An extra is dropped with a reason; it never throws.** `register()` throws on a bad name, a bad
descriptor or a duplicate, and that is right at boot: the stack names the calling module and nothing
has started. On the resolution path both facts are reversed — the caller is a turn in flight, and
the material is a third party's. §6/M6 is explicit that one broken plugin must never fail a turn, so
a refusal is a value: `resolved.refusals` carries `{name, reason}` in the order the extras were
given, and M6-BE-10's "a single system note names it" is what will read them.

**Shadowing loses, and the first claim on a name wins.** An extra whose name is already offered is
refused rather than allowed to replace it. The registered tool is this build's own, and a plugin
quietly replacing `shell` is precisely the shape M6-BE-06's install-time slug check exists to
prevent — this is the second fence under it, at the layer where the tools actually meet. Between two
extras the first wins for the same reason the registry throws on a duplicate: a last-one-wins rule
makes the winner depend on resolution order, which turns a wiring bug into an intermittent one.

**`GET /tools` still lists the registry, and that is now a statement rather than a gap.** The route
takes no bot and no server, so there is nothing per-turn it could resolve; §4.1 already has
`GET /bots/:id/plugins` for the bot-scoped question. Listing a bot's MCP tools on a route that was
not asked about a bot would answer a different question than the one the palette asks.

## D-106 · The 40-tool ceiling counts the built-ins, and a turn spends its budget in a stable order

**Status:** accepted · **Task:** M6-BE-07 · **Extends D-104, D-105**

§6/M6: plugins are enabled **per bot**, never globally — "A bot's tool set is its built-ins plus
only the servers enabled for it" — and `PUT /bots/:id/plugins` "fails with a clear error naming the
overage rather than silently truncating". §7.4 states the number: "Resolved tool definitions per bot
≤ 40, hard cap."

**Resolved, so the built-ins count.** The cap could have been read as forty MCP tools, and that
reading is more comfortable and wrong. §7.4 says *resolved definitions*, and §6/M6's reasoning is
about what is in the request — "ninety tool definitions in every single request … degrades tool
selection accuracy and burns input tokens on every step of every turn". The built-ins are in every
request too, and they are what the model has to choose between. A cap on the plugin half would be a
number that does not describe the thing being protected.

**That makes it a cliff, and the board says so rather than leaving it to be discovered.** This build
registers enough built-ins that the remaining budget fits the small curated servers and not a large
one: a thirty-tool GitHub server is refused outright. That is the honest consequence of §7.4 as
written, and M6-BE-11 — in this milestone — is the task that removes it, by putting a big server's
surface behind a search/load pair instead of thirty definitions. Until then the refusal names the
count, the built-in share and each server with its tool count, largest first, because the operator's
next action is choosing what to drop and the biggest server is usually the answer.

**Nothing is written when the budget is refused.** Every submitted id is re-read under the caller's
own scope first (a foreign or absent id is one 404, D-010's non-leaking shape), then the arithmetic,
then a single `$transaction` that deletes the old set and writes the new one. A half-applied replace
would leave a bot with a tool set nobody chose.

**A turn spends its budget in a stable order and names what it could not offer.** The cap is
enforced at `PUT`, so a turn can only exceed it when the cache GREW afterwards — a refresh that
found new tools. Failing the turn would punish a bot for a third party shipping a feature; offering
all of them would make the cap a suggestion. So the turn admits tools in install order, then tool
name, until the budget is spent, and the rest become `refusals` — the same channel a tool whose name
cannot be namespaced goes down (D-104), which M6-BE-10's "a single system note names it" will read.
Deterministic order matters more than which tools win: a set that changes between two turns of one
conversation is a bot that can do something and then cannot.

**The per-turn read is the cache, never the network.** A turn must not wait on eight servers
answering `tools/list` before the model sees its first token; `McpTool` exists so it does not have
to, and `POST /mcp/servers/:id/refresh-tools` is what fills it. Only `CONNECTED` servers take part:
§6/M6 says a failed server "stays out of tool sets until reconnected", and offering an `ERROR`
server's cached tools would put names in the model's list that can only fail — and spend budget
doing it. What MOVES a server to `ERROR` is M6-BE-10's; this is the line that keeps one out.

**`/bots/:id/plugins` is served from `McpModule`, and the turn reaches it through a holder.** The
answer joins `McpServer`, `McpTool` and `BotMcpServer`, all owned by that module, which already
imports `BotsModule` for `ToolRegistry` (D-104) — Nest mounts a controller by its own path, not by
the module it is declared in, so the route is `/bots/:id/plugins` either way. The reverse arrow is
the cycle `TurnEventsModule` was extracted to break, so `AgentTurnService` asks `TurnPlugins`, a
neutral holder `BotsModule` exports and `McpTurnPluginsRegistrar` binds itself into at init — the
same shape `SkillToolsRegistrar` and `SendMessageRegistrar` already use for `ToolRegistry`. An
unbound holder answers "no plugin tools" rather than throwing, because a build without `McpModule`
is a legitimate build and a turn there should run with its built-ins.

**`GET /bots/:id/plugins` lists every installed server, not only the enabled ones.** §4.1 names the
route "enabled servers for this bot", and `BotPluginSchema` carries an `enabled` field — a listing
of only enabled servers would make that field constant, which is a field nobody needs. The question
the plugin modal asks is "which of my plugins does this bot use", and both halves of the answer have
to be in one list for it to be answerable without a second request.

## D-107 · The read-only ladder runs once, at list time, and the two ways of being wrong are not equal

**Status:** accepted · **Task:** M6-BE-08 · **Extends D-099, D-092**

§6/M6 gives the ladder and the default in one sentence: "`McpTool.readOnly` is set at list time from
the server's `readOnlyHint` annotation when present, falling back to a name pattern (`get_*`,
`list_*`, `search_*`, `read_*`, `fetch_*`). Anything unmatched is treated as writing."

**At list time, which is why the column exists.** The classification is a property of what the
server reported, and only the listing ever saw the annotation — a second classification anywhere
downstream could only be the weaker half of the ladder. So `isReadOnlyTool` runs in `cacheTools`,
`McpTool.readOnly` is the answer, and the per-turn binding carries the row's verdict onto the
descriptor rather than re-deriving anything. One place decides; everything else reads.

**The two ways of being wrong are not equal, and every choice below leans one way.** The answer
decides an approval default: a read runs, a write asks. Classifying a read as a write costs an
interruption the operator can undo in one click, and §6/M6 hands them the mechanism — "the user may
add per-bot rules either way using the existing M5 auto-review matcher". Classifying a WRITE as a
read spends money, sends mail or deletes something, and the operator finds out afterwards.

**So the patterns are exactly the five §6/M6 names, and a bare verb is not one of them.** A tool
called `search` — no underscore — is common, and matching it is tempting. It is the unsafe
direction: the relaxation that admits `search` admits `read`, and a server that calls a destructive
tool `reset` is one prefix family away from reading as safe. Widening a heuristic whose failure mode
is an unapproved write is not a judgement this file gets to make on the PRD's behalf. A server whose
naming does not fit costs one approval prompt and one rule. Case is folded, which is normalization
rather than widening: `Get_Issue` and `get_issue` are the same name written twice.

**`readOnlyHint: false` does not fall through to the pattern.** This is the distinction D-099 built
`boolean | undefined` to preserve, and it is load-bearing in exactly one direction: a server that
says `false` on a tool called `get_report` knows something the name does not — that generating the
report bills for it — and a heuristic that overrules it decides a tool writes nothing when its
author said otherwise. Absent falls through; `false` is an answer.

**`reach` is where the classification lands, and `contained` stops being literally true.** D-092
wrote the two values to answer "would a careful person want to be asked about this before it
happens", and `ToolInfoSchema.reach` publishes them to the operator with exactly that meaning —
`contained` does not ask, `sensitive` does. §6/M6 answers the question directly for MCP ("Every MCP
tool defaults to `ask`. Tools classified `readOnly` default to `allow`"), so a read is `contained`
and a write is `sensitive`. What does not carry over is the FIRST sentence of `contained`'s own
documentation: a read of the operator's mailbox touches nothing of the bot's own. A third value
would state that precisely and would cost a revision of a ratified two-value enum on the wire (§0
rule 2, D-005) to record a distinction nothing branches on. The comment now says which part carried
and which did not, because a doc that is quietly false about half its cases is worse than a name
that is imprecise about one.

## D-108 · MCP approval is the M5 matcher and nothing else, and the absence is the contract

**Status:** accepted · **Task:** M6-BE-09 · **Extends D-092, D-107**

§6/M6 ends its approval section with a sentence that is an instruction rather than an observation:
"Every MCP tool defaults to `ask`. Tools classified `readOnly` default to `allow`. The user may add
per-bot rules either way using the existing M5 auto-review matcher — **MCP tools need no separate
mechanism.**"

**So this task adds no production code, and that is the deliverable.** The pieces were already in
place and were built knowing this was coming: D-092 made the default fall through to the tool's own
`reach` rather than to a flat `ask`; D-107 put the read-only ladder's verdict on that field; D-105
made the descriptor reachable for a tool that is not registered, without which `decideAutoReview`
would have answered `deny` for every MCP call. `DEFAULT_AUTO_REVIEW_RULES` (D-064) deliberately has
no catch-all, which is what leaves the fallthrough reachable at all, and `matchesToolName` already
supports the `gmail__*` prefix form D-005 ratified — which is exactly the shape an operator needs
now that every tool from one server shares a namespace (D-104).

**Writing an MCP-specific approval path would have been the defect.** A second place that decides
whether a tool asks is a second place to forget a case, and the two would first disagree on the one
thing neither is tested for. The evidence that the shared path is the live one is therefore
behavioural rather than structural: `m6-mcp-turn.integration.test.ts` drives real turns against a
real MCP server over loopback, under `DEFAULT_AUTO_REVIEW_RULES`, and asserts that a
write-classified tool leaves the server untouched while a read-only one — same server, same bot,
same rules — reaches it. Flipping the `reach` mapping either way fails one side or the other, which
is what says the classification is what decides and not something else.

**A plugin turn wakes no computer, and that is asserted rather than assumed.** An MCP client lives
in the orchestrator (R10), so a turn whose only tool calls are plugin calls needs no desktop.
M5-BE-14 made every `ToolContext` accessor a thunk for exactly this; the suite runs with no sandbox
provider and no fake Chrome, and checks the bot still has no machine afterwards. Had the rule
quietly stopped holding, the suite would have needed a container to test a Gmail call — which is
the shape of the failure, not a detail of the fixture.

**One stub, shared.** `mcp-servers.integration.test.ts` and the turn suite both need a server that
speaks the real protocol, and they need different halves of it — the listing and the call. Two
copies of a protocol stub drift precisely where a test stops proving anything, so it moved to
`test/mcp-stub.ts`. What did NOT move is each suite's fetch policy: the install suite rewrites only
two hostnames onto the stub and passes everything else through, because one of its rows must stay
genuinely dead for the "did not answer" case to mean anything.

## D-109 · A plugin's failure is counted, bounded and said once — and none of it can fail the turn

**Status:** accepted · **Task:** M6-BE-10 · **Extends D-105, D-106**

§6/M6's failure isolation opens with the sentence everything below serves: "One broken plugin must
never fail a turn." Four rules follow — a 10 s list bound and a 30 s call bound (§7.4), a failing
server dropped from the tool set with "a single system note" naming it, three consecutive failures
moving a server to `ERROR` with an `mcp.status` frame, and a 401 buying one refresh (already
D-103's).

**The numbers live on the behavior descriptor, which is what M6-BE-12 built it for.**
`ToolFailurePolicy` gains a second variant, `isolate-remote`, carrying `callTimeoutMs` and
`strikeLimit`. Both variants isolate; what differs is what a failure MEANS. A built-in's failure is
this build's own — a bug, a full disk — and there is nothing to disable, because the tool will be
there next turn regardless. An MCP tool's failure is a third party's server, which is the only case
where "how long do we wait" and "how many times before we stop asking" are questions at all. The
switch over the union runs through `assertNever`, so a third variant is a compile error in the
registry, and a non-positive bound is refused at registration: a zero timeout and a zero strike
limit both READ as policy and are not — the first fails every call, the second disables a plugin on
its first blip. Policy that is silently off is worse than policy that is missing.

**Enforcement is where the socket is, and the number travels to it.** The binding publishes the
deadline on the descriptor and passes it with the call; `McpServersService` is the only party that
can close a connection that is not answering, so it runs the race. The abandoned promise is not
cancelled and cannot be — `McpConnection` takes no signal and the SDK owns the socket — so what is
bounded is how long the CALLER waits, which is the thing §7.4 is about and the only thing that
decides whether a turn stays answerable. The loser is silenced with a `catch`, because an abandoned
rejection reaching the process is a crash the operator cannot connect to anything.

**Strikes are memory; `ERROR` is the row.** The count of consecutive failures is not a fact about a
server — the outcome is, and `McpServer.status = ERROR` is persisted and survives a restart exactly
as §6/M6 requires. What a restart forgets is two strikes, which is the right direction to fail: the
orchestrator retries a server it might have disabled rather than keeping one disabled that a deploy
just fixed.

**A refresh still fails on the first failure, and that is not a contradiction.** `refreshTools`
marks a server `ERROR` immediately (D-100) and keeps doing so. The two rules are about different
events. A refresh is an operator asking "does this work?", and the honest answer to a server that
did not answer is "no", immediately, on the screen they are looking at. A tool call inside a turn is
nobody asking: one failure there is weather, and disabling a plugin over it costs a reconnect that
was not needed.

**Two things deliberately do NOT count as strikes.** A `CallToolResult` with `isError: true` is the
server working correctly and reporting a tool-level problem — folding it in would disable a healthy
plugin because the model kept asking for an issue that does not exist. And a refusal this side of
the wire (a `NEEDS_REAUTH`, a missing `CREDENTIAL_KEY`) is filtered by the same test `refreshTools`
uses: a `NEEDS_REAUTH` has already taken the server out of tool sets and named the one action that
fixes it, and counting it again would overwrite that sentence with a vaguer one two calls later.

**One system note per turn, however many servers, posted before the reply.** §6/M6 says "a single
system note names it", and the word is load-bearing: three unreachable plugins is one thing that
happened, not three, and a note per server turns a caveat into a wall the operator learns to scroll
past. The note names SERVERS rather than tools, because the thing a person can act on is the server
— they reconnect Linear, they do not reconnect `linear__create_issue` — and its reason is derived
from the STATUS rather than from `lastError`, which holds the server's own words: a transcript is
read by somebody who was not debugging anything, and "ECONNREFUSED 10.0.0.4:443" tells them nothing
they can do. Per-TOOL withholdings (a name this build cannot use, a budget already spent) stay in
the log, where the person who needs them is.

**And the note cannot fail the turn.** Same posture as `ChainNoticeService`: the drop has already
happened and is already correct, so taking the turn down over the sentence explaining it is the one
outcome worse than the operator not reading it — in a task whose first line is that a broken plugin
must never fail a turn.

## D-110 · The overflow goes behind three doors, and two of them exist so approval survives

**Status:** accepted · **Task:** M6-BE-11 · **Supersedes part of D-106**

D-106 implemented §7.4 as written — forty RESOLVED tool definitions per bot, built-ins included —
and said out loud that it leaves a cliff: this build registers enough built-ins that a thirty-tool
server does not fit beside them, so `PUT /bots/:id/plugins` refuses a configuration an operator had
every reason to want. It named M6-BE-11 as the relief, and the board note names the shape: "advertise
tool descriptions and materialize the full schema on demand instead of spending a slot per tool."

**So overflow is not dropped, not truncated, and not refused — it goes behind three definitions that
cost three slots however many tools are behind them.** `find_plugin_tools` answers with names and one
line each when asked for everything, and with full input schemas for what matches a query; that split
IS the board's sentence. `read_plugin_tool` and `use_plugin_tool` run one by name.

**Three doors and not one, because approval is decided per tool NAME.** A single `use_plugin_tool`
would be simpler and would quietly undo half of §6/M6's approval rule: one door has one classification
for everything behind it, so it is either `sensitive` — and "Tools classified `readOnly` default to
`allow`" is lost for exactly the tools unlucky enough to overflow — or `contained`, and every write in
the catalogue runs unasked. Two call doors keep both halves. The read door is `contained` and REFUSES
anything M6-BE-08's ladder did not classify as a read, naming the other door in the refusal; the write
door is `sensitive` and runs anything, so a read taken through it merely asks unnecessarily. The
enforced direction is the fail-safe one: the cheap door cannot open a write.

**The doors are `origin: builtin`, not `mcp`.** They are this build's own definitions and they reach
every server the bot has. An `mcp` origin carries a `serverId`, and there is no single server these
belong to — naming one would make M6-BE-10's strike state key off a server chosen at random.

**The direct share is the head of the listing, not a whole server.** A bot with one large plugin would
otherwise have all of it behind a search while slots sat unused, and a model reasons better about a
tool it can see. The order is the same one D-106 fixed — install order, then tool name — and stability
matters more than which tools win: a set that changes between two turns of one conversation is a bot
that can do something and then cannot. When overflow exists the direct share shrinks by the three the
doors need, because otherwise the last three direct tools would be bought by pushing the doors over
the ceiling, which is the ceiling not holding.

**And the cap now almost never refuses, which is the point rather than a regression.** The number
`PUT /bots/:id/plugins` checks is what a turn will actually resolve, so a thirty-tool server is
admitted and §7.4 still holds exactly: never more than forty definitions in a request. What still
fails is the state that is genuinely impossible — this build's own tools leaving fewer than three
slots — and it fails with a sentence that says so, because the operator cannot fix that by choosing
different plugins. §6/M6's "fails with a clear error naming the overage rather than silently
truncating" is satisfied in the way that matters: nothing is truncated, and the one remaining refusal
names what is wrong. M6-QA-03's 39/40/41 boundary moved with it, and is now measured where it is
enforced — on the tool set a turn is handed — rather than on a number the route happened to add up.

## D-111 · Ciphertext is token material, and reachability is answered twice

**Status:** accepted · **Task:** M6-QA-11, M6-QA-12 · **Extends D-102**

§7.3 and §6/M6 ask two different questions about a plugin credential, and the tests have to be
shaped differently for each. The first is about BYTES — "no API response anywhere in the app
contains access or refresh token material" — and is asserted against serialized bodies and frames
rather than DTO types, because a field added to a row and spread into a response is invisible to a
type-level check and that is the shape this defect actually takes. The second is about
REACHABILITY — "no MCP credential is reachable from inside a sandbox" — and a behavioural test
cannot answer it alone: proving one command did not see a token says nothing about the next one.

**A leak test that only looks for plaintext does not fire.** This was found by falsification rather
than by review: a mutation that spread the entire `McpCredential` row into `GET /bots/:id/plugins`
passed, because the columns hold AES-256-GCM output and carry no marker at all. §7.3 says token
MATERIAL, and ciphertext is material — it is the thing a key compromise turns into a token, and a
response that has a field for it is one careless change away from carrying the plaintext. So every
assertion here reads the stored ciphertext back out of the row and checks the body against that too;
the same gap existed in the `GET /mcp/servers` case M6-BE-02 shipped, and is closed with it.

**Reachability is answered structurally and behaviourally, and neither half would do alone.**
Structurally: exactly one file in the orchestrator imports `mcp-credentials.js`, and no file under
`sandbox/`, `agent/` or `skills/` mentions the seam or `CREDENTIAL_KEY` under any spelling. That is
the half that stays true for the NEXT command, and it fails the moment somebody threads a credential
toward a tool — where R10's lint rule cannot help, because the file is local rather than an import
from another package. Behaviourally: `seatEnv` is asserted as an ALLOWLIST — exactly `DISPLAY` and
`DBUS_SESSION_BUS_ADDRESS`, and nothing else — because "the token is not in here" is true of any
environment until somebody adds one, while "these two and nothing else" fails the moment anything is
threaded through. `createSession` is asserted to pass no environment at all, which is the single
edit that could carry a secret into a container.

**The `mcp.status` frame is the surface easiest to widen by accident.** It is the only one of the
three that carries free text — `lastError` — and what goes wrong is sometimes an authorization
server quoting the token back. The frame is therefore parsed against `McpStatusPayloadSchema` (so an
added field fails) and then checked, serialized, against both the plaintext and the ciphertext.

## D-112 · The plugin modal is a Settings pane, and the one new capability is fenced where it lives

**Status:** accepted · **Task:** M6-FE-01, M6-FE-02, M6-FE-03 · **Extends D-088**

§6/M6 asks Electron for "the plugin modal — search, category filters, install, connect, and an
installed-count summary", for an OAuth flow that "opens the system browser" and polls, and for
`NEEDS_REAUTH` surfaced "as an actionable state, not a raw error".

**It is a pane of the Settings modal rather than a modal of its own.** Installing a plugin is a
settings-shaped act, and a second top-level overlay is one more thing to open, position and close
for a list that belongs beside the models it works with. The pane also carries per-bot enablement
and uninstall, which no FE task names: `PUT /bots/:id/plugins` exists, and a plugin an operator can
install and connect but cannot give to a bot is a feature that does nothing. Installing is per USER
and enabling is per BOT, which argues for two screens — and it is the wrong split for the question
an operator actually has, which is "which plugins does this bot have?" One list answers it; two
screens mean the switch and the thing it is about are never visible together.

**⚠️ `shell.openExternal` is the widest capability in this app, and the URL reaching it is a third
party's.** It comes from an MCP server's own OAuth discovery document (D-101), by way of the
orchestrator. `shell.openExternal` hands a string to the operating system, which decides what to
run: `file:` opens a file manager, and a registered custom scheme can launch a program. So the
channel admits `https:` only, refuses credentials in the authority (`https://accounts.google.com@evil.test/`
is a phishing shape and no authorize URL has them), and the check lives in the MAIN process — a
renderer check is worth nothing, because a compromised renderer simply does not perform it.

**The admission function returns the URL rather than a boolean, and that is the security property
rather than a convenience.** A predicate leaves the caller opening the string it was GIVEN while
having checked the string as PARSED, and those differ: the URL parser trims whitespace, folds the
scheme's case, and rewrites `https:/\host`. Validating one value and handing over another is the
shape of every bypass this check exists to prevent, so what comes back is the normalized href.

**The channel goes through `guardedIpc` from the same call site as the other six (D-088).** An
unfenced door beside a fenced one is the one that ends up mattering, and this is the first new
channel since V1-11. An untrusted sender and a failed launch are deliberately indistinguishable to
the renderer: the second is something an operator can act on, and the first must not be tellable
from it by anything probing the channel.

**Polling reads the LIST route, because the per-id route does not exist.** §6/M6 says the desktop
"polls `GET /mcp/servers/:id` for status"; §4.1's table has no such route, and §0 rule 2 forbids
inventing one. The poll reads `GET /mcp/servers` and finds the row, which costs one array scan on a
request a person is already waiting through. It stops after five minutes: a browser trip can simply
not come back — the tab is closed, or the answer was no — and a pane that polls an abandoned flow
until the app closes spends a request every two seconds on a question nobody is waiting for.

**M6-FE-03 is a function, not a component.** A raw error is `lastError` rendered into a red box: the
server's own words, saying what failed rather than what to do, and indistinguishable from a bug in
this app. So every status carries an ACTION — the label of the button that fixes it — and
`lastError` is shown as detail UNDER the sentence rather than as the headline, because "the token
was rejected" is useful to whoever is debugging and useless to whoever has to press something.

**The screen is a separate component from the loader.** `renderToStaticMarkup` runs no effects, so
a component that fetches in `useEffect` renders its spinner and stops — a test of the CONTROLS,
which is exactly what M6-FE-03's property is about, could only ever assert the spinner. The
container owns the round trips; `PluginsPaneView` owns the screen, and the tests render that over
rows the real merge produced.

## D-113 · The tool budget is tokens over a two-door bridge, and there is no count left to refuse

**Status:** accepted · **Task:** follow-on to M6 (not on the board) · **Supersedes D-106 and D-110**

§7.4 reads "Resolved tool definitions per bot | ≤ 40, hard cap" and §6/M6 asks that exceeding it
"fails with a clear error naming the overage rather than silently truncating". D-106 implemented both
literally, built-ins included, and recorded the consequence honestly: a thirty-tool GitHub server is
refused beside this build's own tools. D-110 put the overflow behind three doors, which removed the
cliff for everything that did not fit and left the number doing very little — a bot with a 41st tool
got a search box; a bot with 39 got forty definitions and no way to search them. Both were right about
what §7.4 says. What was wrong is §7.4's premise.

**Because a count of definitions was never the thing §6/M6 is protecting.** §6/M6 says it in its own
sentence: "Six plugins at fifteen tools each is ninety tool definitions in every single request. That
degrades tool selection accuracy and burns input tokens on every step of every turn." What costs is
what the MODEL IS SENT, and two definitions can cost eighty tokens or eight hundred depending on their
schemas. A count is a proxy for that, and a bad one: it refuses the large-but-cheap server and admits
the small-and-expensive one. So the count is gone and what is bounded instead is the text.

**Every plugin tool now reaches a turn through the bridge, and the bridge is two definitions whatever
the catalogue holds.** `find_plugin_tools` carries the listing in its own description and answers a
query with the matched tools' input schemas; `use_plugin_tool` runs one by name. There is no direct
share and no overflow tier — one path for a bot with one plugin and for a bot with three thousand, so
there is no line at which the product behaves differently. This is Hermes Agent's tool-search, which
is public and which the operator pointed at; Hermes' own docstring states the invariant this keeps:
"ANY deferrable tool activates the bridge (the listing scales with budget, not activation)".

**The budget is `PLUGIN_LISTING_TOKEN_BUDGET` (4000), and it bounds the LISTING rather than the tool
set.** The listing degrades in FORM as a catalogue grows — `name (Plugin) — one line`, then names
alone, then per-plugin counts, then a cut with `…and N more plugin(s)` — so the prompt footprint stops
growing at the budget while reachability never depends on it. `find_plugin_tools` with a query
searches the whole catalogue, and a name the listing never mentioned still runs. A cut in the listing
is a cut in what is ADVERTISED, never in what works; §6/M6's rule that nothing is silently truncated
is kept in the stronger form, because nothing is truncated at all.

**`PUT /bots/:id/plugins` therefore has no size refusal left in it.** It keeps D-010's 404 for an
unknown or foreign server id and still writes nothing when it refuses, but a bot with three hundred
plugin tools is configured exactly as easily as one with three. §6/M6's acceptance criterion
"exceeding 40 tools on `PUT` fails with an error naming the count and the offending servers" is
satisfied by there being no overage to name — and where a refusal survived D-110 because the operator
could not fix it by choosing differently, that state is gone too.

**One call door and not two, because the call is unwrapped before anything decides.** D-110 needed two
call doors for one reason: approval is decided per tool NAME (D-092), one door has one classification,
so a single door is either `sensitive` — and "Tools classified `readOnly` default to `allow`" is lost
for everything behind it — or `contained`, and every write runs unasked. Hermes answers the same
problem better: the bridge call is unwrapped before the guardrails see it, and `_unwrap_tool_search_call`
is the function that does it. `RegisteredTool.unwrap` is that seam here, `ResolvedTools.projectCall`
is how it is reached, and `createTurnApprovalPolicy` takes the projection instead of `behaviorOf`, so
the rules, the classification, the approval memory (§6/M6's `turn-approved`) and the structured log
all speak about the plugin tool rather than the door. `readOnly` → `contained` → runs without asking
still holds for a plugin tool, and a name the catalogue does not have projects `behavior: undefined`,
which the matcher answers with `deny` — fail-closed, the same answer any unknown name gets. The door's
own descriptor stays `sensitive`, and it is now only a fail-safe for a call whose arguments cannot be
read.

**The transcript keeps the wrapper and the PROMPT does not.** `use_plugin_tool` is what the model
produced, so rewriting the parts would put a tool call into the history that the SDK never made. But
an operator asked "use_plugin_tool?" with a JSON blob has been told which door the call came through
rather than which tool is about to act on their account, so `pendingApprovalsIn` recovers the name and
the arguments from the payload alone — it runs while a turn is suspended, with no catalogue in hand —
and the same name is what `remember` records.

**What it costs, said out loud.** A plugin call is one round trip longer (find, then run); the model
gets no provider-native validation of a plugin tool's arguments before the call, because the schema
arrives in the search answer rather than in a definition the provider checks; and a bot that would
have been fine with six direct definitions now pays for a search. Those are Hermes' own stated
trade-offs and they are real here. What they buy is that there is no size at which the product stops
working and no cliff for an operator to fall off — and a build that wanted direct definitions for
small plugin sets would have to keep two surfaces, which is the situation that produced the cliff.

**The listing rides in the definition's DESCRIPTION, not in a tool call.** That is the half that saves
the round trip: Hermes measured models declaring a capability missing, or shelling out to a CLI, when
the bridge advertised nothing about what was behind it. `find_plugin_tools` with no query returns the
same listing, so the two can never describe a bot's plugins differently.

**The doors are `origin: builtin` for the same reason D-110 gives** — they are this build's own
definitions reaching every server the bot has, and an `mcp` origin carries a `serverId`, which would
make M6-BE-10's strike state key off a server chosen at random. The `failure` policy is
`isolate-remote`, because a call through the door is a call to a third party's server whichever tool
it names.

**The search ANSWER is budgeted too, and it is the expensive half.** Review caught this before the
merge: the listing was bounded and the answer was not, which made "what is bounded is tokens over the
advertisement" true of the cheaper side only. The listing rides in a tool description — prompt prefix,
identical across a conversation's turns, paid for once by a provider's prefix cache (D-094's reason for
keeping the prefix stable). A search answer is a tool RESULT: it lands in the message history behind
that prefix and is re-sent on every subsequent step of the turn, uncached, which is §6/M6's sentence
exactly — "burns input tokens on every step of every turn". Ten schemas at a kilobyte each recurs at a
higher cost than the whole advertisement. `MAX_MATCHES` did not bound it, because a count of schemas is
the same bad proxy for cost that a count of definitions was — the premise this entry rejects. So
`PLUGIN_LISTING_TOKEN_BUDGET` applies to both, and the same rule decides what gives: the form degrades,
the reachability never does.

⚠️ **Which is why the first match is admitted whatever it costs.** A tool whose schema alone exceeds
the budget must still be callable, and the schema is what makes it callable — a truncated JSON Schema
is not a smaller schema, it is an unparseable one. Refusing it would put a tool behind a search that
cannot answer for it, and "a name the listing omitted still runs" would stop being true. Matches after
the first are admitted while they fit, and the ones held back are reported as a count so the model
narrows its query instead of concluding they do not exist.

**The renderer unwraps the door as well, because a transcript is the other place a person reads a
call.** The paragraph above keeps the wrapper on the wire and unwraps it for the approval prompt, which
is right for both — but it left `ToolCallPart` rendering "Use plugin tool" for every plugin call a bot
ever makes, and the transcript is where an operator goes to see what a bot has been doing. So
`foldToolParts` shows the tool and the arguments the operator was asked to approve, recovered from the
same payload, and the wire shape is still untouched: this is a view translation, which is what that
module is for. The names and the payload schema moved to `@crewaid/shared` (`USE_PLUGIN_TOOL`,
`PluginBridgeCallSchema`) so both processes read one definition of what a bridge call is — a bridge
call became a wire shape the moment it reached a §4.2 part, and `packages/shared` is where a wire shape
lives.

## D-114 · A private MCP server can carry a bearer, and the model always could

**Status:** accepted · **Task:** CC-56 · **Extends D-085, D-111**

A private install set `authType: 'NONE'` unconditionally, and `mcp-servers.service.ts` said why in a
comment: "the body carries no credential … §4.1 has no route that would let an operator say
otherwise today, and inventing one here would be inventing the contract." That was the right call at
the time and it left a real hole. `authType: 'HEADER'` existed in the enum and threw
`ConflictException` in both the connect path and the call path — "this build has no route that
accepts one yet" — so a custom server behind an API key installed, failed its first listing with the
server's own 401 in `lastError`, and could never be fixed. Most MCP servers an operator would add by
URL are exactly that server.

**No migration, because the model got there first.** `McpCredential.accessToken` is already an
encrypted `@db.Text` column with `refreshToken`, `expiresAt` and `scopes` optional;
`McpAuthType.HEADER` already exists; and `McpServerTarget.headers` is already documented as "a
resolved bearer, today". Every piece was in place except the contract and the two branches that
refused. That is worth saying out loud, because it is the argument for keeping a column mutable and
an enum complete even while the code that would use them is deferred.

**The secret arrives two ways, and both are the same direction.** The private arm of
`InstallMcpServerBodySchema` gains an optional `bearerToken`, because one form in front of an
operator asks for the URL and the token together and one round trip is what that form should be — a
row created now and authorized in a second call is a row left in a state nobody asked for if the
second call never comes. `PUT /mcp/servers/:id/credential` replaces it afterwards, because a token
that can only be set at install is a server that has to be uninstalled and rebuilt when the token
rotates, which takes its per-bot enablement with it: every bot that used the plugin silently stops
having it over a routine key rotation. §0 rule 2 is satisfied by adoption rather than invention —
`PUT /providers/connections/:id/credential` is the same route for the same problem, write-only in
the same way.

**§7.3 is unchanged and now covers one more door.** A secret travelling IN is how a secret gets in
at all; what §7.3 forbids is one travelling out. The value is encrypted by `storeMcpCredential` —
still the only writer, still fenced by `m6-qa-11-12-credentials-stay-put` — before Prisma sees it,
and the route answers with the same `McpServerSummary` every other route answers with, which has no
credential field to fill. The new case asserts the absence of the submitted value, of D-111's
ciphertext, AND of what the column now holds; falsified by echoing `bearerToken` back in the
response, which fails it.

**A header credential has no ladder, and that is the whole difference.** The OAuth path answers a
401 by spending a refresh token and retrying once. There is no second thing to spend here, so
retrying would re-send the value that was just rejected and read a permanent failure as a transient
one — leaving a server `CONNECTED` and quietly broken. So a 401 is terminal: `refuseReauth` moves it
to `NEEDS_REAUTH`, and the operator pasting a new value IS the ladder. The test for this asserts the
credential row is byte-identical afterwards rather than counting requests, because one connection
attempt makes several HTTP requests below this code — a count would measure the transport.

**`connect` reads the credential before it dials.** A header server has nothing to authorize, so
connecting is listing, through the same `refreshTools` door `NONE` uses. But `credentialFor` runs
first: a server whose credential is missing or unreadable should say that, rather than dialling with
nothing and caching the server's 401 as though the token were wrong.

**Install writes the row, then the secret, and keeps neither alone.** `storeMcpCredential` needs the
server id, so it cannot run first; and a row left behind as `HEADER` with no credential is a server
the operator can neither connect nor tell apart from one whose token was rejected. A failed
credential write therefore deletes the row it was for, which leaves the operator where they
started — free to submit the same form again.

**`setCredential` does not dial.** The write says what the credential is; `connect` says whether it
works. Rolling them together would mean a rotation that fails to list leaves the operator unsure
which half went wrong, and a server whose token is right but whose host is briefly down would report
a bad token.

## D-115 · The plugin pane is a grid, and the tile is honest about having no icon

**Status:** accepted · **Task:** CC-57 · **Extends D-112, D-114**

M6-FE-01/02/03 shipped the pane as one flat column: every plugin at the same weight, the actions
inline at a different offset on each row, and the operator's own two servers somewhere inside eleven
catalogue entries. It also had no way to reach `POST /mcp/servers`' private variant at all — the API
had accepted `{name, url, transport}` since M6-BE-02 and nothing in the UI could send it.

**Installed and Available are two sections because they answer two questions.** "What do my bots
have, and is any of it broken?" is about a handful of rows and wants every one of them visible;
"what else could I add?" is browsing. One list answers the first by making a person scan the whole
catalogue for the two rows that are theirs. Order inside each half stays `mergePlugins`' order and
is deliberately not a sort by status — a grid that reorders itself when a server reconnects is a
grid an operator loses their place in, and the reconnect they were watching is exactly when it would
move.

**Two columns, and the width decided the card.** The pane body is about 660px — a 900px modal less
the 196px nav — which puts a card near 310px. That fits a tile, a name, one line of status and the
buttons, and does not fit a description, which is why a card shows its category rather than prose.
Below ~520px it collapses to one column, so a narrowed window degrades to the list this replaced
rather than to two unreadable ones.

**The tile is an initial, because `iconUrl` is null on purpose.** `mcp-directory.ts` refuses to
guess a favicon from the host — "an icon URL is a claim that an image renders at that address, and
this build has verified none; a broken icon in the modal is a small lie that costs a user's trust in
the rest of the card" — and that reasoning did not change because the layout did. So the tile is the
name's initial over a hue derived from the slug by FNV-1a: derived rather than assigned so it
survives a restart and a reorder, because a plugin whose colour changes between sessions has to be
read rather than recognised. `iconUrl` still renders when it is non-null, so the directory can gain
verified icons later without this screen changing.

**STDIO is absent because the contract has none.** `McpTransportSchema` is `['HTTP', 'SSE']` and v1
is remote-only (PRD §2.5). The references this screen follows show STDIO beside Streamable HTTP
because their builds run a local process; offering it here would be offering a transport nothing
implements, and greying it out would imply it is coming.

**A header server's `NEEDS_REAUTH` is a different state wearing one status.** D-114 made pasting a
token its ladder, so `statusView` branches on `authType`: an OAuth server gets "Reconnect", a header
server gets "Add token" and an inline field. Offering "Reconnect" to a header server would offer the
one action that cannot fix it — there is no sign-in to repeat.

**Three things the screenshot caught that the tests could not.** A `DISCONNECTED` server was
labelled "Installed", under a heading that already said Installed — one of a card's two lines spent
repeating its section; it says "Not connected" now. `Remove` rendered at full foreground weight
beside a `Connect` that did not, so on the row that most needed attention the destructive action
read as the suggested one. And the token field's hint stated its constraint backwards. None of these
is a behaviour a render test can assert, which is the argument for looking at the thing.

## D-116 · A bot is told which plugins it has, because it cannot see them any more

**Status:** accepted · **Task:** CC-59 · **Extends D-113**

Reported from the running app: Notion installed, `CONNECTED`, 45 tools cached, enabled for the bot —
and asked "do you have access to notion?", the bot answered *"I don't have MCP servers configured"*
and offered to browse to a publicly shared page instead. Asked again twice, it re-checked and
confirmed its own answer.

**The wiring was right.** Probed through the real `BotPluginsService` against the live rows:
`toolsForBot` returns `find_plugin_tools` and `use_plugin_tool`, zero refusals, zero unavailable, and
the search tool's description carries all forty-five names. The bot had the access it denied having.

**What it did not have was a sentence saying so.** `agent-instructions.ts` enumerates the built-ins
in prose — the computer tools, `send_message`, the workspace — so a model asked what it can reach
answers from there. The bot recited that list back exactly: "browser, shell, screen, files, memory,
team messaging". Nothing in the file has ever mentioned plugins, because until M6 there were none.

**D-113 made this worse rather than causing it, and that is the part worth recording.** Before the
bridge, a plugin's tools were in the tool list under their own names: `notion__search` was visible to
any model that glanced at its tools, and the question answered itself. The bridge traded that
visibility for a prompt footprint that does not grow with the catalogue — the right trade, and this
is the part of the bill that came due. The identity now lives in a tool DESCRIPTION behind two doors
named for what they do, and a fast model does not read descriptions to answer a question about
itself.

**So the block is built from live data, like the team block, and sits beside it.** `pluginInstructions`
names each connected plugin with its tool count, says that their tools are reached through
`find_plugin_tools` and `use_plugin_tool` rather than listed one by one, and — the sentence this
entry exists for — says that a question about whether it can reach one is answered by SEARCHING,
never from memory. A bot that declines to look is the failure that was reported; it did not call
anything and get an error, it answered without checking.

**Resolved, not merely enabled.** The list comes from `BotPluginTools.servers`, which
`toolsForBot` fills only for the servers that actually contributed this turn. A server the operator
switched on but which is not connected contributes nothing, and telling a bot it has one would be
telling it something false — the same distinction `unavailable` already draws for the system note.

**D-094 still holds.** The block is composed with the team block and well above the memory block,
which stays last. Both are live data that changes only when the operator changes something — a
roster, a toggle — so the prefix is byte-identical for the life of a conversation and the provider's
cache survives. A test asserts the ordering, and moving the block below the memory block fails it.

**Empty renders nothing.** A bot with no plugins is not taught about a mechanism it cannot use, which
is the rule `teamInstructions` already follows for a team of one.

## D-117 · The directory is twenty-four entries longer, and every URL was dialled

**Status:** accepted · **Task:** CC-60 · **Extends D-115**

The operator asked for thirty-three services. `mcp-directory.ts` already states the rule that
decides how many of them could be added: "Every entry below was called … A directory entry is a
claim about somebody else's server, and one that 404s makes the whole modal look broken."

**Twenty-four were dialled and answered.** Each was sent a JSON-RPC `initialize` over `POST` with
`accept: application/json, text/event-stream`. A **401 is a pass**, not a failure — the endpoint
exists and wants OAuth, which is what `authType: OAUTH2` describes — and the thing that separates a
real MCP server from a host that 401s everything is the `WWW-Authenticate: Bearer` header, which
most of them carry with `resource_metadata` pointing at `/.well-known/oauth-protected-resource`.
That is the MCP auth spec's own discovery, and it was the evidence used. Shopify is the one `NONE`:
it completed `initialize` unauthenticated and named itself `shopify-mcp-server`.

**Nine were refused, and naming them is the point.** Gmail, Google Calendar, Google Drive and
OneDrive have no vendor-hosted MCP host that answers; 1Password and Clay 404 or do not resolve;
Mobbin does not resolve; AWS Core exists only as awslabs' stdio servers, and v1 is remote-only (PRD
§2.5); Atlassian Forge is covered by the Atlassian entry rather than a separate endpoint. Writing a
plausible `https://mcp.<vendor>.com/mcp` for any of them would have produced a directory that looks
complete and breaks on click.

**The marks are bundled and keyed on the slug, not named by the server.** The obvious design is an
`iconFile` on `McpDirectoryEntry`; it is wrong twice. Vite fingerprints or inlines these imports, so
a bare filename cannot become a URL at runtime without leaving the bundle behind in `public/`. And
it would put the desktop's file layout into a wire contract `packages/shared` owns — renaming a file
in the renderer would make the ORCHESTRATOR wrong, over a field no other client could read. The slug
is already on the wire, already unique per user, already the tool namespace (D-104); keyed on it, a
missing file is a build error rather than a broken image.

**Masked rather than drawn.** simple-icons ships monochrome glyphs, so an `<img>` renders them
black — beside the initial tiles, which are a white letter on a coloured ground, that is two visual
languages in one grid. `mask-image` paints the glyph white on the brand's own colour, and keeps
somebody else's SVG out of the DOM, where an inlined one would execute script. The files were
checked for `script`, event handlers and external references before being committed.

⚠️ **The `url()` must be quoted, and this is the bug worth remembering.** Vite inlines these files as
`data:image/svg+xml,…` because they are under the 4 KB limit, and the payload carries single quotes
from the source SVG's `role='img'`. An unquoted CSS `url()` cannot contain those, so the declaration
failed to parse and every branded tile rendered as a **blank white square**. Every markup assertion
still passed — the attribute was present and correct-looking. It was found by screenshotting the
pane, which is the second time in two tasks that looking at the thing caught what the tests could
not.

**The tile palette replaced a computed hue, for the same reason.** `hsl(hash % 360, 52%, 42%)` reads
as obviously fine and does not spread: of the twelve curated plugins with no mark, EIGHT landed
between 82° and 145°, so the fallback tiles were a row of near-identical greens. Twelve chosen
colours, indexed by the same hash, keep what the hue gave (stable per slug, no state, no assignment
to maintain) and drop only the illusion of uniqueness that 360 hues never delivered for twelve
items. Repeats are still possible and are accepted: assigning by position in the directory would
guarantee neighbours differ, at the cost of a plugin changing colour whenever the list reorders —
which is the property `tileOf` exists to protect.

## D-118 · Google's plugins sign in on the operator's own client — the one sign-in already uses

**Status:** accepted · **Task:** CC-62 · **Extends D-117, M6-BE-03**

Google hosts official MCP servers for Gmail, Calendar and Drive (`<product>mcp.googleapis.com/mcp/v1`);
D-117 missed them because its probe tried `mcp.gmail.com`. They were still not addable as-is,
because they break the chain M6-BE-03 is built on at both ends. They serve no RFC 9728 metadata and
never challenge — `initialize` and `tools/list` both succeed without a credential, only a
`tools/call` needs one — so there is nothing to discover the authorization server from. And that
server, `accounts.google.com`, has no `registration_endpoint`, so there is no client to register.
`mcp-oauth.ts` refused exactly this case by name ("advertises no registration_endpoint").

**The curated entry names what discovery would have found.** An optional `oauth` block carries the
issuer, the scopes (verbatim from Google's MCP configuration guide, not a guess at least privilege),
the extra authorize parameters, and the environment variables that hold the client.
`discoverConfiguredAuthorizationServer` then skips the metadata walk and nothing else: the issuer's
own document is still fetched through the guarded fetch, and `readEndpoints` still refuses one that
speaks for another issuer or does not accept S256. A configured issuer skips DISCOVERY, not
VERIFICATION. The block is server-side only — `toDirectoryEntry` copies fields one by one — so none
of it reaches the wire.

**The client is the one Better Auth already signs people in with.** `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` exist for the sign-in provider, and one Google Cloud OAuth client can serve
both: the operator adds a second redirect URI and enables three APIs. That removed a per-server
client form, a new table, and a client secret in the database — the secret stays in the environment,
is read at use, and travels only in the body of a token request. It is never stored and never sent to
a browser (a test asserts both).

**Its tokens are deliberately NOT reused.** Using the grant from signing in was the tempting design,
and it is wrong three times. The Google account someone signs in with is not necessarily the mailbox
a bot should read. Sign-in would have to request Gmail's restricted scopes from everyone, including
people who never install the plugin. And those tokens live in Better Auth's `account` table, outside
`mcp-credentials.ts` — which `m6-qa-11-12` enforces as the only reader of a token. So connecting Gmail
is still its own consent screen and its own stored grant; it borrows the app registration, nothing
more.

⚠️ **The secret goes only to the curated entry, and only with its own client id.** Two conditions in
`clientSecretFor`, each falsified. `isPrivate` must be false: a private install is named by its
operator, so one called "Gmail" gets the slug `gmail`, and if the slug alone chose the configuration,
a server at any URL could have Google's secret sent to a token endpoint of its choosing. And the
grant's recorded `clientId` must equal the configured one, so a rotated client never sends the new
secret beside the old id. Removing either check fails its test.

**Two Google specifics are parameters, not code.** `access_type=offline` because Google issues no
refresh token without it; `prompt=consent` because it only re-issues one on a fresh consent. Without
both, a connection would stop working an hour after it was made. `prompt` also carries
`select_account`, so Google shows its account picker rather than connecting whichever account the
browser happens to be signed into. They ride in `authorizeParams`, and
`buildAuthorizeUrl` adds them without overwriting — an entry naming `state` or `code_challenge` would
be replacing the values that make a code safe to pass through a browser.

**What the operator should know, and where it is said.** Connect refuses before dialling anything
when the pair is blank, and the refusal names both variables, the exact redirect URI and the API to
enable. `.env.example` carries the rest, including the constraint no code can fix: an External
consent screen left in Testing gets refresh tokens that expire in seven days (Google's own wording),
so these plugins need reconnecting weekly until the app is published. Google's MCP servers also
require enrolment in the Workspace Developer Preview for now.

**Not verified end to end, and said so.** The suite reproduces Google's shape on loopback — OIDC
metadata with no registration endpoint, a token endpoint that refuses a request without the secret —
and refuses to dial any real host. It cannot prove Google accepts RFC 8707's `resource` parameter
alongside its own; the MCP spec requires it and Google's guide targets clients that send it, so it is
sent. The first real connect is the check.

---

## D-119 · A routine is a BullMQ job scheduler keyed by its id, and a firing is the operator asking again

**Status:** accepted · **Task:** M8-BE-01 · **Touches:** no §3 or §4 change; one new config key

**One job scheduler per routine, with `Routine.id` as its scheduler id.** BullMQ 6's job scheduler
is the current form of §6/M8's "repeatable job": a hash holding the pattern and zone, an entry in the
queue's `repeat` set, and one delayed job for the next slot whose id is derived from the scheduler id
and the slot. Keying it on the routine is what makes §6/M8's restart criterion a property of Redis
rather than of this process. Writing an unchanged schedule again names the same next job, so it
cannot fire twice. And a firing that falls due while the orchestrator is down stays a delayed job
until a worker returns, so there is no gap. The queue is named `routine.run`, after `skill.compile`
and `bot.message`. §6/M8 does not name it.

**The schedule is parsed by the same `cron-parser` BullMQ uses**, now a direct, exact-pinned
dependency (5.10.0, the version BullMQ 6.3.4 pins). A validator or an expansion built on another
library would answer a different question from the one Redis is asked, and the place they would
disagree is the DST edge §6/M8 makes an acceptance criterion. Two checks come before the parser.
The cron must have exactly five fields, because `cron-parser` reads a six-field expression as
seconds-first and `* * * * * *` would start a turn every second. The zone must be known to `Intl`,
because `cron-parser` accepts an unknown zone and fails only on the first `next()`, with a message
that names neither the field nor the value.

**A prompt routine posts its prompt as an ordinary USER message and runs an ordinary turn.** It goes
through the same two calls `MessagesController.send` makes, plus the `message.created` frame the HTTP
response would otherwise have carried. So approvals, limits, memory and waking the computer on demand
all apply unchanged, and there is no second turn implementation. Nothing on the row says a schedule
sent it. That is M8-BE-08's provenance, and D-078 already deferred routine demotion until that signal
exists. A skill routine runs through `SkillRunService.runToCompletion`, a new awaited sibling of
`start` that shares its gate. It runs by the scheduled skill's id, never by name, so a newer version
does not silently replace the one the operator chose.

**A firing's job lasts as long as its work.** Both paths are awaited, so `lastStatus` is an outcome
rather than "accepted", and M8-BE-04's overlap check has a real span to test. A turn that deferred
behind another records `PENDING`. A turn parked on an approval records `RUNNING`. A firing that
throws is not retried, because a retry is the same slot minutes late and would post the prompt
twice. The next slot is the retry.

**`ROUTINE_WORKER` (default `true`) decides two things together:** whether this process consumes
firings, and whether it reconciles Redis against the enabled rows on boot. Its reasons are those of
`SKILL_COMPILE_WORKER` and `BOT_MESSAGE_WORKER` (D-044). The integration suites share one Redis, and a
reconcile in each booted context would schedule every other suite's routines. `vitest.config.mts`
sets it `false`, and it is in `turbo.json`'s `globalEnv` (D-017).

**The boot reconciliation is not what makes a restart survivable. It only repairs drift.** It
upserts an enabled row that Redis lacks or holds with a different pattern or zone, and removes a
scheduler with no enabled row. It leaves a matching schedule untouched: an upsert is harmless to the
next firing, but it is not obviously harmless to an overdue one, which is the firing a restart exists
to deliver. A firing whose row is gone or disabled removes its own scheduler as well. When a delete
never reached Redis, that firing is the one place left that can clean it up.

**Without `REDIS_URL`, `schedule` refuses and `unschedule` succeeds.** A routine saved on an install
that cannot run it would silently never fire. A routine must still stay deletable there.

---

## D-120 · `/routines`: a list is a bare array, run-now is 202, and the row and the schedule move together

**Status:** accepted · **Task:** M8-BE-02 · **Touches:** §4.1 (adds `ListRoutinesResponseSchema`, exports `UpdateRoutineBody`)

§4.1 names the five routes and the body schemas, but not what the list or run-now answer with.

**`GET /routines` is `Routine[]`**, a bare array like `ListBotsResponseSchema`. It has no `botId` filter,
because §4.1 names none. The right rail filters on the client, and a user's routine count is small. It
lists every routine on every bot the caller owns. M8-BE-08's bot-created routines are meant to be visible
in the same place, and they will be.

**`POST /routines/:id/run-now` answers `202` with the routine as it stands.** The firing goes on the
same `routine.run` queue as a scheduled one (a one-off job, no `jobId`), so it gets the same worker, the
same concurrency and the same overlap suppression, and the request is not held open for a whole turn.
Its outcome arrives in `lastStatus`. **A disabled routine is refused with `409`.** Disabling means
"this should not happen", the runner honours that for every firing, and a bypass would need the runner
to tell the two kinds of firing apart.

**The row and the schedule change together, or neither does.** No transaction spans Postgres and Redis,
so each write is ordered to make its failure harmless:
- **Create** writes the row, then schedules it, and deletes the row if the scheduler refuses. "Saved"
  always means "will fire".
- **Update** writes the row, then schedules or unschedules it according to `enabled`, and restores the
  previous values if the scheduler refuses.
- **Delete** unschedules first, then removes the row.

A process dying between the two steps is the drift D-119's boot reconciliation repairs.

**Status codes.** A scheduler refusal because Redis is absent is a typed `RoutineQueueUnavailableError`
and answers `503`. A bad cron or zone answers `400` with `parseRoutineSchedule`'s sentence. The shared
schema still takes both as plain strings, because a zone's existence is a question for this runtime's
`Intl` data.

**Reach.** A routine may name this bot's own skill or a global one, the same reach as `run_skill`.
Another bot's skill answers `404`. Approval is not checked at save time: a DRAFT skill's firing fails
with a readable `FAILED`. §3's "exactly one of prompt or skillId" is checked on the row an update
would produce, so switching a routine to a skill must clear its prompt in the same request.

---

## D-121 · An overlapping firing is measured against BullMQ's active set, and the older firing wins

**Status:** accepted · **Task:** M8-BE-04, M8-QA-04 · **Touches:** nothing in §3 or §4

§6/M8 says a firing that arrives while the previous run is still active is "skipped and logged, not
queued". Two decisions were needed: what "still active" means, and what happens when two firings arrive
at the same moment.

**"Still active" means another job for the same routine is in the queue's active set,** not
`Routine.lastStatus === 'RUNNING'`. The row is written by the process doing the work, and a process
killed mid-turn never writes the ending. A check on the row would then skip every later firing of that
routine forever, which is worse than an overlap. An active job is held by a worker's lock. When the
worker dies, BullMQ's stall check takes the job out of the active set, so the signal repairs itself.
A firing's job lasts exactly as long as its work (D-119), so another active firing of the routine means
the previous run is still going.

**When two firings are active at once, the older one runs.** This happens with a run-now pressed just
as the schedule comes due, or with two workers. If each deferred to any other firing it could see, both
would skip and the slot would run zero times. So exactly one yields: the newer, ordered by enqueue time
and then by job id, which gives the same answer from both sides.

**A skip completes the job, and does not fail it.** It logs `routine.run.skipped` with
`reason: 'overlap'` and the id of the job holding the routine. It leaves the row alone, because
`lastStatus` belongs to the run that is actually happening. Nothing is queued in the skipped firing's
place.

**Known limit.** A prompt routine whose turn defers behind a turn the operator started (M5-BE-16)
returns `PENDING` straight away. Its job finishes before the deferred turn runs, so a firing in that
window is not seen as an overlap. The next firing's turn then defers too, one turn at a time per bot,
so the work still never runs concurrently. It just is not reported as a skip.

---

## D-122 · DST and restarts are verified against the scheduler in Redis; a long outage is coalesced, not replayed

**Status:** accepted · **Task:** M8-BE-06, M8-QA-01, M8-QA-02, M8-QA-03 · **Touches:** nothing in §3 or §4

**DST behaviour, verified with `America/New_York` as §6/M8 requires:**
- `*/5` keeps exactly five real minutes between firings through both boundaries. That is 276 firings
  on the 23-hour spring-forward day, with no 02:xx, and 300 on the 25-hour fall-back day, where the
  01:xx hour runs twice.
- A fixed time keeps its wall-clock hour: 09:00 is 09:00 EDT, then 09:00 EST.
- A time that does not exist fires once, an hour later: 02:30 on spring-forward day fires at 03:30.
- A time that happens twice fires once, at its first occurrence: 01:30 on fall-back day.

**Why these claims are about the real scheduler.** QA-01 checks that `nextFirings` equals a chain of
BullMQ's own `defaultRepeatStrategy`, the function the scheduler runs, over 400 firings for seven
patterns. QA-02 and BE-06 then check DST in Redis itself, with a real job scheduler and worker. Only
`Date` is faked: BullMQ computes firings and due-ness from the client's clock and passes it into its
Lua scripts. Timers stay real. A blocked worker only re-checks for due jobs up to ten seconds later,
so the harness (`test/m8-scheduler-harness.ts`) also writes the queue's wake-up marker after each clock
step. Firings are identified by the slot in their job id (`repeat:<routine>:<ms>`), so "exactly N"
means N distinct, expected slots. Writing `tz: 'UTC'` instead of the routine's zone fails the suite.

**Restarts.** A restart between two firings loses and duplicates nothing. A slot that falls due while
the process is down runs once, late, when a worker returns, and the next slot runs on time. The boot
reconciliation leaves a live schedule's pending job untouched.

**An outage spanning several slots is coalesced.** The one overdue firing runs, and the schedule
continues from the current time. For example, down from 13:06 to 13:22 on a `*/5` routine gives 13:10
(late), then 13:25. The skipped slots are not replayed, because a burst of stale "check the inbox"
turns on reconnect helps nobody and costs a model call each. §6/M8's criterion is about a restart
between two firings, and that case has no gap. QA-03 pins this coalescing behaviour so it is a
deliberate choice rather than an accident.

---

## D-123 · A prompt routine wakes its computer before it posts, through ensure-ready, as a managed job

**Status:** accepted · **Task:** M8-BE-03 · **Touches:** nothing in §3 or §4

§6/M8: "A routine whose bot's sandbox is stopped starts (or resumes) the sandbox first, then runs."

**Through the shared path, and only that path.** A prompt routine wraps its whole run in
`SandboxReadinessService.withComputer(userId, botId, 'managed-job', …)`. That is M3-BE-11's
ensure-ready, and `SandboxService.start` behind it owns storage, capacity admission, per-computer start
serialisation, resume-or-create and bridge readiness. `'managed-job'` is the owner §17 already names
for background work with no row of its own at the moment it wakes. There is no routine-specific start
implementation. A skill routine needed no change: `SkillRunService` already runs every skill inside
`withComputer(…, 'skill', …)`.

**Wake before post is what makes a full host harmless.** The lease is claimed and the computer started
before the USER message exists. When the host is at capacity, `start`'s `503 SANDBOX_CAPACITY` throws
before anything is written. The firing records `FAILED`, and by D-119 it is not retried, so the next
slot is the retry. No prompt is left in the transcript to be answered twice, and there is no duplicate
execution. A retry inside the firing was rejected: capacity is freed by idle stop over minutes, so a
retry within one firing would hold a worker slot for the whole wait.

**The lease is held for the whole turn and released on every path.** While it is held, the idle sweep
cannot stop the computer under the work. `withComputer` releases it on success, failure or a thrown
refusal. Release records final activity, so §8's idle period starts when the work ends.

**No client is involved.** The worker runs inside the orchestrator, and `message.created` is only a
notification to whoever happens to be subscribed. The suites run every firing with no socket open,
which is the desktop app being closed.

---

## D-124 · The attachment reaper's trigger moves to BullMQ; what a pass does does not

**Status:** accepted · **Task:** M8-BE-07 · **Extends:** D-019, D-031 · **Touches:** nothing in §3 or §4; no new configuration key

D-019 always intended the unclaimed-upload reaper to be "a small BullMQ job", deferred to M8 because
that is where the scheduler landed. M2 shipped the cleanup itself on an in-process `setInterval`, so
retention did not wait for M8 (D-031).

**Only the trigger moves.** A pass is still `AttachmentReaperService.sweep`, unchanged. It locks each
candidate row, re-checks the expiry fence, unlinks the file, then deletes the row in the same
transaction. Every ownership and retention guarantee D-031 made therefore still holds, and M2's race
suites still pass over the same code. The new suite shows that a pass arriving through the queue deletes
expired unclaimed uploads from disk and database and leaves young and claimed ones untouched.

**With `REDIS_URL`, the cadence is a job scheduler on its own `artifact.reap` queue,** with `every` set
to `ARTIFACT_REAP_INTERVAL_MS`:
- **One pass per interval for the whole deployment**, instead of one per process.
- **It survives a restart.** A timer restarts its interval at boot, so a process that restarted more
  often than hourly never swept at all.

Every process writes the scheduler at boot, and re-writing an unchanged `every` keeps the same single
pending pass. An `every` scheduler queues its first pass at once, which does the job
`ARTIFACT_REAP_ON_BOOT` does per process, but once for the whole deployment.

**`0` still disables reaping,** and on the queue it now removes the scheduler and drains the queue.
Removing a scheduler takes its delayed pass but not one already waiting, and a disabled reaper must not
run "one more". The queue holds nothing but reap passes, so draining it is safe. The worker is
registered only when the interval is non-zero. That keeps it out of the integration suites (whose config
sets `0`) without a `*_WORKER` key.

**Without Redis, M2's timer stays exactly as it was.** Retention must not depend on a queue being
configured. The reaper takes an optional `ARTIFACT_REAP_ON_QUEUE` flag and keeps no timer when it is set.

---

## D-125 · A bot schedules its own follow-ups; `Routine.origin` says who made each one, and a bot may hold five

**Status:** accepted · **Task:** M8-BE-08 · **Touches:** §3 (`Routine.origin`, enum `RoutineOrigin`), §4.1 (`RoutineSchema.origin`)

M5-BE-19 continues a turn that stopped at a limit. This is the other half of unattended work: a bot
parking something for later on purpose ("check tomorrow at 9 whether the invoice was paid"). The board
names three requirements: record who created each routine, cap how many a bot may hold, and keep
bot-created routines visible and deletable beside the operator's.

**Provenance is a column: `Routine.origin RoutineOrigin @default(OPERATOR)`,** with `OPERATOR | BOT`.
An enum rather than a nullable `createdByBotId`, because the question the panel and the ceiling ask is
"which kind", and a v1 bot only ever schedules on itself. The column is set once and nothing updates
it. It is not in `CreateRoutineBodySchema` and cannot be: the REST route is the operator's, so it
always writes `OPERATOR`, and an `origin` in the body is stripped. Only the bot's own tool writes `BOT`.
The migration defaults every existing row to `OPERATOR`, which is true of all of them.

**Two tools, with deliberately different approval.**
- **`schedule_routine`** (`name`, `cron`, optional `timezone`, `prompt`) is **sensitive**, so the
  shipped rules **ask**. It commits the operator to unattended model calls on a clock, which is exactly
  "would a careful person want to be asked before this happens".
- **`cancel_routine`** (`routine`, an id or an exact name) is **contained**, so it is **allowed**. It
  sees only this bot's `BOT` routines, so the worst it can do is undo the bot's own earlier act. An
  operator routine's exact id is "not yours" rather than found.

The renderer phrases the approval as "Can I schedule "X" to run on my own (cron)?", with the prompt
as the detail.

**The ceiling is `MAX_BOT_ROUTINES = 5` per bot, and it counts only `BOT` routines.** The operator's
routines neither count toward it nor are limited by it. Five leaves room for a handful of real
follow-ups and is small enough that only a runaway hits it. The refusal is a sentence telling the
model to cancel one first. It is a constant rather than a config key, because nothing has asked to
tune it.

**The scheduling result carries the time.** A model does not know the current time, and putting it in
the prompt would break the cached prefix every turn (D-094). So the tool's answer states the current
time and the next three firings, in the routine's own zone. A bot that wrote a cron firing tonight
instead of tomorrow reads that in the result and can fix it in the same turn. The description tells
it that routines repeat, and to pin the day and month for a one-off and cancel it afterwards. §3 has
no one-shot routine, and adding one was not needed to meet the requirement.

**What a bot routine posts is labelled.** An operator routine posts its prompt verbatim (D-119). A
`BOT` routine posts `Scheduled follow-up you set for yourself ("<name>"): <prompt>`. The row is a
USER message, and without the label the transcript would claim the operator asked. D-078's routine
demotion is still deferred: this is provenance on the routine and in the message text, not a flag on
the message or the turn.

---

## D-126 · The routine panel polls for outcomes, and a new routine is read on the operator's clock

**Status:** accepted · **Task:** M8-FE-01 · **Touches:** nothing in §3 or §4

The right rail's placeholder is now the routine panel: create, edit, enable/disable, run-now and
last-run status for the selected bot. It lists what the bot scheduled for itself beside the operator's
own, with a "Set by bot" chip on those (D-125). It uses the `/routines` routes through
`renderer/api/routines.ts`, and parses every answer with the shared schema.

**It polls, because nothing announces an outcome.** A firing's result lands in `lastStatus` long after
run-now's `202`, and a scheduled firing has no request at all. §4.2 has no routine event, and adding
one would be a contract change for a panel that one small `GET /routines` serves. The panel re-reads
every 3 s while a routine is running or queued, or for 15 s after a run-now, and every 30 s otherwise.
Every write re-reads the list rather than patching it locally, because the server decides whether a
cron is valid or a disabled routine is unscheduled.

**A new routine's timezone defaults to the operator's own zone** (`Intl`), not §3's column default. A
person typing "09:00 on weekdays" means their own 09:00. The field stays editable, and the server still
validates the zone.

**Edits send only what changed.** A skill routine's form has no prompt field, and its PATCH never
carries one, so §3's exactly-one-of rule can't be tripped by re-sending the whole row. Run-now is
disabled on a disabled routine, because the server would answer `409` (D-120). The schedule is shown
in words only for the cron shapes the panel recognises exactly (every N minutes, hourly, daily,
weekdays, weekends, a weekday, a day of the month, a date). Anything else is shown as written, because
a wrong sentence about when something runs is worse than an unfamiliar one.

---

## D-127 · A routine may end after a calendar day in its own timezone

**Status:** accepted · **Touches:** §3 `Routine`, §4.1 routine bodies and responses

`Routine.endsOn` is a nullable `YYYY-MM-DD` date. It is inclusive in the routine's timezone: a
routine ending on September 22 may fire through that local day and never on September 23. A null
value means it continues until disabled or deleted. The date is passed to BullMQ as the last instant
of that local day. The runner checks the row again before doing work, so an overdue job delivered
after the end date cannot post a prompt or run a skill. Boot reconciliation removes expired schedules,
and `run-now` refuses a routine that has ended. Existing routines migrate with a null end date.

---

## D-128 · The routine form uses repeat choices and a searchable timezone list

**Status:** accepted · **Touches:** routine panel presentation

> **Superseded in part by [D-129] — 2026-09-22.** The inline sentence row, the native selects and
> date input, and the end-date switch are replaced; the refusal to approximate an interval stays.

The form offers hourly, daily, weekday, weekly and monthly repeats in one inline schedule row,
with multiple day selection for weekly repeats, plus a custom repeat dialog. A HeroUI switch
enables an end date beside its date picker.
It converts those choices to the existing five-field schedule before sending the API request, so
operators never need to enter cron. An unfamiliar schedule already saved on a routine is preserved
until the operator chooses a replacement. Custom intervals are offered only where a five-field
schedule can represent them exactly; the form does not silently approximate every N days or weeks.
The timezone picker lists the runtime's supported IANA zones and UTC, with search and a virtualized
list. An end date may be chosen for any repeat and is sent as the inclusive `endsOn` date (D-127).

---

## D-129 · The routine form follows the Add-schedule and Custom Repeat design

**Status:** accepted · **Touches:** routine panel presentation, §4.1 routine bodies (amends D-127)

The operator's design is an "Add schedule" menu (every hour, day, weekday, week, month, or
Custom…) and a Custom Repeat dialog with a frequency stepper, a unit, and "Never ends / Ends" on a
date. The form now uses that, built from the app's own components rather than native controls.
The repeat menu and the few details each repeat needs (the days, the time, the day of the month)
sit on one row that wraps in the narrow rail. Each connecting word ("on", "at") wraps together with
its control.

- **A menu, not a select.** A `<select>` fires no change for the option it already shows, so a
  custom schedule could not be reopened. Choosing "Custom…" now always opens the dialog, and a
  custom schedule shows an Edit action beside its description.
- **A new routine starts with no schedule.** It opens on "Add schedule" instead of a weekday repeat
  the operator did not choose, and Save asks for one.
- **Every schedule the form writes reads back as a choice.** Every-minute and every-12-months used
  to reopen as an unreadable "Current schedule". The tests now pin the round trip for every preset
  and every custom interval.
- **The stepper only stops on intervals cron can space evenly** (D-128's rule, now enforced by
  the control rather than by an error). Minutes go 1 to 30 through divisors of 60, hours through
  divisors of 24, and months through divisors of 12. Days and weeks stay at 1, and weeks pick
  their days. Every 7 minutes would fire at :56 and :00, four minutes apart, so it is never offered.
- **"Ends" is in both places.** In the form it is a switch, with a date picker once it is on,
  because an end date applies to every repeat, not only a custom one. In the dialog it is the
  design's "Never ends / Ends" radios. Both edit the same `endsOn`. The dialog edits a copy, so
  Cancel changes nothing.
- **An ended routine says so.** The list reads "Ended <date>" and run-now is disabled, because the
  server refuses it (D-127). The routine can still be edited without first moving its end date.
- **Timezones are listed readably with their current GMT offset**, and can be searched by city or
  offset.

The API now refuses an end date that has already passed (`400`). Before this, the routine was
stored and enabled, but the scheduler dropped it at once, so it read as live and never ran. The
refusal applies only to a date being set in that request. An existing routine whose date has
passed can still be renamed or cleared.

---

## D-130 · The pnpm scope is `@crewaid/*`

**Status:** accepted · **Touches:** every package name, every `--filter`, every import of a
workspace package (amends D-095)

> **Amended 2026-11-26.** The product is no longer called Grog, so this file's earlier entries now
> use the Crewaid names. D-095 and this entry keep `grog` where they describe the rename itself.
> `docs/reviews/` and the `tasks.json` notes are unchanged.

D-095 kept `@grog/*` as a codename. The operator has now confirmed Crewaid as the name for the
machine-facing half too, so CC-54 renames it, one slice at a time. This first slice is the
package scope, plus the root package (`crewaid`).

- **The scope goes first because it is the only slice nothing outside the repo stores.** No
  database row, storage key, container label or volume holds a package name. A stale checkout
  fails loudly at `pnpm install` or at import, never silently at runtime.
- **The repo name (`grog-bot`) and the task ids stay**, for D-095's reason: renaming them means
  rewriting every commit prefix and board cross-reference, and no user would see the difference.
- **Historical records keep the old name.** `docs/reviews/` and the notes in `tasks.json` quote
  commands and output as they were run, and this file's earlier entries say what was true when
  they were written. Rewriting them would make the evidence say something that never happened.
  Read `@grog/x` there as `@crewaid/x`.
- **No install holds data worth keeping**, the operator confirmed on 2026-09-23. Every
  database, credential bag and workspace so far is test data. So the slices that carry state
  rename without the migrations D-095 asked for. An operator who upgrades signs in again, and
  existing sandboxes are recreated. That is why this slice also deletes `adoptLegacyUserData`,
  which moved a pre-CC-53 `@grog/desktop` user-data directory into place. Nothing needs moving.
- **Slice 2** renames what Docker and the host see: the image (`crewaid/sandbox`), the labels
  (`crewaid.*`), workspace volumes and containers (`crewaid-workspace-`, `crewaid-sandbox-`),
  the provider id, the compose containers and network, the systemd units, the iptables chain
  prefix, the in-image paths (`/opt/crewaid`) and the workspace marker files. The compose
  database defaults become `crewaid`. An existing compose volume keeps the user it was created
  with, so either keep `POSTGRES_USER`/`DB` in your own `.env` or recreate the volume. Old
  `grog-workspace-*` volumes and `grog/sandbox` images are orphaned. `pnpm db:clean` no longer
  matches them, so remove them by hand.
- **Slice 3** renames every `GROG_*` environment variable to `CREWAID_*`, including
  `CREWAID_CREDENTIAL_KEYRING` and `CREWAID_CREDENTIAL_KEY_ACTIVE`. The orchestrator reads only the
  new names, so an existing `.env` needs its keys renamed. The key values themselves stay, so
  stored credentials still decrypt.
- **Slice 4** renames the renderer's theme. The token sheet is `themes/crewaid.css` and the
  `data-theme` value is `crewaid`. The `grog-*` CSS classes, keyframes and custom properties are
  `crewaid-*`. The pane-layout storage key is `crewaid.pane-layout.v1`, so a saved layout resets
  to the default once.
- **Slice 5** renames every remaining code identifier: `CrewaidWsAdapter` (in
  `ws/crewaid-ws.adapter.ts`) and its `crewaid.ws.*` events, the `window.crewaid` bridge and the
  `crewaid:*` IPC channels, the `crewaid://` sign-in scheme with its `crewaid-desktop` client id
  and `crewaid-auth` cookie prefix, the `X-Crewaid-Mcp-Connect` header, the MCP client name
  (`crewaid`), the `crewaid/*` lint rule namespace, the `__crewaidCapture*` page globals, the seeded
  `usr_crewaid_singleton_v1` user, and the test and temp names. An upgraded app registers the new
  scheme on first launch, and everyone signs in again. **Migrations are not edited.** Two
  already-applied SQL statements still write `Grog Developer` and `@grog.invalid`, because a
  migration's checksum is what `migrate deploy` verifies.
- **Slice 6** is the prose. The product name in comments, UI copy (including the renderer's
  page title), the seed user's name, `.env.example` and the live docs is Crewaid. The PRD's
  product name is `Crewaid`. CC-54 is done. Three kinds of `grog` remain, all on purpose: the
  repository name (`grog-bot`, including checkout paths in CI and TEAM.md), historical records
  (`docs/reviews/`, earlier entries here, the `tasks.json` notes), and the two applied
  migrations.

---

## D-131 · Bots can be grouped, and a group shares instructions and a folder

**Status:** accepted · **Touches:** `BotGroup`, `Bot.groupId`, `Conversation.lastReadAt`,
`/groups`, `POST /bots/:id/read`, the prompt's group block, the sidebar (closes UI-SPEC open
decision 2, which PRD-WORK §2 left open)

The operator asked for sidebar groups like the reference app's "Sales team", with shared context
for the bots in a group, and for unread counts on the headers.

- **Projects group work, groups group bots.** A M10 project (PRD-WORK §9.3) holds tasks and
  goals. A group holds bots. They do not replace each other, and a bot's group says nothing about
  which project its tasks belong to.
- **A group shares two things: instructions and a folder.** The instructions are text the user
  writes, read into every member's prompt. The folder is `/home/bot/groups/<groupId>/` on the
  machine. The file tools let a member into its own group's folder and refuse another group's,
  for the same reason they refuse another bot's area: a confused model, not a determined one
  (WORKSPACE §22). Memory is **not** shared per group. That would be a new memory scope across
  the memory service, its tools and its budget, and nobody asked for it yet.
- **A group is not a role.** The prompt block says in so many words that a group makes nobody the
  lead and changes nothing about who a bot may message. The user prompts behaviour; the app
  records it. Nothing is triggered, escalated or restricted by being in a group.
- **The group block sits after the team block and before the plugins**, inside the prefix a
  provider caches, with the memory block still last (D-094). It changes only when the user edits
  the group or moves a bot, which is the same class of change as editing the roster.
- **Deleting a group deletes no bot and no file.** `Bot.groupId` is `ON DELETE SET NULL`, so the
  members move to Unassigned. The folder stays on the machine: the files are the bots' work.
- **Unread is BOT messages newer than `Conversation.lastReadAt`.** The user's own messages are
  read as they are written. `GET /bots` carries each bot's `unreadCount`, counted in two queries
  whatever the number of bots. `POST /bots/:id/read` marks read, or with `{unread: true}` moves
  the mark to just before the newest bot message, which is what "Mark as unread" means. The
  migration sets every existing conversation's mark to the time it ran, so history written before
  unread tracking existed does not arrive as unread. The renderer raises the count live from
  `message.completed` for any bot not on screen, or `message.created` for a teammate's settled
  message. It marks a bot read when opened and when a message lands while it is open.
- **The sidebar stays flat until a group has a bot.** Group headers appear only for groups with a
  visible member, and "Unassigned" appears only when some group does. A header shows an unread
  chip, a "Needs you" chip when a member is waiting for approval, and its bot count while it is
  collapsed. Its menu opens on right-click, like a bot's: edit (name and instructions), move up,
  move down, delete. Collapsing is stored on the group (`collapsed`) so it survives a relaunch. A
  search opens every group.
- **The two new response fields default.** `groupId` defaults to null and `unreadCount` to 0 in
  the shared schema, because the desktop app and the orchestrator ship separately: a new app
  against an older orchestrator gets a flat, all-read sidebar rather than a CONTRACT failure on
  every bot list. The app treats a failed `GET /groups` the same way.

---

## D-132 · Work is an optional record, and the app never acts on it

**Status:** accepted · **Task:** M10-AR-01 · **Ratifies:** PRD-WORK §0.1, §9.1, §9.6, §9.8

M10 adds projects, tasks, goals, deliverables and search (`docs/PRD-WORK.md`). They are a place to
keep track of work that the user and their bots read and write. They are not a workflow engine.

- **The app acts on nothing by itself.** It never creates, starts, closes, reopens or escalates a
  task, and never sends a bot anything because a task, goal, project or deliverable changed. The
  `*.changed` frames go to the client only. The one scheduled act is the one the user asked for: a
  recurring task puts its next occurrence on the board (D-137), and that starts no turn.
- **Anyone can set any status.** The user on the board, or any of the user's bots through
  `task_update`, on any of the user's tasks. There is no review step, no required note and no rule
  about which bot may change which task. The app records who set each status and when.
- **No roles.** No lead, manager or reviewer bot. A "PM" is a bot the user prompts that way, and it
  tells other bots what to do with `send_message`, which already exists.
- **Not using it changes nothing.** No text is added to `instructions`, no rail section or badge
  appears for a user with no tasks, and the transcript is unchanged.
- **M10 is worked before M9.** `MILESTONE_ORDER` already places it there (D-089/D-090); the ids
  keep their numbers.

## D-133 · Work's data model

**Status:** accepted · **Task:** M10-AR-01 · **Ratifies:** PRD-WORK §4, §3.1–§3.6, §9.3, §9.4,
§9.7 · **Touches:** §3 (`Project`, `Goal`, `Task`, `TaskSeries`, `TaskEvent`, `Deliverable`, their
enums, `Message.taskId`, `Message.routineId`, `Routine.goalId`)

PRD-WORK §4's models are contractual as written, and PRD §3 now carries them. Three points the
sketch leaves to the implementer are settled here:

- **Grouping is optional at every level.** A goal may have no project (§9.7), a task may have
  neither (it is in *Inbox*). A subtask shares its parent's project and goal; a task on a goal that
  belongs to a project is in that project. The service enforces both in one `$transaction`, and
  every referenced project, goal, parent, assignee and series must belong to the caller, or the
  request answers 404.
- **A Work project is not D-073's reserved memory project scope** (§9.3). In code it is `Project`
  and `projectId`; the memory scope, when it lands, must be named apart.
- **Deleting a bot deletes what it produced** (§9.4): `Deliverable.botId` cascades, alongside the
  conversation and attachments D-019/D-020 already remove. Tasks and series assigned to it stay,
  unassigned (`SetNull`), and each open task gets an `UNASSIGNED` event naming the bot, written
  before the row goes so the name survives. `TaskEvent.actorLabel` keeps the bot's name for history.

`Task.rank` is a lexicographic string. The ranking function lives in `packages/shared`, so the
board and the service place a card with the same code, and a drag is one row write.

## D-134 · Work's REST and WebSocket contracts

**Status:** accepted · **Task:** M10-AR-01 · **Ratifies:** PRD-WORK §5 · **Touches:** §4.1, §4.2

The routes and frames in PRD-WORK §5 are contractual and PRD §4 now lists them. Shapes the PRD left
open:

- **Lists are bare arrays** (as D-120 made `/routines`), except `GET /deliverables`, which is
  cursor-paginated `{items, nextCursor}`, and `GET /search`, which is grouped by type.
- **Refusals carry a `code`** beside Nest's `statusCode` and `message`, as `ARTIFACT_CAPACITY`
  does: `PROJECT_NOT_EMPTY`, `TASK_UNASSIGNED`, `TASK_NOT_STARTABLE`, `START_KEY_REUSED`.
- **The four frames are `task.changed`, `project.changed`, `goal.changed` and
  `deliverable.changed`**, each `{<kind>Id, deleted?: true}` and carrying no `botId`. They are
  invalidations, not state: the client refetches what they name, and refetches every open Work
  view after a reconnect. Emitting one follows `TurnEventBus`'s rule (safeParse, log, drop), so a
  frame that cannot be built never fails the write that caused it.
- **Every by-id route declares `@OwnedResource`** with the kinds `project`, `goal`, `task`,
  `taskSeries` and `deliverable`.
- `GET /bots/:id/messages` gains `around=<messageId>` for jump-to-message; `POST`/`PATCH
  /routines` accept `goalId`.
- **`GET /tasks` takes `doneSince`**, an instant before which DONE tasks are left out, so the
  board's 14-day Done column (D-140) is bounded on the server rather than by downloading every
  task ever finished. Absent `status`, the list is every status but CANCELLED.
- **Shared defaults for the new response columns.** `Message.taskId`, `Message.routineId` and
  `Routine.goalId` default to null in the shared schema, as D-131's fields do, so a newer app
  reading an older orchestrator gets "no task" rather than a CONTRACT failure.

## D-135 · Start is one idempotent, recoverable brief

**Status:** accepted · **Task:** M10-AR-01 · **Ratifies:** PRD-WORK §3.3

`POST /tasks/:id/start` requires an `Idempotency-Key` UUID. A key already recorded for the task
returns its `messageId` whatever the task's status now is; the same key on another task is
`409 START_KEY_REUSED`. A new key refuses an unassigned task (`409 TASK_UNASSIGNED`) and a task
not in `TODO` (`409 TASK_NOT_STARTABLE`).

One owner-scoped transaction claims the `TODO` row conditionally, writes the USER brief with
`Message.taskId`, sets `IN_PROGRESS` and writes the `STARTED` event with the key
(`@@unique([userId, startKey])`). After commit the ordinary turn-start path dispatches the brief.
A brief left undispatched by a crash is recovered by `messageId`: recovery checks
`AgentTurn.triggerMessageId` and leaves an active or settled turn alone, so a retry never makes a
second message or turn.

Assigning is not starting, and dragging a card to *In progress* changes only its status. The brief
is a message, never instructions: `agent-instructions.ts` does not change (D-094).

## D-136 · A deliverable is filed once, by provenance, in the attachment's own transaction

**Status:** accepted · **Task:** M10-AR-01 · **Ratifies:** PRD-WORK §3.5, §8, §9.4

Every bot `attach_file` records a `FILE` deliverable. The claim of the `Attachment` for the reply
and the `Deliverable` insert commit in one transaction; if either fails, neither does, the tool
reports a failure and the unclaimed reservation is cleaned up (the reaper is the fallback). User
uploads are inputs, not deliverables.

Filing, first match wins: (1) an explicit, owner-checked `taskId`/`goalId` on the tool call, which
must agree when both are given; (2) the turn's trigger message's `taskId`; (3) the trigger message's
`routineId` → that routine's `goalId`; (4) none, which the views call *Unfiled*. Filing under a task
derives its goal and project; under a goal, its project. Moving a task or goal updates the derived
columns in the same transaction. `sourcePath` records where in the workspace the file came from.

The routine runner now writes `Message.routineId` on the message it posts. The bot-delete
confirmation states how many deliverables go with the bot and offers the shipped *Hide from sidebar*
instead.

## D-137 · A recurring task is a series on the routine scheduler

**Status:** accepted · **Task:** M10-AR-01 · **Ratifies:** PRD-WORK §3.6, §9.7

A `TaskSeries` holds a title, brief, assignee, project, goal and schedule (`cron`, `timezone`,
`endsOn`, validated exactly as a routine's). It is scheduled by the M8 machinery: one BullMQ job
scheduler per series keyed by its id, reconciled at boot, verified across DST and restarts, a long
outage coalesced into one firing (D-119, D-122, D-127). A firing's identity is its scheduled
instant: `@@unique([seriesId, occursAt])` absorbs a retried job, and two firings on one local date
make two tasks. `occursOn` is that instant's local date, for display and date-range queries.

An occurrence is an ordinary task in *To do*. It starts nothing, even when assigned to a bot.
Missed ones stay as they are. Editing a series changes future occurrences only; stopping or deleting
it keeps every occurrence already created. A goal counts a series by done rate (done ÷ occurrences
so far), not in its progress, which is done ÷ (all − cancelled) over its one-off top-level tasks,
derived by one function in `packages/shared` that the service and the renderer both call.

## D-138 · Task tools are contained, and `send_message` carries task context

**Status:** accepted · **Task:** M10-AR-01 · **Ratifies:** PRD-WORK §6, §9.2, §9.5

The tools are `task_list`, `task_read`, `task_create`, `task_update` and `project_create`, all
classified `contained` (D-092), so the shipped rules run them without asking. They read and write
the calling bot's owner's rows and no one else's. Their descriptions follow PRD-WORK §6.1 (the
user's tasks; do not create tasks to organise your own work; suggest a split, create only when the
user agrees; a short note on a status change helps) and together stay within 500 estimated tokens.

`send_message` gains `taskId?: string | null`. Omitted, the delivered message inherits the sender's
trigger message's task; `null` clears it; an ID must be the owner's task or the call is refused. The
recipient's `Message.taskId` is set before its turn starts. `attach_file` gains optional `taskId`
and `goalId` (D-136).

**`send_message` is already contained.** D-092 classified it, so bots message each other without an
approval prompt; `CLAUDE.md`'s note that it falls through to D-064's default `ask` predated D-092
and is corrected. Approval stays where D-092 put it.

**Two shapes differ from PRD-WORK §6 to fit the budget**, measured by `m10-work-tools.test.ts`
over name, description and JSON schema at four characters a token (the plugin budget's estimate):
`repeat` is one string, `<5-field cron> <IANA zone> [until YYYY-MM-DD]`, not an object, because
the nested schema cost more than the rest of `task_update`; and `task_update` has no
`blockedReason`, because a `note` given with a move to `BLOCKED` is recorded as the reason as well
as the note; and `project_create` takes no description, which the user adds on the board.
The REST bodies keep every one of these fields.

**The notepad and the task list are worded apart.** `board_read/add/update` (D-068) describe
`BOARD.md` as "your team's working notes, not the user's task list"; the task tools say "the user's
tasks".

## D-139 · Search is one box over the user's whole record

**Status:** accepted · **Task:** M10-AR-01 · **Ratifies:** PRD-WORK §7.6, §4 (FTS indexes)

`GET /search?q=&types=&botId=&projectId=&limit=` searches tasks, goals, projects, deliverables and
every one of the user's transcripts, with hand-written expression FTS indexes on `Task(title,
brief)`, `Goal(title, outcome)` and `Deliverable(title, summary, searchText)` asserted from
`pg_indexes` (D-073), and `ts_headline` excerpts of at most two fragments (D-077). Hits are grouped
by type and ranked within each group. D-077's own-transcript boundary is a bot's; the user who owns
every bot searches all of them. A message hit opens its transcript through `?around=`.

## D-140 · Work sits at the foot of the sidebar, where the Plugins placeholder was

**Status:** accepted · **Task:** M10-AR-01 · **Amends:** PRD-WORK §7.1 · **Answers:** PRD-WORK §11.1

The sidebar's bottom row was a *Plugins* button that did nothing: plugins moved into Settings
(D-112). The operator asked for Work to take that place.

- **Three quiet rows above the account row: Tasks, Goals, Deliverables.** Selecting one swaps the
  centre pane to that view; selecting a bot returns it to the transcript. The bot list keeps the
  top of the sidebar, because chat stays the way work happens (D-132).
- **Tasks shows a badge only for cards in *Review* or *Blocked*.** With no tasks nothing is badged,
  so a user who never uses Work sees three plain rows and nothing else.
- **Projects are the Work views' scope, not a sidebar section.** Each view's header has a project
  picker (*All projects*, each active project, *Inbox*, *New project…*, *Manage projects*), which is
  what PRD-WORK's `PROJECTS` list did, without a second list competing with the bots for height.
- **⌘K** focuses the sidebar search, which keeps filtering bots and offers *Search everything*
  (D-139).
- **Done shows the last 14 days** with *Show all* below it, as PRD-WORK proposed.

## D-141 · Work's P1 extras ship without a new tool definition; `deliver_link` waits for room

**Status:** accepted · **Task:** M10-BE-09 · **Ratifies:** PRD-WORK §2.2, §5 (`POST /deliverables`)

The Work tool definitions measure exactly 500 of PRD-WORK §8's 500 estimated tokens (D-138).
`deliver_link` and a `goalId` on `schedule_routine` would both add to what every bot is sent on every
step, and the budget is a P0 rule while they are P1, so **both move to Carry-over (M10-CO-01)** until
a trim frees the room. The other extras need no tool text, and ship:

- **`POST /deliverables`** takes PRD-WORK §5's `{kind: 'LINK', url, title}` or `{kind: 'MESSAGE',
  messageId, title}`, each with optional `summary`, `taskId` and `goalId`. Named ids are
  owner-checked and filed by D-136 rule 1. Otherwise a saved message is filed where its work came
  from: a bot reply by its turn's trigger message, any other message by itself (rules 2 and 3), so
  saving a report is filed where attaching it in the same turn would have been. A saved bot reply
  is attributed to that bot; a link or the user's own message to nobody. A message may be saved
  more than once, and a foreign message is a 404 like any foreign id.
- **Text extraction** fills `Deliverable.searchText` with the head of a `.md`, `.markdown`, `.txt`,
  `.csv` or `.json` file a bot attaches, at most 64,000 characters, and with a saved message's
  content. It feeds D-139's index only; no response carries it.
- **Cost** is `usage: {turns, inputTokens, outputTokens}` on `GET /tasks/:id` and `GET /goals/:id`,
  defaulting to zeros in the shared schema as D-134's new fields do. A task's usage is the turns
  started by messages about it or its subtasks; a goal's, the turns started by messages about any
  of its tasks or by its routines' runs. A turn that is about nothing counts nowhere; the list
  routes do not carry usage, so a board never pays for an aggregate per card.
- **"Create task from message" is a client action**: the new-task dialog opens with the message
  quoted as the brief and posts `POST /tasks`. No column links a task back to the message; the
  brief carries the words, and search finds both.

## D-142 · `GET /deliverables` takes `q`, and each Work view searches itself

**Status:** accepted · **Task:** M10-FE-11 · **Extends:** D-134 · **Beside:** D-139

Each Work view has its own search, beside its filter menu, for finding one thing in the list the
user is already looking at. That differs from D-139's one box over everything, which jumps
elsewhere.

- **Tasks and Goals search in the renderer**, over what the view has loaded: a task by its
  name and brief, a goal by its name and outcome. Every word must appear, in any case. The
  views hold the whole list, so matching as you type costs no request. While a task search is
  on, the board drops the 14-day Done window (D-140), because an old finished task is exactly
  what someone searches for.
- **Deliverables search on the server.** The list is paged, so a renderer-side search would miss
  every page not yet loaded. `GET /deliverables` therefore takes an optional `q` (1–200
  characters, trimmed) that matches the title or the summary, any case, and composes with every
  other filter and with the cursor. It is additive: an older client never sends it, and an older
  server ignores it.
- `q` deliberately does not read `searchText` (D-141). A file's contents are D-139's to search,
  where a hit shows the excerpt that explains why it matched. A view row matching on words it
  never shows would read as a false hit.

## D-143 · A Start brief ends by naming its task and asking for a report back

**Status:** accepted · **Task:** M10-BE-10 · **Amends:** PRD-WORK §3.3 · **Keeps:** D-094, D-132

A bot started from a task did the work, replied, and left the task In progress. The user had to
ask whether it was done before the bot found the task and closed it. The brief was only the title,
the context line and the user's text, so nothing told the bot the message was a tracked task, or
which one.

- **The brief closes with one line** after the body: `Task id: <id>. When you finish, use
  task_update to move it to Review, or to Done if there is nothing for the user to check, with a
  one-line note. If you cannot finish, move it to Blocked and say what you need.` The text lives
  in `packages/shared` (`startBriefClosing`), because the orchestrator writes it and the renderer
  reads it.
- **It is part of the message, never of the instructions.** D-094's cached prefix stays
  byte-identical, and a bot that is never started from a task is sent nothing new.
- **The app still acts on nothing by itself (D-132).** The status changes only because the bot
  chose to call `task_update`. A turn that ends is not a task that is finished, so nothing moves
  a card on its own.
- **Review is the suggested default**, because it is the column the user is badged for, and a
  finished piece of work usually wants a look before it is Done.
- **The chat card leaves the line out.** It is addressed to the bot, and `parseBrief` drops a
  closing paragraph that starts with `START_BRIEF_CLOSING_PREFIX`.

## D-144 · Each bot has an approval mode: Ask for approval, Approve for me, or Full access

**Status:** accepted · **Task:** CC-68 · **Extends:** D-092, D-065 · **Touches:** §3 (`Bot.approvalMode`),
§4.1 (`POST`/`PATCH /bots`)

Sometimes an operator knows the work they are about to ask for is safe, or accepts the risk, and
wants the bot to stop asking. Other times they want to see every change before it happens. D-092's
rules and reach draw one line for everyone. This lets the operator move that line per bot, from an
icon in the composer, the way coding agents offer the same three choices.

- **`Bot.approvalMode`: `ASK` | `AUTO` | `FULL`, default `AUTO`.** `AUTO` is D-092 unchanged, so
  every existing bot keeps the behaviour it had. The shared schema defaults it too, so a newer app
  reading an older orchestrator shows Approve for me.
- **`FULL`** allows every call with no question. **`ASK`** asks before every call that changes
  something. **`AUTO`** runs a call that stays on the bot's own computer and workspace, and asks
  about a sensitive one.
- **A `deny` rule holds in every mode, and so does refusing an unregistered tool.** A deny is a
  prohibition the operator wrote, not a question they asked to skip, and Full access is about the
  questions. An unreadable rules column still asks for everything in every mode, because it is an
  error, not a policy.
- **`ASK` never asks about a look.** Asking before every read would bury the questions that matter,
  as D-092 found. So `ToolBehavior` gains a required `effect: 'observes' | 'acts'`. The shared
  `CONTAINED_BUILTIN`/`SENSITIVE_BUILTIN` descriptors say `acts`, and `OBSERVING_BUILTIN` is used
  by the tools that only read: `fs_read`, `browser_read`, `screenshot`, `capture_screen`,
  `board_read`, `memory_read`, `memory_search`, `task_list`, `task_read`, and plugin search. An MCP
  tool its server marks read-only `observes`. A reader left labelled `acts` only asks too often,
  which is the safe direction. `validateBehavior` switches over the field, so a third value cannot
  be registered before the matcher gives it a meaning.
- **In `ASK` and `FULL` the mode sits over the rules**, except for a deny: an `allow` rule does
  not outvote Ask for approval, and an `ask` rule does not stop Full access. The decision's source
  is `{kind: 'mode'}`, so the log says why.
- **A turn reads the mode when it starts**, as it reads the rules (D-005). A change applies from
  the next message, and the menu says so. An approval already waiting stays waiting until it is
  answered.
- **Stored on the bot, not in the app**, because approvals are decided on the orchestrator for
  every turn the bot runs, including a routine's run or a turn another bot started while nobody
  is watching. A duplicated bot keeps its source's mode.

---

## D-145 · Chrome keeps its own sandbox: a seccomp profile, not a capability

**Status:** accepted · **Task:** CC-71 · **Supersedes:** D-027's conclusion · **Touches:** §5.1

D-027 turned Chrome's sandbox off because the zygote died under §5.1's `cap_drop: ALL`, and read
that as the namespace sandbox needing `CAP_SYS_ADMIN`. Measured on the Dokploy host (Ubuntu 24.04,
kernel 6.8, Docker 28.5), the capability was never the obstacle. The kernel lets an unprivileged
process create a user namespace. Docker's default seccomp profile is what refuses it: it allows
`clone` with namespace flags and `unshare` only to a container holding `CAP_SYS_ADMIN`, and
`chroot` only to one holding `CAP_SYS_CHROOT`. With seccomp relaxed, the same image and the same
`cap_drop: ALL` and `no-new-privileges` start Chrome without `--no-sandbox`. Docker's default
AppArmor profile was measured too and allows it.

It mattered because a renderer escape under `--no-sandbox` lands as the `bot` user with every
bot's files and browser profiles on that computer, where a sandboxed renderer has its own user,
PID and network namespaces, an empty root and Chrome's own seccomp filter.

- **Sandbox containers run under `BROWSER_SANDBOX_SECCOMP`**: Docker 28.5.0's default profile,
  vendored verbatim, with its two masked `clone` rules replaced by one unconditional allow of
  `chroot`, `clone` and `unshare`. Nothing else changes. `setns`, `mount`, `bpf` and every other
  capability-gated call stay gated, which the unit tests assert rule by rule.
- **No capability is granted and `no-new-privileges` stays.** D-027's rule, not to relax §5.1 for
  the sandbox, still holds. The kernel still checks each call: `chroot` needs `CAP_SYS_CHROOT`
  in the caller's user namespace, which a process has only inside one it just created.
- **The trade:** code in the container can now create user namespaces, which reaches kernel
  code that `cap_drop: ALL` alone kept out of reach, and user namespaces have been a steady
  source of kernel privilege escalations. That surface is shared with every unprivileged process
  on a stock Ubuntu host. It is weighed against a renderer escape needing no kernel bug at all.
- **The bridge asks instead of assuming.** `seats.browser_sandbox()` runs `unshare --user
  --map-root-user chroot / true` once per container. The image and the orchestrator deploy
  separately, and an older orchestrator still starts containers under Docker's default, where a
  sandboxed Chrome dies before its first window. There the browser starts with `--no-sandbox` as
  before, the log says why, and `/health`'s browser check reports `sandbox: false`. It is reported,
  not a failure, because that browser still works.
- **Following a newer Engine** means replacing `docker-default-seccomp.ts` wholesale with the new
  default. The change is applied in `seccomp-profile.ts`, so it stays three names long.

## D-147 · Clearing a chat or deleting a message keeps memory unless asked; `/new` bounds the history

**Status:** accepted · **Task:** CC-72 · **Touches:** §3 (`Message`, `Deliverable`), §4.1, §4.2

A bot had one conversation that never ended, and nothing in it could be removed. Each turn is seeded
with the newest 40 messages up to 24,000 characters (`AGENT_HISTORY_MESSAGES`, `AGENT_HISTORY_CHARS`),
so for a bot talked to rarely an unrelated subject from months ago still rode along in every prompt.

- **Three routes.** `DELETE /bots/:id/messages` clears the conversation,
  `DELETE /bots/:id/messages/:messageId` deletes one message, and both answer
  `{deletedCount, forgottenCount}`. `POST /bots/:id/topics` is `/new`. They are refused `409` while a
  turn is `RUNNING`, because the runner holds the trigger and the draft it streams into.
- **Memory is kept unless the operator ticks "Also forget".** `Memory.messageId` was already SetNull
  ("deleting a transcript must not delete what was learned from it"), so keeping is the default the
  schema chose. The confirmation puts the other answer in front of the operator every time, unticked.
  With `forget=true`, the memories linked to the deleted messages are marked FORGOTTEN and tombstoned
  in the delete's own transaction. `remember` links a memory to the reply it was written during, so a
  USER message's lessons are the ones on the replies of the turns it triggered, and those are
  included. A memory with no message link is never touched by a deletion.
- **Deliverables are kept.** `Deliverable.messageId` changes from Cascade to SetNull. A file a
  deliverable holds is detached from its message rather than deleted with it, and **an attachment is
  now claimed when it has a message OR a deliverable**: the reaper, the download TTL fence,
  `DELETE /attachments/:id` and both message claims treat a deliverable-held file as claimed.
  `DeliverableView.attachment.messageId` becomes nullable on the wire for exactly this case. Every
  other attachment on a deleted message goes with it, the row now and the bytes after the commit.
  Deleting a bot also deletes the files its deliverables held.
- **`/new` is a boundary, not a deletion.** It writes a SYSTEM row with `Message.startsTopic`, starts
  no turn and makes no model call. The history seed reads only messages after the newest boundary, in
  the same `(createdAt, id)` order it pages in. The transcript still shows everything, and
  `memory_search` still reaches it. The boundary draws as a divider whose Undo deletes it, which puts
  the earlier context back. Consecutive `/new` return the existing boundary instead of stacking one.
- **`message.deleted {botId, messageIds, cleared?: true}`** tells every window. A clear lists no ids:
  the flag already says "everything", and a long conversation's ids would make one frame as large as
  its history. It is a new event type rather than a shape change, so `WIRE_VERSION` stays at 1.

## D-148 · Launch pricing and distribution, as the landing site states them

**Status:** accepted · **Task:** CC-73 · **Touches:** `apps/web` · **Supersedes, for these three
plans only:** COMMERCIAL-ROADMAP §M9's "price and included hours remain unvalidated" as a bar on
advertising them

The landing site needs a price to show, and the owner has set one. It is recorded here because a
number on a pricing page is a promise several people will be held to, and the roadmap it overrides
said not to make one yet.

- **Starter, $20 a month:** 100 hours of computer time and a monthly model allowance.
- **Pro, $100 a month:** a computer that stays on 24/7 and a larger model allowance.
- **Custom, quoted:** self-hosted, with more usage and more seats.
- **Every plan takes the customer's own key** (bring-your-own-key) as an alternative to the
  included allowance.
- **Distribution is a download for macOS and Windows.** The site links the installers; until a
  release URL exists the buttons fall back to the page's download section rather than a dead link
  (`apps/web/src/content/site.ts`).

**What the page deliberately does not say.** The model allowances are described, not counted: no
token figure is set, and a figure on a pricing page is the one thing a customer quotes back. The
providers listed are the ones the orchestrator's registry resolves today (D-002: OpenRouter, OpenAI,
Anthropic); a provider joins the list when it joins the registry.

**Considered and accepted by the owner.** COMMERCIAL-ROADMAP says "do not promise unlimited
continuous execution", and Pro's "stays on 24/7" is close to that promise. It stands as the owner's
call; M9's metering and allowance work (roadmap item 6) is where "24/7" gets its limits, and the
pricing copy changes with it. The same item's "no automatic overages under a hard $30 ceiling" was
written before a $100 plan existed and needs revisiting there, not here.

**What the privacy section promises, and what must be true before the site is published.** The
landing page's Privacy section makes four promises. One is already kept; three are launch blockers,
and the site is not deployed until they are done (the owner's call, recorded here so the page and
the product cannot drift apart).

| Promise on the page | State on 2026-09-29 | Task |
|---|---|---|
| Credentials and API keys are encrypted before they are stored, and never placed on the crew's computer | **Kept.** AES-256-GCM, each ciphertext bound to its user and connection, under a rotatable keyring (D-083, `credentials/credential-cipher.ts`); secrets never enter a sandbox (PRD §7.3) | — |
| Messages are encrypted before they are stored | Not yet: message content is stored in plaintext | CC-74 |
| The customer chooses the region their data lives in when they sign up (EU and others) | Not yet: one deployment, one database | CC-75 |
| An audit or privacy report can be requested at any time | Not yet: no request path and no report | CC-76 |
| The legal pages (Terms, Privacy Policy, Cookie Policy, Acceptable Use) are in effect | Drafts. They show a Draft banner until `LEGAL_REVIEWED` is set, and every fact still missing — the legal entity, address, governing law and the contact, privacy and security addresses (`apps/web/src/content/company.ts`) — is drawn as a visible "to be set" mark rather than invented. The 30-day deletion, price-change notice and liability cap are proposed defaults for counsel to confirm | CC-77 |

## D-149 · A §4.2 frame goes to the account it belongs to, and a socket stops receiving when its session ends

**Status:** accepted · **Touches:** §4.2, `agent/turn-event.bus.ts`, `ws/ws.gateway.ts`, `ws/ws-principals.ts`

`TurnEventBus` sent every server frame to every open socket. That was PRD M1's "every connected
window" while there was one user; since V1-08 there can be several, and a signed-in stranger's
window received other accounts' transcripts, tool arguments and approval prompts. V1-09 made each
*incoming* frame act as its socket's own principal and left the outgoing half as it was.

- **Every frame has one audience, derived on the server.** A frame naming a bot goes to that bot's
  owner, read once per bot and cached (`Bot.userId` cannot change). The frames without a bot —
  `mcp.status` and the four Work invalidations — and `bots.changed`, which is sent after a delete
  when there is no row left to read, take the owner from their caller. A frame whose owner cannot
  be established is dropped and logged, never broadcast.
- **Order is kept per bot, not globally.** A bot's frames wait for its owner in a per-bot queue, so
  a slow read stalls one bot and not every account. A bot's first frames can therefore arrive after
  a user-addressed frame emitted later; the latter are all "refetch this" notices, so nothing
  depends on that order. A socket still receives only frames emitted after it registered.
- **Expiry is checked per outgoing frame, revocation by a sweep.** Each socket registers with an
  accessor that answers its account, or null once the session has passed `expiresAt` — in memory,
  no query. Null ends the socket the way a refused control frame does (an error frame, then 1008).
  Revocation needs the session row, so the gateway re-reads every admitted socket's session every
  15 s (`REVOCATION_SWEEP_MS`); a signed-out window that only listens stops receiving chat and
  screen frames within that bound.

## D-150 · Sandbox providers are pluggable per deployment; DigitalOcean Harness Runtime is the first hosted one

**Status:** accepted · **Touches:** `packages/sandbox-core`, `packages/sandbox-digitalocean`, `sandbox/sandbox-provider.module.ts`, `sandbox/sandbox.config.ts`, agent-bridge `/exec`, `infra/sandbox-image/crewaid-desktop-up`, `infra/compose/.env.example`

Customer computers need to run somewhere other than the orchestrator's own Docker daemon (M9-BE-03),
and which host is cheapest will change with plans and prices. The orchestrator already reached
every machine through one injected `SandboxProvider`; this makes that seam the place a new host is
added, and ratifies the first hosted one.

- **One provider per deployment.** `SANDBOX_PROVIDER=docker|digitalocean` picks it at boot; an
  unknown value, or DigitalOcean without its token or template, fails the boot rather than falling
  back to Docker. `docker` stays the default for local development and self-hosting. There is no
  per-computer provider column: mixing hosts by plan is a later decision with billing, and
  switching a deployment's provider moves nobody's files.
- **The shared half lives in `@crewaid/sandbox-core`.** A provider implements the orchestrator's
  `SandboxProvider` and, where it can, the five-call `SandboxContainer` port, and gets
  `ContainerSandboxSession` — exec framing, file I/O, the reduced tool view — without rewriting
  it. What a hosted provider must supply is small: start, pause and remove a machine; a TCP path
  to a port inside it; and one bootstrap command for when the machine's bridge is down.
- **Commands and file I/O go through the bridge's `/exec`.** DigitalOcean's exec
  (`POST .../sandbox/exec`) is one request and response — `{argv, workdir, timeout_seconds}` in,
  `{exit_code, stdout, stderr}` out as strings — with no stdin, stream, environment or kill, and
  the session needs all four: writes pipe their bytes through stdin, binary reads need exact
  stdout, an aborted tool kills its process, and paths reach the shell through the environment so
  model-written paths are never interpolated. `/exec` is an HTTP Upgrade (`crewaid-exec/1`) on the
  bridge's port to a framed byte protocol (SPEC, STDIN, STDIN_END, KILL → STDOUT, STDERR, EXIT,
  ERROR). It runs as `bot`, which `/skill/run` already does, so it adds no capability to anyone who
  can reach the bridge. DigitalOcean's exec, as root, runs only `crewaid-desktop-up` and the
  workspace marker programs, which must work while the bridge is down. Docker keeps `docker exec`.
- **Every port reaches callers as a loopback listener.** RFB is raw TCP and refuses an endpoint
  with headers (D-012), so the provider listens on `127.0.0.1:0` per machine port and relays each
  accepted connection over its own port-forward WebSocket
  (`wss://api.digitalocean.com/v2/agents/sessions/{id}/port-forward/{port}`, Bearer token, binary
  frames; 4001 session ended, 4002 nothing listening, 4011 retryable). A WebSocket has no
  half-close, so a caller that finishes writing ends its stream — as under `doctl`; RFB, CDP and
  HTTP never half-close. Measured from the VPS on 2026-09-30: 31 ms median screen round trip,
  ~120 Mbit/s, 200–400 ms to open a stream, so callers keep their connections.
- **A computer is one session, found by name.** Sessions carry no labels, so each computer's
  session is named `crewaid-<computer id>` (unique per team), and every session is created by id
  from one shared environment, so creating a computer leaves no saved environment behind.
- **On DigitalOcean the runtime and the workspace are one thing.** Docker removes a container and
  keeps its volume; a DigitalOcean session's disk is the workspace. So `stop`, `destroy` and orphan
  cleanup pause — memory and processes survive, so a logged-in browser stays logged in — and only
  retention's `deleted` outcome removes a session, after `SANDBOX_WORKSPACE_RETENTION_DAYS`.
  `SANDBOX_IDLE_STOP_MS` decides when a computer pauses. DigitalOcean's own idle timer ignores
  tunnel traffic (it paused a machine while a viewer watched), and `keep_warm` cannot switch it
  off: a warm session refuses to pause at all (409), which would leave every computer running and
  billing. So the environment keeps `idle_timeout: 1h` as a backstop for an orchestrator that is
  down, and `checkHealth` — called by the health sweep for every running computer — sends a
  trivial exec at most every ten minutes, because exec does reset that timer (measured: a session
  paused 185 s after its last exec with a 3-minute timeout, while status reads went on).
- **Retention never wakes an in-use machine.** The sweep runs every minute per computer. An
  in-use computer is `retained` from the API alone; an orphan's first-seen time is written once
  into the marker inside its workspace (D-039) and cached, so a restart costs one wake per orphan.
- **The image runs as a custom template on a base adapter.** `agent: custom` is refused while it
  is in private beta, so the template is the sandbox image rebased on `coding-opencode`. The
  desktop starts during the template build and is frozen into the snapshot every session resumes
  from: spec `env` never reaches it, and nothing restarts it, so the provider runs
  `crewaid-desktop-up` (idempotent) when the bridge does not answer after a resume, and again
  every 20 s while it stays down — one crash recovery in five stayed down after a single launch.
- **The isolation profile differs from Docker's.** `agent-net`'s iptables do not apply.
  DigitalOcean blocks private ranges from the guest (verified), does not intercept HTTPS with
  egress unrestricted, and its metadata endpoint shows the guest its session and team ids and
  internal endpoints, but no credential.
- **Config keys:** `SANDBOX_PROVIDER`, `DIGITALOCEAN_ACCESS_TOKEN` (orchestrator only; one file
  reads it, asserted by `token-reader.test.ts`), `SANDBOX_DO_TEMPLATE`, `SANDBOX_DO_SIZE` (default
  `mars-4vcpu-8gb`), `SANDBOX_DO_BASE_ADAPTER` (default `opencode`).

Open with DigitalOcean: how paused-session disk and checkpoints are billed (a checkpoint listed
258 GB, the nominal disk), the 100-active-session team limit (paused sessions count), and when
`agent: custom` leaves private beta.

## D-151 · Cloudflare Containers is the second hosted sandbox provider

**Status:** accepted · **Touches:** `packages/sandbox-cloudflare`, `packages/sandbox-core` (`PortTunnels`), `infra/cloudflare/control-worker`, `sandbox/sandbox.config.ts`, `sandbox/sandbox-provider.module.ts`, `infra/dokploy/compose.cloudflare.yml`

A live trial on 2026-09-30 ran our unchanged sandbox image on Cloudflare Containers through 24 of
24 lifecycle steps (4 vCPU / 12 GiB, desktop healthy 4.4 s after start, 34 ms median screen round
trip from the VPS). It is cheaper than DigitalOcean while stopped and scales without a session
cap, but it cannot keep memory across a stop, so it is added beside DigitalOcean, not instead of
it, behind the same per-deployment seam (D-150).

- **`SANDBOX_PROVIDER=cloudflare`** selects it. It needs `SANDBOX_CF_CONTROL_URL` (https only: the
  secret travels with every request) and `SANDBOX_CF_CONTROL_SECRET`, which one file reads
  (`cf-control.ts`, asserted by `secret-reader.test.ts`) and which never enters a machine.
- **A control Worker is the API.** Only a container's own Durable Object can start it, run a
  command in it or reach its ports, so `infra/cloudflare/control-worker` is one Durable Object
  per computer behind one bearer secret, plus a registry object, because Durable Objects cannot be
  listed. Its routes: provision, status, start, stop, retire-profile, retain, list, and a
  WebSocket tunnel per TCP connection (`getTcpPort(port).connect()`), which `PortTunnels` — now
  in `sandbox-core` behind a structural `TunnelStream` type — turns into loopback listeners.
- **The runtime and the workspace are apart, as under Docker.** A container's disk starts from
  the image every time. The workspace is a tar of `/home/bot` in R2 (`crewaid-workspaces`),
  streamed by the Worker; the container holds no R2 credential. A start restores it before the
  desktop runs — the entrypoint waits for a per-start gate file — and applies profile
  retirements deferred while stopped; a stop closes the bots' browsers so Chrome flushes its
  cookies, saves, then destroys. So `stop`, `destroy` and orphan cleanup really stop the
  container, and only retention's `deleted` outcome deletes the saved tar. Files and saved logins
  survive a stop; open tabs and running programs do not.
- **No filesystem snapshots.** Cloudflare stores each snapshot as an image in the account
  registry (50 GB per account), each holds the whole workspace, a snapshot restores only onto
  the image it came from (the API refuses both together), and it expires 30 days after its last
  restore. A tar in R2 survives image releases, never expires, and restored in 0.3 s in the trial.
- **Workspace history and retention never start a machine.** The first-start time, the orphan
  clock and deferred retirements live in the computer's Durable Object, outside the container.
- **The Worker is the backstop for a vanished orchestrator.** Any open tunnel, even a silent one,
  keeps a Cloudflare container awake past its own inactivity timeout (measured), so an alarm
  saves a running computer every 30 minutes and stops it when the orchestrator has not been heard
  from for 15 — the health sweep reads status every 10 s per running computer. A container that
  crashes loses what changed since its last save.
- **The image needs the agent-bridge's `BridgeServer`.** Cloudflare names containers with a 64-character id, and
  Python's `HTTPServer` failed resolving it (`label too long`), which took the desktop down;
  `BridgeServer` skips that lookup.
- **Measured with the provider itself (2026-09-30, 30/30 steps against the deployed Worker).** First
  start of a new image 16–18 s, a start with a restore ~5 s, a 76 MB workspace (one reopened Chrome
  profile) saved in 15 s; files, the login cookie and a profile retirement queued while stopped
  all survived; the orphan backstop saved and stopped a silent computer; a same-code Worker deploy
  left a running computer and its unsaved files alone. The run found the Worker's save doing
  quadratic work, which exhausted the Durable Object's CPU limit mid-save; it copies each byte
  once now, and the Worker allows 5 minutes of CPU per request. A save cut off mid-upload leaves
  an incomplete multipart upload, which R2's default rule aborts after 7 days.
- **Size** is the Worker's `INSTANCE_VCPU` / `INSTANCE_MEMORY_MIB` / `INSTANCE_DISK_MB` (default
  4 / 12288 / 20000; Cloudflare requires at least 3 GiB per vCPU). Memory and disk bill while
  running whether used or not, so a computer costs about $0.16–0.19 per awake hour against
  DigitalOcean's ~$0.10.

Open: whether deploying the Worker with a new image restarts running computers, and how
Cloudflare bills a Durable Object that holds a screen tunnel open.

## D-152 · Two editions from one codebase: the hosted service and self-hosted Crewaid

**Status:** accepted · **Touches:** `packages/shared` (`auth.ts`), `common/edition.config.ts`, `auth/better-auth.ts`, `auth/desktop-sign-in-page.ts`, `apps/desktop/src/edition.ts`, `main.ts`, `signIn.ts`, `authExchange.ts`, `electron-builder.{cloud,selfhosted}.yml`, `scripts/package.mjs`, the renderer's launch gate and General settings, `infra/dokploy/compose*.yml`, `infra/compose/.env.example`

Crewaid ships twice: as a paid hosted service, and as software anyone can run on their own
machine or cloud with the desktop app and the orchestrator image. The two differ in who runs the
server, how people sign in, and what is charged for, so the difference is decided once — per
build and per server — and never by a user at run time.

| | `cloud` (Crewaid) | `selfhosted` (Crewaid Self-Hosted) |
|---|---|---|
| Orchestrator address | compiled into the app; no field anywhere | asked at first launch, editable in Settings |
| Sign-in | Google, GitHub, magic link (as configured) | email and password only |
| Models | bring-your-own keys; a built-in provider later | bring-your-own keys only |
| Billing, usage limits | yes, once they exist (M9-BE-06) | none |
| Deep-link scheme | `crewaid://` | `crewaid-selfhosted://` |

- **The server: `CREWAID_EDITION`, required.** `readEdition` throws at boot on a missing or
  unknown value rather than picking one: a hosted server booted as `selfhosted` would open
  password sign-up on the internet, and a self-hosted one booted as `cloud` would offer sign-in
  methods nobody configured. The hosted Dokploy compose files fix it to `cloud`; the dev example
  `.env` says `selfhosted`, to match an unpackaged desktop app.
- **Self-hosted sign-in is email and password, through the same desktop handoff.** No identity
  provider to register and no mail service to pay for. The sign-in page renders the password
  form only on a self-hosted server (rendered, not hidden: a hosted page carries no password field
  or the code that posts one), and `@better-auth/electron`'s after-hook mints the one-time code
  for `/sign-in/email` and `/sign-up/email` exactly as for the hosted methods, because it matches
  by path. Signing up signs in at once, with no email to verify. Google, GitHub and Resend
  settings are ignored with a boot warning, and the magic-link plugin is not registered. Sign-up
  is open on a self-hosted server — accounts stay isolated per user, as on the hosted service; an
  owner role, invitations and organizations are deliberately out of scope until teams are
  planned on their own.
- **A self-hosted server's cookies follow its own address.** `Secure` exactly when
  `BETTER_AUTH_URL` is https, not when `NODE_ENV` is production: the image runs as production, a
  home or office install is often plain http on a LAN address, and a browser drops a `Secure`
  cookie there — including the desktop's one-time code, which `@better-auth/electron` sets with
  the session cookie's attributes. Boot warns when a non-loopback http address carries passwords
  in clear. The hosted service keeps `Secure` in production regardless of its URL.
- **Each edition has its own sign-in scheme.** Both apps can be installed on one machine, and an
  OS gives a scheme to whichever app registered it last; with one shared scheme, signing in to
  one app could open the other, which holds no PKCE verifier for that code. The schemes are asked
  of `desktopAuthScheme(edition)` rather than exported as constants, so no caller can use one
  without naming its edition, and each server trusts only its own edition's origin.
- **The desktop's edition is fixed at build time.** `electron-builder.<edition>.yml` writes a
  `crewaid` block into the packaged `package.json` (`extraMetadata`), with its own app id,
  product name (and so its own settings folder and credentials), artifact names and declared
  scheme. `scripts/package.mjs` adds the hosted orchestrator's address from
  `CREWAID_ORCHESTRATOR_URL` and refuses to package a cloud build without an https one. A packaged
  build with no block throws at launch instead of defaulting; an unpackaged one reads
  `CREWAID_EDITION` and defaults to `selfhosted`.
- **A hosted build cannot be pointed anywhere else.** Its main process wraps the CC-07 store
  (`pinOrchestrator`): reads always report the compiled-in address — so a fresh install goes
  straight to sign-in — and any write naming another address is refused. The renderer's channel,
  the sign-in controller and anything added later all write through it, so hiding the field
  (General settings, the launch gate's "Change orchestrator address") is presentation, not the
  rule. The renderer learns its edition over one guarded channel, `crewaid:app:info`, and shows
  neither edition's extras until it has the answer.
- **The rule for later work:** billing, usage metering and any built-in model provider are
  registered only when the server's edition is `cloud`, so a self-hosted server exposes none of
  their routes, and the self-hosted desktop offers none of their screens.

Not yet: a version check between a self-hosted app and its server, and a password reset for a
self-hosted server with no mail service — both belong to the self-hosted server package, with
the published images, the compose file and the installer.

## D-153 · Desktop releases: one tag builds both editions, served from downloads.crewaid.io

**Status:** accepted · **Touches:** `.github/workflows/release-desktop.yml`, `apps/desktop/scripts/{package,publish}.mjs`, `apps/desktop/electron-builder*.yml`, `infra/cloudflare/downloads-worker`

The repository is private, so a GitHub Release asset is not a public download. Installers and
the update feeds the app reads therefore live in an R2 bucket behind a Worker on
`downloads.crewaid.io`.

- **A `v*` tag publishes.** The workflow refuses a tag that differs from
  `apps/desktop/package.json`'s version, then builds each edition (D-152) for macOS (universal: one
  download for Apple silicon and Intel, which the site's one macOS button promises — **superseded
  by D-225:** one build per chip, plus a Linux `.deb`) and Windows (x64, NSIS). A pull request that changes packaging runs the same builds and publishes nothing,
  keeping the installers as workflow artifacts for three days.
- **Installers first, feeds last.** `scripts/publish.mjs` uploads the dmg, zip, exe and blockmaps
  before `latest-mac.yml` / `latest.yml`, so an app or a download link reading the feed mid-publish
  is never sent to a file that is not there yet.
- **A feed never goes backwards.** Publishing tags run one at a time, and the Worker refuses (409)
  a feed whose `version` is older than the published one, writing conditionally on its etag; the
  publish script reports "kept the newer feed" and succeeds. A re-run of an old release can upload
  its installers but cannot roll every app's updates back.
- **Uploads go through the Worker with one bearer secret** (`DOWNLOADS_UPLOAD_SECRET`), not an R2
  API token: CI can write only under `desktop/`. Cloudflare refuses request bodies over 100 MB at
  the edge on this zone's plan, so files over 90 MB go as R2 multipart parts.
- **Stable links:** `/desktop/<edition>/mac` and `/windows` redirect to the installer the current
  feed names (D-225 adds `/mac-arm64`, `/mac-intel` and `/linux`). The landing page links there and never changes for a release.
- **The update feed is baked into each build** (`publish: generic`,
  `https://downloads.crewaid.io/desktop/<edition>`), for the in-app updater (M9-FE-01), with
  `useMultipleRangeRequest: false`: R2 answers a multi-range request with the whole file (measured),
  which would make every differential update a full download.
- **Signing is switched on by secrets, not by editing config.** With `MAC_CSC_LINK` (+ password)
  the macOS build is signed with that Developer ID, and with the App Store Connect key
  (`APPLE_API_KEY` — the `.p8` contents, written to a file on the runner because
  `@electron/notarize` takes a path — plus `_ID` and `_ISSUER`) it is also notarized. They reach the
  macOS jobs only: electron-builder's Windows signer falls back to `CSC_LINK`. Without them `package.mjs` passes
  `mac.identity=-` and `mac.hardenedRuntime=false`, explicitly ad-hoc signing the finished bundle
  without selecting an identity from the runner's keychain. **Amended 2026-10-15:** skipping signing
  (`identity=null`) left Electron's linker signature and an unbound Info.plist; macOS TCC then
  failed to match the saved microphone grant and repeatedly prompted after Allow. The ad-hoc
  signature binds the app id, usage string and audio entitlement. Hardened runtime stays on for
  Developer ID builds; ad-hoc builds disable it because they have no team for library validation.
  Ad-hoc builds still open with right-click → Open and keep `crewaid.macSigned=false`, so they
  cannot install their own updates (Squirrel.Mac requires a Developer ID). Windows builds are unsigned for now;
  SmartScreen warns until Azure Trusted Signing is added.
- **pdf.js's Node-only canvas (`@napi-rs/canvas`) is excluded from the package.** The renderer
  uses pdf.js's browser build, and the per-chip native binary is what a universal build cannot merge.

Open: the packaged `app.asar` is about 113 MB, most of it renderer libraries Vite already bundles,
because they are listed as `dependencies`; moving them to `devDependencies` would shrink every
download.

## D-154 · In-app updates: download quietly, restart when the person chooses

**Status:** accepted · **Touches:** `apps/desktop/src/updater.ts`, `src/autoUpdater.ts`, `src/main.ts`, `src/preload.ts`, `renderer/components/UpdateButton.tsx`, `renderer/components/BotSidebar.tsx`, `electron-builder.{cloud,selfhosted}.yml`, `scripts/package.mjs`

- **electron-updater against the edition's feed** (D-153), pinned to the line electron-builder 26
  pairs with (`6.8.10`, sharing its `builder-util-runtime`). `autoUpdater.ts` is the only file that
  imports it; the decisions are in `updater.ts` behind a port and tested with a fake.
- **It checks 10 s after launch and every 4 hours, downloads in the background, and offers a
  restart.** A button appears on the right of the account row in the sidebar only when there is
  something to do: "Restart to update to vX" once the update is on disk. Checking, downloading and
  failed checks show nothing; a failure is logged and the next check tries again. Pressing it
  installs silently and relaunches; an update nobody pressed for installs at the next quit.
- **An unsigned macOS build cannot install its own update** (Squirrel.Mac checks the signature), so
  it downloads nothing and the button reads "Download Crewaid vX", opening the edition's stable
  download link. `package.mjs` writes `crewaid.macSigned` into the build, so a signed build takes
  the normal path with no code change.
- **Each edition has its own updater cache** (`extraMetadata.name`: `crewaid` / `crewaid-selfhosted`):
  electron-updater names its download folder after the package name, and with the shared
  `@crewaid/desktop` the two apps could clear or pick up each other's pending update.
- **Not in development:** an unpackaged app registers the channels (they answer `idle`) and never
  checks — there is no `app-update.yml`, which electron-builder writes only for updatable targets.

Measured on macOS: a self-hosted zip packaged as 0.0.1 found the live 0.0.3 on
`downloads.crewaid.io` within 15 s and downloaded nothing. The Windows download-and-restart path is
the library's standard one and is first exercised by the release after this one.

## D-155 · The self-hosted server package: images, a compose file, and the fence on any Docker

**Status:** accepted · **Touches:** `infra/selfhost/` (`compose.yml`, `.env.example`, `egress/`), `infra/compose/agent-egress.py` (`--trusted-source`), `packages/sandbox-docker` (`SANDBOX_CONNECT`), `infra/dokploy/Dockerfile`, `.github/workflows/release-images.yml`, `.github/workflows/selfhost.yml`, `packages/shared` (`HealthResponseSchema`, edition enum moved to `enums.ts`), `health/health.service.ts`, `auth/password-reset.ts`, `cli/reset-password.ts`, the desktop's General settings

Self-hosted Crewaid (D-152) runs from published images and one compose file.

- **Images on GHCR, one version with the desktop.** A `v*` tag builds `crewaid-orchestrator`,
  `crewaid-sandbox` and `crewaid-egress` for `linux/amd64` and `linux/arm64` on native runners and
  joins each into one multi-arch tag (`:<version>`, `:latest`) under `ghcr.io/natanael-exe`. The
  sandbox image already installs Chrome for whatever architecture builds it, so Apple silicon and
  ARM servers run it natively. Packages from a private repository start private: each is made
  public once, by hand, after its first release.
- **The fence runs as a container, so it applies on Docker Desktop.** `agent-egress.py` was a Linux
  systemd unit, which a Mac or Windows install could not run — and on Docker Desktop the sandbox
  bridge lives in Docker's VM, where nothing fenced it. The `egress` service runs the same script
  with `network_mode: host` (the Linux host, or that VM) and `privileged` (for the bridge-netfilter
  sysctls), with no Docker socket: the compose file names the bridge (`crewaid-sbx0`). It uses
  whichever iptables backend holds Docker's own chains, re-applies every 30 s, and writes a marker
  on a tmpfs volume that the orchestrator waits for — emptied by a reboot, so the orchestrator
  waits again.
- **Nothing is published: the orchestrator joins the computers' network.** The Dokploy design
  publishes each computer's screen and DevTools ports on a control bridge's gateway, which Docker
  Desktop silently refuses (the mapping comes back empty: its port forwarder cannot bind an address
  that exists only inside its VM). So the self-hosted provider runs with `SANDBOX_CONNECT=network`
  — no port bindings, each port reached at the computer's own address — and the orchestrator joins
  `crewaid-sandboxes` at a fixed address. `agent-egress.py --trusted-source <address>` makes that the
  only address that may open a connection into the bridge, and exempts its own packets from the
  fence (they cross the same bridge); sandboxes, which run without capabilities, still cannot
  reach it. Both are additive: Dokploy's `published` mode and control interface are unchanged.
  The kernel suite (`infra/compose/tests/namespace_probe.py`) proves the trusted source opens into a
  sandbox, is not fenced itself, and stays unreachable from one; removing its ingress rule fails it.
- **Measured on Docker Desktop (macOS), the whole stack as a self-hoster runs it:** health reported
  `selfhosted`; a password account started a real computer (`RUNNING`, healthy) with no published
  ports; the orchestrator read its VNC banner directly; from inside the computer https answered 200
  while the metadata address, the router, this Mac's LAN address, Docker's host gateway, the
  orchestrator and http on 8080 all timed out; `reset-password` made the old password 401, the new
  one 200 and the old session 401. The control-network default range collided with an existing
  Docker network on that machine, which is why the subnet is in `10.x` (Docker's own pools are
  `172.17–31` and `192.168`).
- **Compose:** Postgres, Redis (password), `egress`, the orchestrator (`CREWAID_EDITION=selfhosted`,
  the Docker provider in `network` mode, at `10.231.0.2` on the computers' network), a one-shot
  `networks-ready` service that also makes the sandbox image present (the provider never pulls
  it), and an optional `caddy` profile for HTTPS by domain. The orchestrator listens on
  `127.0.0.1` unless the operator chooses the network.
- **`GET /health` reports `version` and `edition`.** The image bakes `CREWAID_VERSION` in at release
  (`dev` locally). The self-hosted desktop shows the server's version in Settings → General and,
  when the server is an older release than the app, how to update it — the app updates itself,
  the server only when its operator says so.
- **Password reset without mail:** `docker compose exec orchestrator node
  apps/orchestrator/dist/cli/reset-password.js <email>` reads the new password from stdin, hashes
  it with Better Auth's own hasher, and ends the account's sessions in the same transaction.
- **`latest` only ever moves forward.** `.github/scripts/newest-release.sh` answers whether a version is
  the highest plain `x.y.z` among the `v*` tags; the images' `:latest` is moved only when it is, so
  re-running an older release's tag or publishing a prerelease leaves `latest` where it was. The
  installer job asks the same question: npm's `latest` dist-tag (others go out as `previous`) and the
  uploaded `install.sh` follow only the newest release.
- **CI:** `selfhost.yml` runs the compose stack on a Linux runner — health, a password sign-up and
  its reset, the fence's chains, and probes from the sandbox network (https allowed; metadata, the
  Docker gateway, the runner's own address, the orchestrator and a LAN address refused, with the
  runner's address answering from outside the fence).

- **The installer is one package, `crewaid-selfhost`, reached two ways.** `npx crewaid-selfhost
  init` with Node 18+, and `curl -fsSL https://downloads.crewaid.io/install.sh | sh`, a shim that
  runs the same package with npx — or, without Node, inside `node:22-alpine` with the install folder
  and the Docker socket mounted. `init` checks Docker and Compose v2, asks how the server is reached
  (`local`, `lan` with an unencrypted-network warning, or `domain` with the Caddy profile set in
  `.env` as `COMPOSE_PROFILES`), refuses a busy port, picks a computers' subnet no existing Docker
  network overlaps, generates every secret, writes `compose.yml` and a mode-600 `.env`, starts the
  stack and waits for `/health`. Compose runs with `--project-directory`, so `docker compose` by
  hand in that folder does the same thing. `update` rewrites `compose.yml` and changes only
  `CREWAID_VERSION` in `.env`; `init` refuses a folder that already has one. In the container path
  the installer cannot see the host, so the host's LAN address and user id are passed in: health
  is asked of the orchestrator container directly, and the files are handed back to that user —
  on Linux a root-run container's mode-600 `.env` would otherwise be unreadable by its owner.
  `install.sh` reads answers from `/dev/tty`, since `curl … | sh` gives it the pipe as stdin. The
  release workflow publishes the package through npm Trusted Publishing — npm trusts
  `release-images.yml` in this repository and takes the job's OIDC token, so no publish token is
  stored, and a private repository means no provenance — and uploads the shim, which the downloads Worker serves at `/install.sh` with `no-cache`.

Next in this package: the self-host page on the site.

## D-156 · The hosted service's plans: Stripe subscriptions, a $1 trial, and an internal plan for admins

**Status:** accepted · **Touches:** `apps/orchestrator/src/billing/`, `sandbox/compute-policy.ts`, `sandbox/sandbox-meter.service.ts`, `sandbox.service.ts` and `sandbox-idle.service.ts` (the start gate and Pro), `auth/better-auth.ts` (the Stripe and admin plugins), `auth/auth.middleware.ts` and `main.ts` (raw request bodies), `app.module.ts` (the first module registered by edition), `prisma/schema.prisma` (deviation 11), `packages/shared` (`BILLING_PLANS`, the billing schemas, `API_ROUTES.billing`), the desktop's Plan & usage pane, `apps/web` (`/billing/done`), `infra/compose/.env.example`

D-148 sells three plans. This is what stands behind the two that are bought in the app, on a
cloud server only (D-152).

- **The plans live in one table, `BILLING_PLANS` in `@crewaid/shared`.** The server enforces it,
  the desktop shows it, and the site can sell from it. Per billing period, not rolling over:

  | Plan | Price | Computer time | Included model use | Idle stop |
  |---|---|---|---|---|
  | trial | $1 once | 10 h | $1 | yes |
  | starter | $20/month | 100 h | $5 | yes |
  | pro | $100/month | no limit | $10 | no |
  | internal | — | no limit | no limit | yes |

  The model allowances are what PR 3's built-in provider spends; until it exists they are shown
  and not spent. The numbers are constants on purpose: M9-PD-01 still owes the margins, and at
  $0.10–0.19 per awake hour (D-150/D-151) Pro's always-on month costs $73–139 before model spend.
- **Stripe's webhook is verified by `@better-auth/stripe`; the subscription is kept by Crewaid.** The
  plugin checks the signature at `POST /api/v1/auth/stripe/webhook` and hands every event to the
  billing module; its own subscription handling is off. Those handlers applied each event's payload
  in arrival order, which Stripe does not guarantee — a cancellation delivered before its creation
  was overwritten by it, and an update arriving first could rewrite an older subscription's row as
  the newer one — and they logged a failed write and answered 200, so Stripe never retried it.
  `SubscriptionSyncService` instead treats an event as a nudge: it re-reads the subscription it names
  from Stripe and writes the row from that, keyed by Stripe's subscription id (unique). Any order and
  any number of redeliveries end at Stripe's current state, and a failure throws, which the webhook
  answers with 400 so Stripe delivers again. Checkout and the portal are the billing module's too
  (`POST /billing/checkout`, `POST /billing/portal`); with subscriptions off, none of the plugin's
  own checkout or cancel routes work.
- **One live subscription per account, and only one payable checkout.** A checkout is refused (409,
  to the portal) while the account has any subscription Stripe has not ended — in force, or past
  due, unpaid, paused or awaiting its first payment, all of which Stripe is still collecting on and
  the portal fixes. The question is asked of our rows and of Stripe, because a subscription paid a
  moment ago may not have arrived by webhook yet. After a checkout is created, the account's older
  open checkouts are expired, so two tabs, or Starter then Pro, cannot each be paid; "older" rather
  than "other", so two racing requests each expire only the one before them.
- **The trial costs $1 and happens once per account.** A Starter checkout from an account that
  has never had a trial adds a one-time $1 and `trial_period_days: 7`; Stripe charges the $1
  at once, keeps the card, and starts Starter at $20 on day 8 unless it is cancelled. "Never had a
  trial" means no subscription with a trial date or a `trialing` status, in our rows or in Stripe's.
  Pro has no trial. The $1 is an inline `price_data` line in the plan's currency, built from
  `BILLING_PLANS.trial`, rather than a price id from the environment: the code is then the charge,
  and Stripe archives inline prices as it creates them, so none accumulate.
- **Entitlement is decided in one pure function, `entitlementFrom`.** The newest subscription that
  is `active` or `trialing` decides the plan; a trialing Starter is the trial. `past_due` grants
  nothing until the card is fixed — Stripe keeps retrying, and the plan comes back with the
  payment — and a plan or status the code does not know grants nothing, because money is never
  assumed. A subscription cancelled at period end stays `active` in Stripe until then, so it keeps
  working to the end of what was paid for without any code here.
- **An admin is on the internal plan.** Better Auth's admin plugin adds `User.role`; `role = 'admin'`
  is set by hand in the database and puts the account on `internal` — no Stripe, no limits — for
  operating and testing production. The plan has a name so every limit asks one question ("what is
  this account entitled to?") instead of each checking for admins, and so `GET /billing` can say
  what is true. Its usage is counted by UTC calendar month. Idle stop stays on.
- **Usage is a row per user per period, `UsageLedger`, keyed by the period's start.** A new period
  is a new row, so nothing has to zero anything at renewal. Money is micro-dollars in a BigInt.
  PR 2 writes computer time into it and PR 3 model spend; this decision only reads it.
- **Billing is on when the edition is `cloud` and `STRIPE_SECRET_KEY` is set.** A cloud server
  without the key runs unbilled — every account unlimited, as before plans existed — and says so at
  boot; with the key, the webhook secret and the three price ids are required or the server
  refuses to boot. Without billing, `BillingModule` is never imported and its routes answer 404,
  and the Stripe plugin is not registered, so there is no webhook either. A self-hosted server has
  neither the Stripe nor the admin plugin, whatever its environment says.
- **Stripe customers are created at first checkout**, with an idempotency key per user, not at
  sign-up — signing in never waits on Stripe, and an account that never pays never becomes a
  customer.
- **The auth tree gets the body as it was sent.** Stripe signs the exact bytes it posts, and the
  global JSON parser had already consumed the stream, leaving `better-call` to re-serialise
  `req.body` — the same data in different bytes, so every signature failed. Nest now keeps the raw
  body (`rawBody: true`) and the Better Auth middleware hands it on as a string, which `better-call`
  passes through untouched.
- **Stripe's pages return to `crewaid.io/billing/done`**, a static page that says to go back to the
  app, rather than an orchestrator route: a browser coming back from Stripe has no session, and
  every orchestrator route but three needs one. The desktop reads the plan again when its window
  is focused.

**Computer time (part 2).**

- **The lifecycle asks a port, never billing.** `ComputePolicy` (`sandbox/compute-policy.ts`) has three
  questions — may this account start, do its idle computers stop, record this time — and the billing
  module answers them under `COMPUTE_POLICY` from a global module. Where billing is off the token is
  unregistered and every caller treats that as no limits, so the sandbox code carries no notion of a
  plan and a self-hosted server meters nothing.
- **Every start asks first.** `SandboxService.start` — which every wake goes through: a turn's tools, a
  routine, a recording, a skill run, the screen — refuses with **402** before storage and before the
  host's capacity: `PLAN_REQUIRED` with no plan in force, `COMPUTE_ALLOWANCE_EXHAUSTED` when the
  period's hours are used, its `detail` carrying `usedSeconds`, `limitSeconds` and `resetsAt`. Ahead
  of the capacity 503 on purpose: "the host is full" would send the operator to stop a computer for
  a refusal that is about their account. The desktop shows either as a sentence pointing at Plan &
  usage, and does not offer a retry.
- **A sweep counts the time.** `SandboxMeterService` runs once a minute where a policy exists and,
  for every computer holding a slot (`STARTING`, `RUNNING`, `UNHEALTHY` — each costs the host),
  counts the seconds since `Sandbox.meteredAt` or the last start, whichever is later, capped at two
  intervals so a stretch with no process running is not charged. A runtime reconciliation found gone
  — `UNHEALTHY` with its container cleared — runs nothing and is not counted. The watermark only
  moves forward, by compare-and-swap, before the time is recorded: two processes cannot charge one
  interval, a pass with an earlier clock cannot pull it back, and a crash between the two loses the
  interval rather than doubling it. At most the minute before a stop goes uncharged; every error
  here is in the customer's favour.
- **At the limit the computer stops**, running or unhealthy — a container that stopped answering may
  still be running, and leaving it to reconciliation would charge time no plan covers. So does a
  computer whose plan has lapsed or that was started before billing was switched on. The stop holds
  the lifecycle lease and asks the plan again inside it, so a payment or an upgrade that landed after
  the meter decided keeps the computer on; released, the row returns to the state it was claimed
  from.
- **Pro's computers never idle-stop.** The idle sweep asks the policy per pass, so a downgrade starts
  idle stop again at the next one.
- Not yet: a warning before the limit. The pane shows the meter; a pushed notice needs its own §4.2
  frame and lands with the built-in model allowance, which needs the same one.

Next: PR 3 — the built-in model provider and its allowance; PR 4 — pricing copy and terms.

## D-157 · The models a hosted plan includes: a Crewaid connection, charged per call

**Status:** accepted · **Touches:** `apps/orchestrator/src/billing/` (`included-models.ts`, `included-models.service.ts`, `usage-notice.ts`), `models/included-models.port.ts`, `models/model-resolution.service.ts`, `models/normalize-error.ts`, `providers/provider-connections.service.ts`, `agent/turn-event.bus.ts`, `prisma/schema.prisma` (`ProviderKind.CREWAID`, `ModelCharge` with `settledAt`), `packages/shared` (`crewaid` kind, `CreatableProviderKindSchema`, `ALLOWANCE_EXHAUSTED`, `usage.notice`), the desktop's Models pane, model picker and sidebar

D-156's plans promise a model allowance. On a cloud server that bills and has
`CREWAID_OPENROUTER_API_KEY` set, every account gets one: a set of models that run on Crewaid's own
OpenRouter key and are charged to the plan. Supersedes D-083's "no key from the environment" for
this one case — the concern there was one person's work billed to another, and here every call is
charged to the account that made it.

- **A real connection, not a virtual one.** Each account gets a `ProviderConnection` of the new kind
  `crewaid`, named "Crewaid", with one `ProviderModel` per included model. A bot stores its row id
  like any other model, the picker lists it, and `UserSettings.defaultModelId` can point at it — no
  model reference, picker or settings contract grows a second shape. The server makes it the first
  time anything lists models for the account (`GET /models`, `GET /providers/connections`), under a
  per-account advisory lock so two lists at once make one; models added to the list later reach each
  account on its next list. A new account with no default and no connection of its own gets the
  included default, so its first bot answers without a key.
- **It is the server's.** Every route that changes a connection or its models answers 409 for the
  `crewaid` one — rename, enable, key, delete, add, edit or remove a model — and a connection of that
  kind cannot be created (`CreatableProviderKindSchema`). The desktop shows it read-only.
- **The list** is `INCLUDED_MODEL_LIST`: Gemini 3.8 Flash (the default, reads images), Claude Haiku
  4.5, GPT-5 Mini, DeepSeek V4 Pro and GLM 5.3 Flash — strong tool use at low prices, for small
  allowances. Each must have a row in the price table; a test fails without one.
- **The meter is middleware on the model.** `IncludedModelsService` wraps the OpenRouter model with
  `wrapLanguageModel`, so every call is charged whoever makes it — turns, but also memory
  distillation and skill compilation, which call the model directly and never create a turn.
- **Reserve, call, settle.** Before a call runs, one conditional `UPDATE` adds an estimate (the
  prompt plus the call's output limit, from the price table) to the period's total — only while the
  total is under the allowance — and writes a `ModelCharge` row with `settledAt` null. That row lock
  serialises an account's calls: a call arriving while another is in flight sees its reservation
  already counted, so concurrent calls cannot all spend the same remaining balance. After the call,
  the row settles to the actual cost — OpenRouter's own figure (`usage: { include: true }`), or the
  price table's from the call's tokens — and the total moves by the difference, idempotently and
  with retries. A stream settles before its `finish` part reaches the caller, so a turn's next step
  is admitted after the last one's charge. A call that never finishes — cancelled through its abort
  signal, failed mid-stream, or a generate aborted — settles at an estimate of what it used (the
  prompt and what was streamed); one that failed before generating anything settles at zero. A
  settle that cannot be written leaves the reservation counted: charged the estimate, never nothing.
  The call that crosses the allowance completes; the next is refused at reservation.
- **Spent is its own error.** `ModelAllowanceExhaustedError` normalises to the new
  `ALLOWANCE_EXHAUSTED` code — not `QUOTA_EXCEEDED`, which is a provider account out of credit —
  whose message names both ways forward: the account's own key, or a larger plan. No silent fallback
  to another model.
- **Notices at 80% and 100%.** A new §4.2 frame, `usage.notice` `{ kind: compute | model, level,
  resetsAt }`, goes to the account's windows when either meter crosses a line, once per crossing.
  The desktop shows the latest one in the sidebar's footer with a button to Plan & usage; a window
  opened later reads the same numbers there.
- Self-hosted servers, and cloud servers without the key, have no `crewaid` connections and no
  meter: `INCLUDED_MODELS` is simply unregistered. A `crewaid` row left behind on a server that no
  longer has the key is listed unavailable and refuses to resolve.

---

## D-158 · Architecture modernization: TanStack AI, shared seats and measured screens

**Recorded 2026-10-03 from Natanael's request to create the implementation tasks, update the
board and open a planning PR.** Direction and scope are authorized; this entry does not claim
that the new stack, contracts or production acceptance are implemented.

**Pre-launch clarification, 2026-10-03.** Natanael confirms that the product has no launched users
or production data. Major breaking architecture/API/schema changes and a coordinated replacement
of server, client and image are acceptable. The MOD plan therefore targets one clean implementation
and fresh database/queue/computer setup. It does not require customer backfills, old-format history
or skill converters, old-client support windows, parallel legacy backends/viewers, mixed-version
canaries or deployment rollback strategies. Explicitly selected disposable dev/test state may be
reset/reseeded through the documented workflow; this planning PR resets nothing. Ordinary
transaction failure isolation, restart/reconnect, approvals, fencing, login persistence and
backup/host-loss restoration with newly created target state remain runtime requirements.

The implementation handoff is
[ARCHITECTURE-MODERNIZATION-2026-10-03.md](plans/ARCHITECTURE-MODERNIZATION-2026-10-03.md).
`tasks.json` remains authoritative and the three board views are generated. The source reviews
are linked from that handoff and pin inspected revisions, published API evidence and limitations.

**Selected direction.** Migrate from AI SDK's inference/chat layer to TanStack AI on the backend
and TanStack React's headless conversation state on the frontend, with native AG-UI. Keep HeroUI
components and product-specific state. Use TanStack persistence lifecycle through the existing
Prisma client and PostgreSQL: canonical target message contracts, full-snapshot reconciliation,
run/interrupt records and durable event replay are separate responsibilities. TanStack lazy MCP
and compaction should replace generic mechanics when parity is demonstrated. Provider-scoped
credentials, custom endpoint guards, allow/deny/ask policy, usage semantics and pre-call spend
reservation remain requirements. A boolean approval flag or replay log is not their replacement.

This direction supersedes the historical instruction that the inference dependency must remain
AI SDK and that all chat state must remain in the current custom reducer, **only for the planned
MOD tasks**. A library still owns iteration and message assembly; this does not authorize a
handmade model loop or a second permanent transcript authority. Independent `@ai-sdk/harness`
contracts behind the computer-provider seam remain until separately replaced. Exact wire,
persistence, interrupt, current protocol, route, event, table and configuration names must be
ratified in MOD-01 and the domain contract tasks before code is implemented; none are invented
by this backlog entry. Repository contracts may be changed together once the target contract is ratified; no pre-launch client compatibility layer is required.

**Retained foundations and computer constraint.** Keep NestJS, Prisma/PostgreSQL, Better Auth,
BullMQ scheduling, HeroUI, shared Zod contracts and architectural guards. Preserve D-046's default
shared computer per user and bot-specific private Chrome/profile/workspace/X display/WM/session
bus. Preserve D-056/D-057 named identities and exclusive profile leases, D-060 separate bot
screens and D-061 lazy browser acquisition. A live Chrome user-data directory has one active
holder; reusable login does not authorize simultaneous competing Chrome processes on it. The
user computer is the trust boundary, not hostile isolation between same-UID bots. Customers do
not share a computer. Stronger bot isolation or a browser broker would require a separate design.

**Browser, control and policy.** Use a supported Playwright adapter and observation references
bound to browser run/snapshot generation. Reimplement enforced human takeover with admission
closure, bounded draining, one controller, stale-holder fencing and fresh observation on handback.
Cover actual browser, desktop, skill and supported shell mutation boundaries, including native
streamer input. Strengthen external-commit authorization and untrusted-input handling through the
existing policy service and office workflow homes. MOD-SE-01 must explicitly resolve changes to
D-092/D-144 instead of silently changing contained/full-access behavior. D-067's process-local
pending-approval behavior is to be superseded by the ratified durable interrupt contract. Do not
claim arbitrary browser writes become exactly once; uncertain outcomes require reconciliation.

**Screen decision gate.** The user reports lag in the expanded screen while manually controlling
a bot on a hosted/remote server. MOD-SC-01 captures a real timing/load baseline. MOD-SC-02 compares
current RFB, KasmVNC first and Selkies as the alternative, preserving one full desktop per bot
inside the user computer. MOD-SC-03 selects one path and ratifies its media/input/security contracts
before integration. Do not commit to both a major custom pump rewrite and a replacement streamer.
Native client input must preserve server control authority and recording before forwarding;
private ports or client view-only settings alone do not authorize input. Keep non-root execution,
Chrome sandbox/seccomp probing, target-profile persistence and normal restart/restore behavior. Browser-page-only
streaming and screenshot polling cannot replace the required full desktop. Protocol/licensing,
CPU-only hosted performance and actual provider tunnel compatibility are selection criteria.

**Dependency experiments.** Streamdown is the transcript-rendering candidate; Tiptap remains a
feature-scoped artifact-editor evaluation within office tasks. A narrow Docker lifecycle service
reduces the orchestrator's privileged surface. MOD-DU-01 compares reusable execution recovery,
with DBOS first if an engine earns its integration cost and Temporal only when justified; use one
run/interrupt/recovery authority and retain BullMQ's scheduling role. Optional MOD-OP-01/02 evaluate
BullMQ PostgreSQL and public-research MCP without mandating Redis removal, a crawler or service
purchase. Slack/voice, a learning service and external coding runtimes remain outside this migration
unless their existing feature scope is separately authorized. No Hono/Bun/ORM/auth rewrite or
CopilotKit Intelligence purchase is implied.

**Board/gates.** New work lives in the `Modernization` lane with stable `MOD-*` IDs and explicit
prerequisites. This is a cross-cutting program, not a renumbering or weakening of D-034's historical
numbered milestone order. MOD-RV-01's transitive closure covers all required MOD tasks; only the
two explicitly optional evaluations may wait. Every task starts in backlog. Implementation models
must follow dependencies, contract gates, meaningful checks and evidence, with a fresh base after
each merge. Existing completed milestones retain their status. Existing M9/office tasks gain
specific reuse/acceptance boundaries rather than duplicate stores, engines or release gates.

MOD-RV-01 requires target provider/message/approval/usage behavior, hosted-screen measurement,
ownership and runtime restoration evidence, clean installation/deployment and actual removal of
replaced mechanics. Deployment rollback and historical data/client migration are outside scope. It does not pass CC-10, the open M10 real-model reference scenario, office gates or
M9 commercialization. M9 keeps tenant, credential, all-provider recovery, backup and economics
acceptance; its launch gate also requires MOD-RV-01 and existing CC-74/75/76/77 privacy/site/legal promise work.
Encryption/region/privacy reporting are not delivered merely by adopting TanStack persistence.

---

## D-159 · The modernization's shared contracts: one thread per bot, server-owned history, durable interrupts

**Status:** accepted · **Task:** MOD-01 · **Touches:** §3 (`Message`, `AgentTurn`, two new tables),
§4.1, §4.2, the guards in `eslint.config.mjs`

D-158 chose TanStack AI with native AG-UI and left the names to be ratified before code.
[MOD-01-TARGET-CONTRACTS.md](plans/MOD-01-TARGET-CONTRACTS.md) is the full matrix, with the inventory
it was derived from and the package versions it was read against. The rules every later MOD task
codes against:

- **Identity.** `threadId` is `Conversation.id` (one per bot); `runId` is `AgentTurn.id`, minted by
  the server, with the client's proposed id kept only as a per-thread idempotency key; a new user
  message keeps a well-formed client id; ownership always comes from the bot's owner.
- **Conversation delivery moves off §4.2.** `POST /bots/:id/chat` takes an AG-UI `RunAgentInput` and
  answers a durable SSE stream; `GET /bots/:id/chat?threadId=` hydrates (transcript, `activeRun`,
  pending interrupts); `GET /bots/:id/chat?runId=&offset=` joins a run's log. They replace
  `POST`/`GET /bots/:id/messages` and `GET /bots/:id/approvals`. `message.delta`, `message.part`,
  `message.completed`, `message.attachments`, `turn.step`, `approval.requested` and
  `approval.respond` leave the socket; `run.started {botId, threadId, runId}` joins it; `WIRE_VERSION`
  becomes 2 with no v1 reader kept.
- **The server owns history.** Stored ids in a request are ignored, new messages must be user
  messages, the user message and its attachment claims are committed before the run starts, and the
  run loads the server copy. `forwardedProps` admits `attachmentIds` only; client tools, context and
  state grant nothing. This closes the library's merge-by-id cutoff, which would otherwise let a
  stale client transcript delete server rows.
- **Canonical transcript.** One `Message` row per TanStack `ModelMessage`, ordered by a per-thread
  sequence reserved when a message begins. SYSTEM rows are product messages the model never sees.
  Product facts are columns projected into `metadata.crewaid`; attachments are references expanded at
  call time. `loadThread` returns the whole thread; the `/new` boundary, history budget and
  compaction transform provider input only. `saveThread` reconciles by id and never deletes.
- **Runs use the library's vocabulary.** `running`, `interrupted` (waiting for a person, not
  terminal), `completed`, `failed`, `aborted`. Today's crash-time `INTERRUPTED` is retired: a dead
  worker's run is `failed` with `WORKER_LOST` until MOD-DU-02 decides recovery.
- **Approvals are durable rows (`RunInterrupt`), superseding D-067.** Per-call policy lives in
  middleware — `onInterruptBoundary` at `beforeTools` asks, `onBeforeToolCall` re-checks at dispatch —
  because the library's `needsApproval` is a static boolean. One interrupt definition,
  `crewaid.tool-approval`.
- **The delivery log is Postgres (`RunEvent`).** Redis may carry wake-ups, never content. Replay never
  runs a producer or bills. Clear and delete remove the matching events in the same transaction.
- **`bot.cancel` is the cancel.** A closed stream is a disconnect; the run continues.
- **Clear, delete and `/new` are refused `409` while a run is `running` or `interrupted`.**
- **Guards.** The desktop may import `@tanstack/ai-react`, `@tanstack/ai-client`, `streamdown` and
  `@tanstack/ai` types; provider adapters, persistence, MCP, compaction and BYOK paths stay banned.
  Shared bans `@tanstack/*` and `@ag-ui/*`. TanStack enters the orchestrator through a bounded set of
  seam directories that MOD-02 allow-lists with a probe. R10 bans `@tanstack/ai-mcp`.
- **Pre-launch install.** Migrations are appended to the journal; destructive ones are allowed; the
  development reset stays V1-17's guarded `pnpm db:reset`, extended only if a new store keeps run
  state outside Postgres.
- **Evidence** lives in `docs/reviews/evidence/mod-<id>/`; **budgets** come from MOD-03 and MOD-SC-01
  baselines and are ratified before the gates they protect.

Six library behaviours these rules rely on are listed for MOD-02 to prove with real builds before any
dependent task starts (§7 of the matrix). If one fails, MOD-02 records the replacing decision.

---

## D-160 · The pinned TanStack set, and what running it changed in D-159

**Status:** accepted · **Task:** MOD-02 · **Touches:** both apps' manifests, `scripts/check-pins.mjs`,
`eslint.config.mjs`, D-159 §3.1/§3.5/§3.10

MOD-02 installed the set D-159 named and ran it: a real Nest server, the real browser-side client
and the reference AG-UI client, with a scripted model. Evidence is in
`docs/reviews/evidence/mod-02/` (24 drift, 16 compatibility and 3 renderer-bundle tests, 22 probes,
8 of 8 falsifying mutations caught).

**The set.** Orchestrator: `@tanstack/ai` 0.64.0, `-persistence` 0.7.2, `-compaction` 0.1.12, `-mcp`
0.7.0, `-openai` 0.26.0, `-anthropic` 0.19.4, `-openrouter` 0.20.2; dev-only `@tanstack/ai-client`
0.36.1, `@ag-ui/core` 1.0.0 (the protocol the core pins) and `@ag-ui/client` 1.0.1 (the reference
client). Desktop: `@tanstack/ai` 0.64.0, `@tanstack/ai-client` 0.36.1, `@tanstack/ai-react` 0.29.4,
`streamdown` 2.7.0. All are load-bearing in `check-pins.mjs`, and
`mod-02-dependency-drift.test.ts` checks the installed copies against the manifests, the peer
ranges against the installed core, and that every package resolves the **same** core copy
(`@tanstack/ai-mcp` depends on it rather than peering, so a bump could otherwise install two).
The old AI SDK packages stay until MOD-AI-15. Playwright stays the desktop's 1.62.1 pair;
MOD-BR-03 adds `playwright-core` at the same pin.

**D-159 amended — three places the libraries disagreed with the plan:**

1. **§3.1: the client's run id is the run id.** The stock client keeps the id it proposed for its
   resume state and never adopts the one `RUN_STARTED` announces; a generic interrupt's binding
   then names a run the client does not know, and the approval is silently never submitted. So
   `POST /bots/:id/chat` takes the proposed id, insert-if-absent, and refuses `409` an id that
   already names a run on another thread. Ownership is unchanged: it still comes from the bot,
   never from the id.
2. **§3.5: one *running* run per bot.** A continuation is a new run with no parent link, and the
   paused run stays `interrupted` after its interrupts are answered. The `activeKey` fence covers
   `running` only. The admitting route records which paused run a resume answered, because nothing
   else knows.
3. **§3.10 and §3.3 rule 6: an `interrupted` run blocks only while it has pending interrupts.**
   Clear, delete, `/new` and a new user message are refused `409` while the thread has a `running`
   run or pending interrupts; an answered pause blocks nothing.

**Two rules the policy middleware must follow (MOD-AI-02, MOD-SE-02):** the `beforeTools`
boundary fires again on the continuation, so the policy consults resolved interrupts for the same
tool call before asking; and the resume entry carries the continuation's definition id, key,
payload and schema hashes from the client, so it is validated against the stored interrupt and
never trusted.

**Guards.** The renderer may import `@tanstack/ai-react`, `@tanstack/ai-client`, `streamdown`, and
from `@tanstack/ai` only types and `defineInterrupt`; everything else of the stack is banned there,
and the R1 ban on `ai` is now an exact path (as a pattern it also matched `@tanstack/ai`). Shared
bans `@tanstack/*` and `@ag-ui/*`. In the orchestrator, `@tanstack/ai*` and `@ag-ui/*` are
importable only from `agent/execution`, `agent/persistence`, `models`, `mcp`, `billing`, `telemetry`
and tests; a new seam is added with a decision. R10 bans `@tanstack/ai-mcp`. Five probes.

**For later tasks.** Set `history.pageSize` on the client so only unknown messages are sent
(MOD-AI-08); key nothing on stream-only part metadata; normalise Anthropic's fresh-only
`promptTokens` (MOD-AI-01); route custom endpoints through the SDK clients' `fetch` option for
D-085; configure Streamdown's HTML handling deliberately (MOD-MD-01); pin the image's Chrome inside
Playwright's window — it installs `google-chrome-stable` unpinned (MOD-SC-06).

---

## D-161 · The chat path's baseline: goldens for what a bot is told, budgets for what a turn costs

**Status:** accepted · **Task:** MOD-03 · **Touches:** tests only; `turbo.json` `globalEnv`

MOD-03 asked for the behaviour the modernization must keep, in a form a later task can be held to.
`docs/reviews/evidence/mod-03/` holds it.

- **The behaviour inventory** (`behavior-inventory.md`) lists 40 behaviours of the chat path. For
  each: the decision that defines it, the suites that pin it today, and whether those suites drive
  AI SDK mocks, need Postgres, Docker or a real model. It also names the MOD task that re-proves it
  on the TanStack stack. 67 of the orchestrator's 243 test files on `main` drive the AI SDK directly. Every
  one moves to a TanStack stub or is deleted with a named replacement before MOD-AI-15 removes the
  SDK.
- **The goldens are the migration's executable spec.** `mod-03-golden.integration.test.ts` runs six
  canonical scenarios (cold turn, history, `/new`, a tool round, reasoning, a provider refusal)
  through the real coordinator and Postgres. It reduces each to a stack-neutral summary: system
  blocks as length and hash with ids replaced, messages as role, part kinds and text, tool order,
  cache breakpoints, the transcript, and the turn's counters. `fixtures/mod-03/golden.json` is the
  answer. MOD-AI-05 runs the same scenarios on the TanStack path. Every difference it means to
  make, such as one row per model message (D-159 §3.4), is written down beside the regenerated
  golden, never absorbed silently. Each scenario runs as its own user, because the team block and
  workspace memory would otherwise leak one scenario into the next.
- **The server-side budget.** `mod-03-baseline.bench.integration.test.ts` uses a scripted model with
  zero latency, so what it measures is the orchestrator's own cost. On this baseline a 40-word text
  turn takes p50 138 ms / p95 164 ms, with the first delta at p50 24 ms. It writes ~50 tuples and
  commits ~103 transactions, because the partial reply is persisted on every delta. A tool round
  takes p50 65 ms. The machine and figures are in `baseline.json`. **Budget:** on the same machine,
  turn and first-delta p95 may not exceed baseline + 10%. Tuple writes per turn are recorded, not
  budgeted, until MOD-AI-07 chooses how the delivery log batches. That choice is ratified with its
  own write budget, and it must stay inside the latency budget.
- **The real-model baseline is outstanding, and it gates MOD-AI-13.** The session that wrote this
  had no provider credentials. `real-model-runs.sh` is the runnable reference set: the CC-18 cases
  in process and as real turns on a live orchestrator, with latency and tokens read back from
  `GET /bots/:id/turns` and `/usage`. `EVAL_KEEP_BOTS=1` keeps the turns that deleting a bot would
  cascade away. The chat cost and real-latency targets are ratified from its numbers, on the AI SDK
  stack before the TanStack one replaces it. MOD-AI-13 cannot pass without both runs.
- **Gaps recorded rather than fixed here.** `ProviderModel.supportsTools` is stored and never read,
  so a tool-less model is still sent every built-in. MOD-AI-01 honours it or records it as advisory.
  Edited approval arguments do not exist today, so they get new tests, not a baseline.

---

## D-162 · The real-model chat baseline, and the targets the TanStack path must meet on it

**Status:** accepted · **Task:** MOD-03 (closes the item D-161 left open) · **Touches:** tests only

D-161 left the real-model baseline open for lack of credentials. It now exists, on
`openrouter:z-ai/glm-5.3-flash`. The evidence is in `docs/reviews/evidence/mod-03/real-model/`, and
it cost $0.0175. There are two parts:

- **Behaviour.** The CC-18 eval runs in process: 7 of 10 cases pass.
- **Cost and latency per turn.** `mod-03-real-model.bench.integration.test.ts` drives real turns
  through the coordinator, the AI SDK backend, a real provider and Postgres. It has a fake computer
  and no HTTP shell. Each figure is read back from the turn's own `AgentTurn` row. Five samples of
  each of four shapes gave 25 turns and none failed. A one-sentence answer is ~6.2k input tokens:
  the fixed prefix is the turn. First delta lands at p50 0.7–1.0 s. Turn time is p50 2.0–8.9 s, and
  the provider's p95 tail reaches 24 s.

**Targets for MOD-AI-13.** Run both stacks the same day on the same model and machine class, with
`MOD03_REAL_SAMPLES=10` per shape. A retired model is replaced by its successor on both stacks, and
the replacement is recorded.

- No failed turns.
- First-delta p50 per shape no worse than the AI SDK's +20%. Provider variance is wide, and the
  scripted baseline (D-161) already budgets the orchestrator's own share tightly.
- Mean input tokens per shape no worse than +5%, except where compaction (MOD-AI-10) lowers them.
  Cost follows tokens at the provider's price, so it is not budgeted separately.
- Every behaviour case that passes on the AI SDK the same day passes on TanStack.
- p95 is recorded, not budgeted: five or ten samples of a routed provider do not bound a tail.

**A defect the run found, owned by MOD-AI-01/05.** On this model the first reply in one case was
tool-call markup written as text (`<invoke name="memory_read">…`). It was stored as the bot's
words, and nothing in the stack noticed. A reply that is a provider's tool syntax is neither a
message nor a tool call. The TanStack path must either turn it into the call it names, when the
adapter supports that model's format, or fail the step with a D-006 code. It must never store it
as text. The behaviour eval's sycophancy case is the regression check.

**Also recorded.**
- The CC-18 harness now reports "called without the argument" separately from "not called".
- R4's samples share one account, so later samples see the workspace memory the first one wrote.
  A per-sample account is a follow-up, not a defect in the numbers recorded.
- Orchestrator-mode eval needs the sandbox image, which cannot be built behind an HTTPS-only egress
  proxy (its package sources are plain HTTP). The product-turn suite covers the same turns.

## D-163 · Seat control: one human driver per seat, a drain before the grant, an observation after

**Status:** accepted · **Task:** MOD-BR-01 · **Touches:** `packages/shared` (schemas only), docs

`docs/plans/MOD-BR-01-SEAT-CONTROL.md` is the contract. MOD-BR-02 implements the barrier,
MOD-BR-03 the observed references and MOD-BR-05 the lease hardening. Nothing here runs yet.

**What changes from today.** Watching a seat stops being permission to drive it. Today
`ScreenService.input` takes input from any subscribed socket, and nothing pauses the bot while a
person types into the same display.

**The rules several tasks code against.**

- **Four things stay separate.** A view subscription grants pixels. A control lease grants input
  and pauses the bot's seat actions. An identity grant (`BotIdentity`) is an approval record. An
  identity lease says which seat's Chrome holds that login now. None of them implies another.
- **Control is server-authoritative, one holder per seat, fenced by an epoch.** A `take` drains
  the bot's in-flight seat actions before the grant. A drain that times out is refused
  `DRAIN_TIMEOUT` and the bot keeps the seat: exclusivity is never claimed for a seat that did not
  drain. There is no stealing, and the lease's expiry bounds an absent holder.
- **A hand-back requires a fresh observation.** It releases every key and button the server saw
  held, invalidates every browser reference, and refuses the bot's next seat action
  `OBSERVATION_REQUIRED` until it reads the page or takes a screenshot.
- **Admission covers every seat path.** That is the browser tools, desktop input, `shell`,
  `run_skill` and `use_identity`, at the one place a tool call is dispatched and again at the
  bridge for skill replays. Reads are always allowed, and recording control is allowed so that
  teaching still works.
- **A stale reference is refused, never guessed.** References are bound to a browser generation
  and a snapshot generation.
- **A named login moves only after its holder exits.** The bridge decides, checked against
  Chrome's `SingletonLock`. The orchestrator mirrors what the bridge reports and never tells a bot
  a login is free on its own knowledge.
- **The computer is one trust domain.** Bots on it share a Unix user (D-046). The barrier gates
  the supported paths; a bot's background process, or another bot's `shell` naming this display,
  is a documented bypass, not isolation broken.

**Ratified names.** These are the frames `screen.control` and `screen.control.state`, the eight
refusal codes, and `SEAT_CONTROL_DRAIN_MS`, `SEAT_CONTROL_LEASE_MS` and
`SEAT_CONTROL_AGENT_WAIT_MS`. Their payload schemas are in `packages/shared/src/seat-control.ts`
with fixture pairs. They sit on no frame registry until MOD-BR-02 implements them, so no reducer
or gateway answers them yet.

**Rejected.**

- **Pre-empting a login's holder.** Closing another bot's Chrome mid-action to hand its login on
  loses that bot's work silently. The operator closes it from the UI, which flushes first.
- **Stealing control.** A second viewer's `take` while a person drives would turn every open
  window into a tug of war. The lease expires in seconds when its holder goes quiet.
- **Holder ids on the wire.** `holder` is `self`, `other` or `null` relative to the receiving
  socket, so no session or socket id leaves the server.

## D-164 · Effects are decided per call, and an approval is bound to the call it was given for

**Status:** accepted · **Task:** MOD-SE-01 · **Amends:** D-092, D-144, D-065, D-057 ·
**Touches:** `packages/shared` (schemas only), docs

`docs/plans/MOD-SE-01-EXTERNAL-EFFECTS.md` is the contract. MOD-SE-02 implements it, MOD-AI-02
carries the binding in `crewaid.tool-approval`, and V1-OFF-10 writes the first commit adapter.
Nothing here runs yet.

**What was wrong.** Three gaps let an approval reach further than the operator meant:

- D-092 made every browser action `contained`, so once a seat held a named login, every click in
  it ran unasked, in that turn and every later one.
- D-065 remembered approvals by bare tool name. Approving `shell` with `ls` approved `rm -rf` for
  the rest of the turn.
- Nothing compared what was approved with what ran.

**The rules.**

- **Four effects, decided per call:** `read`, `draft`, `commit`, `unknown`.
  - A seat action is `draft` on the bot's private profile and `unknown` on a named login. Crewaid
    does not claim to tell a click that opens an email from one that sends it.
  - Only a commit adapter (Crewaid code bound to one tool) makes a call `commit`. What an MCP
    server says can lower a call to `read` (D-107) and never raise it.
  - **Authority** is a separate flag, for the tools that create what runs later without a person:
    `use_identity`, the bot tools, `save_skill`, `schedule_routine`. They always ask in AUTO.
- **The modes keep their names and promises.** ASK asks about everything but a read. AUTO lets
  the rules decide, then allows reads and drafts and asks about the rest. FULL asks nothing. A
  `deny` rule, an unregistered name and a revoked grant refuse in every mode, FULL included.
- **An approval covers the call it was given for.** It binds to the tool behind the plugin door,
  the effect, a hash of the final arguments (RFC 8785), a hash of the bot's access grants, the
  seat's login and browser generation, and an adapter's account, destinations and content
  revision. All of it is recomputed immediately before dispatch. A difference skips the call
  `APPROVAL_STALE` and asks again; a revoked grant refuses it `GRANT_REVOKED`. Memory by bare name
  survives only for `draft` under ASK.
- **One wider approval: the identity window.** Approving `use_identity`, or the first seat action
  of a turn on a seat already on a login, covers seat actions on that login and browser generation
  for the rest of the turn. Asking about each click on a login is the babysitting D-092 removed,
  and a click cannot be classified any finer. ASK never opens the window.
- **The operator may edit the arguments.** An edited call is validated, decided again (a `deny`
  still denies), bound and dispatched, and the model is told what ran.
- **Untrusted input grants nothing.** Pages, files, email, MCP results and descriptions, memory, a
  teammate's message and a skill's output reach the model as data. Policy inputs are written only
  by the operator over authenticated routes, and no tool's input schema names one. The client
  grants nothing (D-159 §3.3, D-160). Enforcement is the policy service at dispatch, never the
  prompt.

**What it amends.**

- **D-092:** `reach` is derived for the wire, so `ToolInfoSchema` keeps its two values.
  `contained` is `read`, or `draft` without authority. A browser tool on a login reports
  `sensitive`.
- **D-144:** `observes` becomes `read`, and `acts` becomes the other three effects.
- **D-065:** memory is still per turn, keyed by binding. A turn now spans the continuations that
  answered its interrupts, and the memory is read from their durable rows.
- **D-057:** approving `use_identity` still creates the grant. It no longer leaves the login open
  to unasked clicks in later turns.

**Rejected.**

- **Classifying clicks** by selector, label or network request. It is wrong in both directions,
  and the wrong direction sends mail.
- **Asking about every click on a login.** That is safe on paper, but in practice the operator
  stops reading the question, which D-092 measured.
- **Keying memory on arguments for drafts too.** It brings back the per-step prompts D-065
  removed, for effects the operator can undo.
- **Stated non-goals.** Data egress is the network policy's job, not approval's. A person's own
  account signed into a bot's private profile is the bot's account. Another bot's `shell` can read
  any profile on the computer (D-046).

## D-165 · The canonical transcript is the library's message, one row each, and a run speaks the library's statuses

**Status:** accepted · **Task:** MOD-AI-03 · **Touches:** §3 (`Message`, `AgentTurn`,
`Conversation`, new `RunInterrupt`, `RunEvent`), §4 (`TurnStatusSchema` values)

`docs/plans/MOD-AI-03-TRANSCRIPT-SCHEMA.md` is the contract, and migration
`20261003170000_d165_transcript_runs` creates it. MOD-AI-04, -06 and -07 build the stores on it.

**The rules.**

- **One engine per thread.** `Conversation.engine` is `AI_SDK` or `TANSTACK`, and a thread keeps
  its engine for life. Neither engine reads the other's rows, so there is no converter and no
  mixed thread. A development database with the wrong engine's threads is reset, not migrated.
  MOD-AI-15 drops `AI_SDK` and the columns only it writes.
- **A TANSTACK thread is `ModelMessage[]`, one `Message` row each.**
  - The row id is the message id.
  - `parts` holds the body without its id, time or metadata, defined by one strict schema.
  - User content is text. Attachments are references, turned into parts at call time.
  - Tool calls keep their raw arguments and provider metadata. Reasoning keeps its signature.
  - Only the library's `metadata.tanstack` is stored: the run tag reload needs, and a tool
    result's outcome. A client's metadata never is. Product facts are columns, projected on read
    as `metadata.crewaid`.
  - Every row has a stable id. A tool result and an interrupt's text have none from the engine,
    so the store derives one from the thread, the run and the call id (or the body), and the
    same message saved twice updates one row.
- **Authors stay the product's.**
  - The user is `USER`.
  - The thread's bot is `BOT`, on its assistant rows.
  - A tool result is `TOOL`.
  - A teammate's message is `BOT` with the sender's id, and the model reads it as a user turn.
  - SYSTEM notices and `/new` boundaries are product rows the model never sees.
- **Order is `Message.sequence`.** It is a global serial, taken when a message begins. It is an
  `Int` rather than a `BigInt`, because rows reach JSON in many places.
- **`AgentTurn.status` is the library's `RunStatus`:** `running`, `interrupted`, `completed`,
  `failed`, `aborted`.
  - The old `INTERRUPTED` (the worker died) is `failed` with `errorCode = 'WORKER_LOST'`.
  - A failed run's `errorCode` is its D-006 code and never vendor text.
  - The wire's `TurnStatusSchema` changes with it.
  - The routine `RunStatus` enum is a different vocabulary and is unchanged.
- **Runs gain** `conversationId` (required), the library's nullable fencing fields,
  `resumesRunId` (D-160's continuation link, which bounds D-164's turn) and `eventsClosedAt`.
- **`RunInterrupt`** (insertion-ordered by its own sequence) and **`RunEvent`** (a `BIGSERIAL` id
  that is the offset) carry `userId` directly and cascade with their run and thread.
- **Product semantics hold.**
  - A run's several assistant rows count once as unread.
  - Memory and deliverables keep `SetNull` when a message is deleted.
  - Attachments cascade with their message.
  - Topic boundaries stay SYSTEM rows.
- **One mapper,** `agent/persistence/transcript.ts`, is where rows become library records. Every
  crossing is a `safeParse`, and nothing is cast.

**Rejected.**

- **Storing the library's UI message instead of `ModelMessage`.** The store contract is
  `ModelMessage`. A second shape would make hydrate and the model read different transcripts.
- **A per-thread counter for order.** Both engines would have to take it on every insert. A global
  serial orders every thread with no allocation code.
- **Keeping the old status names and translating at the store.** D-159 chose one vocabulary so
  that nothing translates on the way through.

## D-166 · The message store reconciles under a thread lock, and a run takes its place in line before it speaks

**Status:** accepted · **Task:** MOD-AI-04 · **Touches:** orchestrator persistence, D-147's delete
path

`apps/orchestrator/src/agent/persistence/prisma-message-store.ts` is the library's `MessageStore`
over `Conversation` and `Message`, through the one Prisma client and the D-165 mapper.

**The rules.**

- **A store belongs to one principal, and to one run while it writes.** The library passes a bare
  thread id, so the principal is what turns "this thread is yours" into a check. A thread the
  principal does not own loads as empty and refuses a save, the same answer as a thread that does
  not exist (D-010). A thread of the other engine is refused, not read.
- **A save locks the thread.** `FOR UPDATE` on the conversation row, joined to its owner in the
  same statement, serializes two saves of one thread. Without the lock, the concurrent-save case
  fails two runs in three.
- **A save reconciles; it never deletes** (D-159 §3.4).
  - It inserts the messages it does not have.
  - It updates the body of the ones that changed. Author, sender, run and product columns are the
    row's own, written once by whoever created it.
  - It refuses an id that names another thread's row, and nothing of that save is written.
  - A stored message the save left out is kept and logged.
  - An empty or short save cannot truncate the thread.
- **A stale writer is refused.** A save from a run that is no longer its thread's newest run is a
  worker that lost the run, still flushing what it held. It gets `STALE_WRITER`.
- **A message takes its place before it speaks.** `reserve` inserts an assistant row when its
  stream starts, and a tool result's row (under its derived id) when its call starts.
  - A user message admitted mid-run then sorts after them.
  - The next run reads the conversation in the order it happened: a tool result never lands
    between its call and a later user message.
  - A reservation never clobbers what a save wrote.
  - MOD-AI-05 calls it from the run's chunk middleware.
- **Deleting a message deletes its replay.** D-147's delete removes the event log of every run
  that wrote or answered the message, and a clear removes the thread's whole log and its pending
  interrupts, in the same transaction (D-159 §3.7, §3.10).

**Not the library's conformance suite, for messages.** Its message cases save id-less user
messages to threads nobody owns and expect a short save to delete the rest. Crewaid refuses the
first and keeps the rest, by D-010 and D-159. `mod-ai-04-message-store.integration.test.ts` pins
what the store does instead:

- new and existing threads, and product columns surviving;
- empty and short saves, and concurrent saves;
- all-or-nothing writes;
- owner denial, the other engine, and stale writers;
- body updates, and ordering by reservation.

The run and interrupt stores (MOD-AI-06) do run the library's suite, since nothing there departs
from its contract.

## D-167 · One TanStack adapter per resolved model, built from the binding, read in Crewaid's units

**Status:** accepted · **Task:** MOD-AI-01 · **Touches:** `models/tanstack/`, `normalize-error.ts`

`buildTextAdapter(binding)` is the TanStack half of `buildLanguageModel`, under the same rules: the
key comes from the binding the owner-scoped vault decrypted, never from the environment, and one
adapter serves one resolved model for one turn. MOD-AI-05 calls it.

**Which adapter, per connection kind.**

| Kind | Adapter | Why |
|---|---|---|
| `openai` | `OpenAITextAdapter` (Responses) | The API the AI SDK's `languageModel` uses, and the one that returns an o-series model's reasoning |
| `anthropic` | `AnthropicTextAdapter` | It calls the SDK's beta Messages client (`/v1/messages?beta=true`) |
| `openrouter` | `OpenRouterTextAdapter` | Reasoning arrives as `reasoning_details` |
| `custom` | Crewaid's `CompatibleChatAdapter` over Chat Completions, with the guarded fetch (D-085) | The base adapter reads no reasoning; the subclass reads `reasoning_content` and `reasoning`, as the AI SDK's compatible provider does |
| `crewaid` | refused here | The billing module builds it with its meter (MOD-AI-11) |

**The rules.**

- **A model id is validated at runtime.**
  - It must have the shape of an id (`UpstreamModelIdSchema`).
  - It came from the user's own catalog row.
  - Whether it exists is the provider's to answer, as a D-006 error.
  - The adapters type a model as the list their release shipped with, and Crewaid's baseline model
    (`z-ai/glm-5.3-flash`) is not on OpenRouter's list. So there is exactly one documented
    assertion from the checked id to the adapter's model type. At runtime every adapter passes the
    id through untouched.
- **Usage is all input, with the cache as parts of it** (D-009(3)). `normalizeUsage` maps the
  library's `TokenUsage` per provider family:
  - OpenAI-compatible APIs count a cached read inside `prompt_tokens`.
  - Anthropic's input is only the fresh part, so its fresh 100, write 200 and read 300 become 600
    input, 300 cached and 200 written, not 100.
  - A provider that reports no usage gives `null`, not zeros. Unknown must not price a call as
    free.
- **Errors keep D-006.** `normalizeRunError` reads a `RUN_ERROR`'s `{ message, code }`, where the
  code is the provider's error code or the HTTP status. It does so through the same status table
  and the same operator sentences as the AI SDK path. The vendor's text goes to `detail` for the
  log only.
- **Retries are the SDKs'**, as the AI SDK's were. OpenAI and Anthropic retry a 429, a 5xx and a
  connection failure twice; OpenRouter retries 5xx. A redirect the guard refuses is retried as a
  connection failure and still never followed.

**Evidence** (`test/mod-ai-01-adapters.test.ts`, 39 cases on a loopback stub speaking each API's
own wire format). Each of the four adapters:

- streams text;
- runs a tool round, sending the result back;
- streams reasoning apart from the answer;
- sends an attached image;
- closes its request when cancelled;
- reports a 429 and a 401 as `RATE_LIMITED` and `AUTH_FAILED`, with no vendor text or key in any
  event.

The custom endpoint also refuses a private address and a plaintext URL before any request, and
never follows a redirect. Unknown usage stays `null`. A live case, on demand, ran the OpenRouter
adapter against `z-ai/glm-5.3-flash`, with text and a tool round.

**Two adapter behaviours to know.**

- TanStack's Anthropic adapter takes usage from `message_delta` only. The API reports it there
  cumulatively, input included, so it is complete. A proxy that sends the older shape (output
  only) would read as zero input.
- The adapters do not gate on capability. A model whose catalog row says it takes no tools must
  not be sent tools, and `ProviderModel.supportsTools` is still unread (D-161). The backend that
  assembles a turn (MOD-AI-05) owns that check.

## D-168 · Transcript writers require a run and preserve a row's role

**Status:** accepted · **Touches:** D-165/D-166, `AgentTurn`, transcript stores

A hydration store (`runId: null`) is read-only: saves and reservations refuse
`STALE_WRITER` after the owner/engine checks. A body update cannot change the stored
message role or overwrite a SYSTEM notice. A reservation that collides with another
thread's id or an incompatible role refuses `CONTRACT_VIOLATION`, rather than silently
skipping the insert.

`AgentTurn.sequence` is a global serial, allocated on insertion. It determines the
newest writer; `startedAt` is display time. Equal millisecond timestamps and client
chosen run ids cannot choose the writer. MOD-AI-06 must claim a new run under the same
conversation lock before exposing it. Its driver epoch additionally fences a recovered
worker; this serial is ordering, not a substitute for that fencing.

## D-169 · Seat admission is shared, and input names the lease it was sent under

**Status:** accepted · **Task:** MOD-BR-02 · **Touches:** D-163, screen input envelope,
server skill admission, desktop control

One `SeatControlService` admits supported seat mutations and counts them until they
finish. Every mutation requires a successful observation after hand-back, including
navigation, shell and identity changes. Observations capture the agent epoch at start;
failures or reads from an earlier epoch cannot clear the freshness requirement.

The registry gates browser, pointer, keyboard and shell tools. `SkillRunService` gates
the whole replay for model, HTTP and routine callers, avoiding a nested admission that
could deadlock draining. Cancellation ends a waiting admission; an executing replay
keeps its admission until the bridge has returned its outcome. A takeover that cannot
drain is refused. A transport loss ends control immediately, and first contact with a
replacement display releases modifiers and buttons again. Fresh observed element
references remain MOD-BR-03's implementation over this epoch/freshness fence.

Client input retains the bot header of D-035, followed by eight big-endian bytes for
the lease epoch, then the unmodified RFB event. Epochs are positive JavaScript safe
integers. Server pixel frames retain D-035's header and carry no epoch. An input frame
without the current holder's epoch is refused; old queued input cannot become valid
when the same socket reacquires control. This is a coordinated pre-launch change,
with no legacy input decoder. The client remembers grants only on its current socket
and clears them on disconnect.

Renewal is every 10 seconds while the expanded window has focus, independent of wall
clock skew. `SEAT_CONTROL_LEASE_MS` must be at least 15000, and all three seat timers
must fit Node's positive 32-bit timer range. Closing the expanded view releases its
lease. Viewing alone conveys no input authority. Raw execution outside the supported
APIs, including background shell processes or another bot targeting this display, is
outside the same-UID cooperative barrier described in D-163 §3 and must be disclosed
beside the control UI; it is not an OS isolation claim.

### Sandbox acknowledgement of control

The private bridge implements `POST /seats/control?botId=<id>` with an opaque,
per-request `token`, `action` (`take`, `renew`, `release`), and positive bounded
`leaseMs`/`drainMs` for take. This is an internal sandbox protocol, not a new
public ownership route. Provider endpoint headers remain required. Tokens are
unique across orchestrator boots; a late release cannot release a newer holder.

The bridge blocks new skill replays while draining or held and counts each
replay until its runner exits. A runner timeout terminates and reaps its process
group before releasing replay admission, so a pending supported desktop child
cannot outlive the timeout. Taking control waits for this count to reach
zero, including replays dispatched before an orchestrator restart. The
orchestrator remains in `draining` until that acknowledgement arrives. If the
requester left meanwhile, it releases only that request's remote token.
Local lease deadlines start before the remote request, so they cannot extend
beyond the remote lease due to network latency. Renewal extends local control
only after the bridge acknowledges it. A failed hand-back leaves the bridge
fenced until expiry; it never silently permits a replay during human control.

Bridge memory is the replay authority for the lifetime of a computer. The
image supervisor does not restart the bridge in place: a bridge exit ends
the entire container and its runner processes. Replacement closes the screen
transport and invalidates control. Background/raw commands remain outside the
cooperative guarantee above.


## D-170 · Browser actions use native Playwright snapshots and observed references

MOD-BR-03 uses the pinned `playwright-core` 1.62.1 public APIs. It connects over CDP
only to the already authorized bot seat endpoint, preserving provider relay headers
and rewriting Chrome's reported host and transport scheme to the provider endpoint. `noDefaults: true`
preserves the existing profile and desktop settings. No browser, context or hidden
page is launched by the driver. Disconnecting the client leaves Chrome and its
profile alive; recording and screenshot capture remain independent connections.

`browser_read` returns `Page.ariaSnapshot({ mode: 'ai' })`, including native iframe
references. Each successful read replaces the previous reference set. Native refs
are wrapped in a fresh opaque snapshot namespace owned by this turn's connection;
`browser_click` and `browser_type` accept `reference`, never CSS or a first-match
fallback. Only reference annotations in the returned, bounded snapshot authorize
an action. Playwright owns element resolution, strictness and actionability.
`browser_type` fills the referenced editable field and never echoes its value.

References are invalid after any frame navigation, popup/page replacement, lost
connection, identity reset, a newer snapshot, or a changed seat control epoch.
A read begun while a person controls the seat, or spanning an epoch change, can
report text but cannot authorize actions. Browser operations serialize per turn;
control admission still wraps every mutation until it finishes. Checking the
connection and seat epoch immediately before each action prevents an asynchronous
attach/read from reviving stale references. The bridge reports the actual `profile` and a safe-integer `browserGeneration`, zero
before lazy launch and increasing on every real Chrome launch. The bridge reserves the next generation in an atomic profile marker before launch,
using the greater of microsecond time and the last persisted generation plus one.
A registry restart or clock regression therefore cannot reuse a launch generation. References include the seat key and this launch generation, plus a fresh
snapshot nonce. A reconnect keeps Chrome's launch generation but creates a fresh
turn-local reference namespace. These namespaces also
prevent cross-bot/user/run references from naming a locator on another connection.

The initially existing first page remains selected, preserving the existing tab
choice. A popup opened by that page becomes selected; closing it returns to a live
page and requires a new read. Other pre-existing background tabs are not selected
by a guessed label. Reads report the selected URL. Navigation settles at DOM content
loaded with a bounded timeout; failures and cancellation stop outstanding loading
before disconnect, so the next turn can recover a never-committing navigation.
Actions and snapshots also have explicit bounded waits and accept cancellation.
Browser readiness probes both Chrome CDP and its relay, rather than trusting a
still-live PID while Chrome is shutting down. Discovery closes its HTTP connection
so the next turn cannot retain a socket to an exited relay at a reused port.

## D-171 — TanStack state and scoped PostgreSQL own execution recovery

MOD-DU-01 selects the existing Prisma/PostgreSQL run and interrupt records with
lease/epoch fencing for this migration. BullMQ retains scheduling and job delivery;
delivery is not execution authority. DBOS 5.2.11 was tested against the same native
TanStack approval/action workflow. Both approaches passed actual process crashes,
stale-owner rejection, duplicate delivery and lost-response reconciliation. DBOS
did not remove the common approval, ownership and effect ledger work and adds a
second workflow journal. Do not install DBOS or Temporal in the product runtime
for these tasks. The isolated comparison and rejected-alternative rationale are
in `docs/plans/MOD-DU-01-DURABILITY.md`.

MOD-AI-06 must claim under the conversation lock, allocate an increasing driver
epoch and fence all durable progress writes by owner and epoch. Reconstruct clients
from serializable owned IDs. Recover only expired leases; a new process must never
interrupt healthy workers globally. Interrupted approval runs follow D-160 and do
not retain the active-running fence. Native TanStack persistence and its validated
atomic interrupt batch remain the one continuation authority.

MOD-DU-02 must reserve and persist operation/outcome identities around external
dispatch, using an exact effect schema ratified before migration. Recovery first
reconciles an incomplete dispatch through a supported receipt/idempotency contract.
No receipt, a lost response or an expired lease proves that a remote action did not
commit. Unknown outcomes remain explicit and require resolution; never blindly
retry GUI/MCP writes. PostgreSQL fencing cannot stop an uncooperative remote request
already in flight. The bridge's independent seat admission, grant checks and
revision-bound approvals remain necessary. Model billing and event replay retain
MOD-AI-11/07 ownership; this selection promises no universal exactly-once effects.

## D-172 — Skill replay uses native Playwright on its existing private seat

MOD-BR-04 replaces skill-runtime's selector polling, input synthesis and CDP
transport with `playwright-core` 1.62.1, matching the agent driver. The image ships
the pinned library and its assets beside the bundled runner; nothing is installed
at computer startup. The runner lazily connects with `noDefaults: true` only after
the bridge confirms the same bot, seat and CDP port. No default/global endpoint,
browser launch, new context or hidden page is permitted. An X11-only replay does
not start Chrome. Disconnect leaves the existing browser/profile alive.

`ctx.page` retains click, fill, waitForSelector and waitForLoadState and adds
`frameLocator(selector)` scopes with click/fill/waitForSelector/nested frameLocator.
Locators use native strict resolution and actionability; there is no first-match,
force or coordinate substitute after a locator failure. Timeouts are finite
positive milliseconds, at most 60000, default 10000. Closing the session aborts
in-flight and queued browser actions, stops outstanding loading with a bounded
public CDP session, and disconnects. Fill failures do not expose supplied values.
The existing selected page's popup becomes selected; closing it returns to a live
existing page. Replay admission still covers the entire runner process and takes
precedence over browser mechanics (D-169).

Reviewed skills use persistent demonstrated selectors, never agent snapshot refs.
The compiler's recording candidate fence retains only main-frame, light-DOM CSS
forms whose recorder scope is known. A recorder's root-local text uniqueness is
not proof of native text-selector uniqueness, and a root-relative shadow selector
does not identify its host. Those rows and subframe demonstrations keep the real
X11 coordinates; do not invent frame/host paths from incomplete evidence. Explicit
frame paths in reviewed scripts are supported by native frame locators. Recording
CDP and correlation remain independent connections. Publication review, execution
grants, the actual seat display and human handback remain existing authorities.


## D-173 — A selected login is explicit; profile transfer waits for confirmed exit

Ratified 2026-10-04 for MOD-BR-05. This amends D-057/D-060 and implements D-163
§7 without a second login lease authority.

- `Bot.activeIdentityId` is a nullable foreign key to `Identity`;
  `Bot.identityRevision` is a monotonically increasing integer, initially zero.
  Grants remain `BotIdentity` permission records. Selecting A, then B, then A
  selects A regardless of grant age. A selection is usable only while its grant,
  owned bot and owned computer still agree. Private is represented by null.
  New development databases do not infer selection from historical grant dates.
- Selection/grant/revocation writes serialize under the owned computer row lock
  using the existing Prisma client. They increment the revision. This serializes
  creation of a named identity, too. Neither column claims a running lease.
- The bridge reports `identityRevision` on seats and remembers the highest
  requested revision per bot. Create/close requests carry that revision; a stale
  request cannot reopen an old selection or close a newer seat. Attach/allocation
  reconciles an existing seat against durable selection after a server crash.
  Seat creation remains lazy about Chrome. A parked named seat reserves its
  profile until explicitly released; it never ejects another bot.
- `use_identity` uses exclusive admission inside the existing seat control: it
  waits for other supported seat actions to finish and blocks new ones through
  the transition. A transition ends observed references and requires a new
  observation. Model access still passes the existing approval matcher; the
  revision-bound approval replacement remains MOD-SE-02.
- A new authenticated, owner-scoped `DELETE /bots/:id/identity` returns 204. It
  revokes the selected grant, selects the private profile, increments revision
  and closes the old seat after supported actions drain. It never wakes a stopped
  computer. The expanded screen's “Release shared login” action uses this route;
  the operator hands control back first. Refused or incomplete closure is reported
  and never described as successful transfer. Remaining grants are not deleted.
- The bridge's existing replay fence also gates seat closure. New replays are
  refused while a seat is closing; active replays must finish before teardown. An old
  request rechecks its seat after admission. Teardown retains the profile/slot
  reservation until every managed process has demonstrably exited. Failed stop
  retains the holder and is retryable. Partial startup also retains its reservation
  when cleanup fails. Killing a bridge still ends the whole computer (D-169).
- Before removing Chrome singleton files, a same-host live/unknown lock holder
  causes `IDENTITY_IN_USE`; no unowned process is killed or its lock cleared.
  Old-host or demonstrably dead locks may be removed after registry exclusivity
  has been checked. Chrome shutdown first requests `Browser.close` to flush state,
  then escalates only when necessary. Managed process groups prevent a exited
  leader from silently leaving profile-owning descendants behind.
- Contention names the holding bot and tells the operator to release its login.
  No cookie export/import or profile copy is introduced. One user's bots remain
  in a cooperative same-UID trust domain: shell/files can bypass product controls.
  Websites may expire sessions or bind them to devices, IPs or account policy;
  sharing a directory does not override those rules. Backup/restore/retirement
  remains M9-BE-04, not a duplicate implementation here.

## D-174 — Policy proposals are durable server records and dispatch checks current authority

**Status:** accepted · **Task:** MOD-SE-02 · **Clarifies:** D-164 ·
**Touches:** tool metadata, approval payloads, grant revision counters, execution boundaries

- The effect, authority flag and provenance remain beside the tool definition.
  `reach` is derived. Seat mutations resolve `draft` or `unknown` from the actual
  selected seat; shell and unclassified plugin writes remain `unknown`. A trusted
  commit adapter alone supplies the commit account, normalized destinations,
  content revision and committed/refused/uncertain receipt. Tool descriptions,
  client properties and result text cannot install an adapter or alter policy.
- Authority-changing tools always ask in AUTO, including when an allow rule
  matches. This resolves the conflict between the "always ask" rule in D-164 and
  the shorthand mode table in its plan. Deny remains stronger in every mode;
  FULL remains the operator's explicit choice to skip questions, never grants.
- A proposal is stored on `RunInterrupt` before its prompt is emitted. It holds
  server-resolved tool/arguments, binding and source definition. A reply supplies
  only a decision, reason and optional edited arguments; it cannot supply the
  binding, grants, tool name or approval scope. Resolution is owner-scoped and
  single-use. Resolved records supply approval memory across `resumesRunId`
  continuations. Another bot's records cannot supply that memory.
- `ApprovalBinding` additionally carries nullable `resourceRevision`: the hash
  of a resolved skill's id/version/script/parameter schema, or a plugin tool's
  cached schema/classification. Selecting a different approved skill version or
  changing a plugin definition cannot preserve approval merely because the
  model's arguments stayed the same. `argsHash` remains exactly the RFC 8785 hash
  of the final arguments, without hidden arguments added to the tool schema.
- Existing identity selection revisions fence identity changes. The bot gains
  a monotonic plugin-grant revision, incremented transactionally when its plugin
  set is replaced. MCP credentials gain a monotonic revision incremented by the
  existing sole credential writer. Hashes read only revision metadata, never a
  token. Revoke/regrant and two writes in one millisecond cannot reuse approval.
- One policy service assesses calls and rechecks them at dispatch. The SDK hook
  and execution wrappers are adapters around it, not separate policies. Seat
  admission precedes the dispatch recheck and stays held through execution.
  Waiting for a person holds no action admission. Changed binding returns
  `APPROVAL_STALE` without executing; a missing required grant returns
  `GRANT_REVOKED`, including in FULL. The model may propose a fresh call; a stale
  action is never automatically retried.
- ASK draft memory may ignore arguments only while the tool, grant revision,
  resource revision and actual seat remain identical. A new skill version,
  schema, login or browser launch requires fresh approval in ASK as well.
- Edited arguments are schema-validated, matched against current rules, rebound
  to the current server state and dispatched once. The result reports the actual
  arguments. Identity-window comparisons cover the login, browser generation,
  grant revision and turn rather than one action's name/arguments. ASK never
  opens that window. Opening a window after successful `use_identity` must bind
  the newly selected browser's actual generation; selection alone is insufficient.
- Direct operator skill execution is explicit approval of that exact resolved
  version/parameters, subject to deny, grant and seat checks. Scheduled execution
  has no implicit approval: an ask uses the same durable proposal and operator
  approval infrastructure. Skill publication does not grant an identity window.
  Model, HTTP and routine replay all meet the final skill execution fence.
- Use exact `canonicalize` 5.1.0 for RFC 8785, and exact Ajv 8.20.0 for cached
  plugin JSON Schema validation. No network schema loading, coercion, default
  injection, custom code keywords or caller predicates are enabled. Invalid or
  unsupported schemas refuse execution. Built-in Zod validation remains native.
  These libraries do not weaken the bans on evaluating scripts in the server;
  user scripts continue to execute only inside their computer.

This adds no historical conversion or deployment rollback path. MOD-AI-02 binds
the same policy to TanStack's typed tool/interrupt definitions; MOD-AI-06 owns
durable worker continuation. V1-OFF-10 still owns the actual mail-provider commit
adapter and reconciliation, rather than a second send subsystem here.

**D-174 transport and direct-run detail (2026-10-04).** Scheduled and direct skill
execution uses an owned `AgentTurn` in the existing conversation for its durable
policy records, with no fabricated chat message. While the legacy AI_SDK path
is active, the run holds `activeKey` through an approval pause and releases it
on every terminal outcome. AI06 applies the D-160 TANSTACK continuation fence.
`approval.requested` additionally requires the server-computed `binding`;
`approval.respond` is strict and accepts only `toolCallId`, `approved`, optional
`reason` and optional `editedArgs`. Edits are restricted to call scope.
The server emits `approval.resolved` after durable resolution or cancellation:
`{ botId, turnId, toolCallId, approved, reason? }`. All connected clients remove
that exact pending prompt; reloading still reads owned pending rows. A bot cancel
also cancels its owned pending routine prompts. The wire version becomes 2,
with no historical-client compatibility work. Ajv formats are pinned at 3.0.1.

## D-175 — Neutral tool schemas feed execution adapters and typed policy interrupts

**Status:** accepted · **Task:** MOD-AI-02 · **Touches:** shared native tool
schemas, registry/execution ports, TanStack tools and generic approval interrupts

- Native input schemas move unchanged into a Zod-only shared catalog, with
  explicit valid/invalid fixtures for every entry. Server implementations,
  owner context, failure handling and policy metadata stay in the orchestrator.
  A neutral definition holds its schema, execution callback and model-output
  projection; no SDK tool or credential crosses the tool execution port.
  Existing model/history types are replaced by MOD-AI-05, and the temporary
  legacy execution adapter remains until MOD-AI-15.
- Both adapters derive definitions from the same neutral schemas and preserve
  offered names and call IDs. Native schema defaults are applied before a
  proposal is bound; edits cannot change existing reviewed values through
  coercion, stripping or other transformations. Plugin schemas continue to use
  the exact Ajv validator without defaults. Raw results are validated as JSON
  (with more specific schemas where declared) and retained. Output caps and
  screenshot media apply only to provider input; canonical stored results are
  never replaced by a capped view. Projection occurs at the adapter input
  boundary, without adding another tool-calling loop.
- TanStack `toolDefinition().server()` wraps the existing registry dispatch,
  preserving seat leases, cancellation, plugin timeouts and lazy acquisition.
  Tool definitions contain no static `needsApproval`, policy, provenance or
  client-supplied properties. TanStack owns iteration and interrupt framing.
  Middleware assesses every call at `beforeTools`; dispatch still meets D-174's
  final policy check. Denial produces a tool result and leaves other calls usable.
- One `crewaid.tool-approval` definition is derived on server and client from
  shared strict `ToolApprovalRequestSchema` and `ToolApprovalAnswerSchema`.
  The request distinguishes the durable `proposalId` from the model's
  `toolCallId`, names the server-owned bot/run/source definition and includes
  resolved arguments and binding. A reply contains only `approved`, optional
  `reason` and optional `editedArgs`. The generic interrupt key is `proposalId`.
  The renderer may import `toolDefinition` only in its bounded chat schema seam
  to derive definitions without execution callbacks; those definitions grant
  no server capability and no client tool is admitted by a request.
- A continuation uses a required server resume-authorizer port. The middleware
  never applies client-carried request payloads directly as approval authority.
  MOD-AI-06 supplies atomic owned batch validation using the library's binding
  validator, maps the generic interrupt onto the existing proposal row and
  rebuilds policy plans from owned records. It must not create a second approval
  ledger. Edited arguments remain attached to the original model call ID and
  are checked again before execution. MOD-AI-05 wires this adapter to production
  execution; MOD-AI-08 uses the same schemas in the actual client chat path.
- Acceptance here uses the pinned library's real `chat()` engine and controlled
  model fixtures, rather than claiming production durable recovery before
  MOD-AI-06. Work's 500-token definition budget, bot-chain limits, routines,
  current seat-control behavior and the shared-computer architecture remain.

No new endpoint, runtime tool executor, workflow engine, historical converter or
deployment rollback path is introduced.


## D-176 — Canonical execution boundary and controlled TanStack backend (2026-10-04)

MOD-AI-05 ratifies the replacement execution port under D-159 §3.11. A request
contains the owner-scoped model reference, bot/thread/run identity, the admitted
trigger message identity, instruction inputs, neutral guarded tools, policy and
strict generic-interrupt resume entries. It carries no caller history, provider
client, credential, SDK message, SDK event or ORM object. The run ID is the durable
AgentTurn ID, also used by policy and persistence; there is no separate logging
run ID in this path. Incoming USER/BOT triggers are already stored once.

The backend owns model resolution and TanStack chat()/middleware/persistence.
It loads history with messages:[] and requires stores supplied through the server
persistence composition seam. Production run/interrupt composition is MOD-AI-06;
no memory store is a production default. The controlled acceptance harness may
compose the real owned Prisma transcript store with explicit fixture run and
interrupt stores, recording that limitation rather than claiming crash recovery.

Neutral ports append JSON native AG-UI events to a run-log writer, checkpoint
completed model/tool iterations before the next provider call, persist usage and
report status. Append is awaited and can fail execution; a disconnected reader
has no authority over the producer. MOD-AI-07 implements the durable log/transport.
Events are never translated to legacy message.* frames. Provider failures are
normalized before leaving the backend, including RUN_ERROR messages and codes.
An append or checkpoint failure is not a completed run. Interrupted, aborted,
failed and completed outcomes remain distinct, and original finish reasons are
retained. Caller cancellation is forwarded with the library's explicit cancel
reason; listeners are released on every exit.

The pinned library has providerMessages in onConfig. Output projection, claimed
attachment bytes and temporary provider context belong there, on a copy, while
canonical messages remain unchanged. Instruction text comes from the existing
agent-instructions builder, keeping the stable prefix and variable memory last;
Anthropic cache metadata may mark only the stable prefix. The library owns tool
iteration; Crewaid's existing pure limit account supplies step/token/work-time
ceilings, excluding time parked at an interrupt. No custom tool loop is added.
Compaction remains MOD-AI-10; the initial comparison uses bounded test transcripts
and does not claim production long-history parity.

The historical execution types and token move to an explicitly legacy port for
the temporary AI SDK coordinator and its baseline tests. This is an implementation
comparison path, removed by MOD-AI-15, not a history converter or a protocol
translation bridge. The canonical ExecutionBackend port is SDK independent.
The new backend is exercised only with controlled accounts/BYOK until durable
ownership (MOD-AI-06), transport/client integration (MOD-AI-07/08), billing
(MOD-AI-11) and the cutover gates pass. Included models are refused by its model
resolver until their meter exists. No public endpoint, configuration switch or
second approval ledger is introduced by this task.

D-176 implementation detail: outer RUN_FINISHED is withheld until transcript and
checkpoint writes succeed; intermediate model tool_calls finish events do not
terminalize the run. Explicit cancellation is an AG-UI RUN_ERROR with code
RUN_CANCELLED and the fixed sentence “The bot was stopped.”, paired with an
aborted run outcome, rather than a fabricated successful finish. Completed
iteration checkpoints also carry cumulative workingMs. Resume budget/usage
seeds come only from the owned server persistence composition, never from the
request; MOD-AI-06 persists/reconstructs these values. The execution coordinator
provides an awaited releaseForApproval port. D-179 clarifies that parking
releases execution/action admission while retaining the parked browser/profile
reservation; it must not reset the generation bound to a pending approval.


D-176 reservation correction (amends D-166): a reserved TANSTACK assistant/tool
row has SQL NULL `parts`, empty `content`, its original author/fromBot/run and
sequence, until an authoritative save supplies its canonical body. Reservation
rows are ordering placeholders, excluded from `loadThread`; they cannot count as
completed tool results during approval resume. A saved empty tool result has a
non-null canonical body and remains a real result. Filling a reservation must
retain its role, origin and order; malformed null-body rows are refused. No new
column, migration or historical converter is needed for this pre-launch change.

Final checkpoint validation runs before the persistence middleware's terminal
commit; it cannot leave a completed store run when a checkpoint failed. Usage
reporting remains observational under D-009: failed reporting is logged with only
safe correlation and error type and cannot change an execution outcome. Included
model billing admission/settlement remains the separate mandatory MOD-AI-11 path.

A tool result resumed by a fresh run derives its row identity from the run tag
of its matching preceding assistant call, retaining the original reservation.
The latest matching assistant distinguishes provider call IDs reused in later
runs. An unpaired result retains the existing current-run identity rule.

On transcript reload, the validating mapper supplies a missing assistant
`metadata.tanstack.run.id` from the row's owned `runId` column and refuses a
conflicting tag. The engine does not always tag the assistant at an interrupt
boundary; this server-owned annotation preserves originating-run identity
without altering message content or accepting client provenance.

## D-177 — Scoped PostgreSQL execution leases (2026-10-05)

MOD-AI-06's ownership contract is
`docs/plans/MOD-AI-06-OWNERSHIP.md`. `AgentTurn.workerId` and `leaseExpiresAt`
identify a server producer claim; `driverEpoch` fences replacements. PostgreSQL
owns expiry. The lease/heartbeat are 30/10 seconds, with test-only timing inputs.
Claim, renewal, transactional writer checks and release require the owned
bot/thread/run, worker, epoch and active-key predicates. Healthy duplicates join;
parked and terminal records grant no producer authority. Startup recovery cannot
blanket-fail TANSTACK work. Expired takeover requires durable state inspection
before executing; ownership does not authorize replay of uncertain effects.

This is the first MOD-AI-06 implementation boundary, not task completion or
backend activation. The remaining run/interrupt stores and single-proposal-row
mapping must pass their own atomicity and restart gates before the board is done.

## D-178 — Scoped Prisma run records and transactional persistence composition (2026-10-05)

**Status:** accepted · **Task:** MOD-AI-06 · **Touches:** `AgentTurn`, TanStack
persistence adapters and D-165/D-166

`docs/plans/MOD-AI-06-STORES.md` ratifies the next boundary. Generic library run
record insertion does not claim a producer; production execution retains the
D-177 server lease. Store mutations require explicit transactional authority,
and reads are principal-scoped TANSTACK records. `AgentTurn.usage` retains the
validated canonical TokenUsage snapshot while existing counters are updated on
the same row; a null snapshot with zero counters represents absent reporting.
`errorMessage` retains only the server projector's safe sentence.
Conformance fixtures use explicitly admitted unleased records and synthetic
safe errors; separate multi-worker and projection tests prove production rules.
Subagent stores are explicitly omitted and `resumesRunId` remains a continuation
link. Production terminal transcript/run/interrupt writes must share one owned
transaction before terminal publication. Native interrupt mapping and the
remaining crash/recovery gates are still required before task completion.


## D-179 — Owned closing transactions and approval parking (2026-10-05)

**Status:** accepted · **Task:** MOD-AI-06 · **Amends:** D-176/D-178

`docs/plans/MOD-AI-06-BOUNDARIES.md` ratifies short server-only persistence
transactions. A captured live D-177 lease enters the boundary under owned
bot/thread/run locks. Transcript, run and interrupt writes join the same
transaction. Only its selected closing status may replace running, and only
that captured worker may finish flushing after the status changes. Commit clears
producer fields and active key; rollback leaves the prior running record intact.
Cancellation authorizes only an owned abort flush, never dispatch. A stale or
expired worker cannot enter or write. No database transaction spans a model,
tool, browser reset or external request. The context becomes unusable as soon
as its callback ends, including inherited asynchronous callbacks.

Approval parking releases action/execution admission and stops work time while
retaining the browser and profile reservation required by D-173. Resetting Chrome
would invalidate D-164's generation-bound proposal before the answer arrives.
The releaseForApproval port therefore must not reset Chrome or transfer the
named profile. Explicit operator release, real shutdown/teardown or a generation
change still invalidates the old approval; no approval is rebound to a new
generation. Native interrupt mapping, atomic resume admission and real crash/
uncertain-dispatch gates remain required before production activation.

## D-180 — Native interrupt facets on private policy proposals (2026-10-05)

**Status:** accepted · **Task:** MOD-AI-06 · **Amends:** D-165/D-175/D-178

`docs/plans/MOD-AI-06-INTERRUPTS.md` ratifies attaching the complete native
interrupt to its existing owned private proposal row. Policy acceptance and
successful protocol consumption have distinct statuses and timestamps on that
one row. Native IDs are globally unique; policy-only rows never become native
interrupts. The adapter requires transactional server attachment/consumption
authority; protocol data alone grants nothing. Whole-batch terminal consumption
is atomic and joins D-179. The production attachment validator checks the captured
lease, exact private proposal and current native definition/schema binding.
Whole-batch answer admission, restored plans and crash/uncertain-dispatch gates
remain required; generic conformance authority is fixture-only.

## D-181 — Owned native resume batch validation (2026-10-05)

**Status:** accepted · **Task:** MOD-AI-06 · **Builds on:** D-175/D-180

`docs/plans/MOD-AI-06-RESUME.md` ratifies a short database-only validation
boundary over the owned parked run and its complete pending native/private
proposal batch. The installed native validator checks responses and produces the
canonical fingerprint after current definition/private binding checks. Validation
changes nothing and grants no producer or policy authority. Answer admission must
repeat validation in its atomic write transaction; accepted retries need stored
acceptance proof. Raw-argument plan reconstruction, continuation admission,
checkpoint budgets and uncertain-dispatch gates remain mandatory separate work.

## D-182 — Owned native consumption authority (2026-10-05)

**Status:** accepted · **Task:** MOD-AI-06 · **Builds on:** D-175/D-180/D-181

`docs/plans/MOD-AI-06-CONSUMPTION.md` ratifies the production consumption
boundary for admitted resume batches. Dispatch authorization verifies each
claimed tool resolution against the staged policy decision under the owned
parent/continuation chain and dispatches only with staged effective
arguments; the commit authority admits native terminal writes only when the
entry's direction matches the staged decision. Producer liveness remains the
closing lease fence's authority. Raw-argument plan reconstruction, cumulative
checkpoint budgets and uncertain-dispatch gates remain mandatory separate
work before backend activation.

## D-183 — Restored policy plans and the durable dispatch marker (2026-10-06)

**Status:** accepted · **Task:** MOD-AI-06 · **Amends:** D-182 · **Builds on:** D-164/D-181

A continuation is a new policy runtime, so it dispatches only what it rebuilds
from durable rows. The private proposal now stores `rawArgs` (the definition's
normalized input) beside the reviewed `args`, and `skillRevision`. After the
D-182 authorizer verifies the batch, `restore()` rebuilds a plan per answered
operator proposal of the resumed parent: the stored input must still project to
the reviewed call, and an edit is re-assessed as a live answer would be and its
binding recorded before dispatch (admission has no live policy state to compute
it). The authorizer therefore hands the tool `rawArgs`, not the projection; the
runtime substitutes the edit inside its final fence, keeping a bridged call in
its definition shape. This amends D-182's argument transport, not its checks.

Consuming is now durable: after the final fence and before the action, the
runtime writes `dispatchedAt` on the resolution under a row lock, once. A plan
restored with that marker (or an outcome) is consumed; its effect may have
happened, so a restart refuses it with `APPROVAL_STALE` and never repeats it.
Auto-allowed calls without a proposal row are re-decided by the resumed step;
checkpointing them across a mid-step crash remains MOD-DU-02 work.

## D-184 — Owned TanStack persistence composition (2026-10-06)

**Status:** accepted · **Task:** MOD-AI-06 · **Builds on:** D-177–D-183

`openOwnedTanStackPersistence(prisma, lease, budget)` is the one place a
producer's persistence is assembled from its lease (a D-177 claim or a D-181
admitted continuation). Messages, runs and native interrupts join one
`OwnedRunBoundary`; the run store refuses library insertion because the lease
already admitted the run; native attachment uses the D-180 validator and
consumption the D-182 commit authority; resume authorization is D-182's.
No new endpoint, table or configuration key; the agent-turn service does not
select this backend yet.

Running the real engine through it exposed a closing-order defect: a pause
commits `interrupted` and releases the lease, then the engine still calls
`onShouldContinue`, whose checkpoint asserted the released lease and turned
every approval pause into a failure. A producer that has closed checkpoints
nothing further; the closing transaction already flushed its transcript.
`test/mod-ai06-owned-resume.integration.test.ts` drives pause → admission →
fresh-runtime continuation → single dispatch, a declined answer, and an
expired-lease takeover after a worker died inside the tool, on real PostgreSQL.

## D-185 — Heartbeat-driven producer and chain-cumulative ceilings (2026-10-06)

**Status:** accepted · **Task:** MOD-AI-06 · **Touches:** `AgentTurn` · **Amends:** D-184

`AgentTurn.workingMs` (integer, default 0) holds a run's own working time.
`TanStackExecutionPersistence.progress` writes a run's own steps and time under
the lease fence — at each checkpoint and inside a pause's closing transaction,
which never reaches a checkpoint. `openOwnedTanStackPersistence(prisma, lease)`
reads the budget from the continuation chain's rows instead of accepting one, so
answering an approval cannot reset steps, time or tokens; a row keeps only its
own share so a chain is never counted twice.

`executeOwned` is the server producer: persistence from the lease, a heartbeat
renewing it while the producer works, and an abort the moment renewal fails, so
a replaced worker stops instead of racing its successor. The request must name
the lease's run, bot, thread and user. Acceptance in
`test/mod-ai06-owned-resume.integration.test.ts`: an exhausted chain stops the
continuation before dispatch, the heartbeat carries work past the lease length,
and a taken-over producer leaves the new owner's row untouched (removing the
heartbeat or the ancestor sums fails its case).

## D-186 — Scoped recovery from durable rows (2026-10-06)

**Status:** accepted · **Task:** MOD-AI-06 · **Builds on:** D-177/D-183/D-185

`recoverExpiredRuns` claims only runs whose lease has expired (D-177's bounded
discovery, drained batch by batch) and hands each new lease to a resume
callback; a healthy or renewed owner is never claimed. `readAdmittedResume`
rebuilds a reclaimed continuation's resume batch from the staged decisions on
its parent's private proposals, so recovery needs no request body. A claim
grants no replay: D-183's dispatch marker decides what may still run.

Acceptance: `test/mod-ai06-crash.integration.test.ts` SIGKILLs a child process
inside an approved tool after its marker is durable; recovery reclaims the run
at the next epoch, rebuilds the batch, completes it, consumes the native facet
and never repeats the effect, while a healthy owner's row is unchanged.
`mod-ai06-owned-resume` adds that new input and a forged continuation replaying
a consumed batch dispatch nothing.

Not covered here, by design: auto-allowed calls with no proposal row that were
mid-dispatch at a crash (MOD-DU-02's checkpoint-before-action), and selecting
this backend in the agent-turn service (activation, MOD-AI-13/14).

## D-187 — The Postgres delivery log (2026-10-06)

**Status:** accepted · **Task:** MOD-AI-07 · **Builds on:** D-159 §3.7, D-165, D-177

`createRunEventLog` implements the library's `StreamDurability` over `RunEvent`;
the BIGSERIAL id is the offset (D-165), and `'-1'`/`'0'` mean "from the start".

- **Reads** are scoped to the bot's principal, bot, thread and run. A reader
  replays strictly after its offset, then tails; it ends when the log is closed
  or the run is terminal. An offset that names no row of this run is
  `OFFSET_EXPIRED` when the log was closed longer ago than the retention period,
  otherwise `OFFSET_UNKNOWN`. Replay never starts a producer or bills.
- **Writes** need the producer's lease and are fenced by its epoch, not its
  liveness: the backend appends its terminal event after the closing
  transaction released the lease. The fence admits the live owner, or — once
  the run left `running` with no worker — the same epoch, until the log is
  closed. A takeover bumps the epoch, so a replaced worker cannot write.
- **A dead producer is not hidden.** A tail over an expired, unclosed run keeps
  waiting; ownership recovery (D-186) continues the same log.
- **Wake-ups** are in-process, bridged across workers by Redis pub/sub when
  `REDIS_URL` is set. A message is a thread id and an offset, never an event.
- **Retention** is seven days after a log closes (`RUN_EVENT_RETENTION_MS`, not a
  configuration key); `purgeExpiredRunEvents` deletes older logs. D-147's clear
  and delete already remove events in their own transaction.

The authenticated routes, keep-alives and session revocation for long tails are
the next MOD-AI-07 slice.

## D-188 — Conversation delivery routes (2026-10-06)

**Status:** accepted · **Task:** MOD-AI-07 · **Builds on:** D-159 §3.2/§3.8, D-187

- **`GET /bots/:id/chat`** carries `@OwnedResource('bot')` (new `bot` kind) and
  serves two reads. `?runId=&offset=` (or `Last-Event-ID`; absent means the
  start) replays strictly after the offset, then tails, in the library's SSE
  encoding with `X-Accel-Buffering: no`. A run not on the bot's thread is 404,
  an unknown offset 400, an offset into a purged log 410. `?threadId=` hydrates
  through `reconstructChat` over read-only views of the owned stores; any thread
  but the bot's own is 404.
- **Long tails** get a `: keep-alive` comment every 15 s, and each one re-reads
  the session: a revoked or expired session stops receiving within that
  interval, the bound the §4.2 socket's sweep uses. A slow client stops the join
  reading the log (drain); the producer never waits on a reader. A disconnect
  ends only the join.
- **Versions.** Chat responses carry `X-Crewaid-Wire-Version: <WIRE_VERSION>`; a
  request declaring another value is refused 426 `WIRE_VERSION_UNSUPPORTED`.
- **`run.started {botId, threadId, runId}`** joins the §4.2 server registry
  (shared contract and renderer reducer). Its emitter arrives with the first
  code that creates a conversation run in production.
- **Retention** runs at boot and hourly (`RunEventRetentionService`).

`POST /bots/:id/chat` — admitting a user turn into a TanStack thread and
starting its producer — is not part of this decision. It is the production
engine cutover: it needs the turn assembly (instructions, tools, seat preflight,
identity windows, deferred input, limit continuations) shared with the AI SDK
path, and a ratified rule for which transcript message a tool-produced
attachment claims (today `ToolContext.messageId` names the AI SDK draft reply,
which a TanStack run does not have). It must land before MOD-AI-08 can send.

**Superseded by D-190**, which owns that route under MOD-AI-16.

## D-189 — The included-model meter and model-call telemetry on TanStack (2026-10-06)

**Status:** accepted · **Task:** MOD-AI-11 · **Builds on:** D-157, D-167

- **One meter, two transports.** `IncludedModels.textAdapter` returns OpenRouter's
  TanStack adapter on Crewaid's key behind the same reserve/settle core the AI
  SDK middleware uses. `chatStream`, `structuredOutputStream` and
  `structuredOutput` each reserve before the call and settle once; a stream
  settles before its `RUN_FINISHED` reaches the engine, so the next step is
  admitted after this one's charge. Every other adapter property is the
  upstream's own (a `Proxy`). `resolveText` routes `crewaid` connections through
  it; without the billing module they stay unavailable, never free.
- **Settlement.** OpenRouter's reported cost when present, else the price table
  over normalized counters (cached and cache-write tokens priced as such). A
  consumer that stops early, or a stream that fails part-way, pays the prompt
  plus what streamed; a call refused before producing anything pays nothing.
  **Unknown usage keeps the whole reservation, on both transports** — the AI SDK
  meter had priced a usage-less finish at zero. A response lost after settlement
  is not settled again. Event replay never resolves a model, so it never bills.
- **Telemetry.** The TanStack backend emits one `ai.model-call` record per model
  call through the same closed schema and cost estimator as the AI SDK path:
  identifiers and counts only, unknown usage as `usageUnknown`, never awaited. The
  send route's producer (`ChatSendService`) injects `AI_TELEMETRY`, so every
  TanStack run records its calls.

Stripe test-mode evidence and D-156/D-157 commercial sign-off stay M9-BE-06's.

## D-190 — Admitting a user turn, and where a tool's attachment lands (2026-10-06)

**Status:** accepted · **Task:** MOD-AI-16 · **Builds on:** D-159 §3.2/§3.3, D-177, D-181, D-188

`docs/plans/MOD-AI-16-SEND-ROUTE.md` is the contract. `POST /bots/:id/chat`
answers with the same replay-then-tail reader the join serves, so a client that
disconnects mid-turn loses nothing and a reader never steers a producer.

- **Admission is the server's.** Stored ids are ignored rather than merged, so no
  client transcript can reorder or truncate the thread; new messages are
  `user`-only and exactly one; `forwardedProps` carries `attachmentIds` and
  nothing else; a body with neither new input nor `resume`, or with both, is
  refused. The message and its attachment claims commit before the run exists.
- **The thread's state decides.** A `resume` goes through D-181's admission and
  streams the continuation it creates. A message that arrives while a run is
  `running` is stored for the next run and answered when that producer settles,
  which is M5-BE-16 moved server-side; its response is an SSE stream that closes
  with no events, because the run it will be answered by does not exist yet and
  `run.started` is how a client finds a run it did not start. Pending interrupts
  with no answer refuse a new instruction `409`.
- **The run id stays the client's** (D-160), insert-if-absent through the D-177
  claim. A repeat joins the first run; a foreign id or a second concurrent run is
  `409`.
- **One turn assembly.** `agent/turn-assembly.ts` composes instructions, the
  roster, memory, plugin tools, the registry resolution, the policy runtime and
  the computer/browser handles for both engines. Each engine keeps only what is
  genuinely its own: the AI SDK path its draft row and §4.2 frames, this path its
  lease, durable log and library persistence.
- **A tool-produced attachment claims the tool result message of its call.** A
  TanStack run has no draft reply to claim, so `ToolContext.messageId` becomes
  `attachmentHost(toolCallId)`: the AI SDK path answers with its draft id, and
  this path derives the canonical tool result id (`assignTranscriptIds`, from the
  thread, the call's originating run and the call id) — the row the backend
  already reserves at `TOOL_CALL_START`, before the tool runs. The derivation is
  stable, so a re-save updates one row, and `crewaidMetadataOf` already projects
  a row's attachment ids. No new column, and no attachment bytes in the log.

The renderer half is MOD-AI-08. Regenerate and edit remain unsupported, and
display-only client tools still need their own decision.

## D-191 — Serving every turn on a TanStack thread (2026-10-06)

**Status:** accepted · **Task:** MOD-AI-17 · **Builds on:** D-159 §3.1/§3.4/§3.9, D-165, D-177, D-188, D-190

`docs/plans/MOD-AI-17-THREAD-CUTOVER.md` is the contract. D-190 admitted the
operator's own message; this decision gives a `TANSTACK` thread everything else a
bot's conversation does, so that the renderer (MOD-AI-08) can rely on it.

- **The bot names its thread.** `Bot.thread` is `{ id, engine }`: the
  conversation id the chat routes require, and the `TranscriptEngine` that
  decides which conversation path a client speaks. Knowing the id grants
  nothing.
- **One writer per engine.** Routine prompts, teammate deliveries and Work
  briefs on a `TANSTACK` thread are canonical rows (`toTranscriptRow`), with
  `routineId`, `fromBotId`, `chainId`, `hopCount` and `taskId` in their columns.
  `MessagesService` picks the shape from the thread, so its callers don't change.
- **One entry point.** `AgentTurnService.startTurn` hands a `TANSTACK` thread's
  trigger to the TanStack producer: a server-minted run id, the D-177 claim,
  `run.started`, the shared `assembleTurn`. A thread that is busy or waiting for
  an answer keeps the trigger stored for later rather than refusing it.
- **A settled run does what a settled turn does.** Completed or limit-stopped,
  it answers the newest unclaimed trigger that waited (fold, not drain). With
  none waiting, a limit stop continues up to `AGENT_MAX_CONTINUATIONS`, with the
  reason as an instruction, never a stored message. Aborted, failed and
  interrupted runs start nothing. This repairs MOD-AI-16, whose deferred message
  was stored but never answered.
- **A teammate reads as a teammate.** The provider input words a teammate's
  `user` row as `interBotToUserContent` does, under the sender's current name.
  The stored row keeps the sender's words verbatim.
- **Stop reaches a TanStack run.** `bot.cancel` records `cancelRequested` on a
  `running` run and aborts it in-process when this worker owns it. A lease
  elsewhere is fenced at its next heartbeat. An `interrupted` run ends `aborted`
  with its pending interrupts cancelled. **A cancelled run ends `aborted`
  whatever moment the Stop lands in, and the engine does not get there by
  itself**: it ends its stream on an abort without calling a terminal hook, so
  the backend closes the run after the loop; and an abort that lands before the
  first model call opens no persistence at all (D-176), so that run is the
  caller's to settle, for the one run it was holding. Left open either way, the
  row stays `running`, keeps the one-active-run fence, and the next message
  waits behind a run that will never answer it.
- **The AI SDK routes refuse a TanStack thread.** `POST`/`GET /bots/:id/messages`,
  `GET /bots/:id/approvals` and `approval.respond` answer `409 WRONG_ENGINE`.
  The D-147 routes and `POST /bots/:id/read` serve both engines.

New threads are still created `AI_SDK`. MOD-AI-08 flips the creation default in
the same change that lets the renderer show a `TANSTACK` thread, so that main
never holds a thread the app cannot open.

## D-192 — The chat the operator reads, on TanStack React (2026-10-06)

**Status:** accepted · **Task:** MOD-AI-08 · **Builds on:** D-158, D-159 §3.2/§3.4,
D-160, D-165, D-175, D-187, D-188, D-190, D-191

`docs/plans/MOD-AI-08-TANSTACK-RENDERER.md` is the contract. The server has
served a TanStack thread since D-191; this decision is the renderer that can
look at one, and it replaces the transcript authority rather than standing a
second one beside it.

- **A new thread is `TANSTACK`.** `Conversation.engine` defaults to it, which is
  the whole change: a bot's birth, a duplicate and a Work Start all rely on the
  default, so there is one place to read the answer off. Supersedes D-165's
  `AI_SDK` default.
- **The renderer speaks one conversation path.** It stops calling the AI SDK
  message and approval routes, and a thread still marked `AI_SDK` says so in
  place of its transcript. D-158 is what makes that affordable — pre-launch, no
  users, no production data, so such a database is re-seeded rather than
  migrated — and MOD-AI-15 deletes the server half.
- **A hydrate reads for the operator, not for the model.** `loadThread` drops
  `SYSTEM` rows, reads a teammate's row as a `user` turn and carries no product
  facts, which is right for a provider and wrong for a transcript. The hydrate
  takes the same store in an operator view: `SYSTEM` rows kept, and
  `metadata.crewaid` on every message — the §3.4 projection that nothing called
  until now. **`crewaidMetadataOf` now projects `attachments`, not
  `attachmentIds`**: a card needs a name, a type and a size, there is no
  `GET /attachments/:id`, and the read already holds the rows. The model's
  reader is untouched, so product metadata never reaches a provider.
- **One client per thread, mounted by its thread id.** `ChatThread` owns
  `useChat` and `App` mounts it with `key={thread.id}`. The hook preserves its
  messages across a client rebuild on purpose, so re-keying it in place is how
  one bot's conversation would leak into another's; a key change remounts and
  the fresh client hydrates. A bot nobody is looking at has no client and needs
  none — its run is logged durably and replayed in full on return, which is what
  D-187's log was for. The sidebar learns what it needs from `bot.status` and
  from `GET /bots`, whose unread count already counts a TanStack run (D-165).
- **Every run reaches a window through its durable log.** The connection adapter
  is `subscribe`/`send`, not `connect`, because a window must show a run it did
  not start: a routine, a teammate, a message deferred behind a running turn.
  D-188's `run.started` announces each one; the adapter opens each announced run
  at `offset=-1` and opens it once. `send` POSTs the chat route and its response
  is that run's log, joining the same queue; a `202` deferred send is answered
  by an announcement later, like any other run. URLs come from `API_ROUTES` and
  the bearer from the CC-07 bag, every request a `fetch` (D-025).
- **The reducer keeps everything that is not the transcript.** `messagesByBot`,
  `streamingByBot`, `cursorByBot`, `historyStatusByBot`, `historyErrorByBot`,
  `approvalsByBot` and `approvalLoadsByBot` go. `activityByBot` stays, on its
  `bot.status` arm, because the sidebar asks it about bots with no client. The
  frames that fed the departed keys become documented no-ops in the exhaustive
  switch, as `run.started` already is. Two frames do reach the chat client,
  because they concern the thread on screen and have no run of their own:
  `message.deleted` (D-147 serves both engines) and a `SYSTEM`
  `message.created`, which is the limit notice MOD-AI-17 posts between two runs.
- **Stop is still the frame.** `bot.cancel` first, then the client's `stop()`:
  the frame is the authority (§3.9) and closing a stream is a disconnect, not a
  cancel.
- **An approval is a bound interrupt.** `crewaid.tool-approval` (D-175),
  resolved with its edited-args answer, re-prompted from the hydrate after a
  reload or in a second window. `GET /bots/:id/approvals` and the
  `approval.respond` frame leave the renderer. The client only clears an
  interrupt it resolved itself, so a window that still shows a question it did
  not answer remounts its client when the thread's next run starts, and the
  hydrate says whether the question is still open.
- **The sidebar's line comes from the server.** Each `GET /bots` row's `thread`
  gains `preview: { text, createdAt } | null`: the newest non-blank USER or BOT
  message, flattened to one line. It was read off the transcript the window
  happened to hold, which only the bot on screen has now.
- **An empty client state is no state.** `@tanstack/ai-client` sends
  `state: {}` on every request and cannot be told not to, so D-190's refusal
  applies to a state with something in it.

`TranscriptMessage`, the part registry, the tool folds and every component below
`Transcript` keep their shapes. `StreamingMessage`, `StreamingBlock`,
`appendDelta`, `blocksToParts`, `streamedText` and `withTail` go: they existed to
accumulate deltas, and the chat client accumulates them now.

## D-193 — Transcript Markdown on Streamdown (2026-10-06)

**Status:** accepted · **Task:** MOD-MD-01 · **Builds on:** D-158, D-025, M6-FE-02

The hand-written transcript parser (`markdown.ts`) is gone; `StreamingMarkdown`
renders through Streamdown with the same props and the same wrapper, so every
caller (text and reasoning parts, attachment previews, Work panes) is unchanged.

- **Repair only what is still arriving.** Streamdown's incomplete-Markdown
  repair runs only for the reply being written (`PartRenderContext.streaming`,
  from the transcript's `live` row). In settled text an unclosed `[link](` is
  what was written, and repairing it hid every block after it.
- **HTML and resources are policy, not repair.** No `rehype-raw`, so HTML is
  shown as text. The sanitizer is Streamdown's default schema plus one element,
  `mention`, with one attribute, `botid`. Images never load: the hardener
  allows no image prefix and no data image, so an image is its description.
- **Links open in the system browser, https only.** A link click goes through
  `systemBrowser.open`, the fenced `openExternal` channel, which accepts https
  only; any other target keeps its text and loses the link. `target=_blank` is
  not used: in Electron it opens an app window on the page.
- **A message keeps the lines it was typed on.** Every newline in prose is a
  line break, as the old parser had it; in Markdown a single newline joins two
  lines, which is right for a document and wrong for a chat. Code keeps its own.
- **Mentions** are a remark plugin over text nodes outside code and links, so a
  roster bot is a button and code stays literal.
- **Code** keeps the existing allowlisted `hljs-*` tokenizer as Streamdown's
  code-highlighter plugin (no Shiki download), with copy and download controls.
  Highlighting runs after mount, so it is tested on the plugin, not on static
  markup.
- **Theme.** Streamdown's shadcn roles map onto Crewaid tokens; inside Markdown
  `--muted` is a surface tint, because HeroUI's is a text colour. Bold stays a
  `<strong>`.
- **Not supported:** math (it needs another package and nothing asks for it),
  and a table drawn before its delimiter row arrives — GFM has no table until
  then.

## D-194 — Plugin tools on TanStack: deferred tools under the D-113 budget (2026-10-06)

**Status:** accepted · **Task:** MOD-AI-09 · **Builds on:** D-104, D-105, D-113, D-114, D-116,
D-144, D-160, D-175 · **Retires D-113's bridge from TanStack runs**

- **A plugin tool is offered as itself, once loaded.** A TanStack run is given each granted plugin
  tool as its own definition, `<slug>__<tool>`, built by the same M6-BE-06 binding (still closing
  over the server id and the server's own tool name). None is sent to the model until
  `find_plugin_tools` loads it: the tool answers `{ loaded: [names] }` for exact names or a query
  (ten at most, their definitions within `PLUGIN_LISTING_TOKEN_BUDGET`), and from the next step
  the model calls them directly. Its description carries D-113's degrading listing under the same
  budget, so the prompt does not grow with the catalogue.
- **What is loaded is read back from history, every step.** A middleware (`deferredTools`,
  `onConfig`) sends the deferred tools the run's history loaded or called, most recent first,
  until their definitions would exceed the budget — and always a tool whose call is still waiting
  on a result, because a resumed run executes pending calls from that list. A later turn on the
  thread starts with what earlier turns loaded. **The engine's own `lazy` tools are not used:**
  they read history once, when the engine is built, before this app's persistence middleware has
  loaded any, so every approval resume of a plugin tool would be refused as undiscovered.
- **Loading grants nothing.** Only the tools this run was given can be loaded or sent, so a
  revoked, disabled, expired or failing server's tools are absent however the history reads. A
  call to a tool the step was not sent is answered "Unknown tool" by the engine, and the policy
  neither assesses it nor asks the operator.
- **Approval is unchanged.** A plugin call is assessed by the same policy as every tool, on its
  own name, its M6-BE-08 behaviour and its final arguments; nothing is unwrapped any more.
  Dispatch re-reads the server and its credential at call time, as before (D-114).
- **One client: `@tanstack/ai-mcp`.** `openMcpConnection` keeps its verbs over `createMCPClient`
  with the guarded fetch, the resolved bearer and `redirect: 'error'` on every request;
  `@ai-sdk/mcp` leaves the orchestrator. Listing, pagination, duplicate-name refusal and
  cancellation are the library's; a refused endpoint is unwrapped from the client's error so it is
  still answered as the operator's URL. Stdio stays refused (R10).
- **Refused explicitly:** the client no longer claims it can answer a server's input requests
  (form elicitation, sampling), and a server that asks anyway mid-call gets a
  `PLUGIN_INPUT_UNSUPPORTED` tool error, not a strike. MCP Apps widgets are neither read nor
  rendered; a tool's UI link is not carried, so no server UI gains authority in the renderer.
- **The bridge stays for the AI SDK path only** (D-191's legacy threads) and goes with it in
  MOD-AI-15. The bot's plugin sentence (D-116) names loading on TanStack runs.

## D-195 — Compacting what a TanStack call is sent, never the thread (2026-10-06)

**Status:** accepted · **Task:** MOD-AI-10 · **Builds on:** D-048, D-072, D-094, D-165, D-191

A TanStack run loads the whole canonical thread (D-165), and until now sent all of it. The AI
SDK path bounded the same thing twice — a 40-message seed and `prepareStep`'s trim at
`AGENT_CONTEXT_TRIM_TOKENS` — so a long TanStack thread was the one place a conversation could
outgrow its model.

- **`@tanstack/ai-compaction` bounds the provider's copy only.** It runs after the provider
  context is built, on `providerMessages`; the canonical history, the transcript and replay are
  never rewritten, and every later step compacts afresh from the full thread, so a restart or a
  resumed run produces the same valid context. System prompts are not messages, so the identity
  prefix and memory-last order (D-094) are untouched.
- **Budget:** half the resolved model's context window, never more than
  `AGENT_CONTEXT_TRIM_TOKENS` (D-048's 100k). A model whose window is not a positive integer
  fails the run with `INVALID_REQUEST` naming the setting, rather than guessing.
- **Strategy:** clear old tool output first (keeping the six newest results and every call/result
  pair in place), then drop the oldest messages behind a marker, at a message boundary, so no
  result is separated from its call. The newest messages — a resumed run's waiting calls and the
  trigger's attachments among them — are kept. An image is estimated at a fixed 1,600 tokens, not
  its base64 length, which would otherwise evict a photo the moment it arrived.
- **Not a cap (D-072).** Compaction decides how much history one call carries, never whether a
  run continues; the step and turn ceilings are unchanged.
- **No summarization.** It costs a model call per step here — the library's checkpoints apply
  only when the provider copy is the canonical list, which ours is not — and eviction plus
  clearing already bound the measured histories.
- The AI SDK path's seed and trim go with that path in MOD-AI-15.

## D-196 — Background model calls on the run engine's adapter (2026-10-07)

**Status:** accepted · **Task:** MOD-AI-12 · **Builds on:** D-006, D-042, D-086, D-098, D-189

- **One helper, `askModelText`.** Skill compile (and its truncation judgement), skill revise and
  memory distillation ask through `models/text-call.ts`: a system prompt, one user message (with
  images for a compile), `chat({ stream: false })` on the adapter `resolveText` returns. Each keeps
  its own contract — the schema in the prompt, `parseJsonAnswer`, the validator's single
  corrective retry, the 180 s deadline whose abort now reaches the engine's controller.
- **Billing and credentials are the run's.** `resolveText` is owner-scoped (D-086) and meters
  Crewaid's included models in the adapter (D-189), so a background call is charged exactly as a
  chat step is.
- **Errors keep D-006.** A non-streaming call rethrows the engine's run error with the provider's
  code; `normalizeModelError` now reads a coded error the way `normalizeRunError` reads a
  streamed one, so a 401 is still `AUTH_FAILED` and vendor text still never reaches an operator.
- **What still imports the AI SDK serves only the AI SDK turn path** (D-191's legacy threads):
  `resolve()`, the provider factory, the AI SDK meter, its telemetry types, its error classes, and
  the AI SDK message builders in `trigger-content.ts` and `tool-approval.ts`. They are deleted with
  that path in MOD-AI-15. `@ai-sdk/harness` in `sandbox-core` is the computer seam, not inference,
  and stays.

## D-197 — The dispatch ledger: one row before every effect, and no blind repeat (2026-10-07)

**Status:** accepted · **Task:** MOD-DU-02 · **Builds on:** D-164, D-171, D-183, D-186

D-183 marked an *approved* call dispatched before it ran. A call the policy allowed by itself had
no durable trace at all, so a worker that died inside it left a pending tool call that the
recovered run assessed afresh and ran again — a second message sent, a second click. This is the
ledger D-171 asked to be ratified before its migration.

**`ToolDispatch`**, one row per call that can change something:

| Column | Meaning |
|---|---|
| `id` | the operation identity, reserved before dispatch |
| `runId` → `AgentTurn` | the run that dispatched it (cascade) |
| `conversationId`, `userId` | the thread and owner, for scoping and cascade |
| `toolCallId` | the model's call id; **unique with `conversationId`** |
| `toolName`, `effect` | the policy name and its D-144 effect (`draft`, `seat`, `unknown`) |
| `argsDigest` | SHA-256 of the canonical final arguments |
| `status` | `DISPATCHED` → `COMMITTED` \| `REFUSED` \| `UNCERTAIN` |
| `reference` | a commit adapter's receipt, when one exists |
| `dispatchedAt`, `settledAt` | when it started, and when its outcome was written |

- **Which calls.** Every dispatched call whose effect is not `read`. Reading again is safe;
  anything else is not, a product write included (`send_message` twice is two messages).
- **Reserve, then act, then settle.** The row is inserted, with the run's owner and epoch fence,
  before the tool runs. An insert that finds the `(conversation, toolCallId)` row already there
  does not run the tool. The output settles it `COMMITTED` (or the commit adapter's verdict); a
  throw settles it `REFUSED` only when the tool says nothing was dispatched, and `UNCERTAIN`
  otherwise.
- **Recovery never repeats.** A resumed or recovered run that finds a row for a pending call
  answers it from the row: `COMMITTED` reads as done (its output was not kept), and `DISPATCHED`
  or `UNCERTAIN` reads `OUTCOME_UNKNOWN` — the call may or may not have taken effect, it will not
  be repeated, and the operator is the one to check. A stale `DISPATCHED` row is settled
  `UNCERTAIN` at that point. No receipt, a lost response or an expired lease is never read as
  "it did not happen".
- **The operator's surface is the transcript.** The tool row shows the unknown outcome where the
  call was made; the model is told not to retry blindly. A later call with a new id is a new
  decision, assessed and approved as any other.
- **Not exactly-once.** PostgreSQL cannot stop a remote request already in flight, and a remote
  service without a receipt cannot be reconciled from here (D-171). The ledger guarantees that
  this app never issues the same call twice; it does not guarantee what the first one did.

## D-198 — A reply that is tool-call markup fails its run; it is never stored (2026-10-07)

**Status:** accepted · **Task:** MOD-AI-13 · **Closes:** the defect D-162 recorded

MOD-AI-13's same-day behaviour run reproduced D-162's defect on TanStack: asked about a meeting,
`z-ai/glm-5.3-flash` replied with the text `<tool_call>capture_screen({})` — a call to a tool the
run did not even offer, written as prose — and the canonical transcript kept it as the bot's
words. D-162 allowed two fixes, converting it into the call it names, or failing the step, and
forbade storing it. Conversion is refused here: the name need not be a tool this run was sent,
the argument syntax differs per vendor, and guessing a call from text is how a model's slip would
become an effect. So the run fails.

- **What counts.** The run's final assistant message has no tool calls, and its text, trimmed,
  *begins* with a known provider tool-call opener: `<tool_call>`, `<tool_use>`,
  `<function_calls>`, `<invoke `, `<function=`, `<|tool_call|>`, `<|python_tag|>`,
  `<｜tool▁calls▁begin｜>` / `<|tool_calls_begin|>`, or `[TOOL_CALLS]`. Only the beginning: a
  reply that explains such syntax after a sentence of prose is an answer, not a leak, and a false
  positive here would fail a good turn.
- **What happens.** The message's stored text is blanked to the reservation shape, which no
  reader shows or sends to a model, and the run closes `failed` with
  `PROVIDER_UNAVAILABLE` — the retryable D-006 code, because sending the same message again is
  what fixes it — and the message "The model answered with tool-call text instead of a reply.
  Try again." The run's usage is still recorded; the call was made and billed.
- **What is not covered.** The text was streamed before the run could know what it was, so the
  live client and the run's event log (retained for D-159 §3.7's replay window) saw it before the
  terminal `RUN_ERROR`. The transcript, which is what is kept, reloaded and sent to the next
  model call, does not have it. The AI SDK path is not changed: MOD-AI-15 deletes it.

## D-199 — The AI SDK conversation engine is deleted (2026-10-07)

**Status:** accepted · **Task:** MOD-AI-15 · **Builds on:** D-158, D-165, D-191, D-192 · **After:** MOD-AI-13

MOD-AI-13 accepted the TanStack path on a real model, and D-192 already gives every new thread to
it. The AI SDK engine now only answers threads nothing creates, so it goes, with no converter: the
product is pre-launch and its installs hold test data only, so an `AI_SDK` thread is left
unreadable (the desktop already says so) rather than translated.

**Deleted.** `AgentTurnService` and `turn-runner` (the AI SDK turn and its loop),
`ai-sdk-execution-backend`/`ai-sdk-tools`, `legacy-execution.port` and its `EXECUTION_BACKEND`
token; `GET`/`POST /bots/:id/messages` (§4.1's AI SDK history and send — `DELETE` of messages and
`POST /topics` stay, they serve the canonical transcript); the renderer's `listMessages` and
`sendMessage`; the AI SDK provider factory and `LanguageModel` resolution, the included-model AI SDK
meter, and the AI SDK error classes in `normalize-error`. Dependencies removed: `ai`,
`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`, `@openrouter/ai-sdk-provider`.

**Rewired, not deleted.**
- Background triggers — routines, a teammate's delivery, a Work start — hand their stored trigger
  to the TanStack producer (`TanStackTurns.startStored`) directly, as `startTurn` already did for
  every TanStack thread.
- `bot.cancel` stops the bot's TanStack run and any scheduled-skill approval wait, through the
  producer and the approval hub; `approval.respond` and `GET /bots/:id/approvals` answer the
  approval hub, which still carries scheduled skills' approvals. A TanStack run's approval is
  answered through `POST /bots/:id/chat`, as before.

**Retained.** `@ai-sdk/harness`, behind `sandbox-core`'s one re-export: it is the sandbox
session contract, not inference. The approval hub, for scheduled skills.

**Second step.** `Conversation.engine` and the `TranscriptEngine` enum then describe one value. They
are dropped in MOD-AI-15's second change, with every `engine = 'TANSTACK'` fence and the shared
`ThreadSummary.engine` field, so this change stays a deletion of the runtime alone.

## D-204 — The plugin directory lists the deployment's live Composio catalog (2026-10-11)

**Status:** accepted · **Task:** V1-INT-02 · **Amends:** D-202

The pinned three-app pilot becomes a curation overlay over the deployment's
real toolkit catalog. `GET /mcp/directory` merges the curated direct-MCP
entries with Composio toolkits listed through the SDK (`toolkits.list`,
paginated, cached in memory for ten minutes), filtered to toolkits offering
a Composio-managed OAuth2 scheme; API-key, custom-scheme and no-auth
toolkits are deferred and absent from the directory. Directory entries gain
an optional `backend` field so the client can mark a Composio-backed
toolkit.

`COMPOSIO_API_KEY` is the only Composio variable a deployment supplies —
the per-app `COMPOSIO_AUTH_CONFIG_*` IDs are gone (breaking change, fresh
setup per D-158). At install the orchestrator provisions the auth config
itself (`use_composio_managed_auth`, one per toolkit per project) and
stores its id in `ComposioConnection`; `verifyActive` checks the connected
account against the stored id, not the environment.

The directory is management surface and stays un-budgeted; discovery in a
run is still the deferred-tools/bridge machinery under
`PLUGIN_LISTING_TOKEN_BUDGET`. Sessions for overlay apps keep the reviewed
enable lists and the set-equality check. Sessions for any other toolkit
enable the toolkit as a whole vendor-side, and the per-call gate is the
cached `McpTool` row instead of a static list. Tool classification is
overlay first, then the vendor's `readOnlyHint` behavior tag, then the
normal external-action policy. Untagged tools use the bot's existing approval
mode and rules; ASK prompts, while AUTO/FULL retain their ratified behavior.

Curated direct-MCP slugs win: a toolkit whose slug duplicates a curated
entry is filtered out of the directory. A vendor catalog outage serves the
stale cache, or an empty Composio section, and never fails the endpoint.

## D-203 — Plugin access for selected bots or all bots with exceptions (2026-10-11)

**Status:** accepted · **Task:** V1-INT-01 · **Extends:** D-104, D-164, D-202

The Plugins screen manages each installation's access across the account's bots.
`SELECTED` allows only explicitly selected bots. `ALL` allows current and future
bots except explicitly excluded bots, as requested by the operator. New installations
default to `SELECTED` with nobody selected. This applies to Composio and direct MCP.
`McpServer.accessMode` stores the mode and `accessRevision` fences approvals.
`BotMcpServer` rows are positive grants in SELECTED mode and negative exceptions
in ALL mode. Effective access is evaluated from the owned installation and bot
at turn assembly and again at dispatch, so future bots inherit without a creation hook.

The shared `PluginAccessSchema` is `{mode:'SELECTED', selectedBotIds:string[]}`
or `{mode:'ALL', excludedBotIds:string[]}`. IDs must belong to the same account.
Server summaries expose `access`; `PUT /mcp/servers/:id/access` atomically replaces
the mode and overrides and returns the saved access. The existing per-bot PUT
updates that bot's grant or exclusion without changing the installation's mode.
Changing either path invalidates pending approvals. Uninstall's disabled tombstone
cannot receive new access and never contributes tools, even in ALL mode.

OAuth scopes remain deployment auth-config permissions, separate from bot access.
The client explains that permissions are chosen at sign-in and changing configured
scopes requires reconnecting. It does not mutate a project-wide auth config from
an individual account. In-chat connection initiation and event triggers remain deferred.

## D-202 — Composio app integrations under the TanStack harness (2026-10-11)

**Status:** accepted · **Task:** V1-INT-01

Gmail, Google Calendar and Slack use `@composio/core` 0.22.0 in both editions.
The SDK requires Node >=22.22.3. Cloud supplies the deployment's Composio project;
self-hosted administrators supply their own project and three auth config IDs.
An incompletely configured app is absent from the directory and cannot install.
Direct MCP remains available for custom servers and the other curated apps.
The pilot apps have no parallel direct-MCP implementation. Fresh setup is the
contract: no imported credentials, historical data conversion or client fallback.

`McpServer.backend` distinguishes `DIRECT` and `COMPOSIO`; a Composio row has no
URL or MCP transport. The public summary carries only that distinction, never
Composio credentials or session IDs. A related `ComposioConnection` holds the
selected and pending account IDs, pending expiry, auth config ID, session ID and
revision. Provider tokens remain with Composio. Connect uses hosted Connect Links
and owner-authenticated polling; completion checks the provider's user, toolkit
and auth config, and concurrent attempts use a generation fence. One account per
app is selected explicitly. Uninstall removes local bot grants immediately and
retains a disabled tombstone if remote cleanup fails, allowing removal to retry.

`CrewaidTanStackProvider` wraps complete Composio JSON schemas into neutral
Crewaid definitions. SDK dispatch enters only after the existing plugin bridge,
validation and approval policy. Tools are user/bot scoped, never globally
registered. Sessions allow only reviewed pilot tools and the selected account;
connection meta-tools, sandbox, proxy and generic execution helpers are not
offered to the model. TanStack and the configured main model own the loop;
Jev is deferred. Session calls use the SDK's cancellation options, no automatic
write retries, and safe projected errors. The policy grant fingerprint includes
the Composio account/session revision, invalidating approvals after reconnect or
revocation. Vendor packages stay confined to the server's integration seam.

## D-200 — Docker authority moves into a narrow sandbox supervisor (2026-10-07)

**Status:** accepted · **Task:** MOD-SE-03 · **Builds on:** D-039, D-150, D-155, D-158 · **Amends:** PRD R2

The self-hosted orchestrator mounted `/var/run/docker.sock`, so anything that reached its process —
a dependency, a request-handling bug — held root on the host: the socket creates a privileged
container with `/` mounted as easily as it starts a computer. The orchestrator needs a handful of
lifecycle verbs on resources it owns, not the daemon.

**The supervisor.** `packages/sandbox-supervisor` is a small HTTP service that alone holds the socket.
It answers only the `ContainerEngine` verbs the Docker provider already uses (D-039's workspace
volumes, the sandbox network, computer create/start/stop/remove/inspect, label and volume lookups,
the retention marker and profile tombstone helpers) and refuses everything else. It is the
authority on every value that decides what a container can do, so a request cannot widen them:

- **Image:** exactly `SANDBOX_IMAGE`; a pinned digest is verified by the daemon itself.
- **Network and ports:** exactly `SANDBOX_NETWORK` and the fixed sandbox, seat and DevTools ports.
- **Mounts:** none, or the bot's own workspace volume at `/home/bot`, and only a volume the
  supervisor labelled. A host path has no field to travel in.
- **Limits:** within the supervisor's own `SANDBOX_CPUS`/`SANDBOX_MEMORY_MIB` fence; capabilities
  dropped and `no-new-privileges` are not optional.
- **Labels:** the supervisor writes `crewaid.managedBy`; a caller names only the session, identity
  and bot. Every verb on an existing container or volume first checks that label, so a resource the
  supervisor did not create is refused, not acted on.
  Container inventory and mutations also check the daemon-reported sandbox network; workspace
  volumes carry the supervisor-written `crewaid.supervisorNetwork` label. A second deployment on
  the same daemon cannot inventory, mark or delete another deployment's resources. Existing
  unscoped volumes are refused by mutations and omitted from retention inventory; the pre-launch
  fresh-setup contract applies rather than silently adopting them.
- **Exec:** none. A computer's commands and files go through its agent-bridge `/exec`, the path the
  hosted providers already use (D-150), so the supervisor exposes no generic exec. Its own helpers
  run one fixed program each.

**Authentication.** Each request carries an HMAC-SHA256 over method, path, timestamp, nonce and body
hash under `SANDBOX_SUPERVISOR_SECRET`. The secret never crosses the wire and never enters a
container. A timestamp outside ±30 s, or a nonce seen inside that window, is refused, so a captured
request cannot be replayed. Rotation: the supervisor also accepts `SANDBOX_SUPERVISOR_SECRET_PREVIOUS`
while the orchestrator moves to the new secret. The supervisor listens only on the compose project's
private network and is never published.

**Audit.** Every lifecycle verb writes one JSON log line, `supervisor.action`, naming the verb, the
resource and the outcome, including refusals.

**Outage.** An unreachable supervisor is a provider error like an unreachable daemon was: starts fail,
health reports `docker: false`, and nothing is marked as gone. Reconciliation runs again once the
supervisor answers.

**R2, amended.** The one file allowed to import `dockerode` is now
`packages/sandbox-supervisor/src/docker-engine.ts`. `packages/sandbox-docker` keeps the provider's
lifecycle logic and talks to the supervisor through `SupervisorEngine`. The orchestrator has neither
the socket nor the module.

**Not in scope.** A per-computer credential for the agent-bridge. The bridge is still reached only
across the sandbox network, where the egress fence admits only the orchestrator's address.

## D-201 — Bounded transcript reads and an ephemeral switching preview (2026-10-11)

**Status:** accepted · **Builds on:** D-166, D-192

The operator's hydrate honors the library's existing `loadThread(threadId, options)` paging
hint with sequence-bounded database reads. The unpaged model reader is unchanged. The library
still groups canonical messages into UI messages and owns the wire cursor and window. A paged
read scans enough bounded batches to include one extra UI message, including reservations and
tool-result grouping; it does not reread the full thread on every page.

The renderer requests 150 UI messages and starts fetching older history within two viewport
heights of the top. It preserves the row being read at page arrival, including scrolling that
happened during the request. Settled projections retain their identity while a reply streams.

An App-owned, bounded in-memory cache may paint the newest settled transcript while the keyed
client hydrates. This is only a display preview: it never seeds the chat client, approvals,
generation state or a send. The server still owns history, every mount refreshes it, and an empty
response clears the preview. The preview expires, is scoped to endpoint and credentials, and
is invalidated by transcript changes or a disconnected shell. No disk cache or store library is
introduced. Switching bots derives the endpoint from credentials already read by the mounted
shell, rather than momentarily using the previous bot's address during another IPC read.


## D-205 — standalone AG-UI chat and bounded streaming persistence (2026-10-11)

The modernization audit in `docs/reviews/MODERNIZATION-AUDIT-2026-10-11.md` found a refused POST reported as a successful send, a continuation emitting a tool result before RUN_STARTED, and database work proportional to both token count and transcript length. This decision supersedes D-160's renderer package allowance and D-192's TanStack client choice.

- The renderer uses pinned `@ag-ui/core` and `@ag-ui/client` 1.0.1, with the client's RxJS 7.8.1 (nominal Observable types must resolve to the same version). Nest retains RxJS 7.8.2 and TanStack retains its server core pin. TanStack AI stays in the server seams. CopilotKit is not a dependency. The official AG-UI client owns streamed messages and interrupts; React subscribes to it, with bounded display notifications.
- Existing chat URLs, identities, authentication, attachment admission, cancellation and server-owned history remain authoritative. A send succeeds only after a successful HTTP admission response (including deferred 202). Refusal preserves the draft and attachments and removes the optimistic message. Announcements and admitted responses use one sequential, deduplicated run reader. Disconnect detaches the reader; only the existing cancel action cancels work.
- Hydration uses the existing envelope and pagination cursor, now declared by `ChatHydrationSchema` in shared, with AG-UI messages produced by TanStack's server wire codec. The limit counts canonical anchors, including their reasoning/result fan-outs; it does not split a tool pair. Protocol payloads are validated by the AG-UI SDK. Pending interrupt descriptors and binding metadata travel unchanged. An already admitted running continuation takes precedence over its parent's temporarily pending interrupt while the producer consumes it, so another window follows the continuation rather than asking the answered question again.
- Every execution emits RUN_STARTED before restored tool results or any other output, including errors. The upstream duplicate opener is suppressed. The public stream supplies the reasoning role required by AG-UI 1.0.1 and gives reasoning its own message identity. An empty assistant opener waits until its text or tools start, so preceding reasoning stays separate from the spoken reply. Terminal events still follow the owned closing transaction.
- The durable event log remains the source for live partial output and replay. Content deltas are committed in bounded batches (at most 32 events, 16 ms idle batching delay; queued content waits behind the single in-flight database write); lifecycle boundaries flush immediately. There is at most one in-flight append and bounded queued content. No event reaches external delivery before its batch commits. Flush errors propagate and abort the producer. Closing persistence flushes pending events before releasing the lease.
- Canonical transcript saves occur at tool/checkpoint/interrupt/terminal boundaries. Full-history text snapshots during provider streaming are removed. A one-second checkpoint saves only the dirty text reply, starting after its first visible delta, preserving partial text across a process death without reconciling all history. On failure or cancellation an unfinished text reply is saved once more under the owned boundary. Tool-call markup is excluded from these partial saves. No transcript save truncates history, weakens ownership or moves a row between threads.
- Regression acceptance covers refused/deferred admission, hydration/paging, ordinary and approval-continuation production SSE through the official AG-UI client, disposal, bounded batch ordering/backpressure/failure, real PostgreSQL replay/fencing and the renderer dependency guard. Paid-provider and screen acceptance remain separately owned milestone work.

## D-206 — failed producer settlement and quiet automatic continuations (2026-10-11)

An owned development run returned Gmail data and began a model response, then closed its event log while its durable status stayed running. Recovery repeatedly reclaimed the run and failed against the closed log. This is an implementation defect; the original failure's cause is not established by its generic error.

- An execution or delivery exception must settle the captured producer as failed (or aborted for an operator cancellation) through the owned database boundary, independently of a failed delivery buffer. Its safe terminal event follows that commit when the event log is writable. A released or replaced producer cannot alter its successor.
- If settlement cannot commit, stop the heartbeat and release the captured lease for recovery; retain the open log. Never deliberately close the log of a run left running. Recovery settles an already-closed running log as failed, without calling the model or repeating tools.
- Automatic continuations retain their internal step/round budgets and model instructions, but post no chat notice. The normal working indicator communicates ongoing work. Actual stops explain that the bot needs another instruction, without step/token/round counters. Retry notices state the retry without counts. Already-stored automatic continuation notices are omitted from the product transcript; meaningful stop/error notices and ordinary messages remain visible.
- Acceptance injects execution and durable-append failures against real PostgreSQL, checks terminal status, released active keys, ordered safe error replay and refusal by a replaced owner, and proves repeated recovery of a closed log does not call the model. No external outage diagnosis is inferred from UNKNOWN.
- Structured JSON logs use Pino's ISO timestamp function (UTC with an explicit Z) so incident times are readable without decoding Unix milliseconds. Correlation fields and credential redaction remain unchanged.

## D-207 — conversation before run in durable event transactions (2026-10-11)

Final concurrency acceptance logged Prisma P2034 while an event writer raced admission. The event transaction locked AgentTurn before inserting RunEvent, whose conversation foreign key then needs a lock on Conversation. Canonical saves and admission acquire Conversation before AgentTurn, creating a deadlock cycle. Delayed content batches make this overlap possible inside one producer as well as across requests.

- Durable event append/close transactions lock the owned conversation before fencing the captured run. They keep the same ownership/epoch predicates; no transaction spans model or tool work. This matches the existing conversation-before-run order of canonical writes, and the bot-before-conversation-before-run order of admission and terminal composition.
- Acceptance holds a conversation lock, blocks an actual event append, then requests the run lock within that first transaction. Both transactions must finish without a deadlock, with exactly ordered durable replay. The test synchronizes against PostgreSQL's blocking metadata rather than sleep timing.
- The working indicator uses the admitted run's authoritative start time from existing hydration or its original RUN_STARTED timestamp. Switching bots or reconnecting does not manufacture a new start time; protocol state remains owned by AG-UI.
- The hydration active-run descriptor additionally carries its optional admitted `startedAt` in epoch milliseconds, read through the owned native run store. Execution diagnostics log error class, normalized code, stage when known, and HTTP status when present; provider text, request bodies, credentials and email content are excluded.


## D-212 — Chat tool cards are product projections over AG-UI (2026-10-12)

The operator requested the OpenDots chat experience while retaining standalone AG-UI and React. This is presentation work over the existing server-owned transcript and native interrupts, not an additional execution or persistence layer.

- The existing part-renderer registry supplies specialized computer, connected-service and file/deliverable cards, with the existing generic tool renderer as fallback. Readable action labels, current progress, bounded result previews and inline approvals use the same stored tool calls/results and captured approval bindings as ordinary chat. Unknown or partial results remain visible through a safe fallback rather than being described as successful.
- The current action, actionable failures and meaningful results are visible. Older routine activity may collapse into a disclosure; conversation order, the Show bot work preference and accessible details remain authoritative. A failed or stopped run must not leave a card claiming to be working.
- Approval cards display the bound request, retain edited-argument and identity-turn scope rules, and respond through the existing approval handler. The UI does not introduce another approval requirement, repeat a dispatched action, or infer approval from a model-generated summary. Existing server policy remains the authority.
- Existing attachment/deliverable previews and the bot's computer viewer provide navigation. Cards do not poll screenshots, start a computer merely by rendering, fetch every result again, or write another record on a streamed update. Raw tool data is text or validated structured fields; it is never executable HTML or an untrusted link target.
- Acceptance covers connected-service results/failures, file previews, pending/answered/edited approvals, interrupted activity, current-action visibility, history/replay, keyboard operation and both room themes. No CopilotKit, Tiptap or new wire endpoint/schema/configuration is introduced.

### D-213 — Recognizable output cards in chat and Work (2026-10-12)

The user extended CC-80 to attachments and deliverables, with email drafts and Google Workspace outputs as examples. Presentation adapters may recognize documented tool slugs and validated stored fields to render email, document, spreadsheet and slide identities. Email previews show recipients, subject and inert body text; creating or updating a draft must never look like sending it. Only returned results establish completion, and the existing server approval flow remains the only executor. Unknown or changed provider shapes retain the bounded generic result/details view. No resource is inferred from assistant prose.

Attachments and Work deliverables share type-aware identity, preview/download affordances and the existing authenticated viewer. Previewing or opening a result never creates a deliverable, polls a provider, or starts another model call. Remote links use the existing fenced system browser and are available only for successful results with valid HTTPS resource locations. Keep Paper/Light/Night themes and preserve attachment failure, abort, download authorization, task filing and preview behavior. No document editor, new integration, wire schema or database change is included.

### D-214 — Preview an email without creating a remote draft (2026-10-12)

The user's email-preview example asks to review text before adding it to Gmail. A new native `preview_email` tool presents a plain-text draft with `to`, `subject`, `body`, optional `cc`/`bcc` in the existing canonical tool call/result stream. `NativeToolInputs.preview_email` is the shared argument contract; recipient fields are bounded strings (including display-name addresses) and body is at most 20,000 characters. It is an observing builtin: it writes no remote draft, sends no email, opens no machine or account, and returns a short acknowledgment rather than copying the body into another result. The card says Preview only / Not saved or sent. No endpoint, table, renderer-owned execution or automatic follow-up is added. This narrow new tool/input contract amends D-213's no-schema-change scope.

Standing, provider-independent instructions direct bots to use this tool for drafting/review, and to wait for the user before saving to a connected mailbox or sending. This is a communication instruction; existing approval policies remain the enforcement boundary for external actions. Native approvals render the same draft preview over their captured arguments and existing handler, without treating approval of a preview as approval of a send.

### D-215 — The transcript shows what a bot said and what it made for the user (2026-10-12)

The line CC-80's cards must draw is at OUTPUT, not at activity. A tool call is a user output when the tool produces something the user keeps or reviews: an email preview, draft or send, a created or updated Google document/sheet/presentation, a written or attached file. Reads, searches, listings, computer control, shell and Work tools are routine work — machinery the reply already summarizes, and a transcript that prints every fetch is noise. A created task or goal lives in the Tasks pane, not as a "Status: open" card between the bubbles. Failures follow the tool, not the luck of the turn: a failed send is an output card with what went wrong, a failed read is routine. This includes our own argument-validation failures, which the adapters return as results (`INVALID_ARGUMENTS: ...`) rather than throwing — a receipt must never call one a success.

Visibility: with "Show thinking and actions" off, only speech, pending approval prompts and user outputs render. With it on, the routine steps return as one collapsed action log per turn — open while the reply streams, settled and out of the way once the answer lands. Either way, raw arguments and results never sit on a row's face; they live in the row's Details, beside the bounded file preview. Runs of one producing action on one artifact render once — the artifact's identity (service, title, recipients) is the signature, the last run's outcome is the final state, and a count badge says how many times the action ran, because a retried draft must not stack two cards for one email.

Mechanically: part renderers register a predicate identifying their user outputs; the shared transcript projection and row layout use that same predicate. This visibility distinction is presentation only and introduces no event or persistence state. Read-only connected-app actions never render as resource cards — an email a bot fetched is not a deliverable. The rule is code-enumerable today because the built-in and Google tool sets are known; a long-tail MCP app's tools may later be classified once at registration time (a decision model fits that job), which would flow through the same predicate rather than the render path.

## D-208 — GitHub repository work through a server-authenticated Git stream (2026-10-12)

**Status:** accepted · **Task:** V1-INT-03 · **Builds on:** D-104, D-150, D-164, D-173, D-203

The operator approved dedicated clone/fetch/push tools, existing GitHub account and bot access,
forking when source push access is unavailable, and draft PRs by default. This uses the canonical
direct GitHub MCP installation; neither Composio GitHub toolkit is a Git credential export path.

- Three Crewaid-owned descriptors join the installation's discovery bridge. Private tool provenance
  distinguishes them from vendor methods; vendor payloads cannot select a local handler. Clone and
  fetch are local drafts with read-only provider access. Push has a trusted commit adapter.
- Git runs on the owned computer. A packaged helper exposes an ephemeral loopback HTTP endpoint
  and relays smart-HTTP over the existing streaming exec channel. The orchestrator supplies GitHub
  authentication through the sole credential reader, only to fixed HTTPS GitHub URLs. Tokens never
  enter the helper, files, model, logs or tool results. No new sandbox ingress or egress is needed.
- Owned checkout/publication rows pin repository identity, workspace path, bot, installation and
  attempted target/ref/object IDs. Paths stay in the bot's area; operations serialize per checkout.
  Full ordinary Git history and binary files are supported. Submodules, Git LFS, SSH, Enterprise,
  GitLab and automatically authenticated shell commands are deferred.
- Push approval binds the account, checkout, target repository and branch, local commit/tree,
  expected remote HEAD, and access/credential revisions. Dispatch recomputes that binding and
  validates the receive-pack ref update before forwarding bytes. Only new feature branches or
  updates owned by this checkout are permitted; no default-branch writes, tags, deletions or
  non-fast-forward updates. GitHub protections are not bypassed.
- Fork and PR operations continue through GitHub tools with ordinary approval policy. Destination
  forks must belong to the source network. Omitted PR draft is normalized to true before approval
  hashing; explicit false is respected. No uncertain push/fork/PR is automatically repeated.
- Streams use bounded buffers, a ten-minute deadline and a 1 GiB transfer cap. Cancellation,
  timeout and peer loss stop the helper's process group. Restart reconciles attempted publication
  by reading the remote ref. Revocation blocks future requests and preserves local work.

The same capability serves Docker and DigitalOcean in both editions. Fresh schema setup remains
D-158's contract; no customer-data import or compatibility path is introduced.

D-208 setup clarification: the official GitHub resource publishes OAuth metadata but its
authorization server does not offer dynamic client registration. The direct installation
uses an administrator-registered GitHub OAuth app, configured with
`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, in both editions. The user selected reuse of the existing GitHub sign-in OAuth app. Add the
existing plugin OAuth callback alongside its sign-in callback; both editions
read the same server-only client settings. Request `repo`,
`read:org`, `workflow` and `offline_access`; use S256 PKCE and account selection. Secrets
remain in the server environment. GitHub's comma-separated scope responses are normalized
when stored. Refresh before preparing Git operations; never replay a dispatched fork or
PR creation after an authorization rejection.

D-208 publication recovery clarification: fork and PR creation retain their existing
GitHub MCP methods and policy rules, with a trusted commit adapter and an owned
`GitRemoteWrite` receipt. The receipt stores the normalized request, expected account,
connection/access binding, status and confirmed URL. A started write is never replayed.
After a lost response, fixed GitHub REST reads reconcile the expected fork or PR; absence
leaves it uncertain and blocks repeating that request. Confirmed identical requests return
the existing artifact. Receipts survive restart and disappear with the installation;
repository files and remote artifacts remain untouched.

## D-216 — Releases update the existing Cloudflare sandbox Worker (2026-10-12)

Stable release tags may update the existing Cloudflare computer Worker after
the sandbox's AMD64 image has been built and pushed to GHCR. The Cloudflare
job is independent of npm installer publication. It deploys a thin Dockerfile
whose sole base is that immutable GHCR image; Wrangler copies it into
Cloudflare's registry and resolves its digest as `images.base` under the
existing `durable_object` policy. Nothing is provisioned or deleted.
The immutable release image must pass the sandbox runtime smoke check before
copying it to Cloudflare.

`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_SANDBOX_WORKER_NAME` are GitHub repository
variables; `CLOUDFLARE_API_TOKEN` is a GitHub secret. Wrangler resolved the
user-selected application `crewaid-computers-computer` with ID
`edf20284c84d43bf8abaee0b4544a43e` to Worker `crewaid-computers`, in account
`c65487e5772e254efd8be954e4183bee`. `CLOUDFLARE_SANDBOX_APPLICATION_ID` retains
that selected application/COMPUTER namespace ID as an additional identity check.
The job must verify that this exact Worker exists with the computer, registry,
workspace and control-secret bindings. A missing target refuses deployment
rather than creating a duplicate. Existing workspace bucket and computer
resource settings are retained, and namespace identities are verified afterward.

The deployed Worker's `CREWAID_SANDBOX_RELEASE_FINGERPRINT` records a hash of
the Dockerfile, copied sandbox/executor inputs, esbuild pin, Docker ignore rules,
Worker code and deployment configuration. A desktop version bump alone does not
change it. Comparison is against the live Worker, so a failed earlier deployment
is retried by a later release even if its inputs did not change. A matching
fingerprint skips the image copy and deployment.

Cloudflare deployments are serialized, and only the newest stable release may
update the Worker. Running computers retain their image; their next normal
start selects the new image and restores the saved workspace. The release
does not restart user computers or change their scheduling policy or namespaces.

## D-217 — Runtime (withruntime.com) is a third hosted sandbox provider (2026-10-13)

`SANDBOX_PROVIDER=runtime` runs each computer as a Runtime sandbox, a
Firecracker microVM per computer, beside Docker, DigitalOcean (D-150) and
Cloudflare (D-151). Both hosted providers work, but each needs infrastructure
of our own: a rebased DigitalOcean template, or a control Worker with a Durable
Object and an R2 tar of `/home/bot`. Runtime builds our Dockerfile, pauses and
wakes a whole machine with its memory, and tunnels to its ports, so the
provider is a thin client over its SDK and there is nothing else to deploy.
Production moves to it; DigitalOcean and Cloudflare are removed later, in their
own change, once Runtime has carried real computers.

**It plugs in at the `SandboxProvider` seam, not through Runtime's framework
adapters.** `withruntime/ai-harness` is a sandbox for the AI SDK's
`HarnessAgent`; the engine is TanStack (D-190, D-199), and the orchestrator
needs workspace retention, inventory, health and raw TCP to RFB, the bridge and
CDP, none of which it covers. `withruntime/ai` and `withruntime/tools` hand the
model `runtime_exec` and three file tools; bots already have `shell`, `fs_read`
and `fs_write` through the bridge, inside their seat, under approvals (D-164),
and the same bot must behave the same on every provider. Runtime's desktop and
browser products are a web live view and a CDP URL, not the RFB screen and
per-bot seats on one shared computer. So no agent, tool or renderer code
changes.

**Shape.** `packages/sandbox-runtime`, over the official SDK (`withruntime`,
pinned exactly). `runtime-client.ts` is the only file that imports the SDK and
the only reader of `RUNTIME_API_KEY`; it adapts the SDK to a narrow `RuntimeApi`
port, which the provider is written against and the tests fake in memory.

- A computer is one sandbox named `crewaid-<id>`, labelled `crewaid=computer`.
  Its disk is the workspace, so `stop`, `destroy` and orphan cleanup pause it,
  and only retention's `deleted` outcome deletes it. A pause keeps memory and
  processes, so a wake brings the desktop and a logged-in browser back as they
  were.
- The workspace's history is in the sandbox's labels: `crewaid-first-start`
  (written once, by the first start) and `crewaid-orphaned-at` (epoch ms, or
  `none`). They travel with the workspace as D-039's markers do, and are read
  through the API, so neither the workspace sweep nor retention ever wakes a
  paused machine. No exec runs as root.
- Every sandbox is created with `idlePauseSeconds: 0`, no time limit, and paused
  retention set to "while the account has credit": the orchestrator decides
  when a computer pauses (WORKSPACE.md §8) and only retention deletes one (§9).
  A computer the API cannot mark that way is deleted before it is handed out.
  **An account without credit cannot mark it** (`retention_unavailable`: a
  paused sandbox is kept seven days, then deleted with its files), so the
  provider refuses such an account with a message that says to add credit,
  rather than hand out computers a week's absence would erase.
- Ports reach the orchestrator as loopback listeners over the SDK's tunnel: one
  WebSocket per computer, authenticated by the API key, carrying TCP to the
  sandbox's own loopback. No port is opened to the internet and no preview is
  created, which matters because the agent bridge has no authentication.
  Commands and file I/O go through the bridge's `/exec` over that tunnel, as on
  every hosted provider (D-150).
- The image reaches Runtime through `pnpm --filter @crewaid/sandbox-runtime
  build-image <tag>`: Runtime builds `infra/sandbox-image/Dockerfile` with the
  repo root as context, or, with `--from`, imports the image the release
  workflow already pushed to GHCR (credentials stored once in Runtime with
  `runtime images registry set ghcr.io`). Its start command is the entrypoint
  and its ready check is the bridge's port, so a create answers once the
  desktop is up.
- Runtime runs the start command **on create only**: a restart from disk comes
  up with no desktop, and a desktop that died before a pause is still dead
  after the wake (both measured). Whenever the bridge is silent the provider
  runs the image's `crewaid-desktop-up` through Runtime's exec as root (`sudo`,
  which Runtime adds for the sandbox user), again every 20 s until a deadline;
  it is idempotent, and the entrypoint clears the X lock a previous boot left
  in `/tmp`. Restarting would drop memory and still not start the desktop.
- Runtime's exec runs as the sandbox user, uid 1000, which is the image's
  `bot`; retiring a bot's profile runs `profiles.py` directly as that user.

**Config.** `SANDBOX_PROVIDER=runtime`, `RUNTIME_API_KEY` (the SDK's and CLI's own
name), `SANDBOX_RUNTIME_IMAGE` (required, `crewaid-sandbox:<tag>`), and
`SANDBOX_RUNTIME_VCPU` / `SANDBOX_RUNTIME_MEMORY_MIB` / `SANDBOX_RUNTIME_DISK_MIB`
(4 / 8192 / 20480 by default, bounded by Runtime's limits at boot). One Runtime
account serves one deployment: inventory is every sandbox labelled
`crewaid=computer`.

**What it does not do yet.**

- An image update reaches new computers only. Runtime's `switchImage` keeps
  `/workspace` and volumes but not the rest of the disk, and the workspace here
  is `/home/bot`, so switching would lose it. DigitalOcean has the same limit.
  Putting `/home/bot` on a Runtime volume would make `switchImage` safe and is
  the follow-up if images change often.
- Outbound traffic is Runtime's default for a paid account. The egress fence
  Docker deployments run (D-200) has no counterpart; Runtime refuses private
  and metadata addresses itself.
- Releases do not rebuild the Runtime image; the build script is run by hand,
  and a release job (most simply `build-image <tag> --from` the image the same
  release pushed) is the follow-up to D-216's.
- Runtime's image builder refuses outbound requests after about sixty in one
  RUN step, while an ordinary sandbox on the same account downloads freely.
  The Dockerfile's apt step makes several hundred, so building it fails there,
  through our script and Runtime's own CLI alike, and still did on a 4 vCPU
  builder after credit was added. `--from` avoids RUN steps entirely, so it is
  the path to use until Runtime lifts that limit.

**Measured on Runtime, 2026-10-13** (trial account, 2 vCPU / 4 GiB, image
`crewaid-sandbox:0.0.8` imported from GHCR in 29 s, 3,076 MiB). Through the
provider: provisioning a computer 4–5 s; its first start 1.5–2 s; a wake
1–1.3 s with the same processes and files; a killed desktop relaunched in 5 s;
a sandbox Runtime stopped back with its files in 5 s; commands as `bot` (uid
1000) in `/home/bot`; a 300 KB file round trip; the RFB screen and a seat's
Chrome reaching the internet over CDP; the bridge's round trip from a
workstation in Asia 126–136 ms median. Through the orchestrator: a computer
started by the API in 3 s, the live screen streamed to a WebSocket client
(first frame 3.5 s), stop in 0.8 s and start again in 1.7 s with the screen
back. Repeated with credit at the default 4 vCPU / 8 GiB / 20 GiB, with no
test-only changes: the same 27 provider checks passed with paused retention
set for real, and a chat turn on Qwen3 Coder through OpenRouter used the
computer's `shell`, `fs_write`, `capture_screen`, `browser_navigate` and
`browser_read` (real output: `bot`, `runtime-guest`, kernel 6.18.44, 4 CPUs).
On a quiet link the bridge round trip was 108 ms median; stop took 1.2 s and
start 2 s. The whole run used Runtime's included usage and charged no credit.

---

## D-218 — The screen stream keeps a measured window of updates on the way (2026-10-13)

Taking over a computer on Runtime lagged after every interaction. The path was
the cause: the viewer was 185 ms from the orchestrator in Oregon, and the
orchestrator was about 65 ms from the machines in Virginia. Delivery pacing
asked x11vnc for the next update only after the viewer's pong for the last one,
so every frame paid both round trips, one after the other. That meant at most
four frames a second, and no request parked at x11vnc for a key typed meanwhile.

**The rule.** `ScreenStream` asks for the next update while the window has
room, and forwards each update the moment it arrives. The window is at most
`SCREEN_MAX_UPDATES_IN_FLIGHT` (3) unconfirmed updates, the next request
counting as one, and no more bytes than the line to the slowest viewer carries
without queueing.

- **The byte limit** is that line's delivery rate times its latency, the
  bandwidth-delay product. `DeliveryLine` estimates both from the viewers' pongs:
  - **latency** from small updates sent onto an idle line;
  - **rate** from large updates, counting only the time each spent behind its
    own bytes. One sample may at most double the estimate, so pongs that
    arrive together cannot read as an infinitely fast line.

  Until both are known, only 16 KiB may be on the way beside one update.
- **A slow line therefore still gets stop-and-wait** (one busy update at a time),
  which was the reason delivery pacing exists: 3 MB queued on a 1 Mbit/s line. A
  fast, distant line gets several frames per round trip.
- **Nothing is held at the orchestrator.** An update held back for a pong shows a
  picture one round trip older than the one a fresh request would fetch.
- **`AdaptiveQuality` now judges the transfer time `DeliveryLine` computes,** so
  queueing behind an earlier update is not read as a slow line.

**Measured on Runtime the same day.**
- **Setup:** the orchestrator ran on a workstation, about 95 ms from Runtime.
  The viewer sat behind a shaped 185 ms link. Each rule got two runs on a line
  with 2.5–5% packet loss, so the figures are noisy.
- **Results:**

  | | One update at a time | The window |
  |---|---|---|
  | Frames during a 30-key typing burst | 6–7 | 12–15 |
  | Frames per second, terminal scrolling at 50 lines a second | 1.5–1.9 | 2.1–3.4 |
  | Keystroke into that busy terminal until it showed (p50) | 940–960 ms, most attempts not seen within a second | 503–665 ms |
  | Keystroke on a quiet screen (p50) | 385–395 ms | 375–413 ms |

  The quiet-screen keystroke cannot improve: a request is parked at x11vnc
  either way.
- **Inside the machine, x11vnc took 77 ms (p50) to send a typed character.**
  That figure has no network in it. `-defer 5 -wait 5` cut it to 57 ms with no
  measurable idle CPU; that is an image change, left for its own release.

**What this does not settle.** This is the RFB path the screen gate (D-158,
MOD-SC-01..03) measures against. It makes no streamer selection, and it does not
replace that comparison. Sending pixels from the machine straight to the viewer
would also take the orchestrator's hop out of every frame. Input would still
go through the orchestrator, as D-158 requires. That needs a new endpoint and
contract, and it is MOD-SC-03's to decide.

---

## D-219 — Runtime computers follow sandbox releases, switched in place when Runtime allows (2026-10-13)

D-217 left image updates to new computers only. This change makes a release
reach the computers that already exist, as far as Runtime allows. It also
ships the x11vnc polling change measured in D-218.

**Releases put the image on Runtime.** `release-images.yml` gains a
`runtime-sandbox` job. After a `v*` release publishes the multi-arch sandbox
image to GHCR, the job runs `build-image <tag> --from ghcr.io/…:<version>`:

- Runtime pulls the image with the read token stored in it once, so nothing is
  built twice.
- The job tags the new version with the release.
- For the newest release only (`newest-release.sh`), `--latest` also moves
  `crewaid-sandbox:latest`.

The job needs the `RUNTIME_API_KEY` Actions secret, and fails with that message
without it. A deployment that sets `SANDBOX_RUNTIME_IMAGE=crewaid-sandbox:latest`
follows releases; a fixed tag pins every computer to it.

**What a computer runs is a label.** The provider resolves the configured
reference to the version it names now, creates a computer from that exact
version, and labels the sandbox `crewaid-image=<version id>`.

**A computer behind the configured version is moved on its next start from
paused or stopped,** never while it runs, because a bot may be mid-task. The
provider:

1. **Prepares the machine as root:**
   - it closes Chrome, so profiles are consistent on disk;
   - if the home is still on the image's disk, it copies `/home/bot` once into
     `/workspace/.crewaid-home`, under a temporary name that is then renamed;
   - it runs `sync`.
2. **Calls `switchImage`.**
3. **Relabels the sandbox** with the new version.

What the switch relies on, measured on Runtime:

- **What Runtime keeps:** across a switch it keeps `/workspace`, copied in up to
  60 s, and discards the rest of the disk.
- **What restarts:** the new image's start command runs again; the desktop was
  up about 1 s after the switch answered.
- **The start command:** every image `build-image` makes starts with
  `crewaid-runtime-start`. It runs `crewaid-home-on-workspace --create`, which
  binds `/workspace/.crewaid-home` over `/home/bot` (making it the first time,
  from the image's own home), then the entrypoint.
- **After a restart from disk:** that runs no start command, so
  `crewaid-desktop-up` makes the same bind.

Paths stay `/home/bot` everywhere. On Docker, DigitalOcean and Cloudflare no
such home exists, and both scripts do nothing.

**When the move does not happen, the computer starts on its image anyway.**
The start a person asked for matters more than the update.

- **Runtime refuses the switch** (`switch_undone`, `image_on_another_host`,
  `disk_too_small`, …): the provider records `crewaid-image-refused=<version>`
  and does not try that version again; the next release is tried afresh.
- **The machine cannot be prepared,** for example the disk is full: it is tried
  again on the next start.
- **The target image lacks the start command:** the provider never switches to
  it, because the home would be left behind.

Each case goes to the orchestrator's log. Only an API fault outside the switch
fails the start.

**Runtime decides whether a switch can happen.** Each image version is stored on
one server, and a switch only moves a sandbox to an image on its own server
(`image_on_another_host`: "a switch moves no sandbox between servers").

Live tests on 2026-10-13 used the provider's own code against images built
on Runtime:

- **Placement:** fresh images shared the computer's server in about half of
  seven attempts.
- **When they did,** a computer created on a plain-start image was moved
  correctly:
  - its start, with the one-time copy and the switch, took about 13 s;
  - `/home/bot` was then bound from `/workspace/.crewaid-home`, with its files
    and a Chrome file's `bot 600` mode kept;
  - x11vnc ran with the new settings;
  - a later plain start took 1.6 s.
- **When they did not,** the switch was refused and the computer started
  unchanged.
- **New computers:** a computer created from a new image had its home in
  `/workspace` from the start.
- **x11vnc:** a typed character's update on the machine's display took 37 ms
  (p50) with `-defer 5 -wait 5`, against 74 ms on `v0.0.8`.

Runtime also starts every sandbox created from an image on the server holding
that image (`account_busy_here`). So a deployment's computers gather on a few
servers, which bounds their capacity.

**Two Runtime behaviours found on the way, to report to Runtime; both are
outside this decision:**

- **A stop after a switch never finishes restarting.** After any switch, even
  between two plain images, a stopped sandbox stays `starting`
  (`sandbox_not_ready`) for more than five minutes after its restart. The
  provider never stops a computer, and pause and wake after a switch work, so
  only a stop Runtime makes itself hits this.
- **A stop of a paused, non-persistent sandbox ends it.** The sandbox stays
  `stopping`, and its restart is refused as `not_resumable`. A stop from
  running restarts in about 4 s. This bears on D-217's recovery from a stop
  Runtime makes itself.

**Rejected.**

- **Runtime volumes for the home.** A volume lives on one server, and a create
  with a volume on another server than the image was refused
  (`volumes_on_different_hosts`).
- **Runtime's private network,** where each sandbox reaches the others by name.
  Every customer's computer on the account could then reach every other
  computer's unauthenticated bridge.
- **Moving a computer across servers:** a new sandbox from the new image, the
  home copied over a short-lived, token-protected private preview, then the old
  sandbox deleted. This is reliable, and it is deferred because images change
  rarely. It is the path if releases often fail to reach existing computers, or
  if Runtime cannot place an image on a chosen server.

## D-220 — Artifacts live in R2 on a cloud server, and never on its disk (2026-10-13)

**Status:** accepted · **Task:** M9-BE-12 · **Builds on:** D-019, D-031, D-152, D-158 · **Amends:** D-031

Attachments, the files bots attach with `attach_file`, and the recording click crops (D-043)
were all written under `ARTIFACT_DIR`. On the hosted service that is one Docker volume on one
host: the only copy of every user's files, no way to run a second orchestrator, and a 2 GB cap
that every user shares.

**One store, chosen at boot.** Every artifact read and write goes through `ArtifactStore`
(`apps/orchestrator/src/attachments/artifact-store.ts`): `put`, `get`, `open` (a stream for
downloads) and `delete`. An absent object is an answer, not an error. There are two
implementations:

- `R2ArtifactStore` talks to one R2 bucket over its S3 API (`aws4fetch`, SigV4, region `auto`).
  It is selected by four keys, `ARTIFACT_R2_ACCOUNT_ID`, `ARTIFACT_R2_ACCESS_KEY_ID`,
  `ARTIFACT_R2_SECRET_ACCESS_KEY` and `ARTIFACT_R2_BUCKET`, and only its file reads the secret.
  A failure reports the operation and the HTTP status, never R2's response body.
- `DiskArtifactStore` is the earlier behaviour: files under `ARTIFACT_DIR`, read when used, and a
  key that would resolve outside the directory is refused.

**Which store a server uses:**

- **All four keys set → R2**, in either edition. Nothing is written to the orchestrator's disk.
- **Some keys but not all → the server refuses to start**, in either edition. A missing key is a
  typo, and guessing would put files somewhere nobody configured.
- **No keys, cloud edition, `NODE_ENV=production` → the server refuses to start.** Every cloud
  deploy runs as production: the image sets it, and so does every `infra/dokploy` compose file.
  Those compose files no longer mount an artifacts volume and require the four keys.
- **No keys, otherwise → disk.** That covers self-hosted servers, and also local development,
  the test suites and the e2e servers, which all run as `cloud` outside production. This is the
  same line `useSecureCookies` draws. A cloud server outside production logs a warning when it
  falls back to disk.

**Quota (amends D-031).** Every upload is checked against a per-user cap first:
`ARTIFACT_MAX_USER_MB`, default 10240 (10 GiB). It counts every `Attachment` row the user owns,
claimed or not, across all of their bots, in either store. The host-wide `ARTIFACT_MAX_TOTAL_MB`
and the `ARTIFACT_MIN_FREE_MB` floor exist to protect a local disk, so they now apply to the disk
store only. All three checks still run under the one advisory lock, together with the row
insert. Recording crops remain outside the quota (open since M3-BE-04).

**What does not change:**

- **No wire or schema change.** `storageKey` keeps its shape (`YYYY-MM-DD/<uuid>-<name>`,
  `recordings/<id>/<uuid>.png`) and is the object key in R2.
- **Downloads still go through `GET /attachments/:id/download`**, which streams R2's body
  straight into the response. There are no presigned URLs: D-025 holds, and the ownership guard
  stays the only door.
- **No migration (D-158).** Files already on the hosted volume are test data, and the cloud
  edition starts with an empty bucket.
- **The bot's computer never sees R2.** It holds no R2 credential (§7.3). Getting an upload onto
  a computer is a separate change: the orchestrator would copy the file in.

## D-221 — Voice: dictation, voice messages and spoken replies, on ElevenLabs (2026-10-14)

**Status:** accepted · **Task:** V2-VOICE-01 … V2-VOICE-04 · **Builds on:** D-025, D-076, D-094,
D-152, D-157, D-160, D-192, D-220 · **Supersedes:** "Voice input" in PRD §1.5's non-goals and §9's deferred work

A person can speak to a bot in two ways, and a bot answers aloud when it was spoken to.

- **Dictation** turns speech into text in the draft, which the person edits and sends as usual.
  Nothing is stored.
- **A voice message** is a recorded clip. It is stored, transcribed, and sent as a message whose
  `content` is the transcript, with the clip attached as a `VOICE_NOTE`.
- **A spoken reply** is automatic and mirrors the input: when a run's trigger carries a USER
  `VOICE_NOTE` and the run completes, the bot's last reply is synthesised and attached to that
  reply as a `VOICE_NOTE`. A typed message, an uploaded audio file, a routine and a teammate's
  delivery never get one. The bot is not given a tool for it, so PRD-WORK §8's tool-token budget
  is untouched.

**The model reads text (D-076).** Speech-to-text and text-to-speech both run on the server; the
model sees the transcript, so a bot's behaviour does not depend on whether its model takes audio.
`provider-context.ts` adds one line to a voice message's user content, telling the model its
reply will be read aloud. The line is per turn, never in `agent-instructions.ts`, so the cached
prefix and D-094's order are unchanged.

**Contract.**

- `enum AttachmentKind { FILE VOICE_NOTE }`, `Attachment.kind` (default `FILE`) and
  `Attachment.durationMs Int?`. `AttachmentSchema` carries both, so every transcript, frame and
  hydrate does.
- `Bot.voiceId String?`, settable through `PATCH /bots/:id`. Null is the house voice.
- `ProviderKind.ELEVENLABS`. A self-hosted user's key is a `ProviderConnection` of this kind,
  stored and rotated by `CredentialService`. It has no models: the catalog and `text-adapter.ts`
  refuse it.
- Routes, under `API_ROUTES.voice`:
  - `POST /voice/transcriptions` (multipart `file`) → `{ text, languageCode }`. Dictation.
  - `POST /voice/notes` (multipart `file`) → `{ attachment, transcript }`. An unclaimed upload;
    sending the transcript with its id is what posts it. A clip with nothing heard is a 400.
  - `GET /voice/voices` → `{ voices: { id, name, previewUrl? }[], defaultVoiceId }`. The list
    includes only voices whose provider `use_case` label is `conversational`; `previewUrl` is
    an HTTPS provider sample, played on demand without synthesis or metering. The house voice
    is Roger (`CwhRBWXzGAHq8TQ4Fs17`), itself conversational. Explicitly saved voices remain set
    even if excluded from this picker. Preview controls and selection controls are separate,
    so listening does not change the bot's voice.
  - `GET /voice/status` → `{ configured }`.
  - A clip is at most 10 MiB (413 past it), in `audio/webm`, `ogg`, `mp4`, `mpeg` or `wav`.
- A spoken reply reaches an open window as the existing `message.attachments` frame. The chat
  client merges it into the message's `metadata.crewaid.attachments` (D-192 keeps the transcript
  out of the reducer), and a reply heard as it arrives plays once if the window has focus.

**Whose key (D-152).**

- **Cloud** uses Crewaid's key, `CREWAID_ELEVENLABS_API_KEY`, read by `billing.config.ts` and
  registered only with `BillingModule`. Each call is metered against the plan's model allowance
  through D-157's `reserveModelCharge`/`settleModelCharge`, as upstream model
  `elevenlabs:scribe_v2` (transcription, per second of audio) or
  `elevenlabs:eleven_flash_v2_5` (speech, per character). A refused reservation answers
  `402` with code `MODEL_ALLOWANCE_EXHAUSTED`.
- **Self-hosted** uses the person's own ElevenLabs connection, unmetered. With none, every voice
  route answers `409` naming Settings → Providers.
- Without either, `GET /voice/status` says `configured: false` and the composer's voice buttons
  stay disabled.

**The seam (D-160).** `@tanstack/ai-elevenlabs` is pinned at 0.6.7, which peers on the pinned
`@tanstack/ai` 0.64.0, and is imported only by `models/voice/elevenlabs-voice.ts`. The rest of
the server is written against the `VoiceEngine` port in `models/voice/voice-engine.ts`, which the
tests fake. The renderer only records (R1); D-205 is unchanged.

**What a spoken reply says.** `voice/speakable.ts` rewrites the reply's markdown for the ear: a
code block becomes "a TypeScript code block", a table "a table", a link its text, a path its file
name. Past 2,500 characters it stops at a sentence and ends with "The rest is in the chat." The
synthesis runs detached after the run settles: a failure is logged and the text reply stands, and
it never holds up the next queued trigger.

**Desktop.** The composer has a transparent dictation mic beside Send, and its right slot records a voice
message while the draft is empty. A voice note renders as a player, with its text available in
an info popover in the footer revealed by hover or keyboard focus. Both a person's voice message
and a bot's spoken reply show only the player as speech; a bot reply keeps its text bubbles until
audio arrives, and retains them if synthesis fails or no audio is generated. The full original
text remains stored and available in the popover, including content omitted from synthesis.
Audio is fetched through
`ApiClient.download` into an object URL on the first press (D-025), so the CSP gains
`media-src 'self' blob:`. The main process grants `media` to the app's own windows for audio only;
the mac build declares `NSMicrophoneUsageDescription` and the `device.audio-input` entitlement.

Unsent voice messages remain in this window's memory, scoped to their original conversation,
and appear as temporary, playable transcript rows while sending or after failure. A failed row
offers Retry and Discard; Retry reuses a completed upload if only the message post failed. These
rows are not stored history and are released when sent, discarded, or the window closes.

## D-222 — Calls: a live voice line to a bot, on Cloud Pro (2026-10-14)

> **Amended by D-227:** when a request is answered, how the voice waits, and small talk.

**Status:** accepted · **Task:** V2-VOICE-05 · **Builds on:** D-152, D-156, D-157, D-192, D-205,
D-221 · **Evidence:** `docs/reviews/V2-VOICE-05-SPIKE.md`

A person can call a bot from the right rail and talk to it. **The bot answers and the voice
relays it.** One ElevenLabs agent, shared by every call, is only the voice: everything the person
asks reaches the bot as an ordinary chat message, run with the bot's own model, tools, computer,
memory and approvals. The voice reads the bot's reply back. Nothing the voice says on its own is
stored. The transcript is the bot's thread, and the voice's lines are captions.

**Who gets calls (D-152, D-156).** Calls exist only on a cloud server where billing is configured
and both `CREWAID_ELEVENLABS_API_KEY` and `CREWAID_ELEVENLABS_AGENT_ID` are set. A server that has
the agent id without the key refuses to start. A self-hosted server has no call routes.

`BILLING_PLANS` gains `callMinutes`: Pro 30, `internal` unlimited (`null`), every other plan 0.
Minutes are per billing period and do not roll over. `Entitlement` gains `callLimitSeconds`.

**Contract.**

- `model VoiceCall`: `id`, `userId`, `botId`, `conversationId String? @unique` (ElevenLabs'),
  `periodStart`, `reservedSeconds`, `startedAt`, `endedAt?`, `durationSeconds?`, `settledAt?`.
  It is indexed on `[userId, periodStart]`, and deleting the bot deletes its calls.
- `POST /bots/:id/calls` (`@OwnedResource('bot')`) returns
  `{ callId, signedUrl, remainingSeconds, overrides: { prompt, firstMessage, voiceId,
  maxDurationSeconds } }`.
  - It refuses `402 CALL_PLAN_REQUIRED` on a plan with no minutes, and `402 CALL_ALLOWANCE_USED`
    once they are spent.
  - It refuses `409` while the person already has a call open.
- `PATCH /calls/:callId` (`@OwnedResource('voiceCall', 'callId')`) takes
  `{ conversationId?, ended? }` and returns the call.
- `GET /calls/allowance` returns `{ limitSeconds, usedSeconds }`.

**The allowance is settled from ElevenLabs, never from the client.**

- A call reserves what is left of the period when it starts.
- On `ended`, the server reads `metadata.call_duration_secs` from
  `GET /v1/convai/conversations/{id}`. The spike found it final as soon as the call closed.
- A call that never connected settles at zero.
- One that is never ended is settled the next time the account's allowance is read: from
  ElevenLabs once it reports the conversation done, or at its reservation once it is past the
  30-minute ceiling.
- While a call is unsettled it counts as the time elapsed, capped at its reservation.
- `maxDurationSeconds` is when the desktop hangs up, letting the voice finish its sentence first.
  `@elevenlabs/client` cannot send the agent a duration override, and a client could ignore the
  timer anyway, so the cap does not rest on it.

**The agent.** It is configured once in ElevenLabs:
- LLM `gpt-4.1-mini`. Live runs found `gemini-2.5-flash` stalling on tool-call turns and falling
  back to `gpt-4o` after ElevenLabs' 4 s timeout, so every request waited an extra 4 s.
- TTS `eleven_flash_v2` (English agents must use a v2 model) with expressive mode off, so the
  voice's lines carry no `[thinking]`-style tags into captions.
- The client tool `ask_bot(request)`, with `expects_response: false`.
- Overrides allowed for prompt, first message, voice and max duration.
- Signed-URL auth, and concurrency and daily caps.

Each call's prompt names the bot and tells the voice to hand every substantive request to
`ask_bot`, and to read aloud a message beginning "Read this answer to the user". The voice is
`Bot.voiceId`, falling back to the house voice.

**The seam, and one place TanStack is not used (amends D-221's plan).** TanStack's
`elevenlabsRealtimeToken()` builds its ElevenLabs client with no options, so it reads the key
only from `process.env.ELEVENLABS_API_KEY`. It also echoes the overrides back rather than applying
them. A cloud server's key is `CREWAID_ELEVENLABS_API_KEY`, passed explicitly like every other
key here. So `models/voice/elevenlabs-agent.ts` calls ElevenLabs' two REST endpoints directly:
the signed URL and the conversation. It is the only file that does, behind a `CallAgent` port
the tests fake. The orchestrator imports no `@elevenlabs/*` package.

**The desktop (D-205).** `renderer/voice/callSession.ts` is the only file that imports
`@elevenlabs/client`, pinned at 1.28.0. It owns the session as a state machine over an injected
connection:

- **Requests:** `ask_bot` posts the request through the thread's existing send, exactly as if it
  were typed.
- **Waiting:** while the bot works, a `contextual_update` every 30 s says it is still working.
- **Answers:** when the run settles, the reply is rewritten with `speakable()`, which moves to
  `packages/shared` so both sides share one, and pushed with `sendUserMessage`.
- **Approvals:** a pending approval becomes a contextual update telling the person to answer on
  screen. The card stays the only way to decide.
- **Hang-up:** the session hangs up at its remaining time, on a bot switch, and when the window
  closes.

The ElevenLabs client runs its microphone and speaker processors as AudioWorklets. A `file://`
page can only load those from object URLs, so the CSP's `script-src` gains `blob:`, on the same
reasoning as the PDF worker's `worker-src blob:`.

The rail's call button sits beside "Bot settings". A call bar above the composer shows the time,
the minutes left, the voice's current line, mute and hang-up. A lint rule bans `@elevenlabs/*`
outside `callSession.ts` in the desktop and everywhere in the orchestrator, and each rule has a
probe.

---

## D-223 — Screen pixels travel on a stream of their own, opened by a grant (2026-10-14)

Every screen pixel crossed the orchestrator twice: from the computer over the
provider's tunnel, then out to the viewer on the §4.2 socket. On Runtime that is
Virginia → Oregon → the viewer, and Hetzner pays for it twice, once in and once
out, while the input that actually needs the orchestrator is a few bytes a
keystroke. D-218 named the fix and left its contract to the screen track:
pixels straight from the machine to the viewer, input still through the
orchestrator. This is that contract, settled for the RFB path the product ships.

**The split.**
- **Pixels: a stream socket per viewer per bot.** Binary frames are complete RFB
  server messages, with no D-035 envelope, because a stream carries one seat. Text
  frames are `ScreenStreamServerMessage` / `ScreenStreamClientMessage` JSON
  (`packages/shared/src/screen-stream.ts`). A viewer never sends RFB on it, so the
  stream is read-only by construction.
- **Input: unchanged on §4.2.** `screen.subscribe { botId }` is now only
  membership: it lets a socket send `screen.input` and ask for `screen.control`.
  Seat control (D-163/D-169), the recording tee (M3) and `activity.touch` all
  stay on the orchestrator. Each watched seat has one RFB connection there that
  never requests an update, so it reads no picture at all, however busy the
  desktop is. It stays open when nobody watches, which keeps D-163's first
  contact a one-off rather than replaying it, and sending the pointer to the
  corner, on every reopen.

**The grant.** `POST /api/v1/bots/:id/screen/grant` (`@OwnedResource`) answers
`{ endpoint, ticket, expiresAt }`.
- **Endpoint.** `orchestrator` means the app opens `/ws/screen` on the address it
  already holds; `direct` means a `wss://` URL served from inside the computer.
- **Refused for a computer that is not RUNNING (409 `SCREEN_NOT_RUNNING`).** So
  opening the panel never wakes anything (D-039 §16), and the app's reconnects,
  which always ask for a fresh grant, cannot wake one either. The app asks
  again within its bounded retries before it says "not running" (amended
  2026-10-15): a viewer is open only while the app's own state says RUNNING,
  so a refusal is the two disagreeing for a moment, and the frame that says the
  computer stopped closes the viewer anyway. UNHEALTHY stays refused: the health
  poll writes it for a computer Runtime has paused, and the seat calls a grant
  makes would wake that one through the tunnel.
- **The ticket.**
  - What it is: Ed25519, signed by the orchestrator over
    `ScreenTicketClaims` (computer session, bot, seat port, expiry, `jti`).
  - How long it lives: 60 s, and it opens one stream once, enforced by a replay
    guard.
  - When it is checked: at the HTTP Upgrade, so a bad one is a real 401 and never
    a socket.
  - Bound to a computer: a ticket for a computer replaced since its grant is
    refused with `SCREEN_NOT_RUNNING`.
  - The key: made at boot and never stored. Nothing needs it to survive a
    restart, and only its public half ever leaves the process.
- **`/ws/screen` is mounted on the §4.2 adapter's HTTP server.** Nest destroys
  every Upgrade on a path it has no server for, so the stream host's server is
  registered beside the gateway's. It is authenticated by the ticket, never the
  session token, so a stream URL that leaks into a log opens nothing.

**One stream implementation, two hosts.** RFB handling, `DeliveryLine`,
`AdaptiveQuality` and the fan-out moved into `packages/screen-stream`, with no
Nest and no `ws` of its own. The orchestrator hosts it for providers that cannot
serve a viewer themselves (Docker, DigitalOcean, Cloudflare, self-hosted). The
same package runs inside the computer when the grant is `direct`. Two changes
came with the move:
- **Pacing is acked, not pinged (amends D-218).** After each update the stream
  sends `{t:'mark',seq}`, and the viewer answers `{t:'ack',seq}` as soon as it
  has the message. A proxy between viewer and computer may answer WebSocket
  pings itself, and a pong would then measure the hop to the proxy and let the
  window over-send. Runtime's preview edge was measured NOT to (it passes pings
  both ways), but an ack can only come from the viewer's app, whatever is on the
  way. The window, its byte budget and adaptive quality are unchanged.
- **An empty stream closes (replaces M2-BE-08's 1 fps keepalive).** The
  keepalive kept the connection that ALSO carried input. With input on its own
  connection, a stream nobody watches has nothing to keep: a returning viewer
  replaced it anyway, because Tight's dictionaries are per connection. §7.4's
  idle budget is now measured as zero pictures read
  (`screen-keepalive.integration.test.ts`).

**Contracts changed (pre-launch, no compatibility layer, D-158).**
- `screen.frame` leaves `BINARY_WS_EVENTS`, and `screen.subscribe` loses
  `quality`. Quality is a message on the stream now (D-037's expand/collapse
  without a reconnect, kept).
- D-035's envelope remains for `screen.input` only.
- A binary frame on §4.2 is now an invalid event to the app.

**Relation to the screen track (D-158, MOD-SC-01..08).** This settles where a
stream is served and who may open it: grants, tickets, revocation by refusal,
input authority and the tee. It does not select a streamer. RFB stays the media
inside the stream socket until MOD-SC-03 decides otherwise, and a different
streamer would change what travels inside the socket, not the grant around it.

**The direct path on Runtime.**
- **The gateway:** `packages/screen-gateway`, bundled into the sandbox image as
  one CommonJS file and run by the entrypoint as `bot` on `127.0.0.1:7071`, in a
  restart loop so its failure never tears the desktop down. It serves only
  `/v1/stream`, reads each seat's x11vnc on loopback, and admits a viewer only
  with a ticket that the delivered key verifies, that names this computer, and
  whose port is a seat's. It never forwards input. The bridge (7070) is never
  put behind a preview, because its `/exec` has no auth.
- **The computer's key:** before each direct grant, the orchestrator posts its
  public key and the computer's session to the bridge's `POST /screen/key`. The
  bridge writes them to `$XDG_RUNTIME_DIR/crewaid-screen-ticket.json`, and the
  gateway reads them on every Upgrade, so a restarted orchestrator's new key
  applies to the next viewer. A bot that rewrites the file can only let itself
  watch its own desktop.
- **The address:** the provider's optional `screenAccess` reads the computer's
  state from Runtime on every grant and refuses unless it is running, then
  shares the gateway's port as a private Runtime preview. One token admits any
  number of new connections until it expires, so the share is reused by every
  grant while its token has a ticket's minute left, and the token lasts
  `SCREEN_ACCESS_TTL_SECONDS` (600). Amended 2026-10-15: a share minted per
  grant, with a 120 s token, put three more Runtime round trips on every bot
  switch. The grant expires with the earlier of the ticket and that token.
- **Stopping:** every preview is deleted before a computer pauses, because
  Runtime wakes a paused sandbox when its preview is visited, and the reused
  share is forgotten with it. If the delete fails the pause still happens, and
  the leftover token stops admitting within ten minutes; only the app holds
  it, and the app never reuses a link — a reconnect is granted afresh.

**Direct-stream admission and lifecycle hardening.** A gateway resolves a ticket's
bot through the bridge's existing `GET /seats?botId=…`, checks the signed port,
and keys the stream by the immutable `seatId` as well as the bot and port. Every
initial connection and recovery checks that binding before opening RFB and again
after the handshake; no pixels or ready event pass until the second check succeeds.
This prevents a retired seat's port from granting access to its replacement.
Consumed ticket IDs are atomically reserved on disk beside the key file, retained
until expiry, and survive gateway process restarts. Failure to record consumption
refuses the connection. Runtime preview creation and stop share the same per-computer
operation queue, so successful unsharing cannot be followed by an in-flight grant
creating a preview before pause. Gateway socket errors and rejected upgrade tasks
end only the affected connection.

**Measured on Runtime, 2026-10-14** (a throwaway sandbox on a compartment key,
viewer on the operator's line):
- **Opening:** a WebSocket carrying the token in `runtime_preview_token`
  opened with origin `file://` (Electron's), `null` or none. No token, or a
  forged one, got 401. The edge strips the token before forwarding, so the
  gateway sees only `ticket` and `quality`.
- **Token expiry:** an open socket was still alive 35 s after its token expired,
  while a new one on the expired token got 401. Before it expired, one token
  opened four connections in turn.
- **Revocation:** `rotate` and `delete` cut open sockets at once; after a delete
  the address answers 404.
- **Waking:** a paused sandbox whose preview was deleted stayed paused, and a
  request got 404. With a live preview, one request woke it.
- **Line:** 101 ms round trip at p50 (76 min, 230 max) from the operator's
  machine straight to Virginia, against about 250 ms through Oregon by D-218's
  figures. 3.7 Mbit/s on that line.

**Rejected.**
- **A websockify relay with noVNC as a full RFB client:** each viewer would get
  stop-and-wait on its own round trip, losing the D-218 window and adaptive
  quality, and input would have to be filtered out of the stream.
- **Runtime sessions in the app:** they grant exec and files on the computer.
- **Public TCP ports:** unauthenticated.
- **WebRTC:** Runtime carries no inbound UDP, and a TURN server would put the
  bandwidth back on a server.

## D-224 — Runtime upgrades migrate a computer when its new image is on another server (2026-10-15)

This supersedes D-219's deferral of cross-server migration. A release with a new
screen protocol cannot leave a computer silently running an incompatible image.
The observed `image_on_another_host` refusal is an upgrade trigger, including a
refusal saved by an older orchestrator. Other switch refusals retain D-219's policy.

The logical computer/session id stays fixed; its physical Runtime sandbox id may
change. Under the existing database lifecycle lease, the provider creates a staged
sandbox from the resolved immutable image id at the source computer's size, keeps
it while paused, and transfers both `/home/bot` and `/workspace`. The duplicated
`/workspace/.crewaid-home` is excluded: the restored home becomes that directory
and is bound over `/home/bot` by the new image. Desktop processes are shut down
before archiving so Chrome can flush its profiles. Archive streams travel only
through the SDK's authenticated tunnels with bounded memory, length/digest checks,
and checked archive exit statuses; no preview, private network, Runtime API key in
a guest, or full archive on the orchestrator's disk is needed.

Only after restore and bridge readiness pass may the source be paused and renamed
to a backup and the replacement take the canonical `crewaid-<computer>` name.
Migration labels record the computer, source, replacement, and readiness before
either rename. Lookups and inventory recognize a verified replacement during the
rename gap; the next start completes promotion after an orchestrator restart.
Unverified stages are never adopted. A failed copy leaves the source intact and
surfaces an upgrade failure instead of claiming the new desktop is ready.

Backups carry a separate management label, lose their previews, and remain paused.
The existing workspace retention sweep retires them after its configured grace
period, only while a replacement exists; ordinary runtime-orphan cleanup cannot
delete them. Staging resources are excluded from computer inventory. A failed
staging copy may be removed because the source remains authoritative.

The database lifecycle lease renews while a start is working, retaining its CAS
fence. A transfer may outlast the former 60-second lease without admitting a
second starter. No REST/WS shape, database table, environment key, or desktop
control is added. Deployment of this change upgrades existing computers on their
next start from paused/stopped; running computers remain on their current image.

## D-225 — Desktop installers per Mac chip, and an Ubuntu installer (2026-10-15)

**Status:** accepted · **Amends:** D-153 · **Touches:** `apps/desktop/electron-builder.yml`, `.github/workflows/release-desktop.yml`, `apps/desktop/scripts/publish.mjs`, `apps/desktop/src/updater.ts`, `infra/cloudflare/downloads-worker`, `apps/web/src/content/site.ts`, `apps/web/src/components/DownloadDropdown.tsx`

- **macOS ships one build per chip, not a universal one.** `dmg` and `zip` are built for `arm64`
  and `x64`, named `Crewaid-<v>-mac-arm64.*` and `-mac-x64.*`. Each download is half the
  universal size (about 125 MB instead of 250 MB), and nothing has to merge per-chip native
  binaries any more. Both zips sit in the one `latest-mac.yml`, and electron-updater picks the
  one for the running chip.
- **Linux ships a `.deb` for x64 (Ubuntu).** The release matrix gains an `ubuntu-latest` job;
  electron-builder writes `latest-linux.yml` beside the package, and electron-updater's
  `DebUpdater` installs updates through `pkexec`, so the person is asked for their password.
  Until it has been installed on a real Ubuntu machine, treat a broken `.deb` as a release
  blocker, not a follow-up.
- **Stable links:** `/desktop/<edition>/mac-arm64`, `/mac-intel`, `/windows` and `/linux`. The
  older `/mac` still answers, with the Apple silicon installer, and any `/mac*` link falls back to
  whatever `.dmg` a feed published before this split lists.
- **The in-app download page follows the chip.** An update that cannot install itself opens the
  link for the running platform and `process.arch`, so an Intel Mac is never sent the arm64 build.
- **The site offers the visitor's platform first.** One button for the detected platform, the
  rest behind its chevron. The user agent cannot tell the two Macs apart (it says "Intel" on
  both), so the architecture client hint and then the WebGL renderer decide, and Apple silicon is
  the default; Safari reports "Apple GPU" on both chips, so an Intel Mac in Safari chooses from
  the menu. The closing call to action keeps both Macs behind one button, beside Windows and
  Ubuntu.

## D-226 — A seat's x11vnc runs threaded, and the RFB client speaks first (2026-10-15)

**The cause of slow bot switches.** Every switch opens a new RFB connection to
the seat's x11vnc: from the orchestrator under Docker, from the computer's own
screen gateway on Runtime (D-223). Unthreaded, x11vnc serves a new client from
its polling loop, and that loop naps while the screen is quiet, so each step of
the handshake waited out a nap. Measured on a local Docker computer:
- **A seat idle for about a minute:** 1.1–1.4 s before x11vnc's first byte, and
  up to 2.3 s before a picture.
- **A seat in use moments before:** about 0.3 s.
- **End to end,** returning to a bot after 65 s away: 1.76–2.89 s (median
  1.98 s). The grant took 52–443 ms of that, and opening the socket 2–4 ms.

**The change.**
- **`-threads`** on each seat's x11vnc: every client gets its own reader, so a
  viewer is answered in about 0.1 s whether or not the seat was idle.
- **The RFB client sends its version as soon as it connects.** The 0.1 s left
  was x11vnc's VNC library waiting, on every new connection, for a WebSocket
  client to speak first. A client that has already spoken is greeted at once:
  about 1 ms. The server's version is still checked when it arrives.
- **Result,** same test: 0.17–0.23 s (median 0.18 s) returning to a bot after
  65 s away. A bot's first view after its computer starts still creates its
  seat, 1.4–1.6 s.

**Streaming under threads.** Nine soaks of one to three minutes each: a viewer
requesting every update and an input client, on a seat showing a full-screen
canvas that repainted every 50 ms.
- **Threaded:** 14–18 updates a second; worst gap between updates 0.9–2.4 s.
- **Unthreaded:** 12–19 updates a second; worst gap 0.7–11.9 s.
- No x11vnc crash or RFB framing error in either. x11vnc documents Tight as
  stable for several clients under threads on Linux.

**Not changed.** The machine's own display (`:1`): no viewer connects to it.

**Rejected.**
- **`-nonap -sb 0` without threads:** 0.3–0.4 s to a picture, against 0.1 s.
- **Keeping each seat's connection open between views:** it would help only a
  seat viewed recently, and the first repaint would still wait for a nap.

**What remains.** On Runtime, the viewer's WebSocket through the preview edge
took 864 ms (p50) from the operator's line (D-223), and is now the largest part
of a switch.

---

## D-227 — A call waits on the server's `run.settled`, and stays quiet while the bot works (2026-10-15)

**Status:** accepted · **Task:** V2-VOICE-05 · **Amends:** D-222 · **Builds on:** D-159, D-160,
D-188, D-191

**Why.** D-222's call read a request's answer when the desktop's chat stopped generating, and
PR #446 replaced that with the AG-UI run-finished event. Neither knows when a message has its
last answer. A step-limit stop is carried on by a new run, a transient failure is retried, and a
message stored while a run worked is folded into the run that a newer message starts. Stop and a
dropped stream end a run with no event the window reads, and a run some other window started is
not the call's. The renderer sees only the runs it reads. The server's settle step (D-191 §4)
is the one place that decides what happens next, so it says when a message is answered.

**Contract.**
- §4.2 gains server → client `run.settled`, `{ botId, threadId, runId, messageIds, outcome,
  reply }`. `outcome` is `completed`, `failed` or `stopped`.
  - `messageIds` is the run's trigger and every stored message it folded in: the unanswered
    ones older than the trigger, back to the last trigger another run claimed, at most 25.
  - `reply` is the last non-empty bot message any run for that trigger wrote, or null.
- `ChatSendService.settle` sends it once nothing more will happen for those messages:
  - a completed run without a step-limit stop, and a stalled one;
  - a step-limit stop that is not carried on, because no continuation is left or a waiting
    message took over;
  - a failure that is not retried, as `failed`; an aborted run, as `stopped`.
  - It is never sent for an interrupted run: the resume is that message's run and settles it.
- A new frame type is not a shape change, so `WIRE_VERSION` stays 2. An older desktop drops it.
- The trigger is stored under the client's message id (D-159 §3.1). The chat client's
  `sendMessage` now resolves to that id, which is how a sender recognises its message.

**The call (desktop).**
- A request is its stored message id. It is answered only by a `run.settled` naming that id,
  and other runs on the thread are ignored. A frame that arrives before the send has resolved
  is held until it does.
- A failure is spoken as "I couldn't finish that", a stop as "I stopped working on that", and
  a completed run with no text as "I've finished. The details are on screen."
- If the bot is idle or in error for 20 s with a request open, the call stops waiting and
  says so. That covers a run that ended without settling, such as a worker that died.

**Talking while the bot works.** What ElevenLabs documents, and how the call uses it:
- **`contextual_update` is background the agent never answers aloud.** Everything about the
  work goes this way, prefixed "Work status:": the request, the bot's current action and the
  tail of its visible narration (at most every 10 s, and only when it changed), an approval
  waiting or answered, and the end. Reasoning and tool arguments or results never do.
- **`user_message` is the only documented way to make the agent speak on the client's
  initiative.** The call uses it for the answer, the failure lines, the approval line, and one
  check-in after 45 s of quiet. PR #446's 30 s spoken progress turns are gone.
- **The agent's "take turn after silence" timeout re-engages the user** ("anything else?"); it
  was 7 s. While a request is open and the line has been quiet for 4 s, the desktop sends
  `user_activity` every 4 s, which resets that timer. It never does so while either side is
  speaking, because each one silences the agent for 2 s. The agent's timeout goes to 30 s, so a
  pause in an ordinary conversation is not filled either.
- **`ask_bot` stays `expects_response: false`.** The tool's `async` execution mode is documented
  as fire-and-forget. Whether the agent would speak a result that arrives later is not
  documented, so a late tool result is not relied on.

**Small talk.** The voice may answer small talk itself, briefly. Anything needing work,
current facts, or what the bot knows about the user goes to `ask_bot`. This narrows D-222's
"answers nothing itself". The voice has none of the bot's memory or tools, and nothing it says
on its own is stored. It is accepted because a line that goes silent for minutes while the bot
works is worse, and the prompt keeps it short.

## D-228 — A failed model call says the provider's reason, and the chat stops hiding its errors (2026-10-17)

**Status:** accepted · **Task:** M1-BE-11 · **Amends:** D-006, D-093

**Why.** A custom connection to OpenCode answered 403 "OpenCode's free tier can only be used from
within OpenCode." The app said "Something went wrong. Try again." Three layers replaced the
message, one after another:
- The server sent D-093's sentence for `AUTH_FAILED`, which blamed the key.
- The chat client swapped that for "The bot could not finish this request."
- The thread view swapped every chat error for "Something went wrong. Try again."

The one line that said what to do was in a log the person cannot open. The same happened to our
own setup errors ("no default model is chosen", "this connection has no key"). Those were already
written for the person, and they still came out as the generic sentence.

**Contract.**
- `NormalizedModelError` gains an optional `explanation: { source, text }`
  (`ProviderExplanationSchema`). `source` is the name the person gave the connection, at most 80
  characters. `text` is at most 400.
- A failed run's terminal `RUN_ERROR` carries it at `metadata.crewaid.explanation`. That is the
  library's extension slot and the namespace the transcript already uses. The run row keeps only
  `{ code, message }`, so nothing is stored that the 7-day event log does not already hold.
- No new code, event or route. `WIRE_VERSION` stays 2, and an older desktop ignores the field.

**What becomes an explanation.** `normalize-error.ts` decides, and nowhere else does (D-006's rule
about layers stands). It takes the first readable sentence from the provider's error body
`message`, then the upstream body OpenRouter keeps in `metadata.raw`, then the error's own
message. The error's own message counts only when the code shows the provider wrote it: an HTTP
status, a known provider code, or a body. An adapter's `parse-error` is our stack talking. A
candidate is dropped when it is:
- an HTTP reason phrase or SDK placeholder ("Unauthorized", "status code (no body)", "Provider
  returned error");
- JSON, markup or a stack trace;
- a socket error code;
- a request-shape complaint (`messages.1.content…`, a quoted `snake_case` field), which is our bug
  and is already covered by the INVALID_REQUEST sentence;
- fewer than four words.

What is kept loses its status prefix, has key-shaped strings replaced by `[hidden]`, and is cut at
400 characters.

**Who it is attributed to, and when nothing is.** Only a run on the person's own connection
quotes its provider. An included model (D-157) runs on the platform's account, so its upstream's
complaints are not theirs to act on. `ResolvedTextModel.included` turns the explanation off there.
Any caller without a `source`, such as skill compile, quotes nothing.

**Our own setup errors keep their words.** `ModelSetupError` marks the errors that mean a model is
not set up: no default, a model that is gone, no key, included models off on this server, no
context window. `normalizeModelError` sends their sentence as the `message`, under
`INVALID_REQUEST`. Their copy was rewritten to name a place the person can reach (the composer,
Settings → Models) and to stop quoting row ids.

**D-093's copy, corrected.** `AUTH_FAILED` covers 401 and 403, and a 403 is often a key that works
but is refused for something else (a free tier, a region or a plan). The sentence now names the
refusal and leaves the reason to the explanation. Every "Settings → Connections" now says
"Settings → Models", because that pane was renamed and the old name pointed nowhere.

**The desktop renders what it is given.**
- The chat client keeps the run's `{ code, message, explanation }`. The thread view no longer
  replaces it.
- The banner shows the sentence, then "<source> says: “…”" in the muted colour.
- A `RUN_CANCELLED` shows no banner, because the reply's own note already says it was stopped.
- A refused send now says why when the person can act: an approval still waiting, the bot still
  busy, the plan or storage used up, the server not reached. Anything else is "Your message could
  not be sent."
- A stream that ends after its own `RUN_ERROR` is not reported as a lost connection.

**Technical words out of the shared copy.** `apiError.ts`, `apiClient.ts`, `wsClient.ts` and the
bot and skill mappers no longer say "orchestrator", "token" or "shape" to the person. The screens
for setting a server address still say "orchestrator", because there it names the thing being
configured.

**Evidence.** `d228-provider-explanation.test.ts` (quoted, dropped, hidden and unattributed cases,
and the setup errors), `mod-ai05-execution.test.ts` (the terminal event's metadata, no key in any
event, nothing quoted for an included model), `crewaidChat.test.ts` and `d228ErrorBanner.test.tsx`
on the desktop.



## D-229 — Permanent assistant, conversational onboarding and curated Templates (2026-10-19)

**Status:** accepted by the product owner · **Task:** CC-81 · **Amends:** D-094, D-080, D-132 ·
**Mockups:** Paper file "Crewaid", page "B+ — Assistant & Templates" (01–13, 07b, 08b)

**The main assistant.** Every account has one permanent `Crewaid`, identified by a server-owned
`Bot.kind` (`STANDARD` or `MAIN`); a partial unique index fences concurrent creation, and ordinary
create/update bodies cannot set `kind`. MAIN cannot be renamed, relabelled, unpinned, hidden,
reordered, moved into a group, duplicated or deleted. It is the first tile in the Pinned strip,
labelled "Main assistant". Its avatar, model, voice and `systemPrompt` stay editable; the prompt is
asked for as "How Crewaid should work with you", because it is the person's preferences layered on
app-owned responsibilities (`MAIN_ASSISTANT_INSTRUCTIONS`, composed before it, memory still last).
This is not a manager role: it coordinates only through the same `send_message` every bot has, and
D-132 still holds — nothing starts because a task or file changed.

**First run.** `POST /onboarding/bootstrap` (idempotent) returns the assistant and the per-user
`UserOnboarding` progress, which clearing a chat never resets; `GET/PATCH /onboarding` read and move
it. The client gate **fails open**: if the server cannot answer, the app runs as it did before
Crewaid existed. A new account opens on Crewaid with the rail collapsed. The welcome is product
copy, never a fabricated message: "Find my crew" sends one plain message in the person's name,
"Show me around" shows a written guide in place, three example tasks only fill the composer, and
"Skip introduction" records the skip. Existing accounts keep their selection.

**Memory.** Each bot's settings open "What {bot} knows about you": shared rows and that bot's private
rows, with Edit and Forget. `PATCH /memory/:id` records a correction as TOLD and supersedes the old
row; `DELETE /memory/:id` forgets one; both tombstone the old claim and resolve by id and
`principal.userId` together. Business facts may be shared; personal details default to private.

**Templates.** A first-party catalog of five crews (Sales, Admin, Product, Content, Client work)
and their twenty specialists. Each specialist is defined once and listed both alone and inside
its crew. A template's `systemPrompt` is the persona only — it becomes the bot's Description, so
nothing a crew depends on may live there. Crew collaboration lives in the crew brief written to
the group's instructions at install time: the goal, shared context, each role mapped to a bot id,
and the handoff order. `GET /templates`, `GET /templates/:id` and `POST /template-installations`
are the contracts; one search (`templateMatches`) over what a person reads serves both the library
and `search_templates`. Installing a crew creates its group, bots, conversations and brief in one
transaction, records a `TemplateInstallation` (revision, configuration, created ids) keyed by an
idempotency key — a retry returns the first result, a different configuration under the same key
is refused — and suffixes names on a second copy ("Hannah 2"). Adding starts no work and schedules
no routine. A single-bot template continues in the ordinary create form, prefilled. Models and
approval policies are the account's defaults.

**Entry points.** A floating **Templates** pill sits bottom-left outside the sidebar on the Crew
tab only — it belongs to the crew, and the Work views (Tasks, Goals, Deliverables) leave it out.
The sidebar column stops short of it so it never covers a bot, and over a narrow sidebar it is
icon-only. The sidebar `+` still creates a bot from scratch. *(Placement superseded by D-239: Templates now sits
in the sidebar's footer.)* In chat,
`read_template` (optionally carrying a goal and context Crewaid drafted) renders a card whose
**Set up crew** opens the library's review step prefilled; `install_template` is one authority
action for the whole reviewed setup. After adding, **Start first task** sends Crewaid exactly the
text shown.

**Deferred.** Role "playbooks" — first-party, on-demand know-how per specialist — are a separate
decision. Third-party skill packs are not loaded at runtime: they are unreviewed instructions
running on bots with real computers and connected accounts.

## D-230 — Security audit remediation: the boundaries an audit found open (2026-10-20)

**Status:** accepted · **Amends:** D-101, D-222, CC-02, D-221, D-022, V1-09

**Why.** A static audit and a lab run against a disposable copy of the stack confirmed a set of
gaps. These are the ones that change what a caller sees.

**Contract changes.**
- **`GET /health`** keeps its §4.1 shape and stays exempt, but `sandboxes` lists the signed-in
  caller's bots only. An anonymous request gets `[]` and causes no sandbox probe.
- **MCP OAuth callback** (D-101) gains the refusal `other-account`: a browser signed in to Crewaid
  as someone other than the flow's owner is refused before the code is exchanged. A browser with
  no session is still let through; a full browser binding needs a deep-link completion and is a
  separate decision.
- **Calls** (D-222) are bound to their conversation when they start: the signed URL is asked for
  with `include_conversation_id`, which makes it single-use and carries the id. A client's
  `conversationId` that differs is refused 409. A conversation ElevenLabs never saw settles to
  zero only after the URL can no longer start it (`SIGNED_URL_TTL_MS` + 1 min).
- **Cookie-authenticated writes** to the REST API must carry this server's own `Origin`. Bearer
  requests, which every client sends, are unchanged.
- **Recordings.** An X11 typing run that the page reported going into a password field is stored
  as `{ text: SECRET_TYPING_TEXT, secret: true }`; the compiler makes it a parameter.
- **Limits.** §4.2 frames are capped at 1 MiB and 64 levels deep; a socket more than 4 MiB behind
  is ended. Multipart uploads take at most 8 text fields of 1 KiB. A NUL in the URL or a JSON body
  is a 400. A WS principal survives an unreadable session store for 30 s, not until expiry.
- **Desktop.** The IPC fence also checks that the sending document is the renderer; a packaged
  build ignores `ELECTRON_START_URL`; renderer windows refuse navigation and new windows; only the
  microphone, clipboard writes and fullscreen are granted (D-221 narrowed further).
- **Bridge.** Any request carrying `Origin` is refused 403: a web page in a seat's browser can reach
  127.0.0.1:7070, and no real caller sends one.

**Kept as designed.** An MCP server's own `readOnlyHint` still lowers a call to `read` (D-107: the
server runs the code either way). ASK still remembers a `draft` approval by tool name (D-164). The
shell floor stays a floor (D-064). The bridge, RFB and CDP ports stay unauthenticated behind the
egress fence and the providers' authenticated tunnels; a token in the sandbox would be readable by
the same user the bots run as.

## D-231 — "Try a task" has Crewaid ask in its own thread (2026-10-20)

**Status:** accepted by the product owner · **Task:** CC-81 · **Amends:** D-229

**Why.** "Try a task" only focused the composer, and a click that changes nothing but a caret
reads as a dead button. The welcome should feel like Crewaid talking to the person, not the app
showing states.

**Decision.** D-229's "never a fabricated message" gains one exception. When the person chooses
"Try a task", Crewaid asks "What task would you like me to help you with?" as a stored message in
its own thread. `PATCH /onboarding` takes `askForTask: true`, which requires `welcomeSeen: true`.
The server writes the row only when that update is the one that closes the welcome, so a retry or
a second window asks once. The row is `author: BOT`, `fromBotId` = Crewaid and `runId: null`: the
app wrote it and no model did, so it costs no model call. The thread's read mark moves past it,
because the person is watching when it arrives. The renderer re-reads the thread and focuses the
composer. Nothing is sent in the person's name and no run starts (D-132).

**The provider's copy.** The row is part of the history a run loads, but it opens the thread, and
a provider may refuse a conversation that opens on the assistant (Anthropic answers 400).
`providerContext` therefore starts the provider's copy at the first message that is not an
assistant message (one carrying tool calls is kept). The transcript keeps the opening. The rule
applies to every vendor, so no prompt is built per vendor (D-076).

**Not changed.** The rest of the welcome is still product copy. A fully conversational welcome,
with the greeting and guide as Crewaid's messages and the choices as buttons under them, is a
separate decision. Unprompted messages on later days stay out (D-132).

## D-232 — Crewaid's welcome is a conversation (2026-10-21)

**Status:** accepted by the product owner · **Task:** CC-81 · **Amends:** D-229, D-231

**Why.** The welcome read as the app showing states, not Crewaid talking to the person. D-231
made one choice a real message; the person asked for the whole welcome to work that way.

**Decision.** The welcome is stored messages in Crewaid's thread, written by the app and never by
a model. All rows are `runId: null`, read through the one validating mapper (D-165), and the
thread's read mark moves past them, so no unread badge appears.

- **Greeting.** `POST /onboarding/bootstrap` writes Crewaid's three opening messages when the
  welcome is open and the thread is empty, inside its lock on the user, so two windows greet once.
  An account that already has a crew is not greeted (its welcome starts seen, as in D-229).
- **Replies.** Under Crewaid's newest message the person can tap "I have a task", "Help me find
  the right crew" or "Show me around". `PATCH /onboarding` takes `reply: 'TASK' | 'TOUR'`, on
  its own (with neither `welcomeSeen` nor `discovery`). The server stores the reply as the
  person's message in those words, then Crewaid's fixed answer:
  - `TOUR`: the guide and "Want to try something now?". The welcome stays open. A second tap finds
    the guide already there and writes nothing.
  - `TASK`: D-231's question. It closes the welcome, and only the update that closes it writes, so
    a retry asks once. This replaces D-231's `askForTask`.
  - The crew reply is unchanged from D-229: a real message to Crewaid, which starts discovery.
- **Typing anything** closes the welcome, as before. There is no skip link.
- **One copy.** `WELCOME_COPY` in `@crewaid/shared` holds every line. The server writes it, and the
  renderer reads the same words to decide what to offer: the replies while the welcome is open
  (without the tour once the guide is in the thread), and starting points while Crewaid's question
  is the newest message. Starting points only fill the composer (D-229).
- **The opening.** The top of Crewaid's thread shows its mascot, "Welcome" and "Every task, crew
  and result starts here." While the welcome is open the mascot waves once (the `greeting`
  activity; with reduced motion it holds still).

**Model context.** A run reads these rows like any history. The greeting opens the thread on the
assistant, which D-231's rule already drops from the provider's copy. The canned exchange after it
is the person's and Crewaid's own conversation, so it is kept.

**Not changed.** Nothing is sent in the person's name except the crew reply, as before, and no
run starts from a tap (D-132).


## D-233 — Telegram is an authenticated client of the existing chat engine, through each person's own bot (2026-10-17, revised 2026-10-21)

**Status:** accepted · **Task:** V2-TG-01 · **Builds on:** D-152, D-164, D-165, D-190, D-191, D-221.

The user authorized Telegram as mobile access while the native mobile app is being
built. The channel is server-side and available in both editions. It reuses chat
admission, canonical history, attachment/voice services, durable native approval
consumption and cancellation. It adds no agent loop, model path, tool authority or
sandbox credential. Live screen control and teaching stay in the dedicated app.

**Each person brings their own Telegram bot.** The first version gave a deployment
one shared bot; it was rewritten before merging because a shared bot gives the
person no name of their own, makes one ban or one rate limit (about 30 messages a
second) an outage for every account, and puts one token in front of every
person's conversations. Now:

- **QR code (when the deployment has a manager bot).** Telegram's Managed Bots let
  a manager bot create a bot for a person from a `t.me/newbot/{manager}/{suggested}`
  link. The app shows that link as a QR code; the person only keeps or changes the
  name. The server fetches the new bot's token, restricts it to its creator,
  registers its own webhook and holds it as a pending bot.
- **Pasted token (always available).** A person who made a bot with @BotFather
  pastes its token; the server checks it with `getMe` and holds it as a pending bot
  bound to that account.
- **Linking is a code, then a Confirm in Crewaid.** The app shows an 8-character
  single-use code (about 39 bits, ten minutes, stored as a digest). The person sends
  it to the new bot. Even the right code only *claims* the bot: nothing is live
  until the signed-in person presses Confirm in the app, which names the Telegram
  account that sent it. A code read off someone's screen and sent from an
  attacker's own bot therefore reaches a Confirm its owner can refuse, never a
  connection. A managed bot accepts a code only from its creator, a pasted bot only
  a code issued to the account that pasted it, five wrong codes retire the bot, and
  a creator may hold at most three unclaimed bots.
- **Crew members are commands.** `/emma find me ten leads` selects Emma and sends
  her the message; the `/` menu lists the crew, then the controls.

Tokens are sealed at rest with the credential cipher under `CREDENTIAL_KEY`; only
`telegram/telegram-tokens.ts` calls it. Each bot's webhook has its own random
secret, stored only as a digest. A retired bot (disconnect, a 403, expiry, an owner
change, Cancel) has its webhook deleted and, when managed, its token replaced so
the server's copy is dead. BotFather-shaped tokens are redacted from logs.

Rejected: the shared bot (above); a deep link carrying the ticket as the only proof
(it links whoever opens it); a username typed in Crewaid as the ticket (spoofable
and not unique in time); the code alone without the in-app Confirm (it lets a code
seen on a screen link the viewer's own bot).

The routes, schemas, persistence tables, queue, configuration, delivery semantics
and activation procedure are defined in `docs/TELEGRAM.md`, the contract for this
addition to PRD §§3–4. The manager webhook and each bot's webhook are exact,
POST-only session exemptions authenticated by their own secrets; every other
Telegram route, Confirm included, needs a session. Ordinary messages and approvals
retain the linked account's ownership and policy.

### D-233 recovery amendment (2026-10-22)

A failed webhook registration must remain discoverable. `webhookUrl` records a
confirmed registration; it is empty while the stored secret digest is being
registered. Reconciliation runs through the globally serialized scan queue at
boot and after each minute's cleanup, so a failure retries without a restart.

`TelegramRetiredBot` stores only `telegramBotId` (primary key) and `retiredAt`.
Before replacing a retired managed bot's token, persist this marker. Manager
updates for retired ids are ignored, including the token-change update caused by
retirement itself. Markers have no token, account or conversation data and are
not expired; an explicit pasted token may still connect the bot.

A Telegram `/new` has a deterministic topic-boundary message id derived from its
connection and update id. `MessagesService.startTopic` accepts that server-owned
id and inserts it once. Both bare `/new` and `/new text` pin the selected crew
member on first consumption; retrying an acknowledgement or admission cannot
insert a later boundary or reset another crew member's context.

---

## D-234 — Language, timezone and microphone settings (2026-10-22)

**Status:** accepted by the product owner · **Tasks:** CC-82 … CC-85

**Why.** The app is English-only, a bot is never told the person's timezone (so a routine it
schedules without one runs on `America/Port-au-Prince`, §3's default, wherever the person lives),
and dictation and calls always use the system microphone. The owner asked for the three settings
of the reference design: Language, Timezone and Microphone.

**Decision.**

- **Language and timezone are account settings.** `UserSettings` gains four nullable columns.
  `language` and `timezone` are the person's choice; null means "Follow System" and
  "Auto-detect". `systemLanguage` and `systemTimezone` are what a signed-in desktop last reported
  for its computer. `PATCH /settings` takes all four on the existing rule: absent leaves a field
  alone, null clears it. A language is a `LocaleSchema` code, and a zone must be one the runtime's
  `Intl` knows. Two columns per setting, because one cannot tell a choice from a detection, and a
  second computer must refresh the detection without overwriting the choice.
- **One resolution.** `resolveLocale` and `resolveTimezone` in `@crewaid/shared` give the value in
  effect: the choice, then the computer's, then (for the language only) English. The server adds
  no fallback when it tells a bot something. A bot told a zone nobody chose is told something
  false.
- **The bot is told, in the cached prefix.** A "The person you work for" block names the language
  as where the bot starts ("write to them in French; when they write in another language, answer in
  theirs") and the zone for the times the person gives and the schedules the bot sets. It sits
  after the workspace block and before the memory instructions. It changes only when the person
  changes a setting, so D-094/D-076 hold, and it carries no clock (D-125 stands). A line is emitted
  only for a value the server knows.
- **Schedules.** A routine created with no zone uses the person's zone, then §3's default.
  `schedule_routine` says so. The Work tools' text is unchanged (it is at its 500-token budget, D-141):
  the prompt block tells the bot which zone to write in a repeat.
- **Calls.** The voice is told to speak the person's language, opens with a greeting in it, and
  the ElevenLabs agent's `language` (which also sets its speech recognition) is overridden with
  the agent's code for it (`CallOverrides.language`). The relay prompt and the phrases the desktop
  sends ("Read this answer to the user", "Work status:", "Give the user a short update") stay
  English, because the prompt keys on them: they are protocol, not copy. The shared agent must
  allow the `agent.language` client override.
- **Microphone is per computer.** A device id means nothing on another machine, so the choice is
  stored in the desktop's localStorage (`crewaid.voice.microphone`), like the theme. Dictation, voice
  messages and calls ask for that device only while it is plugged in; otherwise they use the system
  default rather than failing.
- **The whole UI is translated, by typed catalogs and no library.** English (`en.ts`) is the
  source; its keys and `{param}` names are typed. The other 35 locales are JSON files loaded on
  demand. Plurals are keyed by `Intl.PluralRules` category, and a small tag syntax carries inline
  markup. A coverage test refuses a locale with a missing, extra or empty key, a mismatched
  placeholder or an invalid plural category. A language is offered only when its catalog is
  complete, and once every string is extracted a lint rule refuses new literal copy in the renderer.
- **The languages.** af ar bn cs da de el en es fi fr ha he hi hu id it ja ko mr nb nl pl pt ru sv
  sw ta te th tr uk ur vi zh-Hans zh-Hant. Portuguese and Spanish use Brazilian and Latin American
  wording under the bare codes. ar, he and ur are right to left: `<html dir>` follows the language,
  the renderer lays out by reading order (start and end, never left and right), directional icons
  mirror, and what a person or a bot wrote reads in its own direction, paragraph by paragraph. Code
  and the bot's screen stay left to right, and so does the room for the macOS window buttons, which
  the OS keeps on the left. `test/rtl-logical-layout.test.ts` refuses a new physical left or right.
- **The translations are machine-made.** `tools/i18n/translate.mjs` writes them from the English
  sources (the app's catalog, and D-235's welcome, templates and failure sentences) through
  OpenRouter, with `deepseek/deepseek-v4.1-flash-1017` at maximum reasoning effort: the owner's
  choice, at a few dollars for every language against tens for a frontier model. It first fixes
  a glossary per language (`tools/i18n/glossary/`; Crewaid is never translated, and bot, routine,
  skill, plugin, Work, task and goal each get one rendering), then checks every answer and asks
  again for any that breaks a placeholder, tag or plural form. No native speaker reviews them
  before launch. A test fails when a shipped language lacks a string or was translated from
  older English (`tools/i18n/translated-from.json`), so new English ships with
  `pnpm i18n:translate`. Arabic, Hebrew and Urdu ship with the right-to-left layout (CC-85).
- **Timezone picker.** It lists every zone the runtime knows plus `UTC`, with "Auto-detect (zone)"
  first and each zone's current time beside it. `TimezoneSchema` now accepts `UTC`, which the
  routine picker already offered and the contract refused.

- **The newest voice models.** Spoken replies and the call agent use `eleven_v4_turbo`, which
  speaks all 36 languages. `eleven_flash_v2_5` speaks 32 and lacks nine of them, and the agent's
  `eleven_flash_v2` speaks English only (this amends D-222's agent setup). Transcription stays
  on `scribe_v2`, and the agent's recognition on Scribe v2 Realtime: both are already the newest.
  The agent also allows the `agent.language` client override now.

**Not changed.** Times shown in the app stay on the computer's clock. Text the server stores
(Crewaid's welcome, D-232) and the server's own HTML pages stay English for now; D-235
amends this for the welcome, the templates and a failed run's sentence. The agent's own
language model stays `gpt-4.1-mini`, which the call relay was tuned against (D-222).

## D-235 — What the server writes for a person is in the account's language (2026-10-23)

**Status:** accepted by the product owner · **Task:** CC-86 · **Amends:** D-232, D-234

**Why.** D-234 translates the app but left the server's own words in English: Crewaid's welcome,
the templates library, and the sentence a failed run shows. A person who chose French would read
an English welcome in a French app. And a mobile app is planned, so these words cannot be the
desktop's to translate: every client shows what the server wrote.

**Decision.**

- **One rule.** Text the server writes for a person to read is written in the account's
  language: `UserSettings.language`, then the computer's, then English. A language whose server
  copy has not shipped reads English, as the app does. Text a model reads (crew briefs, tool
  descriptions and results, the call relay, the person block) stays English: it is instruction,
  not copy, and D-234 already tells the bot which language to write.
- **The welcome (amends D-232).** `WELCOME_COPY` becomes one copy per language in `@crewaid/shared`,
  read through `welcomeCopy(locale)`. The server writes each line in the account's language when it
  writes it, and Crewaid's role is written in it when Crewaid is created. Lines already stored are
  history and keep their language. The renderer and the server recognise a welcome line (the guide,
  the task question) in any language's copy, so changing language mid-welcome strands no reply.
- **Bootstrap carries the window's language.** On a new account the greeting is written before the
  opening window's device report lands, so `POST /onboarding/bootstrap` takes an optional
  `{ language }`: the language that window shows. The account's choice still wins over it, and it
  wins over an older device report. It is used for that write only, and stores nothing.
- **Templates.** A template's words (titles, categories, summaries, descriptions, inputs,
  outcomes, examples, starter tasks) are separate from its structure (members, looks, tools,
  revision). The library, the template tools and an install read the account's language. An
  installed bot's role and description, and its crew's name, are written in it. The revision
  names a definition, not a language.
- **Failed runs.** The sentence a failed run shows is worded in the account's language, from its
  error code, including the model setup refusals (D-228). A provider's own explanation is quoted as
  the provider wrote it.
- **Translations** follow D-234: machine-made from the English source with the same glossary, in
  the same batch as the app's catalogs (CC-84).

**Not changed.** Telegram replies and command descriptions, email, and the server's HTML pages
stay English for now.

## D-236 — Message text is sealed before it is stored (2026-11-16)

**Status:** accepted by the product owner · **Task:** CC-74 · **Amends:** D-073, D-077, D-083, D-139

**Why.** The site says messages are encrypted before they are stored, and they were not: a copy of
the database (a backup, a dump, a replica) held every conversation as text. Credentials were already
sealed (D-083); what people and their bots say to each other was the larger and more personal half.

**Decision.**

- **What is sealed.** `Message.content`, `Message.parts`, and `RunEvent.chunk`, the run's delivery
  log, which carries the same words a second time as the stream that produced them. AES-256-GCM,
  the credential cipher, under a key derived (HKDF-SHA-256, a label of its own) from each version
  in `CREWAID_CREDENTIAL_KEYRING`. No new variable: every deployment already has the ring, and a
  message and a credential are still never encrypted under the same key.
- **No schema change.** A sealed value starts with `cwsealed1.<key version>.`, so it names itself
  and the key it needs. A row written before this is read as the plaintext it holds. `parts` and
  `chunk` stay `Json` columns and hold the sealed value as a JSON string. Empty and
  whitespace-only text is stored as itself: `content <> ''` is how a dozen queries tell a spoken
  row from a tool call, and such a row says nothing.
- **Where.** One Prisma client extension over `PrismaService` (`prisma/message-sealing.ts`), not a
  call at each of the twenty-odd places a message is written or read. Writes on `message` and
  `runEvent` are sealed; every result is opened, including a message that arrives as a relation of
  another model. Code above the client never sees a sealed value. Two things the extension cannot
  make right are refused instead: a `where` that compares `content` to anything but the empty
  string, and a message or run event written as a nested write of another model.
- **Raw SQL opens what it selects.** The sidebar preview query selects `content` and opens it with
  `openStoredMessageText`. No other raw query reads a sealed column.
- **Search (amends D-077, D-139).** Postgres cannot index ciphertext, so `Message_content_fts_idx`
  is dropped. Transcript search — a bot's `memory_search` and the global search's messages — reads
  the scope's most recent `TRANSCRIPT_SEARCH_WINDOW` (2,000) spoken messages through the client and
  hands the opened text back to Postgres as parameters of one statement to rank. The `websearch`
  syntax, the stemming, the ranking and the `<<…>>` excerpts are unchanged. A message older than
  the window is no longer found by search; memory (D-073) is what keeps a fact longer than that.
- **Without a keyring.** A production server (`NODE_ENV=production`) refuses to start without the
  keyring, as a cloud server does without R2 (D-220); every production compose file already
  requires it. Outside production — local development, the suites, the e2e servers — a missing
  keyring stores messages as written and says so once at boot. A keyring that is set and malformed
  is refused everywhere.
- **What was already stored, and rotation.** `sealStoredMessages` seals every row that is not
  under the active key: plaintext from before this, and rows under a version since rotated out.
  The orchestrator runs it at each start, unawaited, and
  `node apps/orchestrator/dist/cli/seal-messages.js` runs it on demand. Each row is replaced only
  if it still holds what was read, so it is safe beside a serving process. A row that will not
  open is counted and left. Rotating the keyring therefore rotates messages too: add the new key,
  make it active, deploy, and retire the old key only after a pass reports nothing left under it.

**What a ciphertext is bound to.** The column and the key version, not the row: a message's id does
not exist when its `create` is built, and an `update` names the row by id alone. A writer inside the
database could move a sealed value between two rows of the same column. The promise is about what a
reader of the database learns.

**Not sealed, and so not claimed.** Tool-approval payloads (`RunInterrupt`), tool dispatch records,
memories, tasks, goals and deliverables, recordings, routine prompts, attachments in the artifact
store, and BullMQ job payloads in Redis. Each is its own decision; the site's sentence is about
messages, credentials and API keys.

**Consequences.**

- Losing `CREWAID_CREDENTIAL_KEYRING` now loses every transcript as well as every provider key.
  There is no recovery; keep the ring outside the database and its backups.
- There is no way back to plaintext: a release older than this one shows sealed rows as
  ciphertext.
- A search costs a read of up to 2,000 messages instead of an index lookup.

## D-237 — One snapshot per computer: save, replace, restore, recreate (2026-11-19)

**Status:** accepted by the product owner · **Task:** CC-87 · **Amends:** D-031, D-224 · **Defers:** Docker (CC-88)

**Why.** A paused Runtime computer keeps its memory and disk on one host with no expiry (D-217), and
nothing else of it exists: Runtime never snapshots or restores a sandbox by itself, and a host lost
with a paused machine on it takes the computer's files with it. People also want a known-good point
to go back to after a bot breaks something. Runtime snapshots (`sandbox.snapshot()`,
`sandboxes.create({ snapshot })`) capture the whole machine, are copied off the host after capture
(`backedUp` confirms the verified copy), and are billed for what they store ($0.18/GB-month),
so one per computer is affordable on every plan.

**Decision.**

- **One slot per computer, whole machine.** A snapshot is taken in Runtime's `memory` mode (files,
  memory and running programs) with `retentionDays: null`, so it is kept while the account has
  credit, up to the year Runtime allows. Saving again replaces it; there is never a second one.
- **Routes (§4.1 additions).** `GET /computer/snapshot`, `POST /computer/snapshot` (save) and
  `POST /computer/snapshot/restore`, each answering `ComputerSnapshotStatusResponse`
  `{ supported, snapshot: { takenAt, sizeBytes, expiresAt } | null, activity: 'SAVING' | 'RESTORING' | null, lastError: 'SAVE_FAILED' | 'RESTORE_FAILED' | null }`.
  `lastError` is a code the client words, never a provider's message.
  They address the caller's computer (the oldest `Sandbox` of `principal.userId`, the one
  `attachToComputer` picks), so they take no parameter and need no ownership marker. Both POSTs
  answer **202**: a capture can take minutes, so the work runs on in the orchestrator and the
  client reads GET while `activity` is set. A save or restore while one is in flight, or while
  any bot on the computer has a `running` turn, is **409 `COMPUTER_BUSY`**: a restore would pull
  the machine out from under a bot mid-step, and a capture pauses it. Nothing to act on — no
  computer yet, no snapshot to restore, or a provider without snapshots — is **409
  `SNAPSHOT_UNAVAILABLE`**; GET still answers, with `snapshot: null`.
- **A capability, not an edition.** `SandboxProvider.snapshots` is optional. Runtime implements it;
  Docker, DigitalOcean and Cloudflare do not and answer `supported: false`. A self-hosted server on
  `SANDBOX_PROVIDER=runtime` gets the feature; billing, metering and plans are untouched.
- **Under the lifecycle lease.** Save and restore each hold the computer's renewing lifecycle lease
  (the `Sandbox` row's CAS), so no wake, idle stop or migration races them, and both work on a
  **paused** machine: a running computer is paused first and brought up again through the ordinary
  start path afterwards, so its tunnels, ports and screen are rebuilt the way every wake rebuilds
  them; a paused one is captured without being woken. Runtime would pause a running machine for the
  capture on its own, but behind the lifecycle's back, leaving it with listeners nothing reopened.
- **Replacing is take, then delete, then rename.** The new snapshot is taken as
  `crewaid-snapshot-<computer>-next`. Once Runtime reports `backedUp`, the old snapshot is deleted
  and the new one takes the canonical `crewaid-snapshot-<computer>` name. Reading the status or
  sweeping retention finishes an interrupted swap. The old snapshot stays available during upload.
  A failed capture or off-host copy is reported as `lastError` and removed by the next save.
- **Restoring goes through D-224's journal.** Runtime cannot restore into an existing sandbox, so a
  restore creates a staged sandbox from the snapshot, waits for its bridge, then runs the same
  stage → backup rename → promote sequence as a cross-server migration, which `find()` already
  recovers after a crash. The backup is then deleted (it carries `crewaid-restore-discard`, so the
  retention sweep deletes it at once if the orchestrator dies first). The restored machine
  stays paused if the computer was stopped. A running computer takes the restored machine back
  into service with its memory intact.
- **Deleted bots stay deleted.** A snapshot predates later profile retirements, so before promotion
  every Chrome profile on the restored machine that is neither a current bot's nor one of the
  computer's identities is retired with `profiles.py retire`, the tombstone D-056 already uses.
  Seats need nothing: the bridge owns them, and the restored bridge holds the snapshot's.
- **Recreate from it (amends D-031).** A computer whose machine is missing is recreated from its
  snapshot, when one is ready, instead of refusing to start. D-031 forbids an *empty* replacement;
  a snapshot the person saved is their workspace, not an empty one, so the provider reports it as
  the workspace (`inspectWorkspace`) and the start's `createSession` makes the machine from it,
  retiring profiles as a restore does. Without a snapshot the refusal stands.
- **Retention.** Deleting an orphaned computer deletes its snapshots too, so a deleted computer
  leaves nothing billed.

**Consequences.**

- A restored computer runs the image its snapshot was taken on. Its next wake from paused follows
  the configured image (D-219): files and the home are kept, programs restart.
- Restoring discards everything since the snapshot: files, logins and the bots' browser state.
  There is no undo once the old machine is deleted.
- **Docker is deferred (CC-88).** Docker has no memory snapshot; the design there is a copy of the
  `/home/bot` volume into a labelled `crewaid-snapshot-<computer>` volume by a network-less
  supervisor helper while the computer is stopped, admitted like the workspace volume (D-200). It
  doubles the computer's disk on the host and restores files and saved logins, not open programs.
  It needs no route or UI change: the provider gains `snapshots`.

## D-238 — Open-core split: cloud-only server code lives in `ee/` (2026-11-23)

**Status:** accepted by the product owner · **Amends:** D-152, D-156, D-157

**Why.** The repository is public under the AGPL, and until now every cloud-only feature (Stripe
billing, metered computers, included models, hosted voice allowances, bot calls) was AGPL code
behind `CREWAID_EDITION=cloud`. Anyone could set that variable and run the paid features on their
own server. Keeping the cloud features in a private fork would mean two repositories to keep in
sync for a single maintainer. Code already published under the AGPL stays AGPL; this split covers
what changes from here on.

**Decision.**

- **One repository, two licenses.** Code under `apps/orchestrator/src/ee/` and
  `apps/orchestrator/test/ee/` is licensed under the Crewaid Enterprise License
  (`apps/orchestrator/src/ee/LICENSE.md`): source-available, development use allowed, production
  use reserved for Crewaid Cloud. Everything else stays AGPL-3.0. Contributions to either are taken
  under the CLA (`CLA.md`), which lets the maintainer license them both ways.
- **The core never imports `ee/`.** `restrictedImports()` bans `**/ee` and `**/ee/**` unless a block
  passes `eeSeam`; only `ee/` code does. Probe: `ee-core-import.probe.ts`. Core tests never name
  `ee/` either, so the core lints, builds and tests with every `ee/` directory deleted.
- **Ports in the core, bindings in `ee/`.** The core keeps the optional ports it already had
  (`COMPUTE_POLICY`, `INCLUDED_MODELS`, `HOSTED_VOICE`) and gains one for Better Auth plugins
  (`auth/auth-extensions.ts`). `ee/` binds them. With nothing bound the core behaves as the
  self-hosted edition always has: no limits, no billing routes.
- **A separate composition root.** CC-06 bans dynamic `import()` in the orchestrator, so the core
  cannot load `ee/` on demand. `ee/main.ts` boots `CloudAppModule` (the core `AppModule` plus the
  `ee/` modules) through the shared `bootstrap()`. `dist/main.js` refuses `CREWAID_EDITION=cloud`.
- **Self-hosted artifacts contain no `ee/`.** The orchestrator Dockerfile deletes `ee/` unless built
  with `CREWAID_BUILD_EE=1`; only the hosted Dokploy compose files pass it. The GHCR image and the
  one-click PaaS templates are pure AGPL builds.
- **What stays AGPL.** The desktop app, including its plan, usage and call UI (it does nothing
  without the server's `ee/` routes); the shared wire contracts; the Prisma schema and migrations
  (the cloud tables exist, empty, on self-hosted servers); magic-link sign-in; the ports above.

## D-239 — Templates moves into the Crew sidebar's footer (2026-11-23)

**Status:** accepted by the product owner · **Amends:** D-229 (entry points)

**Why.** The floating pill sat on the wallpaper beside the sidebar, attached to nothing, and the
sidebar column had to stop 54px short of the window so the pill never covered a bot. The room's
left column was the only panel that did not run the full height, and the entry point read as an
afterthought rather than part of the crew.

**Decision.** **Templates** is the sidebar's footer action on the Crew tab, below the roster and
the usage notice; the sidebar runs the full height of the room. What D-229 asked of the entry point
still holds: it belongs to the crew, so the Work views (Tasks, Goals, Deliverables), which hide the
sidebar, leave it out; under a narrow sidebar it is an icon-only button with a tooltip; it never
covers a bot, now because it lives in the column instead of over it. The sidebar `+` still creates
a bot from scratch.

## D-240 — Pro computers idle-stop; Pro's hours are counted, never capped (2026-11-25)

**Status:** accepted by the product owner · **Amends:** D-156 (the plans table)

**Why.** D-156 gave Pro a computer that never idle-stops. At $0.10–0.19 per awake hour that is
$73–139 a month per Pro account before any model spend, against a $100 price — and most of those
hours are a computer nobody is using. Waking a stopped computer takes seconds, and routines already
wake their computer through the shared ensure-ready path, so nothing a Pro account relies on needs
it awake while idle.

**Decision.**

- **Every plan idle-stops.** `BILLING_PLANS.pro.idleStop` is `true`. The `idleStop` field and the
  `ComputePolicy.idleStops` port stay, so a plan can opt out again without a change to the
  lifecycle.
- **Pro still has no hour limit, and its time is still counted.** The meter keeps recording Pro's
  seconds into `UsageLedger`; with `computeHours: null` the count never stops the computer or
  raises a usage notice. Counting is kept on purpose: the meter's pass is also what stops a
  computer whose plan has lapsed, a busy computer (a tight routine, a loop) is invisible to idle
  stop, and Pro's margins still need real hours to be set.
- **The sales copy is unchanged for now.** The desktop's Pro offer and the README still say the
  computer stays on 24/7; they will be reworded separately.

## D-241 — Coding harnesses: built-in sub-loop first, shared ACP core for local and sandbox runners (2026-11-26)

**Status:** accepted by the product owner · **Amends:** none (preserves PRD §2.2 R1, R5; PRD §2.5; D-199; D-208)

**Why.** Crewaid bots can already clone private GitHub repositories and open draft PRs (D-208), but
coding inside a bot's existing turn is cramped: `fs_read` returns whole files truncated at 16k
characters without line ranges (even though `sandbox-core` already supports 1-based line ranges),
`fs_write` replaces whole files with no targeted edit tool, `rg`/`fd` are not in the sandbox image,
`shell` times out at 120s with no managed background processes, turns cap at 25 steps, and once
history passes its token budget (100k by default) compaction clears every tool output but the 6
most recent, whatever they were. At the same time, many developers already pay for flat-rate
coding subscriptions (Claude Code, Codex, Antigravity) and want Crewaid bots to coordinate those
harnesses rather than pay per-token API rates for every refactor.

Evaluating a built-in Pi-style harness, an ACP bridge to local harnesses, and pre-installed sandbox
harnesses showed that none of the three alone covers both zero-setup 24/7 sandbox work (especially
on Crewaid Cloud) and power-user subscription workflows without violating R1, R5, or vendor terms.

**Decision.** Build a staged coding architecture behind one orchestrator-side `CodingRunner` port,
in six steps:

1. **Fix the shell-cancel tag mismatch immediately.** `computer-tools.ts` tagged commands with
   `crewaid-shell:<id>` while `killByTag` searched for `[g]rog-shell:<id>`, leaving cancelled shell
   commands running until the 120s timeout. Fix and cover with a regression test independently of
   the harness work.
2. **Add coding-grade tools and compaction to the existing loop.** Every bot benefits, not only
   coding bots:
   - `fs_read` with 1-based line ranges and line numbers.
   - `fs_edit` for surgical search-and-replace edits (`CONTAINED_BUILTIN`).
   - `fs_grep` and `fs_glob` (`OBSERVING_BUILTIN`), adding `ripgrep` (`rg`) and `fd` to the sandbox
     image. All file tools continue routing through `resolveWorkspacePath`.
   - Managed background processes (start, read incremental output, stop) for dev servers and >120s
     test suites, held alive by an exit-watched `'background-process'` keep-running lease with a
     user-visible time limit (default 30m). Cancelling a turn stops processes started during that
     cancelled run (keyed by `runId`), while processes from turns that finished normally keep
     running until `process_stop`, their time limit, or container stop.
   - Coding-aware compaction that, once over budget, retains working file context instead of
     clearing every tool result but the last 6.
3. **Add a delegated `code_task` tool behind a `CodingRunner` port.** Coding stays a delegated tool
   rather than replacing a bot's main execution backend, so the bot keeps its Crewaid tools (Chrome
   seat, screen capture/recording, memory, Work board, inter-bot messaging, server-authenticated
   GitHub push/PR). The default runner is a lean Pi-inspired coding sub-loop running **in the
   orchestrator** on `TanStackExecutionBackend` with a larger step budget and an optional separate
   coding model. Zero credentials enter the sandbox, and it works identically across Docker,
   Runtime, Instabox, Self-Hosted, and Crewaid Cloud—including 24/7 unattended routines.
4. **Unlock subscription savings through the orchestrator.**
   - Point Anthropic Max/Ultra/Team subscribers to their linked Claude Console monthly API credits
     through existing Anthropic BYOK settings. Do not integrate Claude consumer OAuth in Crewaid
     while third-party subscription rules remain unsettled.
   - Apply for OpenAI's "Sign in with ChatGPT" ("Use your ChatGPT plan") partner access for Crewaid
     Cloud after verifying `@tanstack/ai-openai` compatibility with its Responses API constraints
     (`store: false`, streaming-only, and unsupported parameters).
   - **Step 4 audit result (verified against `@tanstack/ai@0.64.0`, `@tanstack/ai-openai@0.26.0`, `@tanstack/openai-base@0.12.2`):**
     - **Streaming-only (`stream: true`):** Compatible across every Crewaid call site (`TanStackExecutionBackend`, `BuiltInCodingRunner`, and `askModelText`). Even `askModelText`'s `chat({ stream: false })` routes through `runNonStreamingText` → `runStreamingText({ stream: true })` → `client.responses.create({ ..., stream: true })`, and Crewaid never calls `adapter.structuredOutput` (`stream: false`).
     - **`store: false` & payload fields:** `OpenAITextAdapter` defaults to omitting `store`, puts system prompts in `instructions`, emits only `type: "function"` tools (no OpenAI hosted tools), omits `temperature`/`top_p` on reasoning models (`o*`, `gpt-5*`, `codex-mini-latest`) while requesting `include: ["reasoning.encrypted_content"]`, and sends none of `max_output_tokens`, `metadata`, or `previous_response_id` from Crewaid call sites. `buildTextAdapter` now supports `{ store: false }` via a stateless `OpenAITextAdapter` subclass that enforces `store: false` and strips `metadata`/`previous_response_id`, and `normalizeModelError`/`normalizeRunError` map `subscription_sharing_usage_limit_exceeded` to non-retryable `QUOTA_EXCEEDED`.
     - **OAuth client boundary:** `@tanstack/ai-openai` already ships loopback-only SIWC helpers (`@tanstack/ai-openai/siwc`, `dynamic_agent_client` + `http://127.0.0.1:<port>/auth/callback`) permitted only for open-source/local apps; Crewaid Cloud still requires OpenAI partner approval for a commercial OAuth client ID with server-side encrypted refresh-token storage in `ProviderConnection` (D-083). Once partner credentials are issued, verify multi-turn `function_call`/`reasoning` `itemId` replay under `store: false` against the live plan-token endpoint before enabling in production.
5. **Build a shared ACP core + opt-in standalone local connector (`crewaid connect <dir>`).**
   Presented explicitly as a separate opt-in mode ("manage my local harnesses") where the code stays
   on the user's machine and closing the laptop marks the connector offline:
   - **Shared core:** One ACP client (`@agentclientprotocol/sdk`), coding-session record, and
     progress UI serve both Step 5 and Step 6; only the transport differs (outbound WebSocket vs
     `bridgeExec` stdio).
   - **Outside Electron (R1):** The connector is a separate CLI process that opens one outbound
     WebSocket to the orchestrator (like a GitHub Actions self-hosted runner) using a revocable
     connector-scoped token—no inbound ports, and no host process spawning inside Electron (the
     desktop app displays status and a copyable launch command unless a later decision explicitly
     amends R1).
   - **Prompt-injection and privacy guardrails:** Because bots read untrusted web pages and
     Telegram messages, bots **propose** tasks by default and a human approves the exact bound
     payload (bot, connector, folder, verbatim prompt hash) before dispatch. ACP
     `session/request_permission` prompts are always answered locally on the user's machine (never
     by a bot), with `WAITING_LOCAL_PERMISSION` surfaced in Crewaid plus a local notification.
     Reporting defaults to summary-only, with an explicit user opt-in for full transcripts/diffs so
     private source code is not silently uploaded to Crewaid Cloud. UI and docs state plainly that
     `cwd` scopes the workspace while the harness's own local sandbox/permission mode enforces host
     OS boundaries.
   - **Crew handoff:** The local harness pushes a feature branch using the user's own laptop Git
     credentials; a Crewaid bot clones that branch in its sandbox (D-208) to test in Chrome, record
     a video, and comment on the PR.
6. **Add opt-in sandbox ACP harnesses through the same core.**
   - Spoken over existing `bridgeExec` stdin/stdout streams—no new sandbox ports, working identically
     across Docker, Runtime, and Instabox.
   - Installed on demand into `/home/bot/.local` at Crewaid-tested versions rather than bloating the
     base sandbox image.
   - **No Settings storage or injection of third-party harness tokens.** Consistent with R5 and
     Chrome profiles, users sign into unmodified official CLIs directly on their bot's desktop.
     Order: Codex first (device-code login and sanctioned third-party plan use), then OpenCode and
     Antigravity (`agy acp`, gated on verifying login persistence in the sandbox image, which ships
     `dbus-x11` without `gnome-keyring`), and Claude Code with user-managed API keys only until
     third-party subscription policy settles.
   - Add each CLI's auth directory (`.codex`, `.claude`, etc.) to `MACHINE_OWNED` in
     `workspace-paths.ts` as a guardrail against confused file tools.
   - **Honest black-box boundary:** Because Docker sandboxes run with `CapDrop: ['ALL']` and
     `no-new-privileges`, Codex's nested `bwrap` sandbox cannot run inside them, so sandbox external
     harnesses run with full access to the bot's computer and bypass `PrivacyVault`, fine-grained
     approvals, metering, and per-step checkpoints. The real boundary is the container plus D-208's
     server-gated push/PR approval, and the UI states this plainly.
   - Active sandbox ACP sessions hold and renew the computer's `keepRunningUntil` lease (WORKSPACE
     §17) and settle cleanly on orchestrator restart (marking `INTERRUPTED` or resuming via a
     persisted ACP session ID).

**Rejected.**

- **Running an LLM-calling harness (such as Pi) inside the sandbox container.** Putting user or
  Crewaid Cloud model keys inside the container breaches R5, and self-hosted Docker egress blocks
  the host and RFC1918 addresses so a local model proxy is unreachable without extra infrastructure.
- **Adopting `@ai-sdk/harness`'s `HarnessAgent`.** `@ai-sdk/harness` stays pinned strictly behind
  `sandbox-core`'s sandbox contract as a design reference only: its ACP adapter requires an exposed
  sandbox loopback port and egress credential proxy that Crewaid does not have, and D-199 removed
  the parallel AI SDK runtime in favor of TanStack AI.
- **Storing/injecting external CLI OAuth tokens from Crewaid Settings.** Violates Anthropic's terms
  and weakens the boundary separating orchestrator secrets from container-local user sessions.
