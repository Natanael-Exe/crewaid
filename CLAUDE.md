# CLAUDE.md

Guidance for coding agents and contributors working in this repository.

## Overview

Crewaid is a self-hosted Electron desktop app (`apps/desktop`) backed by a NestJS orchestrator (`apps/orchestrator`) and isolated Linux containers (`packages/sandbox-*`, `infra/sandbox-image`) where AI agents ("bots") browse, run skills, message each other, track Work items, and stream their screens live.

`CREWAID_EDITION` (`selfhosted` or `cloud`, required) controls sign-in and commercial features: `selfhosted` uses email/password with no billing routes; `cloud` enables OAuth/magic-link sign-in, Stripe billing, metered models, and voice calls. Cloud-only server code lives in `apps/orchestrator/src/ee/` under the Crewaid Enterprise License (D-238) and boots only through `dist/ee/main.js`; `dist/main.js` refuses `cloud`.

## Commands

```bash
pnpm install                        # pnpm 10.15.0, Node >= 22
cd infra/compose && cp .env.example .env && docker compose up -d --wait && cd ../..
export DATABASE_URL="postgresql://crewaid:crewaid@localhost:5432/crewaid?schema=public"

pnpm db:generate                    # required before build/typecheck/test on a clean clone
pnpm db:deploy                      # apply Prisma migrations
pnpm db:seed                        # seed development user

pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm pre-review                     # full local gate (requires DATABASE_URL)
node tools/guard-probes/run-probes.mjs
node scripts/check-pins.mjs
```

Orchestrator integration suites require `DATABASE_URL` (and `ARTIFACT_DIR` for attachment/ownership HTTP suites) and run `--no-file-parallelism` against Postgres. Without `DATABASE_URL`, DB-backed suites skip. Desktop tests render with `renderToStaticMarkup` (no jsdom).

## Architecture

- **`packages/shared`** — Single source of truth for REST routes, WebSocket frames, and Zod schemas. Zero runtime dependencies besides `zod` (lint-enforced). Every exported schema requires a valid/invalid fixture pair in `src/schemas.test.ts`.
- **`apps/orchestrator`** — NestJS server owning all orchestration, Better Auth sessions (`auth/`), ownership checks (`@OwnedResource` + `ResourceOwnershipGuard`), Prisma message sealing at rest (`prisma/message-sealing.ts`), TanStack AI execution (`chat/`, `agent/`), MCP plugins (`mcp/`), routines (`routines/`), Work (`work/`), voice (`voice/`), and Telegram (`telegram/`).
- **`apps/desktop`** — Electron + React 19 + HeroUI v3 + Tailwind v4 client with zero orchestration logic. Main-process IPC goes strictly through `guardedIpc` in `src/tokenStore.ts` (lint-enforced). Renderer HTTP calls go through `renderer/api/` (validated with shared schemas); shell events flow through `renderer/state/chatReducer.ts`; live chat transcripts stream via standalone `@ag-ui/client`.
- **`packages/sandbox-*` & `packages/screen-*`** — `sandbox-core` defines the shared `SandboxProvider` contract (and Chrome browser-sandbox seccomp profile); `sandbox-docker` talks to `sandbox-supervisor` (the sole process holding the Docker socket); `sandbox-runtime` targets Runtime (`withruntime.com`); `sandbox-instabox` targets Instabox (`instabox.sh`) via `@insforge/instabox-sdk` and multiplexed SSH tunnels; `sandbox-digitalocean` and `sandbox-cloudflare` are deprecated. `screen-stream` implements ACK-paced RFB streaming shared by the orchestrator and `screen-gateway`.

## Machine-Enforced Invariants

- **Strict TypeScript** (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, zero `any`, zero `as never` in production code).
- **Exact dependency pins** (`node scripts/check-pins.mjs` — no `^`/`~` ranges; direct provider SDKs like `openai` or legacy `ai` packages are banned).
- **Architectural lint rules + negative probes** (`eslint.config.mjs` + `tools/guard-probes/run-probes.mjs`):
  - `apps/desktop` holds no orchestration imports; raw `ipcMain.handle` is banned outside `tokenStore.ts`.
  - Only `packages/sandbox-supervisor/src/docker-engine.ts` imports `dockerode`; the orchestrator never imports the supervisor.
  - No `eval`, `vm.*`, `new Function`, or dynamic `import()` in `apps/orchestrator`.
  - `no-restricted-imports` blocks in `eslint.config.mjs` must compose via `restrictedImports()` so earlier bans are never overwritten.
- **Route & DB ownership**: `test/ownership-route-coverage.test.ts` checks every parameterized Nest route; `test/prisma-allowlist.test.ts` audits every Prisma call site by enclosing function; `test/schema-contract.test.ts` guards Prisma field names; CI runs `prisma migrate diff --exit-code`.
- **Open-core boundary (D-238)**: the AGPL core never imports from an `ee/` directory (lint + `ee-core-import` probe). The core exposes ports (`COMPUTE_POLICY`, `INCLUDED_MODELS`, `HOSTED_VOICE`, auth extensions) and `ee/` binds them. Core tests never name `ee/`; the core must lint, build and test with every `ee/` directory deleted.
- **At-rest message sealing**: `Message.content`, `Message.parts`, and `RunEvent.chunk` are encrypted via `PrismaService`'s client extension. Never query ciphertext with `where: { content: ... }` (except `{ not: '' }`) and never write messages as nested writes.
- **Desktop i18n**: User-facing strings live in `apps/desktop/src/renderer/i18n/messages/en.ts`. Missing translations fall back to English at runtime; maintainers refresh shipped locales with `pnpm i18n:translate` and verify full coverage with `pnpm i18n:check`.

## Conventions

- Follow [DESIGN.md](./DESIGN.md) for all visual and interaction decisions in `apps/desktop`. It describes Crewaid's own theme, not HeroUI's default; update it alongside any change to the theme CSS.
- Branch from `main`; keep commits focused.
- Comments explain *why* the code has this shape (invariants, races, upstream quirks) — never who asked for it or internal ticket IDs.
- New secrets go through environment variables and `infra/compose/.env.example` — never into a sandbox container.
