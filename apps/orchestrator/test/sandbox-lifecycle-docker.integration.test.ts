import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { SANDBOX_LABELS } from '@crewaid/sandbox-docker';

import { privateComputerBot } from './computer-fixtures.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SandboxService } from '../src/sandbox/sandbox.service.js';
import { SandboxHealthService } from '../src/sandbox/sandbox-health.service.js';

/**
 * M2-QA-02, M2-QA-03, M2-QA-04 — the lifecycle against a REAL Docker daemon.
 *
 * ── WHY THESE EXIST WHEN THE FAKE-PROVIDER SUITES ALREADY PASS ──────────────
 *
 * `sandbox-lifecycle.integration.test.ts` and `sandbox-health.integration.test.ts`
 * cover the same three claims against a fake provider, and their reasoning for
 * doing so is right: the lock is `updateMany`'s row count under Postgres'
 * concurrency semantics, and counting `createSession` calls measures who got
 * past the compare-and-swap directly, in milliseconds rather than minutes.
 *
 * What they cannot measure is the other half of each claim, because in every
 * case the fake is standing exactly where the doubt is:
 *
 *   - M2-QA-02 asks for one CONTAINER, not one `createSession`. A losing racer
 *     that got as far as `docker create` before losing the CAS leaves a second
 *     container behind while the call count still reads 1.
 *   - M2-QA-03 asks for the same container id across an orchestrator RESTART.
 *     A fake resumes from its own memory, which the restart clears, so the
 *     assertion it supports is about the fake's map rather than about whether
 *     `sessionId` actually finds a container that outlived the process.
 *   - M2-QA-04 asks what happens after `docker kill`. A fake reports whatever
 *     the test told it to; the real question is whether `checkHealth`
 *     distinguishes a killed container from an unreachable daemon, and whether
 *     the recovery start RESUMES it rather than quietly building a fresh empty
 *     desktop (D-031).
 *
 * ── WHY ONE CONTAINER ACROSS THREE TESTS ────────────────────────────────────
 *
 * They run in order against one bot and one desktop, because that is also the
 * sequence being asserted: five racing starts produce it, a restart finds it,
 * a kill takes it away and the next start brings the SAME one back. Booting a
 * full XFCE desktop three times to avoid saying so would cost minutes and
 * assert less — the container id carried from test to test is itself the claim
 * M2-QA-03 and M2-QA-04 are making.
 *
 * @skip-reason: needs a Docker daemon, a built crewaid/sandbox image and a real
 * database; set CREWAID_DOCKER_TESTS=1 with DATABASE_URL to run (Natanael). Both
 * are declared in turbo.json globalEnv so Turbo's strict env mode cannot strip
 * a gate and turn this into a dormant guard (D-017).
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const DOCKER_TESTS = process.env['CREWAID_DOCKER_TESTS'];
const SKIP =
  DATABASE_URL === undefined ||
  DATABASE_URL === '' ||
  DOCKER_TESTS === undefined ||
  DOCKER_TESTS === '';

const USER_ID = 'usr_crewaid_singleton_v1';
const BOT_PREFIX = 'm2qa-docker';
/** One cold boot of a full XFCE desktop, plus room for a slow host. */
const BOOT_MS = 120_000;

const run = promisify(execFile);

/**
 * Every container carrying this bot's session label, running or not.
 *
 * `-a` rather than `ps` is the whole point for M2-QA-02: a duplicate that was
 * created and then abandoned is exactly the failure being looked for, and it
 * would not be running. `--no-trunc` because the persisted `containerId` is
 * the full 64-character id and the short form would need a prefix match.
 */
async function containersFor(sessionId: string): Promise<string[]> {
  const { stdout } = await run('docker', [
    'ps',
    '-aq',
    '--no-trunc',
    '--filter',
    `label=${SANDBOX_LABELS.sessionId}=${sessionId}`,
  ]);
  return stdout.trim() === '' ? [] : stdout.trim().split('\n');
}

async function isRunning(containerId: string): Promise<boolean> {
  const { stdout } = await run('docker', ['inspect', '-f', '{{.State.Running}}', containerId]);
  return stdout.trim() === 'true';
}

async function startedAt(containerId: string): Promise<string> {
  const { stdout } = await run('docker', ['inspect', '-f', '{{.State.StartedAt}}', containerId]);
  return stdout.trim();
}

describe.skipIf(SKIP)('M2-QA-02/03/04 sandbox lifecycle (real Docker, real db)', () => {
  let app: INestApplication;
  let botId: string;
  /** The one desktop this suite creates; carried across all three tests. */
  let containerId: string;
  let previousHealthInterval: string | undefined;

  /**
   * A whole orchestrator with the REAL provider — no `overrideProvider`, which
   * is the only difference from the fake-backed suites and the entire point.
   */
  const bootOrchestrator = async (): Promise<INestApplication> => {
    const { Test } = await import('@nestjs/testing');
    const moduleRef = await Test.createTestingModule({
      imports: [(await import('../src/sandbox/sandbox.module.js')).SandboxModule],
    }).compile();
    const created = moduleRef.createNestApplication();
    await created.init();
    return created;
  };

  const sandboxes = (): SandboxService => app.get(SandboxService);
  const prisma = (): PrismaService => app.get(PrismaService);
  const row = () => prisma().sandbox.findFirstOrThrow({ where: { bots: { some: { id: botId } } } });

  beforeAll(async () => {
    // The background poll is disabled so `sweep()` is driven by hand: these
    // tests take longer than one interval, and a timer firing between a kill
    // and its assertion would make the transition arrive from somewhere the
    // test cannot name. Restored in afterAll — process.env is shared across
    // files in this worker.
    previousHealthInterval = process.env['SANDBOX_HEALTH_INTERVAL_MS'];
    process.env['SANDBOX_HEALTH_INTERVAL_MS'] = '0';

    app = await bootOrchestrator();
    await prisma().user.upsert({
      where: { id: USER_ID },
      create: { id: USER_ID, name: 'Test User', email: `${USER_ID}@test.invalid` },
      update: {},
    });
    const bot = await privateComputerBot(prisma(), app.get(SANDBOX_PROVIDER), USER_ID, {
      name: `${BOT_PREFIX}-${randomUUID().slice(0, 8)}`,
      role: 'R',
      avatarColor: '#123456',
      systemPrompt: 'x',
    });
    botId = bot.id;
  }, BOOT_MS);

  afterAll(async () => {
    // A desktop left running outlives the test run and the database row that
    // named it, and every later health sweep would keep probing it.
    for (const id of await containersFor(botId).catch(() => [])) {
      await run('docker', ['rm', '-f', id]).catch(() => undefined);
    }
    // The bot's durable workspace (D-039) outlives its container by design, so
    // nothing in the product removes it and this suite has to. Deleting the
    // container first is required: Docker refuses to remove a volume that is
    // still attached to one, even a stopped one.
    await run('docker', ['volume', 'rm', '--force', `crewaid-workspace-${botId}`]).catch(
      () => undefined,
    );
    await prisma()
      .bot.deleteMany({ where: { userId: USER_ID, name: { startsWith: `${BOT_PREFIX}-` } } })
      .catch(() => undefined);
    await app?.close();
    if (previousHealthInterval === undefined) delete process.env['SANDBOX_HEALTH_INTERVAL_MS'];
    else process.env['SANDBOX_HEALTH_INTERVAL_MS'] = previousHealthInterval;
  }, BOOT_MS);

  it(
    'produces exactly one container for five simultaneous starts (M2-QA-02)',
    async () => {
      // §5's acceptance criterion, counted in DESKTOPS rather than in
      // `createSession` calls — which is the number the criterion names and the
      // only one an operator can see.
      //
      // Worth being precise about what this covers, because measuring it turned
      // up something the fake-backed suite cannot: FOUR independent fences have
      // to fail before a second container appears. Removing the row-count check
      // from the compare-and-swap is not enough (claim() also refuses on a
      // STARTING row it has read), and neither is removing the whole claim
      // (the provider looks the session up by label, and the container NAME is
      // derived from the session id, so Docker refuses the duplicate itself).
      // Only disabling the claim AND making the name non-deterministic produces
      // two desktops — verified by mutation.
      //
      // So this does not re-prove the lock; `sandbox-lifecycle.integration.test.ts`
      // does that, directly and in milliseconds. It proves the PRODUCT of the
      // four, against the daemon that enforces the last two, which is the only
      // place that combination exists.
      const results = await Promise.all(
        Array.from({ length: 5 }, () => sandboxes().start(USER_ID, botId)),
      );

      expect(results.every((result) => result.state === 'RUNNING')).toBe(true);

      const containers = await containersFor(botId);
      expect(containers).toHaveLength(1);
      containerId = containers[0] as string;
      expect(await isRunning(containerId)).toBe(true);

      // The row and the daemon name the same container. A start that created a
      // desktop it then failed to record is the shape of orphan M2-BE-12 has to
      // clean up later, and it would pass a count-only assertion.
      const persisted = await row();
      expect(persisted.containerId).toBe(containerId);
      expect(persisted.state).toBe('RUNNING');
      expect(persisted.sessionId).toBe(botId);
    },
    BOOT_MS,
  );

  it(
    'resumes the same container after an orchestrator restart (M2-QA-03)',
    async () => {
      expect(containerId).toBeTypeOf('string');

      // Container identity alone does not prove the desktop was unchanged: a
      // stop/start cycle keeps the same container id while replacing every
      // live process and open window. Docker's start timestamp changes on that
      // cycle, so preserving both values covers §5's separate "same container"
      // and "no restart of the desktop" requirements.
      const startedBeforeRestart = await startedAt(containerId);

      // A real restart, not a reset: the process-local caches, the Prisma
      // client and the provider's dockerode handle all go away, so the only
      // thing carrying the desktop across is `Sandbox.sessionId` in Postgres.
      await app.close();
      app = await bootOrchestrator();

      // `start()` alone would prove nothing here. The row is still RUNNING, so
      // §4.1 idempotence answers from the database and never reaches Docker —
      // a process that had lost the desktop entirely would return exactly this.
      // (Confirmed by mutation: an `acquire` that never reattaches still passes
      // an assertion built only on this call.)
      expect((await sandboxes().start(USER_ID, botId)).state).toBe('RUNNING');
      expect(await containersFor(botId)).toEqual([containerId]);

      // Something that must reach the daemon. The health poll in the NEW
      // process resolves the persisted sessionId to a container and probes its
      // bridge, so a RUNNING verdict here means the desktop was genuinely
      // re-found rather than merely remembered.
      await app.get(SandboxHealthService).sweep();
      expect((await row()).state).toBe('RUNNING');
      expect(await startedAt(containerId)).toBe(startedBeforeRestart);

      // And the resume path itself, end to end. `stop` attaches to the
      // inherited container; `start` resumes it. Both must land on the id the
      // previous process created — minting a fresh session here is what would
      // strand the bot's workspace under a name nothing looks for.
      expect((await sandboxes().stop(USER_ID, botId)).state).toBe('STOPPED');
      expect(await containersFor(botId)).toEqual([containerId]);
      expect(await isRunning(containerId)).toBe(false);

      expect((await sandboxes().start(USER_ID, botId)).state).toBe('RUNNING');
      expect(await containersFor(botId)).toEqual([containerId]);
      expect((await row()).containerId).toBe(containerId);
      expect(await isRunning(containerId)).toBe(true);
    },
    BOOT_MS,
  );

  it(
    'reports a killed desktop UNHEALTHY and starts it again (M2-QA-04)',
    async () => {
      expect(containerId).toBeTypeOf('string');
      const health = app.get(SandboxHealthService);

      await run('docker', ['kill', containerId]);
      expect(await isRunning(containerId)).toBe(false);

      await health.sweep();

      const killed = await row();
      expect(killed.state).toBe('UNHEALTHY');
      // The reason is the operator's only account of what happened — the §4.2
      // frame that announced the transition is long gone by the time anyone
      // opens the rail.
      expect(killed.lastError).toBeTruthy();
      // D-031: a desktop that stopped answering is a recoverable fault, never
      // STOPPED. STOPPED is a state an operator chose, and a later start would
      // paper over the failure by treating this as a first creation.
      expect(killed.state).not.toBe('STOPPED');

      const recovered = await sandboxes().start(USER_ID, botId);

      expect(recovered.state).toBe('RUNNING');
      expect(await isRunning(containerId)).toBe(true);
      // The SAME desktop, not a fresh empty one. This is the D-031 claim that
      // no fake can make: the workspace and the browser profile in that
      // container are the bot's, and a recovery that silently replaced them
      // would satisfy every other assertion here.
      expect(await containersFor(botId)).toEqual([containerId]);
      expect((await row()).containerId).toBe(containerId);
    },
    BOOT_MS,
  );
});
