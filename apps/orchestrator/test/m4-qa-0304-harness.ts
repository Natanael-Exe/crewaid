/**
 * M4-QA-03/04 — the shared real-sandbox harness.
 *
 * Both required tests need the same chain before they can ask their own
 * question: a sandbox, the fixture served inside it, a calibration that says
 * where the viewport sits in the framebuffer, a recording of one click that
 * the correlator actually paired, and a compile driven by the emission rules.
 * QA-03 then asks what the script contains; QA-04 runs that script at two
 * viewport widths. Keeping the chain in one place is what makes the two suites
 * readable as the two questions they are.
 *
 * Nothing here asserts anything about the product. It boots, drives and reads;
 * every claim lives in the suite that makes it.
 */

import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

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
import { ScreenService } from '../src/screen/screen.service.js';
import {
  FIXTURE_ORIGIN,
  FIXTURE_SERVER_PATH,
  fixtureServerCommand,
  fixtureServerSource,
} from './m4-qa-03-fixture-page.js';

export const USER_ID = 'usr_crewaid_singleton_v1';
/** One cold boot of a full XFCE desktop and a Chrome, plus a slow host. */
export const BOOT_MS = 180_000;
/** How long an observable the product must produce is given to appear. */
export const ARM_MS = 30_000;
/** How many recordings the host gets to deliver one in-window click. */
export const RECORD_ATTEMPTS = 6;
/** §6/M4's correlation window, written here as a literal for the messages. */
export const WINDOW_MS = 150;

const run = promisify(execFile);
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface EventRow {
  readonly id: string;
  readonly tsOffsetMs: number;
  readonly layer: string;
  readonly type: string;
  readonly payload: unknown;
  readonly screenshotKey: string | null;
  readonly correlatedWithId: string | null;
}

/** Retry until `condition` holds; the failure message names what never came. */
export async function until(
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
export class FakeClient extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
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
export function pointerEvent(mask: number, x: number, y: number): Uint8Array {
  const bytes = new Uint8Array(6);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 5);
  view.setUint8(1, mask);
  view.setUint16(2, x);
  view.setUint16(4, y);
  return bytes;
}

/** Every coordinate click in a script, found the way a reader would. */
export function coordinateClicksIn(script: string): readonly string[] {
  return script.match(/ctx\.click\([^)]*\)/g) ?? [];
}

/** Write an artefact when the run asked for one (`CREWAID_QA_EVIDENCE_DIR`). */
export function saveEvidence(name: string, body: string): void {
  const dir = process.env['CREWAID_QA_EVIDENCE_DIR'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
}

/** One skill run's outcome, as the bridge answers it (D-040's shape). */
export interface BridgeOutcome {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly logs?: readonly string[];
  readonly detail?: string;
  readonly code?: string;
}

/** Where the viewport's top-left sits in the framebuffer, and at what ratio. */
export interface Calibration {
  readonly dpr: number;
  readonly originX: number;
  readonly originY: number;
}

/** A page session on an open connection, with a reader for it. */
export interface DrivenPage {
  readonly connection: CdpConnection;
  readonly session: string;
  evaluate(expression: string): Promise<unknown>;
  navigate(url: string): Promise<void>;
}

/** Attach a second session to the page target and hand back a reader. */
export async function drivePage(connection: CdpConnection): Promise<DrivenPage> {
  const { targetInfos } = await connection.send('Target.getTargets');
  const pages = (targetInfos as Array<Record<string, unknown>>).filter(
    (info) => info['type'] === 'page',
  );
  if (pages.length === 0) throw new Error('the sandbox reported no page target to drive');
  const attached = await connection.send('Target.attachToTarget', {
    targetId: pages[0]!['targetId'],
    flatten: true,
  });
  const session = String(attached['sessionId']);
  const evaluate = async (expression: string): Promise<unknown> => {
    const result = await connection.send(
      'Runtime.evaluate',
      { expression, returnByValue: true },
      session,
    );
    return (result['result'] as { value?: unknown } | undefined)?.value;
  };
  return {
    connection,
    session,
    evaluate,
    navigate: async (url: string) => {
      await connection.send('Page.navigate', { url }, session);
    },
  };
}

/** Read a JSON-stringified expression out of the page. */
export async function readJson<T>(page: DrivenPage, expression: string): Promise<T> {
  return JSON.parse(String(await page.evaluate(expression))) as T;
}

/** The centre of `#buy`, in the page's own CSS pixels. */
export const BUY_CENTRE_EXPRESSION = `(() => {
  const r = document.getElementById('buy').getBoundingClientRect();
  return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height });
})()`;

export interface BuyRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * A booted sandbox with the fixture served inside it.
 *
 * The server is written and started through the session's own process API and
 * listens on the container's loopback, so the page is local to the browser
 * that loads it — no container→host routing, and §7.3's egress policy is left
 * exactly as it is.
 */
export class FixtureSandbox {
  private constructor(
    readonly app: INestApplication,
    readonly botId: string,
    readonly sessionId: string,
  ) {}

  static async boot(botPrefix: string, botName: string): Promise<FixtureSandbox> {
    const { Test } = await import('@nestjs/testing');
    const moduleRef = await Test.createTestingModule({
      // The real module graph with the REAL providers: the §4.3 input entry is
      // the path these suites click through.
      imports: [(await import('../src/screen/screen.module.js')).ScreenModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    const prisma = app.get(PrismaService);
    await prisma.user.upsert({
      where: { id: USER_ID },
      create: { id: USER_ID, name: 'Test User', email: `${USER_ID}@test.invalid` },
      update: {},
    });
    const bot = await app.get(BotsService).create(USER_ID, {
      name: `${botPrefix}-${botName}`,
      role: 'QA fixture',
      avatarColor: '#123456',
      systemPrompt: 'x',
    });

    await app.get(SandboxService).start(USER_ID, bot.id);
    const sandbox = await prisma.sandbox.findFirst({
      where: { bots: { some: { id: bot.id } } },
      select: { sessionId: true },
    });
    const sessionId = sandbox?.sessionId ?? bot.id;

    const provider = app.get<SandboxProvider>(SANDBOX_PROVIDER);
    const session = await provider.attachSession({ sessionId });
    if (session === null) throw new Error(`no container is attached to session ${sessionId}`);
    await session.writeTextFile({ path: FIXTURE_SERVER_PATH, content: fixtureServerSource() });
    await session.spawn({ command: fixtureServerCommand() });
    const probe = await session.run({
      command:
        `for i in $(seq 1 60); do curl -fsS ${FIXTURE_ORIGIN}/ >/dev/null && echo UP && exit 0; ` +
        `sleep 0.25; done; echo DOWN; cat ${FIXTURE_SERVER_PATH}.log 2>/dev/null`,
    });
    if (!probe.stdout.includes('UP')) {
      throw new Error(`the fixture server never answered inside the sandbox: ${probe.stdout}`);
    }

    return new FixtureSandbox(app, bot.id, sessionId);
  }

  /** Run one script through the bridge — the shipped runner, the same Chrome. */
  async bridgeSkill(script: string): Promise<BridgeOutcome> {
    const provider = this.app.get<SandboxProvider>(SANDBOX_PROVIDER);
    const session = await provider.attachSession({ sessionId: this.sessionId });
    if (session === null) throw new Error(`no container is attached to session ${this.sessionId}`);
    const endpoint = await session.getPortEndpoint({ port: SANDBOX_PORTS.bridge });
    const response = await fetch(`${endpoint.url}/skill/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(endpoint.headers ?? {}) },
      body: JSON.stringify({ script, params: {} }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throw new Error(`the bridge answered ${response.status}`);
    return (await response.json()) as BridgeOutcome;
  }

  async teardown(): Promise<void> {
    const { stdout } = await run('docker', [
      'ps',
      '-aq',
      '--no-trunc',
      '--filter',
      `label=${SANDBOX_LABELS.sessionId}=${this.botId}`,
    ]).catch(() => ({ stdout: '' }));
    for (const id of stdout.trim() === '' ? [] : stdout.trim().split('\n')) {
      await run('docker', ['rm', '-f', id]).catch(() => undefined);
    }
    await run('docker', ['volume', 'rm', '--force', `crewaid-workspace-${this.botId}`]).catch(
      () => undefined,
    );
    const prisma = this.app.get(PrismaService);
    await prisma.skill.deleteMany({ where: { botId: this.botId } }).catch(() => undefined);
    await prisma.bot.deleteMany({ where: { id: this.botId } }).catch(() => undefined);
    await this.app.close();
  }
}

/**
 * Where the viewport sits in the framebuffer, measured OUTSIDE any recording
 * that matters.
 *
 * One dispatched click reveals it: the fixture's own listener records the
 * event's `clientX`/`clientY` and `screenX`/`screenY` together, and M4-BE-05's
 * probe established that an RFB click at framebuffer (x, y) is reported as
 * `screenX`/`screenY` (x, y). It runs inside a throwaway recording that is
 * stopped immediately, because a calibration click is an interaction like any
 * other — left inside the recording under test it would compile to a step no
 * operator performed, and §6/M4 asks to see the FLOW compiled.
 */
export async function calibrate(sandbox: FixtureSandbox): Promise<Calibration> {
  const recordings = sandbox.app.get(RecordingsService);
  const cdp = sandbox.app.get(CdpAttachService);
  const { recordingId } = await recordings.start(USER_ID, sandbox.botId, {
    intent: 'calibration',
  });
  try {
    const connection = await cdp.connectionFor(sandbox.botId, recordingId);
    if (connection === null) throw new Error('the calibration CDP attach never completed');
    const page = await drivePage(connection);
    await page.navigate(`${FIXTURE_ORIGIN}/?calibrate=1`);
    await until(
      async () => (await page.evaluate("document.getElementById('buy') !== null")) === true,
      ARM_MS,
      'the served fixture to load for calibration',
    );
    const viewport = await readJson<{ width: number; height: number }>(
      page,
      'JSON.stringify({ width: window.innerWidth, height: window.innerHeight })',
    );
    const corner = { x: viewport.width - 40, y: viewport.height - 40 };
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await connection.send(
        'Input.dispatchMouseEvent',
        {
          type,
          x: corner.x,
          y: corner.y,
          button: 'left',
          buttons: type === 'mousePressed' ? 1 : 0,
          clickCount: 1,
        },
        page.session,
      );
    }
    await until(
      async () => (await page.evaluate('typeof window.__cal')) === 'object',
      ARM_MS,
      'the calibration click to be seen by the page',
    );
    const cal = await readJson<{
      clientX: number;
      clientY: number;
      screenX: number;
      screenY: number;
      dpr: number;
    }>(page, 'JSON.stringify(window.__cal)');
    return {
      dpr: cal.dpr,
      originX: cal.screenX - cal.clientX * cal.dpr,
      originY: cal.screenY - cal.clientY * cal.dpr,
    };
  } finally {
    await recordings.stop(USER_ID, recordingId).catch(() => undefined);
  }
}

export interface RecordedClick {
  readonly recordingId: string;
  readonly rows: readonly EventRow[];
  readonly press: EventRow;
  readonly click: EventRow;
  /** The report's latency behind the press, in ms. */
  readonly dt: number;
  /** Every attempt's latency, including the ones that missed the window. */
  readonly latencies: readonly number[];
}

/**
 * Record one click on `#buy` that the correlator PROVED was one action.
 *
 * ── WHY THIS RETRIES ────────────────────────────────────────────────────────
 *
 * Both suites' claims are strict: every click in the recording compiled to a
 * page call. That needs the click correlated, which needs the page's report
 * within §6/M4's 150 ms of the X11 press — a host latency, ~60–250 ms on the
 * M4-BE-05 probe. A recording whose report arrived late is not a product
 * defect and not a counter-example; it is an input the claim is not about. So
 * this records, checks after `stop` whether the correlator paired it, and
 * records again if not, returning null when the host never delivers one.
 *
 * ── WHY THE NAVIGATION IS PROVED BY A ROW ───────────────────────────────────
 *
 * `CdpCaptureService.arm` returns before its install finishes, so a navigation
 * issued the instant `connectionFor` resolves can beat `Page.enable` and never
 * reach the trace — the clicks still record, which is what makes the omission
 * quiet. The page cannot be asked either: the capture script REPLACES
 * `__crewaidCaptureTeardown` rather than deleting it, so a document carried over
 * from an earlier recording answers "armed" for a registration that is gone.
 * The only witness that cannot be confused is a row.
 */
export async function recordOneCorrelatedClick(
  sandbox: FixtureSandbox,
  client: FakeClient,
  calibration: Calibration,
  intent: string,
): Promise<RecordedClick | null> {
  const recordings = sandbox.app.get(RecordingsService);
  const screens = sandbox.app.get(ScreenService);
  const cdp = sandbox.app.get(CdpAttachService);
  const prisma = sandbox.app.get(PrismaService);
  const latencies: number[] = [];

  for (let attempt = 1; attempt <= RECORD_ATTEMPTS; attempt += 1) {
    const { recordingId } = await recordings.start(USER_ID, sandbox.botId, { intent });
    const connection = await cdp.connectionFor(sandbox.botId, recordingId);
    if (connection === null) {
      throw new Error('the CDP attach never completed — see the earlier service warning');
    }
    const page = await drivePage(connection);
    const rowsFor = (): Promise<EventRow[]> =>
      prisma.recordingEvent.findMany({ where: { recordingId }, orderBy: { tsOffsetMs: 'asc' } });

    let navigations = 0;
    await until(
      async () => {
        if ((await rowsFor()).some((row) => row.layer === 'CDP' && row.type === 'load'))
          return true;
        navigations += 1;
        await page.navigate(`${FIXTURE_ORIGIN}/?run=${attempt}-${navigations}`);
        await sleep(1_500);
        return (await rowsFor()).some((row) => row.layer === 'CDP' && row.type === 'load');
      },
      ARM_MS,
      'the navigation to the served fixture to reach the trace',
    );
    await until(
      async () =>
        (await page.evaluate("document.getElementById('buy') !== null")) === true &&
        (await page.evaluate('typeof window.__crewaidCaptureTeardown')) === 'function',
      ARM_MS,
      'the served fixture and its capture script to be in place',
    );

    const buy = await readJson<BuyRect>(page, BUY_CENTRE_EXPRESSION);
    const point = {
      x: Math.round(calibration.originX + buy.x * calibration.dpr),
      y: Math.round(calibration.originY + buy.y * calibration.dpr),
    };

    // The click, through the product's own §4.3 input path.
    screens.input(client as unknown as WebSocket, sandbox.botId, pointerEvent(1, point.x, point.y));
    await sleep(20);
    screens.input(client as unknown as WebSocket, sandbox.botId, pointerEvent(0, point.x, point.y));

    // Non-vacuity from the page itself: the click landed on the button, and
    // the button's own handler ran.
    await until(
      async () =>
        Number(await page.evaluate('window.__qa.buy')) >= 1 &&
        (await page.evaluate("document.getElementById('receipt') !== null")) === true,
      ARM_MS,
      'the click to land on #buy and the page to show its receipt',
    );
    await until(
      async () => {
        const current = await rowsFor();
        return (
          current.some(
            (row) =>
              row.layer === 'X11' &&
              row.type === 'pointer' &&
              (row.payload as Record<string, unknown>)['buttonMask'] === 1 &&
              (row.payload as Record<string, unknown>)['x'] === point.x,
          ) &&
          current.some(
            (row) =>
              row.layer === 'CDP' &&
              row.type === 'click' &&
              (row.payload as Record<string, unknown>)['id'] === 'buy',
          )
        );
      },
      ARM_MS,
      'both layers to record the click',
    );
    await sleep(800);

    // `stop` settles the trace and runs the REAL correlator.
    await recordings.stop(USER_ID, recordingId);
    const rows = await rowsFor();
    const press = rows.find(
      (row) =>
        row.layer === 'X11' &&
        row.type === 'pointer' &&
        (row.payload as Record<string, unknown>)['buttonMask'] === 1 &&
        (row.payload as Record<string, unknown>)['x'] === point.x,
    );
    const click = rows.find(
      (row) =>
        row.layer === 'CDP' &&
        row.type === 'click' &&
        (row.payload as Record<string, unknown>)['id'] === 'buy',
    );
    if (press === undefined || click === undefined) {
      throw new Error('a layer did not record the click it had already been observed to make');
    }
    const dt = click.tsOffsetMs - press.tsOffsetMs;
    latencies.push(dt);
    if (press.correlatedWithId === click.id && click.correlatedWithId === press.id) {
      return { recordingId, rows, press, click, dt, latencies };
    }
    // The two failures look the same from here and are not the same thing. A
    // report that arrived LATE is host latency, and the next attempt is the
    // right answer. A report that arrived INSIDE the window and still did not
    // pair is the correlator being wrong, and retrying would bury a product
    // defect under "re-run on a less loaded host" — which is exactly the
    // misdiagnosis this check exists to prevent.
    if (dt >= 0 && dt <= WINDOW_MS) {
      throw new Error(
        `the correlator left an in-window pair uncorrelated (dt=${dt}ms, press ${press.id}, ` +
          `click ${click.id}): §6/M4 says a CDP click within ${WINDOW_MS} ms of an X11 click at ` +
          'the same coordinates IS the same action. This is a product defect, not host latency.',
      );
    }
  }
  return null;
}

/** The sentence a suite fails with when the host never delivered a pair. */
export function noPairMessage(latencies: readonly number[]): string {
  return (
    `the host never delivered a page report within ${WINDOW_MS} ms of the press in ` +
    `${RECORD_ATTEMPTS} recordings (latencies: ${latencies.join(', ')} ms). ` +
    'That is an environment result, not a product one — re-run on a less loaded host.'
  );
}
