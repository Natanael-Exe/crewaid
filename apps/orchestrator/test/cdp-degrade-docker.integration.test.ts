import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { SANDBOX_LABELS } from '@crewaid/sandbox-docker';

import { BotsService } from '../src/bots/bots.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SandboxService } from '../src/sandbox/sandbox.service.js';
import { RecordingsService } from '../src/recordings/recordings.service.js';
import { RecordingTeeService } from '../src/recordings/recording-tee.service.js';
import { CdpAttachService } from '../src/recordings/cdp-attach.service.js';
import type { CdpConnection } from '../src/recordings/cdp-connection.js';

/**
 * M4-BE-07 — the degradation against a REAL sandbox: an attach that works,
 * and a browser that dies mid-recording.
 *
 * ── WHY THIS EXISTS WHEN `cdp-degrade.integration.test.ts` ALREADY PASSES ───
 *
 * That suite drives the attach-FAILURE path — no browser behind the endpoint
 * — with real modules and a real database. What it cannot produce is the
 * other moment §6/M4 names: a recording whose CDP connection was live,
 * carrying rows, and then went away because Chrome did. The fake has no
 * browser to kill. So this suite boots a real container from `SANDBOX_IMAGE`,
 * lets the real attach succeed, navigates a real page so the trace holds
 * real CDP rows, kills Chrome inside the container — which §5's supervisor
 * contract turns into a dead container — and asserts what the row records
 * and what the X11 layer does next.
 *
 * The X11-after-the-drop half is driven through `RecordingTeeService.tee`,
 * the synchronous seam the §4.3 input path calls: the desktop died with its
 * container, so nothing else CAN arrive over the wire, and what must be true
 * is that the recording's X11 side is still accepting and flushing rows.
 * The full WS leg has its own suites (M2-QA-05, M3-QA-06).
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
const BOT_PREFIX = 'm4be07drop';
/** One cold boot of a full XFCE desktop and a Chrome, plus room for a slow host. */
const BOOT_MS = 120_000;
/** How long an observable this suite causes is given to appear. */
const OBSERVE_MS = 30_000;

const run = promisify(execFile);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A page's own document, as a URL the sandbox can load without a network. */
function fixture(body: string): string {
  return `data:text/html,${encodeURIComponent(body)}`;
}

const FIXTURE = fixture('<!doctype html><html><body><button id="go">Go</button></body></html>');

/** Every container carrying a session's label, running or not. */
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

/** Retry until `condition` holds; the failure message names what never appeared. */
async function until(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting until ${message}`);
    await sleep(200);
  }
}

describe.skipIf(SKIP)('M4-BE-07 Chrome dies mid-recording (real Docker, real Chrome)', () => {
  let app: INestApplication;
  let botId: string;
  let sessionId: string | null = null;

  /** Evaluate one expression in a page's main world and return its value. */
  async function evaluate(
    connection: CdpConnection,
    pageSession: string,
    expression: string,
  ): Promise<unknown> {
    const result = await connection.send(
      'Runtime.evaluate',
      { expression, returnByValue: true },
      pageSession,
    );
    const value = (result['result'] as { value?: unknown } | undefined)?.value;
    return value;
  }

  beforeAll(async () => {
    const { Test } = await import('@nestjs/testing');
    const moduleRef = await Test.createTestingModule({
      // The real module graph with the REAL providers: the whole point is
      // that nothing between the lifecycle and Chrome is substituted.
      imports: [(await import('../src/recordings/recordings.module.js')).RecordingsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const prisma = app.get(PrismaService);
    await prisma.user.upsert({
      where: { id: USER_ID },
      create: { id: USER_ID, name: 'Test User', email: `${USER_ID}@test.invalid` },
      update: {},
    });
    const bot = await app.get(BotsService).create(USER_ID, {
      name: `${BOT_PREFIX}-${randomUUID().slice(0, 8)}`,
      role: 'R',
      avatarColor: '#123456',
      systemPrompt: 'x',
    });
    botId = bot.id;
  }, BOOT_MS);

  afterAll(async () => {
    const sandbox =
      sessionId ??
      (
        await app
          ?.get(PrismaService)
          .sandbox.findFirst({
            where: { bots: { some: { id: botId } } },
            select: { sessionId: true },
          })
          .catch(() => null)
      )?.sessionId ??
      botId;
    for (const id of await containersFor(sandbox).catch(() => [])) {
      await run('docker', ['rm', '-f', id]).catch(() => undefined);
    }
    await run('docker', ['volume', 'rm', '--force', `crewaid-workspace-${botId}`]).catch(
      () => undefined,
    );
    await app
      ?.get(PrismaService)
      .bot.deleteMany({ where: { id: botId } })
      .catch(() => undefined);
    await app?.close();
  }, BOOT_MS);

  it(
    'records the degradation when Chrome dies, and the recording continues over X11',
    async () => {
      const prisma = app.get(PrismaService);
      const recordings = app.get(RecordingsService);
      const tee = app.get(RecordingTeeService);
      const cdp = app.get(CdpAttachService);
      const record = (id: string) =>
        prisma.recording.findUniqueOrThrow({
          where: { id },
          select: { state: true, cdpAvailable: true, warning: true, error: true, endedAt: true },
        });

      // The recording's ensure-ready wakes this; starting it first keeps the
      // cold boot out of the window under test.
      await app.get(SandboxService).start(USER_ID, botId);
      sessionId =
        (
          await prisma.sandbox.findFirstOrThrow({
            where: { bots: { some: { id: botId } } },
            select: { sessionId: true },
          })
        ).sessionId ?? botId;

      const { recordingId } = await recordings.start(USER_ID, botId, {
        intent: 'degrade when the browser dies',
      });

      // ── a live CDP capture, before anything is killed ────────────────────
      let connection: CdpConnection | null = null;
      await until(
        async () => {
          connection = await cdp.connectionFor(botId, recordingId);
          return connection !== null;
        },
        OBSERVE_MS,
        'the CDP attach to land',
      );
      // At this point the row still claims CDP: it dropped nothing yet.
      expect((await record(recordingId)).cdpAvailable).toBe(true);

      const { targetInfos } = await connection!.send('Target.getTargets');
      const pages = (targetInfos as Array<Record<string, unknown>>).filter(
        (info) => info['type'] === 'page',
      );
      expect(pages.length).toBeGreaterThanOrEqual(1);
      const { sessionId: pageTarget } = await connection!.send('Target.attachToTarget', {
        targetId: pages[0]!['targetId'],
        flatten: true,
      });
      const pageSession = String(pageTarget);
      // The capture script's teardown global proves the arm sequence has run
      // on this page — the CDP rows below are the capture's, not a probe's.
      await until(
        async () =>
          (await evaluate(connection!, pageSession, 'typeof window.__crewaidCaptureTeardown')) ===
          'function',
        OBSERVE_MS,
        'the capture to arm the sandbox page',
      );
      await connection!.send('Page.navigate', { url: FIXTURE }, pageSession);
      await until(
        async () =>
          (await prisma.recordingEvent.findMany({ where: { recordingId, layer: 'CDP' } })).some(
            (row) => row.type === 'navigate',
          ),
        OBSERVE_MS,
        'the navigation to reach the CDP layer of the trace',
      );

      // ── Chrome dies (and §5's supervisor takes the container with it) ────
      const containers = await containersFor(sessionId);
      expect(containers.length).toBeGreaterThanOrEqual(1);
      await run('docker', ['exec', containers[0]!, 'pkill', '-f', 'google-chrome']);

      await until(
        async () => (await record(recordingId)).cdpAvailable === false,
        OBSERVE_MS,
        'the row to record cdpAvailable=false',
      );

      // The degradation is a mode, not a failure: recording continues, no
      // warning, no error, not settled — and the connection is gone.
      expect(await record(recordingId)).toMatchObject({
        state: 'RECORDING',
        cdpAvailable: false,
        warning: null,
        error: null,
        endedAt: null,
      });
      expect(await cdp.connectionFor(botId, recordingId)).toBeNull();

      // ── the X11 half keeps capturing ─────────────────────────────────────
      // The synchronous seam the §4.3 input path calls; the desktop itself
      // died with its container, so this is the only arrival possible.
      tee.tee(botId, { kind: 'pointer', x: 400, y: 300, buttonMask: 1 });
      tee.tee(botId, { kind: 'pointer', x: 410, y: 310, buttonMask: 0 });
      await until(
        async () => {
          const status = await recordings.status(USER_ID, recordingId);
          return status.counts.x11 === 2;
        },
        OBSERVE_MS,
        'the X11 rows to flush',
      );
      const status = await recordings.status(USER_ID, recordingId);
      expect(status).toMatchObject({
        state: 'RECORDING',
        cdpAvailable: false,
        warning: null,
        error: null,
        counts: { x11: 2 },
      });
      expect(status.counts.cdp).toBeGreaterThanOrEqual(1);

      // ── and the recording settles through the normal stop path ──────────
      const settled = await recordings.stop(USER_ID, recordingId);
      expect(settled.id).toBe(recordingId);
      expect(settled.cdpAvailable).toBe(false);
      expect(await cdp.connectionFor(botId, recordingId)).toBeNull();
      expect((await record(recordingId)).endedAt).not.toBeNull();
    },
    BOOT_MS * 2,
  );
});
