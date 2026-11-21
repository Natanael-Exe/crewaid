import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { RecordingStatusResponse } from '@crewaid/shared';
import { SANDBOX_LABELS } from '@crewaid/sandbox-docker';

import { BotsService } from '../src/bots/bots.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SandboxService } from '../src/sandbox/sandbox.service.js';
import { RecordingsService } from '../src/recordings/recordings.service.js';
import { CdpAttachService } from '../src/recordings/cdp-attach.service.js';
import type { CdpConnection } from '../src/recordings/cdp-connection.js';
import { CAPTURE_BINDING_NAME } from '../src/recordings/cdp-capture-script.js';

/**
 * M4-BE-02 — the capture script against a REAL sandbox: real Docker, real
 * container, real Chrome, real clicks. (M4-BE-03 adds the selector ladder to
 * the same artifact; the second test below proves the candidates through a
 * real DOM.)
 *
 * ── WHY THIS EXISTS WHEN `cdp-capture.test.ts` ALREADY PASSES ───────────────
 *
 * The fake suite proves the sequence, the trust boundary and the teardown.
 * What no in-process test can prove is the thing this task is actually
 * about: THE EMITTED SOURCE RUNS IN A REAL PAGE. The first draft of the
 * script referenced a module constant, and a probe against this Chrome threw
 * `ReferenceError` at install time while every in-process call stayed green —
 * the serialized copy resolves names in the page, not in the module, and
 * only a page can say so. The same goes for `Page.enable` before the
 * registration (without it the registration is silently never delivered) and
 * for `runImmediately` on an already-loaded document. And for the selector
 * generator: it is composed into the same source as a serialized third
 * artifact, so only a real page can say the composition runs — and only a
 * real DOM can say the uniqueness flags are the ones a query actually
 * produced, rather than the ones a stand-in was told to report.
 *
 * So this suite drives the whole chain — attach → script → binding → parser →
 * tee → Postgres — and the assertions it makes are exactly the ones a fake
 * cannot: the sandbox's own browser reports the click, and the trace the
 * operator would see contains it. A second page opened mid-recording pins
 * the discovery half (M4-BE-02's "for the duration of a recording").
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
const BOT_PREFIX = 'm4be02cap';
/** One cold boot of a full XFCE desktop and a Chrome, plus room for a slow host. */
const BOOT_MS = 120_000;
/** How long an observable the capture must produce is given to appear. */
const ARM_MS = 30_000;

const run = promisify(execFile);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A page that is one big button at the viewport origin, so a click is a coordinate. */
function fixture(id: string): string {
  const html =
    '<!doctype html><html><body style="margin:0">' +
    `<button id="${id}" data-testid="go" style="position:fixed;left:0;top:0;width:120px;height:60px">Go</button>` +
    '</body></html>';
  return `data:text/html,${encodeURIComponent(html)}`;
}

/**
 * The M4-BE-03 fixture: every rung of the ladder, and every way a rung can be
 * shared. The `pay` button is at 30/30, the first duplicate-id div at 30/110,
 * the framework-named div at 30/210 — all fixed, so a click is a coordinate.
 */
function selectorFixture(): string {
  const tile = (style: string, inner: string): string => `<div ${style}>${inner}</div>`;
  const html =
    '<!doctype html><html><body style="margin:0">' +
    '<button id="pay" data-testid="pay-now" aria-label="Pay now" ' +
    'style="position:fixed;left:0;top:0;width:120px;height:60px">Pay now</button>' +
    tile('id="dup" style="position:fixed;left:0;top:100px;width:120px;height:40px"', 'a') +
    tile('id="dup" style="position:fixed;left:0;top:150px;width:120px;height:40px"', 'b') +
    tile('id=":r0:" style="position:fixed;left:0;top:200px;width:120px;height:40px"', 'dyn') +
    '</body></html>';
  return `data:text/html,${encodeURIComponent(html)}`;
}

/**
 * The M4-BE-06 fix-wave fixture: a click whose target lives INSIDE a shadow
 * root. The page retargets the event for every listener outside the shadow
 * tree, so the recorder must report the HOST — the one element a
 * document-level replay query can reach — rather than anything shadow-scoped.
 */
function shadowFixture(): string {
  const html =
    '<!doctype html><html><body style="margin:0">' +
    '<div id="hostA" style="position:fixed;left:0;top:0;width:120px;height:60px"></div>' +
    '<script>' +
    'const host = document.getElementById("hostA");' +
    'const shadow = host.attachShadow({ mode: "open" });' +
    'shadow.innerHTML = ' +
    '\'<button id="shadowid-btn" style="position:fixed;left:0;top:0;width:120px;height:60px">In shadow</button>\';' +
    'shadow.getElementById("shadowid-btn").addEventListener("click", function () {' +
    '  window.__innerClicks = (window.__innerClicks || 0) + 1;' +
    '});' +
    '</script>' +
    '</body></html>';
  return `data:text/html,${encodeURIComponent(html)}`;
}

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

describe.skipIf(SKIP)('M4-BE-02 capture script (real Docker, real Chrome)', () => {
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

  /** Ask the lifecycle for status until the trace shows `ready`; it also flushes the tee. */
  async function untilStatus(
    recordings: RecordingsService,
    recordingId: string,
    ready: (status: RecordingStatusResponse) => boolean,
    message: string,
  ): Promise<RecordingStatusResponse> {
    let latest: RecordingStatusResponse | null = null;
    await until(
      async () => {
        latest = await recordings.status(USER_ID, recordingId);
        return ready(latest);
      },
      ARM_MS,
      message,
    );
    if (latest === null) throw new Error('unreachable: until() resolves only after a status read');
    return latest;
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
    'installs the capture into the sandbox’s own browser and turns real clicks into CDP rows',
    async () => {
      // The recording's ensure-ready wakes this; starting it first keeps the
      // cold boot out of the arming window under test.
      await app.get(SandboxService).start(USER_ID, botId);

      const recordings = app.get(RecordingsService);
      const cdp = app.get(CdpAttachService);
      const prisma = app.get(PrismaService);
      const { recordingId } = await recordings.start(USER_ID, botId, {
        intent: 'click the button on the page',
      });

      const connection = await attached(cdp, recordingId);

      // The page the sandbox boots with is a real target the capture swept;
      // the test attaches its own session to drive it.
      const { targetInfos } = await connection.send('Target.getTargets');
      const pages = (targetInfos as Array<Record<string, unknown>>).filter(
        (info) => info['type'] === 'page',
      );
      expect(pages.length).toBeGreaterThanOrEqual(1);
      const page = pages[0]!;
      const { sessionId } = await connection.send('Target.attachToTarget', {
        targetId: page['targetId'],
        flatten: true,
      });
      const pageSession = String(sessionId);

      // One observable of arming: the binding the capture adds from ITS
      // session appears as a global in the page's main world.
      await until(
        async () =>
          (await evaluate(connection, pageSession, `typeof window.${CAPTURE_BINDING_NAME}`)) ===
          'function',
        ARM_MS,
        'the capture to install its binding into the sandbox page',
      );

      // A document the page had NOT loaded when the recording started: the
      // script that runs here is the one the registration was supposed to
      // carry across navigations.
      await connection.send('Page.navigate', { url: fixture('a') }, pageSession);
      await until(
        async () =>
          (await evaluate(connection, pageSession, 'typeof window.__crewaidCaptureTeardown')) ===
          'function',
        ARM_MS,
        'the capture script to run in the navigated document',
      );

      await clickIn(connection, pageSession, 30, 30);

      // Three CDP rows by now: the fixture navigation's `navigate` and `load`
      // (M4-BE-04 — the page was navigated by the step above) and the click
      // itself. All three, then the click is found BY TYPE: with navigation
      // rows in the trace, the first row is no longer the click's.
      const status = await untilStatus(
        recordings,
        recordingId,
        (current) => current.counts.cdp >= 3,
        'the fixture navigation and the click to reach the CDP layer of the trace',
      );
      expect(status.counts.cdp).toBeGreaterThanOrEqual(3);

      const rows = await prisma.recordingEvent.findMany({
        where: { recordingId, layer: 'CDP' },
        orderBy: { tsOffsetMs: 'asc' },
      });
      const clickRow = rows.find((row) => row.type === 'click');
      // The row is the parser's output, so this also proves what the page
      // actually sent survived the trust boundary intact.
      expect(clickRow?.payload).toMatchObject({
        id: 'a',
        testid: 'go',
        tag: 'button',
        text: 'Go',
        clientX: 30,
        clientY: 30,
        button: 0,
      });

      // ── a page that did not exist when the recording started ──────────────
      const created = await connection.send('Target.createTarget', { url: fixture('b') });
      const secondTarget = String(created['targetId']);
      const second = await connection.send('Target.attachToTarget', {
        targetId: secondTarget,
        flatten: true,
      });
      const secondSession = String(second['sessionId']);

      // The capture's discovery saw the new target and armed it; its script
      // follows into the document the target was created with.
      await until(
        async () =>
          (await evaluate(connection, secondSession, 'typeof window.__crewaidCaptureTeardown')) ===
          'function',
        ARM_MS,
        'the capture to arm a page created mid-recording',
      );
      await clickIn(connection, secondSession, 30, 30);

      // The click's own row, polled by value: whether the new target's
      // initial navigation was armed in time is a race, so no count on this
      // trace is a fixed number — only the row itself is evidence.
      await until(
        async () => {
          const so = await prisma.recordingEvent.findMany({
            where: { recordingId, layer: 'CDP' },
          });
          return so.some(
            (row) => row.type === 'click' && (row.payload as Record<string, unknown>)['id'] === 'b',
          );
        },
        ARM_MS,
        'the second click to reach the CDP layer of the trace',
      );
      const later = await prisma.recordingEvent.findMany({
        where: { recordingId, layer: 'CDP' },
        orderBy: { tsOffsetMs: 'asc' },
      });
      const secondRow = later.find((row) => (row.payload as Record<string, unknown>)['id'] === 'b');
      expect(secondRow).toBeDefined();
      expect(secondRow?.payload).toMatchObject({ testid: 'go', clientX: 30, clientY: 30 });

      // ── stop leaves nothing attached ──────────────────────────────────────
      const settled = await recordings.stop(USER_ID, recordingId);
      expect(settled.id).toBe(recordingId);
      expect(connection.closed).toBe(true);
      expect(await cdp.connectionFor(botId, recordingId)).toBeNull();
    },
    BOOT_MS,
  );

  it(
    'reports the selector ladder a real DOM answered, shared rungs and all (M4-BE-03)',
    async () => {
      const recordings = app.get(RecordingsService);
      const cdp = app.get(CdpAttachService);
      const prisma = app.get(PrismaService);
      const { recordingId } = await recordings.start(USER_ID, botId, {
        intent: 'click the button, then the shared tiles',
      });

      const connection = await attached(cdp, recordingId);

      // A fresh target, so the fixture document is one this recording armed
      // rather than whatever the previous test left open.
      const created = await connection.send('Target.createTarget', { url: 'about:blank' });
      const target = String(created['targetId']);
      const attachedTo = await connection.send('Target.attachToTarget', {
        targetId: target,
        flatten: true,
      });
      const pageSession = String(attachedTo['sessionId']);

      // Wait for the capture to have armed THIS target before navigating: the
      // binding appearing in the target's main world is that proof (the same
      // observable the M4-BE-02 test uses), and only once the registration is
      // in place does it carry the script into the document a navigation
      // creates. Navigating first would race the arm and the wait below would
      // hang on a document the script never reached.
      await until(
        async () =>
          (await evaluate(connection, pageSession, `typeof window.${CAPTURE_BINDING_NAME}`)) ===
          'function',
        ARM_MS,
        'the capture to arm the selector-fixture target',
      );

      // The navigation is what the registration is registered for: the script
      // (and the serialized generator inside it) must run in this document.
      await connection.send('Page.navigate', { url: selectorFixture() }, pageSession);
      await until(
        async () =>
          (await evaluate(connection, pageSession, 'typeof window.__crewaidCaptureTeardown')) ===
          'function',
        ARM_MS,
        'the capture script to run in the selector fixture document',
      );

      // Three real clicks: the fully-attributed button, the first of two
      // same-id divs, and the framework-named div.
      await clickIn(connection, pageSession, 30, 30);
      await clickIn(connection, pageSession, 30, 110);
      await clickIn(connection, pageSession, 30, 210);

      await untilStatus(
        recordings,
        recordingId,
        (current) => current.counts.cdp >= 3,
        'three clicks to reach the CDP layer of the trace',
      );

      const rows = await prisma.recordingEvent.findMany({
        where: { recordingId, layer: 'CDP' },
        orderBy: { tsOffsetMs: 'asc' },
      });
      const candidatesOf = (id: string): unknown => {
        const row = rows.find((entry) => (entry.payload as Record<string, unknown>)['id'] === id);
        expect(row, `no CDP row for #${id}`).toBeDefined();
        return (row!.payload as Record<string, unknown>)['candidates'];
      };

      // Every rung, in ladder order, with uniqueness as the REAL document
      // answered: `[data-testid]`, `#id`, `[aria-label]` (no role on the
      // element, so the label alone), the shortest unique path, and the
      // text — all unique in this fixture, so all true. This is the claim a
      // fake cannot make: had the generator not run in the page, the parser
      // would have stored a row without the field, and this would be
      // `undefined`.
      expect(candidatesOf('pay')).toEqual([
        { kind: 'testid', selector: '[data-testid="pay-now"]', unique: true },
        { kind: 'id', selector: '#pay', unique: true },
        { kind: 'aria', selector: '[aria-label="Pay now"]', unique: true },
        { kind: 'css', selector: 'button', unique: true },
        { kind: 'text', selector: 'text="Pay now"', unique: true },
      ]);

      // The shared id: the rung exists, flagged — and the path rung names
      // the first div among its same-tag siblings, which is this one.
      expect(candidatesOf('dup')).toEqual([
        { kind: 'id', selector: '#dup', unique: false },
        { kind: 'css', selector: 'div:nth-of-type(1)', unique: true },
        { kind: 'text', selector: 'text="a"', unique: true },
      ]);

      // A framework-generated id (`:r0:`) is not a CSS identifier: the rung
      // takes the attribute form, escaped, and still resolves.
      expect(candidatesOf(':r0:')).toEqual([
        { kind: 'id', selector: '[id=":r0:"]', unique: true },
        { kind: 'css', selector: 'div:nth-of-type(3)', unique: true },
        { kind: 'text', selector: 'text="dyn"', unique: true },
      ]);

      await recordings.stop(USER_ID, recordingId);
    },
    BOOT_MS,
  );

  it(
    'captures a shadow-root click as its host, whose candidates the replay resolver can execute (M4-BE-06 fix wave)',
    async () => {
      const recordings = app.get(RecordingsService);
      const cdp = app.get(CdpAttachService);
      const prisma = app.get(PrismaService);
      const { recordingId } = await recordings.start(USER_ID, botId, {
        intent: 'click the button inside the shadow tree',
      });

      const connection = await attached(cdp, recordingId);

      // A fresh target, so the fixture document is one this recording armed.
      const created = await connection.send('Target.createTarget', { url: 'about:blank' });
      const target = String(created['targetId']);
      const attachedTo = await connection.send('Target.attachToTarget', {
        targetId: target,
        flatten: true,
      });
      const pageSession = String(attachedTo['sessionId']);

      await until(
        async () =>
          (await evaluate(connection, pageSession, `typeof window.${CAPTURE_BINDING_NAME}`)) ===
          'function',
        ARM_MS,
        'the capture to arm the shadow-fixture target',
      );

      await connection.send('Page.navigate', { url: shadowFixture() }, pageSession);
      await until(
        async () =>
          (await evaluate(connection, pageSession, 'typeof window.__crewaidCaptureTeardown')) ===
          'function',
        ARM_MS,
        'the capture script to run in the shadow fixture document',
      );

      // The host sits at the viewport origin and the shadow button fills it,
      // so a click at (30, 30) hit-tests into the shadow tree.
      await clickIn(connection, pageSession, 30, 30);

      await until(
        async () => (await evaluate(connection, pageSession, 'window.__innerClicks')) === 1,
        ARM_MS,
        'the click to reach the shadow-internal button',
      );

      await untilStatus(
        recordings,
        recordingId,
        (current) => current.counts.cdp >= 1,
        'the shadow click to reach the CDP layer of the trace',
      );
      const rows = await prisma.recordingEvent.findMany({
        where: { recordingId, layer: 'CDP' },
        orderBy: { tsOffsetMs: 'asc' },
      });
      const clickRow = rows.find((row) => row.type === 'click');

      // The page's own listener saw the click inside the shadow tree; the
      // RECORDER saw the retargeted host — `#hostA`, the only name a
      // document-level query can reach — so no shadow-scoped rung can arise
      // from this path, and the host's plain-CSS rungs are ones the replay
      // resolver executes (the runtime matrix in the skill-runtime package
      // fences that side).
      expect(clickRow?.payload).toMatchObject({
        id: 'hostA',
        candidates: [
          { kind: 'id', selector: '#hostA', unique: true },
          { kind: 'css', selector: 'div', unique: true },
        ],
      });

      await recordings.stop(USER_ID, recordingId);
    },
    BOOT_MS,
  );
});
