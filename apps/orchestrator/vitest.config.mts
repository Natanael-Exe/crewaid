import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    setupFiles: [
      './test/sandbox-retention.setup.ts',
      './test/loopback-listen.setup.ts',
      './test/sandbox-supervisor.setup.ts',
    ],
    /**
     * Two M2-BE-11 policies are host-wide, and a shared test database is not a
     * host. Both are neutralised here and re-enabled by the suites that test
     * them, which construct their own service with an explicit value.
     *
     * `SANDBOX_MAX_RUNNING` counts every Sandbox row in the database, and
     * integration suites deliberately leave theirs behind — a local database
     * carries hundreds from previous runs. Left at its production default of
     * six, the first start in any suite would be refused for capacity, which
     * is a true statement about the row count and a useless one about the
     * code under test.
     *
     * `SANDBOX_IDLE_STOP_MS` is `0` so no suite acquires a background timer
     * that stops sandboxes other suites are still asserting on.
     */
    env: {
      // Ordinary app suites use fake providers or make no Docker calls. Keep
      // their boot configuration valid without touching a developer's daemon;
      // Docker-gated suites replace these with a real supervised endpoint.
      SANDBOX_SUPERVISOR_URL:
        process.env['SANDBOX_SUPERVISOR_URL'] ||
        (process.env['CREWAID_DOCKER_TESTS'] === '1' ? '' : 'http://127.0.0.1:1'),
      SANDBOX_SUPERVISOR_SECRET:
        process.env['SANDBOX_SUPERVISOR_SECRET'] || 'test-supervisor-secret-not-a-real-key-000000',
      SANDBOX_MAX_RUNNING: '1000000',
      SANDBOX_IDLE_STOP_MS: '0',
      // D-156: the computer-time meter only runs where billing is on, and the
      // billing suite drives it directly; no suite gets a background timer.
      SANDBOX_METER_INTERVAL_MS: '0',
      SANDBOX_HEALTH_INTERVAL_MS: '0',
      // Reconciliation owns production startup. Integration suites share one
      // database, so the dedicated suite drives a pass explicitly instead of
      // allowing each unrelated Nest app to reconcile every other suite's rows.
      SANDBOX_RECONCILE_ON_BOOT: 'false',
      // Artifact reaping and quota are host-wide too. Interval 0 keeps
      // background timers out of every suite; the huge quota and the disabled
      // disk floor keep uploads from being refused for capacity. The dedicated
      // reaper suite sets its own explicit values per case.
      ARTIFACT_REAP_INTERVAL_MS: '0',
      ARTIFACT_REAP_ON_BOOT: 'false',
      ARTIFACT_MAX_TOTAL_MB: '1000000',
      ARTIFACT_MIN_FREE_MB: '0',
      // M3-BE-06: a `@Processor` starts a real worker in EVERY Nest context
      // that has it, and thirteen suites boot the whole application against
      // one shared Redis. Left on, every suite would consume every other
      // suite's `skill.compile` jobs and run real model calls for them. The
      // queue suite drives a worker of its own instead.
      SKILL_COMPILE_WORKER: 'false',
      // M7-BE-01's delivery worker, off for the same reason: a @Processor
      // starts a real worker in every booted context, and the suites share
      // one Redis. The delivery suites drive a worker of their own.
      BOT_MESSAGE_WORKER: 'false',
      // M8-BE-01's routine worker and boot reconciliation, off for the same
      // reason — and the reconciliation matters as much as the worker here:
      // left on, every booted suite would schedule every other suite's
      // routines in the shared Redis. The routine suites drive their own.
      ROUTINE_WORKER: 'false',
      TELEGRAM_WORKER: 'false',
      TELEGRAM_PUBLIC_URL: '',
      TELEGRAM_MANAGER_BOT_TOKEN: '',
      TELEGRAM_MANAGER_WEBHOOK_SECRET: '',
      // CC-05: the daily caps are system-wide (every bot, every user), and a
      // shared database carries every suite's turns — left configured, one
      // suite's spend could refuse another suite's turns. Neutralised here;
      // the caps suites construct their own service (or set this before
      // booting) with an explicit value.
      MAX_DAILY_TOKENS: '0',
      // V1-08: `better-auth.ts` requires these at MODULE scope, so a suite
      // that merely imports the guard — directly or through AppModule — fails
      // to load without them. Set for the whole run rather than per suite,
      // because the failure is an import error naming an environment variable
      // and reads nothing like the auth test it broke.
      //
      // Not real secrets and not a shared fixture value either: signing with a
      // known constant is fine for a process that only verifies its own
      // tokens, and the URL is only used to build callback and magic-link
      // URLs, which no suite follows.
      // D-152: required at module scope by `better-auth.ts`, for the same
      // reason as the two below. `cloud` because every existing auth suite
      // drives the hosted sign-in methods; the self-hosted suite builds its
      // own instance with `createAuth('selfhosted')`.
      // D-236: the suites run with messages sealed, as every deployment does,
      // so a read that would show ciphertext or a write that would store
      // plaintext fails here rather than in production. A suite about a
      // missing or different keyring sets its own.
      CREWAID_CREDENTIAL_KEYRING:
        process.env['CREWAID_CREDENTIAL_KEYRING'] || JSON.stringify({ 1: '7'.repeat(64) }),
      CREWAID_EDITION: 'cloud',
      BETTER_AUTH_SECRET: 'test-better-auth-secret-not-a-real-key-000000',
      BETTER_AUTH_URL: 'http://localhost:3000',
    },
  },
});
