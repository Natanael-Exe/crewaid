# Contributing to Crewaid

Thanks for taking the time to contribute. Crewaid is pre-1.0 and moves quickly,
so keeping changes small, well-tested, and aligned with the repository's
enforced boundaries helps pull requests land smoothly.

## Before writing code

- **Small bug fixes, tests, and docs:** open a PR directly.
- **New features, schema changes, or architectural changes:** open an issue
  first so we can agree on the design before you spend time implementing it.
- **Security vulnerabilities:** do **not** open a public issue — follow
  [`SECURITY.md`](SECURITY.md).

## Getting set up

Full setup instructions (Postgres, Redis, Docker sandbox image, environment
variables, and architectural rules) live in
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

On a clean clone:

```bash
pnpm install
pnpm db:generate        # required before typecheck/test/build
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Note that many orchestrator integration suites skip unless Postgres is running
with `DATABASE_URL` exported and migrations applied (`pnpm db:deploy`), and
attachment tests require `ARTIFACT_DIR`.

## Architectural rules & contracts

Crewaid enforces its core boundaries in CI rather than relying on review
comments alone. Before making cross-package edits, read:

- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — enforced lint/test invariants
  and shared contract rules.
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — recorded design decisions (`D-xxx`).
  Where a decision and [`docs/PRD.md`](docs/PRD.md) disagree, the decision wins.

Key rules that fail CI if broken:

- **`packages/shared` is the single source of truth** for wire types and Zod
  schemas, and depends only on `zod`. Every exported schema needs a
  valid/invalid fixture pair in `packages/shared/src/schemas.test.ts`.
- **Exact dependency versions:** no `^` or `~` ranges (`node scripts/check-pins.mjs`).
- **Route ownership:** every direct-by-id Nest route must declare
  `@OwnedResource(...)` or an explicit exemption
  (`apps/orchestrator/test/ownership-route-coverage.test.ts`).
- **Prisma scoping:** every Prisma call site is tracked by enclosing function in
  `apps/orchestrator/test/prisma-allowlist.test.ts`.
- **Guard probes:** if you add or modify an architectural lint rule in
  `eslint.config.mjs`, keep its probe passing in
  `node tools/guard-probes/run-probes.mjs`.
- **Schema migrations:** `schema.prisma` must never drift ahead of
  `apps/orchestrator/prisma/migrations/`.
- **Desktop i18n:** you can edit English strings in `apps/desktop` freely —
  missing translations fall back to English at runtime, and maintainers refresh
  shipped locales before release (`pnpm i18n:translate` / `pnpm i18n:check`).

## Pull request checklist

1. Branch from `main` (never commit directly to `main`).
2. Keep PRs focused on one change and explain *why* in the PR description.
3. Run the checks locally before requesting review:
   - Quick pass (no DB): `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
   - Full gate (with local Postgres/Redis via `infra/compose` and `DATABASE_URL`
     set): `pnpm pre-review`
4. Format code with `pnpm format` (Prettier).

## Contributor License Agreement

Before your first pull request can be merged, you need to accept the
[Crewaid Contributor License Agreement](CLA.md). A bot comments on your pull
request with instructions: reply with the sentence it gives you. You only need
to sign once, and the signature covers all of your future contributions.

You keep the copyright to your work. The CLA gives the maintainer the right to
distribute your contribution under other licenses as well as the AGPL, for
example in the hosted cloud edition of Crewaid.

## License

Crewaid is released under the
[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`), and your
contributions are distributed in it under that license. Brand artwork and third-party marks remain governed by
[`packages/brand/LICENSE.md`](packages/brand/LICENSE.md).
