import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 configuration.
 *
 * Prisma 7 reads the datasource URL from here rather than from `env()` inside
 * `schema.prisma`. The schema itself is PRD §3 verbatim and must not acquire
 * tooling concerns — they live in this file instead.
 *
 * `DATABASE_URL` is read leniently rather than via `env()`, which throws at
 * config-load time when the variable is unset. Schema-only commands
 * (`migrate diff --from-migrations --to-schema`, used by the CI drift guard)
 * touch no datasource and must still load this file. Commands that genuinely
 * need a connection fail on their own with a clear message.
 */
const shadowDatabaseUrl = process.env['SHADOW_DATABASE_URL'];

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Runtime queries may use Neon's pooled URL while migrate deploy uses its
    // direct URL. Local development keeps using DATABASE_URL for both.
    url: process.env['MIGRATION_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '',
    /**
     * Only set when present — the key must be ABSENT when unset, never an
     * empty string: Prisma P1013 rejects `shadowDatabaseUrl: ""` outright
     * (hit in CI, 2026-09-02). Required by `migrate diff --from-migrations`
     * (the CI drift guard), which replays the migration history into a
     * throwaway database; Prisma 7 takes it from config, not from a flag.
     */
    ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}),
  },
});
