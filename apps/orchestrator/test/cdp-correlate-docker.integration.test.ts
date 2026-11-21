import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { WebSocket } from 'ws';
import { SANDBOX_LABELS } from '@crewaid/sandbox-docker';

import { BotsService } from '../src/bots/bots.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SandboxService } from '../src/sandbox/sandbox.service.js';
import { RecordingsService } from '../src/recordings/recordings.service.js';
import { CdpAttachService } from '../src/recordings/cdp-attach.service.js';
import type { CdpConnection } from '../src/recordings/cdp-connection.js';
import { CAPTURE_BINDING_NAME } from '../src/recordings/cdp-capture-script.js';
import { ScreenService } from '../src/screen/screen.service.js';

/**
 * M4-BE-05 — the correlator against a REAL sandbox: real Docker, real
 * container, real Chrome, real RFB input.
 *
 * The synthetic suites prove the pairing logic (`click-correlator.test.ts`)
 * and the durable write behind the real stop path
 * (`click-correlator.integration.test.ts`). What neither can prove — because
 * only a real page in a real window has an answer — is the thing the pairing
 * is built on: that a click driven through the desktop arrives at the page
 * reporting the SAME desktop coordinates the X11 layer recorded. The probe
 * that settled the design (Chrome 152 in this image, dpr 1: an RFB
 * PointerEvent at framebuffer (x, y) is reported by the page as
 * `event.screenX === x, event.screenY === y`, exact at every position tried)
 * is what this suite fences, plus the two outcomes §6/M4 fixes: an in-window
 * pair correlates on both sides; an out-of-window one does not.
 *
 * ── WHAT IS CONTROLLED AND WHAT IS NOT ──────────────────────────────────────
 *
 * Input goes through the product's own path — `ScreenService.input`, the
 * §4.3 entry: the frame is teed and then forwarded to the sandbox's x11vnc —
 * and the page reports through the REAL capture script (M4-BE-02), so both
 * rows of every pair are produced by the machinery that produces them in
 * production. What the host does NOT control is latency: the report's arrival
 * is release + browser + relay, which on a loaded workstation has been
 * measured anywhere from ~60 ms to ~250 ms. So the fast clicks are driven
 * several times, every pair is asserted against the spec rule applied to its
 * OWN measured dt, and the suite fails if the host never managed to deliver a
 * single pair inside the window — with the last-ditch clause that if that
 * happens, the message says the environment, not the correlator, is why.
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
const BOT_PREFIX = 'm4be05cap';
/** One cold boot of a full XFCE desktop and a Chrome, plus room for a slow host. */
const BOOT_MS = 120_000;
/** How long an observable the capture must produce is given to appear. */
const ARM_MS = 30_000;

/** How many fast clicks are attempted before requiring one inside the window. */
const FAST_ATTEMPTS = 4;

const run = promisify(execFile);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A page big enough that any interior point is a click on it. */
function fixture(marker: string): string {
  const html =
    '<!doctype html><html><body style="margin:0;width:100vw;height:100vh;background:#eee">' +
    `<h1>${marker}</h1>` +
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

/** Enough of a §4.3 subscriber for the upstream to exist and stay open. */
class FakeClient extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  /** Binary frames the fan-out pushed; the first one proves the stream is up. */
  sends = 0;
  send(_data: Buffer, _o?: unknown, callback?: (error?: Error | null) => void): void {
    this.sends += 1;
    callback?.(null);
  }
  terminate(): void {
    this.readyState = 3;
  }
}

/** One RFB PointerEvent (RFC 6143 §7.5.5). */
function pointerEvent(mask: number, x: number, y: number): Uint8Array {
  const bytes = new Uint8Array(6);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 5);
  view.setUint8(1, mask);
  view.setUint16(2, x);
  view.setUint16(4, y);
  return bytes;
}

interface EventRow {
  readonly id: string;
  readonly tsOffsetMs: number;
  readonly layer: string;
  readonly type: string;
  readonly payload: unknown;
  readonly correlatedWithId: string | null;
}

describe.skipIf(SKIP)('M4-BE-05 click correlation (real Docker, real Chrome)', () => {
  let app: INestApplication;
  let botId: string;
  let connection: CdpConnection;
  let pageSession: string;

  async function evaluate(expression: string): Promise<unknown> {
    const result = await connection.send(
      'Runtime.evaluate',
      { expression, returnByValue: true },
      pageSession,
    );
    const value = (result['result'] as { value?: unknown } | undefined)?.value;
    return value;
  }

  /** One real click through Chrome's own input pipeline, at (x, y) viewport px. */
  async function clickInPage(x: number, y: number): Promise<void> {
    await connection.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 },
      pageSession,
    );
    await connection.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 },
      pageSession,
    );
  }

  beforeAll(async () => {
    const { Test } = await import('@nestjs/testing');
    const moduleRef = await Test.createTestingModule({
      // The real module graph with the REAL providers, ScreenModule included:
      // the §4.3 input entry is the path this suite drives.
      imports: [(await import('../src/screen/screen.module.js')).ScreenModule],
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
    'pairs real clicks across the layers, at the coordinates both layers recorded',
    async () => {
      await app.get(SandboxService).start(USER_ID, botId);

      const recordings = app.get(RecordingsService);
      const screens = app.get(ScreenService);
      const cdp = app.get(CdpAttachService);
      const prisma = app.get(PrismaService);

      const { recordingId } = await recordings.start(USER_ID, botId, {
        intent: 'click a couple of spots on the page',
      });

      const attachedConnection = await cdp.connectionFor(botId, recordingId);
      if (attachedConnection === null) {
        throw new Error(
          'the CDP attach never completed — see the CdpAttachService warning earlier in this run',
        );
      }
      connection = attachedConnection;

      // The page the sandbox boots with is a real target the capture swept;
      // the suite attaches its own session to drive it.
      const { targetInfos } = await connection.send('Target.getTargets');
      const pages = (targetInfos as Array<Record<string, unknown>>).filter(
        (info) => info['type'] === 'page',
      );
      expect(pages.length).toBeGreaterThanOrEqual(1);
      const page = pages[0]!;
      const attached = await connection.send('Target.attachToTarget', {
        targetId: page['targetId'],
        flatten: true,
      });
      pageSession = String(attached['sessionId']);

      // Three observables of arming, in the order they become true: the
      // binding in the boot document, then the capture script in a document
      // the page had NOT loaded when the recording started, then the
      // teardown marker in the fixture itself.
      await until(
        async () => (await evaluate(`typeof window.${CAPTURE_BINDING_NAME}`)) === 'function',
        ARM_MS,
        'the capture to install its binding into the sandbox page',
      );
      const marker = `m4be05-${randomUUID().slice(0, 8)}`;
      await connection.send('Page.navigate', { url: fixture(marker) }, pageSession);
      await until(
        async () =>
          (await evaluate('typeof window.__crewaidCaptureTeardown')) === 'function' &&
          (await evaluate('document.querySelector("h1")?.textContent ?? ""')) === marker,
        ARM_MS,
        'the capture script to run in the fixture document',
      );

      const viewport = JSON.parse(
        (await evaluate(
          'JSON.stringify({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })',
        )) as string,
      ) as { width: number; height: number; dpr: number };

      const rowsFor = (): Promise<EventRow[]> =>
        prisma.recordingEvent.findMany({
          where: { recordingId },
          orderBy: { tsOffsetMs: 'asc' },
        });

      // ── calibration, and the no-false-positive fence ─────────────────────
      //
      // A CDP-dispatched click with no X11 counterpart: the page reports it,
      // the trace holds it, and with no press it must stay uncorrelated. Its
      // payload also tells the suite where the viewport sits in framebuffer
      // pixels, so the RFB clicks below can be aimed at named page points.
      const calibrateX = Math.round(viewport.width / 4);
      const calibrateY = Math.round(viewport.height / 4);
      await clickInPage(calibrateX, calibrateY);
      await until(
        async () =>
          (await rowsFor()).some(
            (row) =>
              row.layer === 'CDP' &&
              (row.payload as Record<string, unknown>)['clientX'] === calibrateX,
          ),
        ARM_MS,
        'the calibration click to reach the CDP layer of the trace',
      );
      let rows = await rowsFor();
      const calibration = rows.find(
        (row) =>
          row.layer === 'CDP' && (row.payload as Record<string, unknown>)['clientX'] === calibrateX,
      )!;
      const calPayload = calibration.payload as Record<string, number>;
      const dpr = calPayload['dpr'] ?? viewport.dpr;
      // Desktop position of viewport (0, 0): the calibration clicked at
      // (calibrateX, calibrateY) and the page said it happened at screenX/screenY.
      const originX = calPayload['screenX']! - calibrateX * dpr;
      const originY = calPayload['screenY']! - calibrateY * dpr;

      // ── the real thing: RFB input through the product's own path ─────────
      const client = new FakeClient();
      await screens.subscribe(USER_ID, client as unknown as WebSocket, botId);
      // A frame arriving is the only proof the upstream is streaming: §4.2
      // does not acknowledge `screen.subscribe`, the RFB handshake finishes
      // after it resolves, and input is refused — not queued — until then.
      // (`screen-input-roundtrip.integration.test.ts` waits on the same
      // signal through a real socket; this suite watches its stand-in for the
      // same frame.)
      await until(async () => client.sends > 0, ARM_MS, 'the first §4.3 screen frame');
      const press = (x: number, y: number): void =>
        screens.input(client as unknown as WebSocket, botId, pointerEvent(1, x, y));
      const release = (x: number, y: number): void =>
        screens.input(client as unknown as WebSocket, botId, pointerEvent(0, x, y));

      const targetOf = (fx: number, fy: number): { x: number; y: number } => ({
        x: Math.round(originX + fx * viewport.width * dpr),
        y: Math.round(originY + fy * viewport.height * dpr),
      });

      interface Attempt {
        readonly point: { x: number; y: number };
        readonly holdMs: number;
      }
      // The fast clicks: short holds, several positions. The slow one is the
      // deterministic negative control — its report cannot arrive inside the
      // window because the button was held down longer than the window itself.
      const attempts: readonly Attempt[] = [
        { point: targetOf(0.33, 0.5), holdMs: 15 },
        { point: targetOf(0.5, 0.35), holdMs: 15 },
        { point: targetOf(0.62, 0.6), holdMs: 15 },
        { point: targetOf(0.45, 0.7), holdMs: 15 },
        { point: targetOf(0.72, 0.45), holdMs: 400 },
      ].slice(0, FAST_ATTEMPTS + 1);

      for (const attempt of attempts) {
        press(attempt.point.x, attempt.point.y);
        await sleep(attempt.holdMs);
        release(attempt.point.x, attempt.point.y);
        await sleep(150);
      }

      // Both rows of every attempt: the X11 press (from the RFB frame the
      // input path teed) and the CDP click (from the real capture script).
      const expected = attempts.length;
      await until(
        async () => {
          const current = await rowsFor();
          const presses = current.filter(
            (row) =>
              row.layer === 'X11' &&
              row.type === 'pointer' &&
              (row.payload as Record<string, unknown>)['buttonMask'] === 1,
          );
          const clicks = current.filter(
            (row) => row.layer === 'CDP' && row.type === 'click' && row.id !== calibration.id,
          );
          return presses.length >= expected && clicks.length >= expected;
        },
        ARM_MS,
        'every real click to reach both layers of the trace',
      );

      // The stop settles the trace and runs the correlator — nothing below
      // calls it directly; the lifecycle wiring is under test. (Its outcome
      // state is the queue's business and needs Redis; this suite does not.)
      const settled = await recordings.stop(USER_ID, recordingId);
      expect(settled.id).toBe(recordingId);

      rows = await rowsFor();
      const pressAt = (point: { x: number; y: number }): EventRow | undefined =>
        rows.find(
          (row) =>
            row.layer === 'X11' &&
            row.type === 'pointer' &&
            (row.payload as Record<string, unknown>)['buttonMask'] === 1 &&
            (row.payload as Record<string, unknown>)['x'] === point.x &&
            (row.payload as Record<string, unknown>)['y'] === point.y,
        );
      const clickAt = (point: { x: number; y: number }): EventRow | undefined =>
        rows.find(
          (row) =>
            row.layer === 'CDP' &&
            row.type === 'click' &&
            (row.payload as Record<string, unknown>)['screenX'] === point.x &&
            (row.payload as Record<string, unknown>)['screenY'] === point.y,
        );

      // ── the coordinate fence ──────────────────────────────────────────────
      //
      // The page reported WHERE the click happened, and it reported the same
      // desktop pixel the X11 row carries — the fact the whole pairing rests
      // on, and the one the capture script was changed to report (M4-BE-05).
      let inWindow = 0;
      for (const attempt of attempts) {
        const pressRow = pressAt(attempt.point);
        const clickRow = clickAt(attempt.point);
        expect(
          pressRow,
          `no X11 press row at (${attempt.point.x}, ${attempt.point.y})`,
        ).toBeDefined();
        expect(
          clickRow,
          `no CDP click row at (${attempt.point.x}, ${attempt.point.y})`,
        ).toBeDefined();

        const dt = clickRow!.tsOffsetMs - pressRow!.tsOffsetMs;
        const where = `(${attempt.point.x}, ${attempt.point.y})`;
        if (dt >= 0 && dt <= 150) {
          inWindow += 1;
          console.log(`M4-BE-05 docker: pair at ${where} dt=${dt}ms -> correlated`);
          // In the window and at the same coordinates: §6/M4 says one action,
          // and one action means BOTH rows name the other.
          expect(
            { dt, x11: pressRow!.correlatedWithId, cdp: clickRow!.correlatedWithId },
            `pair at ${where} inside the window must correlate`,
          ).toMatchObject({ x11: clickRow!.id, cdp: pressRow!.id });
        } else {
          console.log(`M4-BE-05 docker: pair at ${where} dt=${dt}ms -> left uncorrelated`);
          // Outside it (the slow control, or a loaded host): not one action —
          // the rows stay as captured, and nothing pairs them post hoc.
          expect(pressRow!.correlatedWithId, `dt=${dt} is outside the window`).toBeNull();
          expect(clickRow!.correlatedWithId, `dt=${dt} is outside the window`).toBeNull();
        }
      }

      // The calibration click has no press behind it; nothing may have paired
      // it, then or during the correlator's pass.
      const calibrationAfter = rows.find((row) => row.id === calibration.id)!;
      expect(calibrationAfter.correlatedWithId).toBeNull();

      // At least one click inside the window is the point of the suite: the
      // positive correlation is asserted above only when one occurs, so the
      // suite demands the host delivered one rather than passing vacuously.
      expect(
        inWindow,
        'the host never delivered a single click inside the 150 ms window — this is the ' +
          'environment (container latency under load), not the correlator; re-run when the ' +
          'machine is quiet',
      ).toBeGreaterThan(0);
    },
    BOOT_MS,
  );
});
