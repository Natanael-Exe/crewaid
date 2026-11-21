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
import { CdpAttachService } from '../src/recordings/cdp-attach.service.js';
import type { CdpConnection } from '../src/recordings/cdp-connection.js';

/**
 * M4-BE-04 — the navigation rows against a REAL sandbox: real Docker, real
 * container, real Chrome, real navigations.
 *
 * ── WHY THIS EXISTS WHEN `cdp-nav-events.test.ts` ALREADY PASSES ────────────
 *
 * The unit suite pins the judgement — main frame or not, document or not,
 * which request pairs with which completion — against shapes the probe
 * observed. What no in-process test can prove is that those shapes are what
 * the sandbox's Chrome actually sends through the capture's OWN session, and
 * that the rows land in Postgres in the order the operator lived them: the
 * probe that established the shapes ran its own attach sequence, and only a
 * live run of the real module graph says the service's sequence sees the same
 * events (one commit per attached session, the document completing after its
 * commit, a subframe quietly excluded, a tab armed mid-recording capturing
 * its later navigations).
 *
 * So this suite drives the whole chain — attach → arm (M4-BE-02) →
 * `frameNavigated`/`requestWillBeSent`/`loadingFinished` → parser → tee →
 * Postgres — and asserts the trace the operator would see: a `navigate` row
 * per main-frame document, a `load` row when that document finishes, an
 * iframe's document in neither, and the whole sequence interleaved with an
 * interaction row on one strictly-increasing offset chain.
 *
 * The fixtures are data: URLs on purpose (same reason as M4-BE-02's suite):
 * they need no network, and the probe verified a data: document moves
 * through the Network domain exactly like an http one.
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
const BOT_PREFIX = 'm4be04nav';
/** One cold boot of a full XFCE desktop and a Chrome, plus room for a slow host. */
const BOOT_MS = 120_000;
/** How long an observable the capture must produce is given to appear. */
const ARM_MS = 30_000;

const run = promisify(execFile);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A page's own document, as a URL the sandbox can load without a network. */
function fixture(body: string): string {
  return `data:text/html,${encodeURIComponent(body)}`;
}

const FIXTURE_A = fixture(
  '<!doctype html><html><body><button id="go" data-testid="go">Go</button></body></html>',
);
/** A page whose subframe loads a document of its own — the exclusion case. */
const IFRAME_URL = 'data:text/html,CREWAID-IFRAME-MARKER';
const FIXTURE_B = fixture(
  `<!doctype html><html><body><iframe src="${IFRAME_URL}"></iframe></body></html>`,
);
const FIXTURE_C = fixture('<!doctype html><html><body><p>Third page</p></body></html>');

/** Every container carrying this bot's session label, running or not. */
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

describe.skipIf(SKIP)('M4-BE-04 navigation rows (real Docker, real Chrome)', () => {
  let app: INestApplication;
  let botId: string;

  /** A completed attach, or a failure whose reason is in the log above it. */
  async function attached(cdp: CdpAttachService, recordingId: string): Promise<CdpConnection> {
    const connection = await cdp.connectionFor(botId, recordingId);
    if (connection === null) {
      throw new Error(
        'the CDP attach never completed — see the CdpAttachService warning earlier in this run',
      );
    }
    return connection;
  }

  /** Evaluate one expression in a page's main world and return its value. */
  async function evaluate(
    connection: CdpConnection,
    sessionId: string,
    expression: string,
  ): Promise<unknown> {
    const result = await connection.send(
      'Runtime.evaluate',
      { expression, returnByValue: true },
      sessionId,
    );
    const value = (result['result'] as { value?: unknown } | undefined)?.value;
    return value;
  }

  /** One real click through Chrome's own input pipeline, at (x, y). */
  async function clickIn(
    connection: CdpConnection,
    sessionId: string,
    x: number,
    y: number,
  ): Promise<void> {
    await connection.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 },
      sessionId,
    );
    await connection.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 },
      sessionId,
    );
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
    for (const id of await containersFor(botId).catch(() => [])) {
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
    'records main-frame navigations and load completions, in order, around an interaction',
    async () => {
      const prisma = app.get(PrismaService);
      const recordings = app.get(RecordingsService);
      const cdp = app.get(CdpAttachService);

      // The recording's ensure-ready wakes this; starting it first keeps the
      // cold boot out of the arming window under test.
      await app.get(SandboxService).start(USER_ID, botId);
      const { recordingId } = await recordings.start(USER_ID, botId, {
        intent: 'navigate and click',
      });

      const connection = await attached(cdp, recordingId);
      const { targetInfos } = await connection.send('Target.getTargets');
      const pages = (targetInfos as Array<Record<string, unknown>>).filter(
        (info) => info['type'] === 'page',
      );
      expect(pages.length).toBeGreaterThanOrEqual(1);
      const { sessionId } = await connection.send('Target.attachToTarget', {
        targetId: pages[0]!['targetId'],
        flatten: true,
      });
      const pageSession = String(sessionId);

      // The capture script's teardown global proves the whole arm sequence —
      // which ends with the script registration — has run on this page.
      await until(
        async () =>
          (await evaluate(connection, pageSession, 'typeof window.__crewaidCaptureTeardown')) ===
          'function',
        ARM_MS,
        'the capture to arm the sandbox page',
      );

      /** The CDP rows so far, in trace order. */
      const rowsOf = () =>
        prisma.recordingEvent.findMany({
          where: { recordingId, layer: 'CDP' },
          orderBy: { tsOffsetMs: 'asc' },
        });
      const urlOf = (row: { payload: unknown }): string => {
        const url = (row.payload as Record<string, unknown>)['url'];
        return typeof url === 'string' ? url : '';
      };
      /** Wait for one row the operator's flow must produce. */
      const untilRow = (
        ready: (rows: Awaited<ReturnType<typeof rowsOf>>) => boolean,
        what: string,
      ) => until(async () => ready(await rowsOf()), ARM_MS, what);

      // ── page A: a navigation, then a click under its completed load ──────
      await connection.send('Page.navigate', { url: FIXTURE_A }, pageSession);
      await untilRow(
        (rows) => rows.some((row) => row.type === 'load' && urlOf(row) === FIXTURE_A),
        'the load row for the first navigation',
      );
      await clickIn(connection, pageSession, 30, 30);
      await untilRow(
        (rows) => rows.some((row) => row.type === 'click'),
        'the click to reach the CDP layer of the trace',
      );

      // ── page B: a navigation whose subframe loads a document of its own ──
      await connection.send('Page.navigate', { url: FIXTURE_B }, pageSession);
      await untilRow(
        (rows) => rows.some((row) => row.type === 'load' && urlOf(row) === FIXTURE_B),
        'the load row for the iframe-host page',
      );
      // The subframe's document had time to load with its host; give the
      // exclusion a beat to be wrong before asserting it was not.
      await sleep(1_000);

      // ── page C: a tab that did not exist when the recording started ──────
      // Created empty (about:blank): the tab's own first load commits at
      // creation time, which races the arming, so the navigation this test
      // judges is the NEXT one — deterministic by construction.
      const created = await connection.send('Target.createTarget', { url: 'about:blank' });
      const thirdSession = await connection.send('Target.attachToTarget', {
        targetId: String(created['targetId']),
        flatten: true,
      });
      const third = String(thirdSession['sessionId']);
      await until(
        async () =>
          (await evaluate(connection, third, 'typeof window.__crewaidCaptureTeardown')) ===
          'function',
        ARM_MS,
        'the capture to arm the page created mid-recording',
      );
      await connection.send('Page.navigate', { url: FIXTURE_C }, third);
      await untilRow(
        (rows) => rows.some((row) => row.type === 'load' && urlOf(row) === FIXTURE_C),
        'the load row for the page created mid-recording',
      );

      // ── what the trace holds ─────────────────────────────────────────────
      const status = await recordings.status(USER_ID, recordingId);
      const rows = await rowsOf();

      // Exactly one navigate and one load per main-frame document, in the
      // order the operator caused them...
      const dataUrls = (type: string): string[] =>
        rows
          .filter((row) => row.type === type)
          .map((row) => urlOf(row))
          .filter((url) => url.startsWith('data:text/html,'));
      expect(dataUrls('navigate')).toEqual([FIXTURE_A, FIXTURE_B, FIXTURE_C]);
      expect(dataUrls('load')).toEqual([FIXTURE_A, FIXTURE_B, FIXTURE_C]);

      // ...and the subframe's document is in neither: an iframe is not a
      // page wait condition (M4-BE-04's filter, on a real subframe).
      expect(rows.some((row) => urlOf(row) === IFRAME_URL)).toBe(false);

      // ── the one offset chain ─────────────────────────────────────────────
      // Every row is a position in one recording: the click must sit between
      // A's completed load and B's commit, and each load after its own
      // commit. This is the ordering the compiler reads the trace by.
      const at = (predicate: (row: (typeof rows)[number]) => boolean): number =>
        rows.findIndex(predicate);
      const navA = at((row) => row.type === 'navigate' && urlOf(row) === FIXTURE_A);
      const loadA = at((row) => row.type === 'load' && urlOf(row) === FIXTURE_A);
      const click = at((row) => row.type === 'click');
      const navB = at((row) => row.type === 'navigate' && urlOf(row) === FIXTURE_B);
      const loadB = at((row) => row.type === 'load' && urlOf(row) === FIXTURE_B);
      const navC = at((row) => row.type === 'navigate' && urlOf(row) === FIXTURE_C);
      const loadC = at((row) => row.type === 'load' && urlOf(row) === FIXTURE_C);
      expect([navA, loadA, click, navB, loadB, navC, loadC].every((index) => index >= 0)).toBe(
        true,
      );
      expect(navA).toBeLessThan(loadA);
      expect(loadA).toBeLessThan(click);
      expect(click).toBeLessThan(navB);
      expect(navB).toBeLessThan(loadB);
      expect(loadB).toBeLessThan(navC);
      expect(navC).toBeLessThan(loadC);

      // Nothing was appended and lost: every CDP row the tee counted is on
      // disk, so the trace above is the whole trace.
      expect(status.counts.cdp).toBe(rows.length);

      // ── stop leaves nothing attached ─────────────────────────────────────
      const settled = await recordings.stop(USER_ID, recordingId);
      expect(settled.id).toBe(recordingId);
      expect(connection.closed).toBe(true);
      expect(await cdp.connectionFor(botId, recordingId)).toBeNull();
    },
    BOOT_MS,
  );
});
