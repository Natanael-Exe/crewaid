# Developing Crewaid

How to run Crewaid from source, test it, and change it without breaking the
rules the build enforces. To run Crewaid without building it, use the installer
in [`infra/selfhost/README.md`](../infra/selfhost/README.md) instead.

Design records:

- **Product spec:** [`PRD.md`](PRD.md)
- **Decisions:** [`DECISIONS.md`](DECISIONS.md). Where a decision and the PRD
  disagree, the decision wins.
- **When something breaks:** [`RUNBOOK.md`](RUNBOOK.md), organized by the
  symptom you see

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | ≥ 22 |
| pnpm | 10.15.0 (`corepack enable`) |
| Docker | with Compose v2, and room for a ~2 GB image |
| OpenSSL | to generate the secrets below |

## First run

### 1. Install and start Postgres + Redis

```bash
pnpm install

cd infra/compose
cp .env.example .env          # then fill in the secrets and ONE sign-in method — see below
docker compose up -d --wait   # Postgres 16 + Redis 7
cd ../..
```

If host port 5432 or 6379 is already taken, set `POSTGRES_PORT` / `REDIS_PORT`
in `.env` (the compose file reads both) **and** change the port in its
`DATABASE_URL` / `REDIS_URL` to match.

### 2. Migrate and seed

```bash
export DATABASE_URL="postgresql://crewaid:crewaid@localhost:5432/crewaid?schema=public"
pnpm db:generate              # generate the Prisma client — required on a clean clone
pnpm db:deploy                # apply migrations
pnpm db:seed                  # the development fixture user
```

### 3. Build the sandbox image

Every bot works on a computer started from this image, so without it a bot can
be created but has nowhere to work. **The build context is the repo root**,
because the image bundles the skill runner from `packages/skill-runtime`:

```bash
docker build -f infra/sandbox-image/Dockerfile -t crewaid/sandbox:dev .
```

The tag must match `SANDBOX_IMAGE` in `.env` (`crewaid/sandbox:dev` by default).
The first build takes several minutes; rebuild after pulling changes to
`infra/sandbox-image/` or `packages/skill-runtime/`, or the bots run the old
ones. It builds natively on arm64 and amd64. The `agent-net` bridge network the
containers join is created by the supervisor on first use. Smoke test,
production egress policy and what runs inside are in
[`infra/sandbox-image/README.md`](../infra/sandbox-image/README.md).

### 4. Start the supervisor and orchestrator

Set `SANDBOX_SUPERVISOR_SECRET` in `.env` to a fresh `openssl rand -hex 32`
value. In one terminal, start the process that holds the Docker socket:

```bash
pnpm --filter @crewaid/sandbox-supervisor... build
node --env-file=infra/compose/.env packages/sandbox-supervisor/dist/main.js
```

In another terminal, start the orchestrator with the same environment:

```bash
pnpm orch                     # builds, then runs with infra/compose/.env loaded
```

It refuses to boot without `CREWAID_EDITION`, `BETTER_AUTH_SECRET` and
`BETTER_AUTH_URL`, so misconfiguration fails here rather than at the first
request. The Docker provider also requires `SANDBOX_SUPERVISOR_URL` and
`SANDBOX_SUPERVISOR_SECRET`; the example URL is `http://127.0.0.1:7300`.
`curl localhost:3000/health` reports Postgres, Redis, Docker and every sandbox.

### 5. Open the desktop app, sign in, create a bot

```bash
pnpm --filter @crewaid/desktop dev     # or build an installer: pnpm package:selfhosted | package:cloud
```

1. **Set the orchestrator address** (`http://localhost:3000`) when the app asks.
   An unpackaged app is the self-hosted edition, which is the one that asks; the
   hosted edition has its address compiled in.
2. **Sign in with browser.** With `CREWAID_EDITION=selfhosted` (the example
   `.env`), the page offers email and password: create an account the first
   time. With `cloud`, it offers only the methods `.env` configures (magic link,
   Google, GitHub) — start the orchestrator with `pnpm orch:cloud` (the cloud
   edition boots from `dist/ee/main.js`, D-238; `pnpm orch` refuses `cloud`) and
   run the app with `CREWAID_EDITION=cloud
   CREWAID_ORCHESTRATOR_URL=http://localhost:3000` to match. If the OS did not
   register the sign-in scheme — an unpackaged build on macOS registers it to
   the Electron binary — the page prints a code to paste into Settings instead.
3. **Settings → Connections**: add a provider and its API key. Keys are
   per-user and encrypted at rest; none is read from the environment.
4. **New bot** in the sidebar, then pick a model in the composer. Opening the
   bot's screen card wakes its computer.

[`V1-ROLLOUT.md`](V1-ROLLOUT.md) has the longer version, including OAuth
redirect URIs and key rotation. For a one-VPS Dokploy deployment using Neon,
follow [`infra/dokploy/README.md`](../infra/dokploy/README.md).

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm test:e2e                 # built Electron + real local orchestrator; no provider key needed
pnpm pre-review               # all of the above plus probes and pins; needs DATABASE_URL
```

⚠️ Without `DATABASE_URL`, the orchestrator's integration suites skip and the
run still reports green. `ARTIFACT_DIR` is needed too, or three suites fail with
a 500 that looks like an attachment bug.

## Environment variables

All secrets come from the environment; none is ever passed into a sandbox
container. [`infra/compose/.env.example`](../infra/compose/.env.example) is the
annotated list — every tuning knob, with its default and why. The ones a first
run needs:

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | **yes** | Postgres connection string |
| `BETTER_AUTH_SECRET` | **yes** | Signs sessions and magic links. `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | **yes** | The orchestrator's public origin; OAuth callbacks are built from it |
| `CREWAID_CREDENTIAL_KEYRING` | **yes** | Encrypts provider API keys and every stored message. `{"1":"<openssl rand -hex 32>"}`. Keep a copy: nothing sealed under it can be read without it |
| `CREDENTIAL_KEY` | for plugins | Encrypts MCP plugin tokens. `openssl rand -hex 32` |
| `REDIS_URL` | for skills, messaging, routines | Redis / BullMQ. Chat works without it |
| `ARTIFACT_DIR` | without R2 (set in `.env.example`) | Where attachments and recording screenshots are written when R2 is not configured |
| `ARTIFACT_R2_ACCOUNT_ID` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` / `_BUCKET` | **cloud in production**; optional otherwise | All four or none. When set, every artifact is stored in this R2 bucket and nothing on disk |
| `SANDBOX_IMAGE` | defaulted | The image from step 3 (`crewaid/sandbox:dev`) |
| `SANDBOX_SUPERVISOR_URL` | with Docker | Private supervisor address (`http://127.0.0.1:7300` locally) |
| `SANDBOX_SUPERVISOR_SECRET` | with Docker | Signs lifecycle requests; same value in both processes. `openssl rand -hex 32` |
| `GOOGLE_CLIENT_ID` / `_SECRET` | **one sign-in method** | Google sign-in and the direct Drive plugin. Redirect URI: `$BETTER_AUTH_URL/api/v1/auth/callback/google` |
| `COMPOSIO_API_KEY` | for app integrations | Server-side Composio project key. [Setup and bot access](COMPOSIO.md) |
| `GITHUB_CLIENT_ID` / `_SECRET` | **sign-in / GitHub plugin** | GitHub sign-in and direct GitHub repository tools in both editions; see [GitHub Git setup](GITHUB-GIT.md) |
| `RESEND_API_KEY` + `MAGIC_LINK_FROM` | **one sign-in method** | Email magic links. `MAGIC_LINK_FROM` must be on a domain verified in Resend |

In the `cloud` edition, any one of the three sign-in methods is enough; a method
whose variables are blank simply has no button. In the `selfhosted` edition,
sign-in uses email and password and none of those three methods is required. The
three key variables are separate on purpose (D-083): rotating one must not force
rotating the others. Keep them out of the database and its backups.

## Architectural rules are enforced, not documented

These are machine-checked in CI and fail the build. Each rule also has a probe
in [`tools/guard-probes/`](../tools/guard-probes) that proves the rule still
fires, because a lint rule that silently stopped matching looks exactly like a
codebase that obeys it.

| Rule | Enforced by |
|---|---|
| Only the sandbox supervisor's Docker engine imports `dockerode`, and the orchestrator cannot import the supervisor | `no-restricted-imports` + a one-file allowlist |
| Sandbox harness types come through one re-export | `no-restricted-imports` + a one-file allowlist |
| No `eval`, `vm.*`, `new Function` or dynamic `import()` in `apps/orchestrator` | `no-restricted-syntax`, `no-eval`, `no-new-func` |
| The Electron app holds no orchestration logic | banned imports in `apps/desktop` |
| MCP clients never enter sandbox-facing packages | banned imports in `packages/sandbox-core`, `packages/sandbox-docker`, `packages/sandbox-supervisor` and `packages/skill-runtime` |
| `packages/shared` depends on nothing but `zod` | banned imports in `packages/shared` |
| Exact version pins, no carets | [`scripts/check-pins.mjs`](../scripts/check-pins.mjs) |
| Prisma field names match the PRD's data model | `apps/orchestrator/test/schema-contract.test.ts` |
| Every route that takes an id declares which row owns it | `apps/orchestrator/test/ownership-route-coverage.test.ts` |
| The schema never drifts ahead of the migrations | `prisma migrate diff --exit-code` in CI |

> ⚠️ **`no-restricted-imports` does not merge across ESLint flat-config blocks —
> the last matching block wins outright.** Every block that restricts imports
> composes the shared bans via `restrictedImports()` in `eslint.config.mjs`. If
> you add a block that sets this rule, compose it the same way or you will
> silently disable the architectural bans for those files.

## Contracts you must not casually change

- **Prisma field names** (`apps/orchestrator/prisma/schema.prisma`) are
  contractual. So are the **WebSocket event names** in PRD §4.2 and the **REST
  paths** in §4.1.
- `packages/shared` is the single source of truth for both. Every exported
  schema must have a valid/invalid fixture pair in `schemas.test.ts`; a
  coverage test fails the build if one is missing.
- Genuinely underspecified? **Ask, don't guess** (PRD §0 rule 2).
