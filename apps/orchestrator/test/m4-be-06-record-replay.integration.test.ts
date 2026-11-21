import { SeatControlService } from '../src/screen/seat-control.service.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from './model-resolution-fake.js';
import { ModelResolutionService } from '../src/models/model-resolution.service.js';
import { resolvedTextModelOf } from './model-resolution-fake.js';
import { SkillCompileService } from '../src/skills/skill-compile.service.js';
import { SKILL_COMPILE_QUEUE } from '../src/skills/skill-compile.queue.js';
import { SkillsService } from '../src/skills/skills.service.js';
import { SkillRunService } from '../src/skills/skill-run.service.js';
import { AgentBrowserService } from '../src/agent/agent-browser.service.js';
import type { INestApplication } from '@nestjs/common';
import type { WebSocket } from 'ws';
import { SANDBOX_PORTS } from '@crewaid/sandbox-core';
import { SANDBOX_LABELS } from '@crewaid/sandbox-docker';

import { BotsService } from '../src/bots/bots.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SandboxService } from '../src/sandbox/sandbox.service.js';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../src/sandbox/sandbox.provider.js';
import { RecordingsService } from '../src/recordings/recordings.service.js';
import { CdpAttachService } from '../src/recordings/cdp-attach.service.js';
import type { CdpConnection } from '../src/recordings/cdp-connection.js';
import {
  CAPTURE_BINDING_NAME,
  CAPTURE_DECLINED_KEY,
} from '../src/recordings/cdp-capture-script.js';
import { ScreenService } from '../src/screen/screen.service.js';
import {
  constrainToResolver,
  foldCorrelated,
  renderTrace,
  type TraceRow,
} from '../src/skills/compile-input.js';

/**
 * A fresh real Docker/Chrome/RFB recording keeps main-frame selector evidence
 * and the iframe's demonstrated coordinate fallback. Actual persisted rows are
 * compiled by the real service with a scripted model, reviewed and published,
 * then replayed through the private-seat runner. Draft/foreign publication and
 * replay during human control are refused. Native runtime tests additionally
 * exercise explicit frame locators, popups, strict actionability and cancellation.
 *
 * @skip-reason: real Docker, current SANDBOX_IMAGE and Postgres; enable
 * CREWAID_DOCKER_TESTS=1 with DATABASE_URL. Model calls remain scripted.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const DOCKER_TESTS = process.env['CREWAID_DOCKER_TESTS'];
const SKIP =
  DATABASE_URL === undefined ||
  DATABASE_URL === '' ||
  DOCKER_TESTS === undefined ||
  DOCKER_TESTS === '';

const USER_ID = `mod-br04-${randomUUID()}`;
const BOT_PREFIX = 'm4be06rr';
/** One cold boot of a full XFCE desktop and a Chrome, plus room for a slow host. */
const BOOT_MS = 120_000;
/** How long an observable the capture must produce is given to appear. */
const ARM_MS = 30_000;
/** The whole test, including three bounded bridge runs. */
const TEST_MS = 240_000;

const run = promisify(execFile);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The record-side fixture: a main-frame button (`#outer`, at 20/20) and an
 * iframe (at 220/220) whose srcdoc holds a button (`#inner`). Both buttons
 * count their own clicks on the PARENT window — the srcdoc document is
 * same-origin, so the in-frame button can reach out and say it was clicked,
 * which is how the suite knows a click really landed inside the frame.
 */
function fixture(): string {
  const inner =
    "<!doctype html><html><body style='margin:0'>" +
    "<button id='inner' style='position:fixed;left:30px;top:30px;width:200px;height:70px'>Inner</button>" +
    "<script>document.getElementById('inner').addEventListener('click', function () { parent.__clicks.inner += 1; });</script>" +
    '</body></html>';
  const html =
    "<!doctype html><html><body style='margin:0'>" +
    "<button id='outer' data-testid='outer' style='position:fixed;left:20px;top:20px;width:160px;height:60px'>Outer</button>" +
    "<iframe id='frame' style='position:fixed;left:220px;top:220px;width:420px;height:300px;border:0' srcdoc=\"" +
    inner +
    '"></iframe>' +
    '<script>window.__clicks = { outer: 0, inner: 0 };' +
    "document.getElementById('outer').addEventListener('click', function () { window.__clicks.outer += 1; });" +
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

/** Enough of a §4.3 subscriber for the upstream to exist and stay open. */
class FakeClient extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  /** Binary frames the fan-out pushed; the first one proves the stream is up. */
  sends = 0;
  send(data: Buffer | string, _o?: unknown, callback?: (error?: Error | null) => void): void {
    if (typeof data !== 'string') this.sends += 1;
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
  readonly screenshotKey: string | null;
  readonly correlatedWithId: string | null;
}

/** One skill run's outcome, as the bridge answers it (D-040's shape). */
interface BridgeOutcome {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly logs?: readonly string[];
  readonly detail?: string;
  readonly code?: string;
}

describe.skipIf(SKIP)(
  'M4-BE-06 record → replay compatibility fence (real Docker, real Chrome)',
  () => {
    let app: INestApplication;
    let botId: string;

    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const moduleRef = await Test.createTestingModule({
        // The real module graph with the REAL providers, ScreenModule included:
        // the §4.3 input entry is the path this suite drives.
        imports: [(await import('../src/screen/screen.module.js')).ScreenModule],
      })
        .overrideProvider(SKILL_COMPILE_QUEUE)
        .useValue({ enqueue: () => Promise.resolve() })
        .compile();
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
      // The fixture desktop starts from a known observation.
      app.get(SeatControlService).seats.observed(botId);
    }, BOOT_MS);

    afterAll(async () => {
      const computer = await app?.get(PrismaService).sandbox.findFirst({
        where: { bots: { some: { id: botId } }, userId: USER_ID },
        select: { id: true, sessionId: true },
      });
      for (const id of await containersFor(computer?.sessionId ?? botId).catch(() => [])) {
        await run('docker', ['rm', '-f', id]).catch(() => undefined);
      }
      await run('docker', [
        'volume',
        'rm',
        '--force',
        `crewaid-workspace-${computer?.id ?? botId}`,
      ]).catch(() => undefined);
      await app
        ?.get(PrismaService)
        .bot.deleteMany({ where: { id: botId } })
        .catch(() => undefined);
      await app?.close();
    }, BOOT_MS);

    it(
      'keeps a subframe click X11-only through compile, and replays both emitted forms on the sandbox',
      async () => {
        await app.get(SandboxService).start(USER_ID, botId);
        // The person demonstrates an already open browser. Recording itself
        // deliberately never starts Chrome or creates a seat.
        const demonstrated = await app.get(AgentBrowserService).connect(botId);
        await demonstrated.close();

        const recordings = app.get(RecordingsService);
        const screens = app.get(ScreenService);
        const cdp = app.get(CdpAttachService);
        const prisma = app.get(PrismaService);
        const provider = app.get<SandboxProvider>(SANDBOX_PROVIDER);

        const { recordingId } = await recordings.start(USER_ID, botId, {
          intent: 'click the outer button and the inner one',
        });

        const connection = await cdp.connectionFor(botId, recordingId);
        if (connection === null) {
          throw new Error(
            'the CDP attach never completed — see the CdpAttachService warning earlier in this run',
          );
        }

        /** Evaluate one expression in the driven page's main world. */
        const evaluate = async (expression: string): Promise<unknown> => {
          const result = await connection.send(
            'Runtime.evaluate',
            { expression, returnByValue: true },
            pageSession,
          );
          return (result['result'] as { value?: unknown } | undefined)?.value;
        };

        // The page the sandbox boots with is a real target the capture swept;
        // the suite attaches its own session to drive it.
        const { targetInfos } = await connection.send('Target.getTargets');
        const pages = (targetInfos as Array<Record<string, unknown>>).filter(
          (info) => info['type'] === 'page',
        );
        expect(pages.length).toBeGreaterThanOrEqual(1);
        const attached = await connection.send('Target.attachToTarget', {
          targetId: pages[0]!['targetId'],
          flatten: true,
        });
        const pageSession = String(attached['sessionId']);

        await until(
          async () => (await evaluate(`typeof window.${CAPTURE_BINDING_NAME}`)) === 'function',
          ARM_MS,
          'the capture to install its binding into the sandbox page',
        );

        // The fixture document is one the recording did NOT start with: the
        // script that runs here is the one the registration carried across the
        // navigation, and its registration covers the iframe the document
        // creates.
        await connection.send('Page.navigate', { url: fixture() }, pageSession);
        await until(
          async () =>
            (await evaluate('typeof window.__crewaidCaptureTeardown')) === 'function' &&
            (await evaluate(
              "document.getElementById('frame')?.contentDocument?.getElementById('inner') !== null",
            )) === true,
          ARM_MS,
          'the capture script and the fixture (iframe included) to be in place',
        );

        // ── the fence, observed inside the subframe ─────────────────────────
        //
        // The script RAN in the iframe and declined — its marker is there —
        // rather than merely failing to arrive. That is what makes the
        // "no report" assertions below non-vacuous.
        await until(
          async () =>
            (await evaluate(
              `typeof document.getElementById('frame').contentWindow.${CAPTURE_DECLINED_KEY}`,
            )) === 'boolean',
          ARM_MS,
          'the capture script to reach the iframe and decline',
        );
        expect(
          await evaluate(
            "typeof document.getElementById('frame').contentWindow.__crewaidCaptureTeardown",
          ),
        ).toBe('undefined');
        // The transport itself exists in the frame (the binding is added to the
        // target's contexts) — the fence, not a missing binding, is what keeps
        // the frame silent.
        expect(
          await evaluate(
            `typeof document.getElementById('frame').contentWindow.${CAPTURE_BINDING_NAME}`,
          ),
        ).toBe('function');

        // ── calibration: where the viewport sits in the framebuffer ─────────
        //
        // A CDP-dispatched click at a dead spot reports its own screen
        // position, and the probe this arithmetic rests on (M4-BE-05: an RFB
        // click at framebuffer (x, y) is reported as screenX/screenY (x, y))
        // is what follows.
        const viewport = JSON.parse(
          (await evaluate(
            'JSON.stringify({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })',
          )) as string,
        ) as { width: number; height: number; dpr: number };
        const calibrate = { x: viewport.width - 40, y: viewport.height - 40 };
        const dispatchClick = async (x: number, y: number): Promise<void> => {
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
        };
        await dispatchClick(calibrate.x, calibrate.y);

        const rowsFor = (): Promise<EventRow[]> =>
          prisma.recordingEvent.findMany({
            where: { recordingId },
            orderBy: { tsOffsetMs: 'asc' },
          });
        await until(
          async () =>
            (await rowsFor()).some(
              (row) =>
                row.layer === 'CDP' &&
                (row.payload as Record<string, unknown>)['clientX'] === calibrate.x,
            ),
          ARM_MS,
          'the calibration click to reach the CDP layer of the trace',
        );
        const calibration = (await rowsFor()).find(
          (row) =>
            row.layer === 'CDP' &&
            (row.payload as Record<string, unknown>)['clientX'] === calibrate.x,
        )!;
        const calPayload = calibration.payload as Record<string, number>;
        const dpr = calPayload['dpr'] ?? viewport.dpr;
        // Desktop position of viewport (0, 0).
        const originX = calPayload['screenX']! - calibrate.x * dpr;
        const originY = calPayload['screenY']! - calibrate.y * dpr;

        // ── where the two buttons are, in page and framebuffer pixels ───────
        const points = JSON.parse(
          (await evaluate(`(() => {
  const outer = document.getElementById('outer').getBoundingClientRect();
  const frame = document.getElementById('frame').getBoundingClientRect();
  const inner = document.getElementById('frame').contentDocument.getElementById('inner').getBoundingClientRect();
  return JSON.stringify({
    outer: { x: outer.left + outer.width / 2, y: outer.top + outer.height / 2 },
    inner: { x: frame.left + inner.left + inner.width / 2, y: frame.top + inner.top + inner.height / 2 },
  });
})()`)) as string,
        ) as { outer: { x: number; y: number }; inner: { x: number; y: number } };
        const toFramebuffer = (point: { x: number; y: number }): { x: number; y: number } => ({
          x: Math.round(originX + point.x * dpr),
          y: Math.round(originY + point.y * dpr),
        });
        const outerCenter = toFramebuffer(points.outer);
        const innerCenter = toFramebuffer(points.inner);
        // Jitter keeps the attempts distinct within each button; the main-frame
        // ones are retried because report latency is the host's (the M4-BE-05
        // probe measured ~60–250 ms), and the fence does not depend on any pair
        // landing inside the correlation window.
        const outerAttempts = [
          { x: outerCenter.x - 30, y: outerCenter.y },
          { x: outerCenter.x, y: outerCenter.y },
          { x: outerCenter.x + 30, y: outerCenter.y },
        ];
        const innerAttempts = [
          { x: innerCenter.x - 15, y: innerCenter.y },
          { x: innerCenter.x + 15, y: innerCenter.y },
        ];

        // ── the real clicks, through the product's own input path ───────────
        const client = new FakeClient();
        await screens.subscribe(USER_ID, client as unknown as WebSocket, botId);
        await until(async () => client.sends > 0, ARM_MS, 'the first §4.3 screen frame');
        await screens.control(client as unknown as WebSocket, botId, { action: 'take' });
        const control = app.get(SeatControlService).seats;
        const epoch = control.stateFor(client as unknown as WebSocket, botId).epoch;
        const press = (point: { x: number; y: number }): void =>
          screens.input(
            client as unknown as WebSocket,
            botId,
            pointerEvent(1, point.x, point.y),
            epoch,
          );
        const release = (point: { x: number; y: number }): void =>
          screens.input(
            client as unknown as WebSocket,
            botId,
            pointerEvent(0, point.x, point.y),
            epoch,
          );

        for (const attempt of [...outerAttempts, ...innerAttempts]) {
          press(attempt);
          await sleep(15);
          release(attempt);
          await sleep(150);
        }

        // Non-vacuity from the page itself: every click landed on its button —
        // including the two INSIDE the iframe, whose handlers fired.
        await until(
          async () => {
            const outer = Number(await evaluate('window.__clicks.outer'));
            const inner = Number(await evaluate('window.__clicks.inner'));
            return outer >= outerAttempts.length && inner >= innerAttempts.length;
          },
          ARM_MS,
          'both kinds of click to land on their buttons',
        );

        // The X11 layer holds a press for every click; the CDP layer holds a
        // report for every MAIN-FRAME click — and reports arrive in the same
        // ~250 ms band, so once they are all here the absence below is real.
        await until(
          async () => {
            const current = await rowsFor();
            const presses = current.filter(
              (row) =>
                row.layer === 'X11' &&
                row.type === 'pointer' &&
                (row.payload as Record<string, unknown>)['buttonMask'] === 1,
            );
            const clicks = current.filter((row) => row.layer === 'CDP' && row.type === 'click');
            const reported = outerAttempts.filter((point) =>
              clicks.some((row) => {
                const payload = row.payload as Record<string, unknown>;
                return payload['screenX'] === point.x && payload['screenY'] === point.y;
              }),
            );
            return (
              presses.length >= outerAttempts.length + innerAttempts.length &&
              reported.length === outerAttempts.length
            );
          },
          ARM_MS,
          'every X11 press and every main-frame CDP report to reach the trace',
        );
        await sleep(1_000);

        const rows = await rowsFor();
        const cdpClicks = rows.filter((row) => row.layer === 'CDP' && row.type === 'click');
        for (const attempt of innerAttempts) {
          expect(
            cdpClicks.filter((row) => {
              const payload = row.payload as Record<string, unknown>;
              return payload['screenX'] === attempt.x && payload['screenY'] === attempt.y;
            }),
            `a CDP report at the in-frame click (${attempt.x}, ${attempt.y})`,
          ).toEqual([]);
        }
        const outerRow = cdpClicks.find(
          (row) => (row.payload as Record<string, unknown>)['id'] === 'outer',
        );
        expect(outerRow, 'no CDP click row for #outer').toBeDefined();
        // The recording kept every fact the page reported — including the rungs
        // the compiler will set aside — so the "no engine-syntax form" claim
        // below is about the compile fence, not about capture.
        expect(
          (
            (outerRow!.payload as Record<string, unknown>)['candidates'] as Array<{ kind: string }>
          ).some((candidate) => candidate.kind === 'text'),
        ).toBe(true);

        // The stop settles the trace and runs the correlator for real; nothing
        // below calls it directly.
        const settled = await recordings.stop(USER_ID, recordingId);
        expect(settled.id).toBe(recordingId);
        await screens.control(client as unknown as WebSocket, botId, { action: 'release', epoch });
        const settledRows = await rowsFor();

        // ── correlate → fold → compile(input) over the real rows ────────────
        //
        // The same two steps the service applies, in the same order: fold the
        // proven pairs, constrain to resolver-executable candidates, render the
        // exact trace the model would read.
        const folded = constrainToResolver(foldCorrelated(settledRows as readonly TraceRow[]));
        const trace = renderTrace(folded, []);

        // The one-sided in-frame presses stayed one-sided: the correlator
        // invents no partner for them.
        const innerPresses = settledRows.filter(
          (row) =>
            row.layer === 'X11' &&
            row.type === 'pointer' &&
            (row.payload as Record<string, unknown>)['buttonMask'] === 1 &&
            innerAttempts.some(
              (point) =>
                (row.payload as Record<string, unknown>)['x'] === point.x &&
                (row.payload as Record<string, unknown>)['y'] === point.y,
            ),
        );
        expect(innerPresses).toHaveLength(innerAttempts.length);
        for (const row of innerPresses) expect(row.correlatedWithId).toBeNull();

        // Nothing in the model's trace names the in-frame element as a
        // candidate or sits at the in-frame click points as a page click.
        // (The document URL itself contains the fixture's markup, so the claim
        // is made about candidate selectors, not about every string.)
        const lines = trace
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const candidateSelectors = lines.flatMap((line) =>
          Array.isArray(line['candidates'])
            ? (line['candidates'] as Array<{ selector: string }>).map(
                (candidate) => candidate.selector,
              )
            : [],
        );
        expect(candidateSelectors.some((selector) => selector.includes('inner'))).toBe(false);
        for (const attempt of innerAttempts) {
          expect(
            lines.some(
              (line) =>
                line['type'] === 'click' && line['x'] === attempt.x && line['y'] === attempt.y,
            ),
            `a trace click at the in-frame point (${attempt.x}, ${attempt.y})`,
          ).toBe(false);
        }
        // The in-frame clicks appear exactly as the X11 press they are — the
        // raw material of the coordinate form.
        expect(
          lines.some(
            (line) =>
              line['type'] === 'pointer' &&
              line['x'] === innerAttempts[0]!.x &&
              line['y'] === innerAttempts[0]!.y &&
              line['buttonMask'] === 1,
          ),
        ).toBe(true);
        // The main-frame click kept its selector story, and the engine-syntax
        // rung the page recorded is not part of it.
        expect(
          lines.some(
            (line) =>
              line['type'] === 'click' &&
              Array.isArray(line['candidates']) &&
              (line['candidates'] as Array<{ selector: string }>).some(
                (candidate) => candidate.selector === '[data-testid="outer"]',
              ),
          ),
        ).toBe(true);
        expect(trace).not.toContain('text=');

        // ── REPLAY: the emitted steps, executed by the shipped runner ───────
        //
        // What the compiler's rules derive from the trace above: a click with
        // resolvable candidates becomes `ctx.page.click(<first unique
        // candidate>)`; a click with none becomes `ctx.click(x, y)` at its
        // recorded position. Both run through the bridge — the shipped bundle,
        // the same Chrome — against the page that recorded them.
        const bridgeSkill = async (script: string): Promise<BridgeOutcome> => {
          const sandbox = await prisma.sandbox.findFirst({
            where: { bots: { some: { id: botId } } },
            select: { sessionId: true },
          });
          const sessionId = sandbox?.sessionId ?? botId;
          const session = await provider.attachSession({ sessionId });
          if (session === null) throw new Error(`no container is attached to session ${sessionId}`);
          const endpoint = await session.getPortEndpoint({ port: SANDBOX_PORTS.bridge });
          const response = await fetch(`${endpoint.url}/skill/run?botId=${botId}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(endpoint.headers ?? {}) },
            body: JSON.stringify({ script, params: {} }),
            signal: AbortSignal.timeout(90_000),
          });
          if (!response.ok) throw new Error(`the bridge answered ${response.status}`);
          return (await response.json()) as BridgeOutcome;
        };
        // The recording's own connection closed at `stop`; reads during replay
        // go through a fresh attach that the suite tears down after each peek —
        // the same service the recorder used, reopened on purpose.
        const peekCounters = async (): Promise<{ outer: number; inner: number }> => {
          cdp.attach(botId, recordingId);
          try {
            const fresh = await cdp.connectionFor(botId, recordingId);
            if (fresh === null) throw new Error('the peek attach never completed');
            const { targetInfos } = await fresh.send('Target.getTargets');
            const pages = (targetInfos as Array<Record<string, unknown>>).filter(
              (info) => info['type'] === 'page',
            );
            if (pages.length === 0) throw new Error('no page target to read back');
            const peek = await fresh.send('Target.attachToTarget', {
              targetId: pages[0]!['targetId'],
              flatten: true,
            });
            const result = await fresh.send(
              'Runtime.evaluate',
              { expression: 'JSON.stringify(window.__clicks)', returnByValue: true },
              String(peek['sessionId']),
            );
            return JSON.parse(String((result['result'] as { value?: unknown }).value)) as {
              outer: number;
              inner: number;
            };
          } finally {
            await cdp.detach(botId);
          }
        };
        /** Wait for a replay's click to register in the page before comparing. */
        const countersUntil = async (
          ready: (counts: { outer: number; inner: number }) => boolean,
          message: string,
        ): Promise<{ outer: number; inner: number }> => {
          let latest: { outer: number; inner: number } | null = null;
          await until(
            async () => {
              latest = await peekCounters();
              return ready(latest);
            },
            20_000,
            message,
          );
          if (latest === null) throw new Error('unreachable: until() resolves only after a peek');
          return latest;
        };

        const selectorFromTrace = (
          (outerRow!.payload as Record<string, unknown>)['candidates'] as Array<{
            selector: string;
            unique: boolean;
          }>
        ).find((candidate) => candidate.unique)!.selector;
        expect(selectorFromTrace).toBe('[data-testid="outer"]');

        // 1. The main-frame click's emitted form, against the real ctx.page.
        const before = await peekCounters();
        const selectorRun = await bridgeSkill(
          [
            'export default async function run(ctx) {',
            `  await ctx.page.click(${JSON.stringify(selectorFromTrace)}, { timeout: 15000 });`,
            "  return 'clicked';",
            '}',
          ].join('\n'),
        );
        expect(selectorRun).toMatchObject({ ok: true, result: 'clicked' });
        const afterSelector = await countersUntil(
          (counts) => counts.outer === before.outer + 1,
          'the selector replay to land on #outer',
        );
        expect(afterSelector.inner).toBe(before.inner);

        // 2. The in-frame click's emitted form: the coordinate fallback, at the
        // recorded desktop position — and it lands on the recorded element.
        const recordedInner = (innerPresses[0]!.payload as Record<string, number>)['x']!;
        const recordedInnerY = (innerPresses[0]!.payload as Record<string, number>)['y']!;
        const coordinateRun = await bridgeSkill(
          [
            'export default async function run(ctx) {',
            "  ctx.log('coordinate replay');",
            `  await ctx.click(${recordedInner}, ${recordedInnerY});`,
            "  return 'clicked';",
            '}',
          ].join('\n'),
        );
        expect(coordinateRun).toMatchObject({ ok: true, result: 'clicked' });
        const afterCoordinate = await countersUntil(
          (counts) => counts.inner === before.inner + 1,
          'the coordinate replay to land inside the iframe',
        );
        expect(afterCoordinate.outer).toBe(before.outer + 1);

        // 3. The form the fence prevents: a frame-relative selector cannot run
        // on the main page. Native frame locators need an explicit frame path;
        // the captured rows do not identify that path, so retain coordinates.
        const frameRelativeRun = await bridgeSkill(
          [
            'export default async function run(ctx) {',
            "  await ctx.page.click('#inner', { timeout: 1500 });",
            "  return 'impossible';",
            '}',
          ].join('\n'),
        );
        expect(frameRelativeRun.ok).toBe(false);
        expect(String(frameRelativeRun.detail)).toContain('Timeout');
        const afterFrameRelative = await peekCounters();
        // ...and nothing was clicked in its place: the wrong-element misclick
        // the fence exists to prevent did not happen.
        expect(afterFrameRelative.inner).toBe(afterCoordinate.inner);
        expect(afterFrameRelative.outer).toBe(afterCoordinate.outer);

        // A fresh compile from these actual rows, followed by the real publication
        // and execution services. Only the model is scripted; no skill row is seeded.
        const script = `export default async function run(ctx) {
          await ctx.page.click(${JSON.stringify(selectorFromTrace)});
          await ctx.click(${recordedInner}, ${recordedInnerY});
        }`;
        const model = new MockLanguageModelV4({
          doGenerate: (options) => {
            const prompt = JSON.stringify(options.prompt);
            expect(prompt).toContain('data-testid');
            expect(prompt).toContain(String(recordedInner));
            expect(prompt).toContain('frameLocator');
            return Promise.resolve({
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    name: 'fresh_native_replay',
                    description: 'Replay the demonstrated outer and frame clicks.',
                    params: [],
                    steps: ['Click the outer button.', 'Click the demonstrated frame position.'],
                    script,
                  }),
                },
              ],
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              warnings: [],
            });
          },
        });
        const resolution = vi
          .spyOn(app.get(ModelResolutionService), 'resolveText')
          .mockResolvedValue(resolvedTextModelOf(model));
        try {
          await app.get(SkillCompileService).run(recordingId);
          const skill = await prisma.skill.findFirstOrThrow({
            where: { sourceRecordingId: recordingId },
          });
          expect(skill.status).toBe('DRAFT');
          expect((await recordings.status(USER_ID, recordingId)).state).toBe('READY');
          const runs = app.get(SkillRunService);
          const skills = app.get(SkillsService);
          await expect(runs.start(USER_ID, skill.id, {})).rejects.toThrow('APPROVED');
          await expect(skills.approve(randomUUID(), skill.id)).rejects.toThrow('not found');
          expect((await skills.approve(USER_ID, skill.id)).status).toBe('APPROVED');
          await screens.control(client as unknown as WebSocket, botId, { action: 'take' });
          const held = control.stateFor(client as unknown as WebSocket, botId);
          expect(held.mode).toBe('human');
          const heldAttempt = runs.runToCompletion(USER_ID, skill.id, {});
          expect(await peekCounters()).toEqual(afterCoordinate);
          await screens.control(client as unknown as WebSocket, botId, {
            action: 'release',
            epoch: held.epoch,
          });
          const blocked = await heldAttempt;
          expect(blocked.status).toBe('FAILED');
          expect((await runs.status(USER_ID, skill.id, blocked.runId)).error).toContain(
            'OBSERVATION_REQUIRED',
          );
          await peekCounters();
          control.observed(botId);
          const replay = await runs.runToCompletion(USER_ID, skill.id, {});
          expect(
            replay.status,
            JSON.stringify(await runs.status(USER_ID, skill.id, replay.runId)),
          ).toBe('SUCCEEDED');
          expect(
            await countersUntil(
              (counts) =>
                counts.outer === afterCoordinate.outer + 1 &&
                counts.inner === afterCoordinate.inner + 1,
              'the published fresh skill to replay',
            ),
          ).toEqual({
            outer: afterCoordinate.outer + 1,
            inner: afterCoordinate.inner + 1,
          });
        } finally {
          resolution.mockRestore();
          screens.unsubscribe(client as unknown as WebSocket, botId);
        }

        console.log(
          'M4-BE-06 fix wave docker: subframe click stayed X11-only (declined marker verified in-frame); ' +
            'selector replay landed on #outer; coordinate replay landed in the iframe; ' +
            'frame-relative selector provably cannot run',
        );
      },
      TEST_MS,
    );
  },
);
