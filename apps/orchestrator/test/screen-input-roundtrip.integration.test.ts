import 'reflect-metadata';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { WebSocket } from 'ws';
import { encodeScreenInputFrame } from '@crewaid/shared';

import { BotsService } from '../src/bots/bots.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SeatControlService } from '../src/screen/seat-control.service.js';
import { SandboxService } from '../src/sandbox/sandbox.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import { SeatService } from '../src/sandbox/seat.service.js';
import { seatEnv } from '../src/agent/seat-env.js';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../src/sandbox/sandbox.provider.js';

/**
 * M2-QA-05 — the `proof.txt` round trip, automated.
 *
 * PRD §5: "inject a synthetic `PointerEvent` and `KeyEvent` through the WS
 * path, assert the effect via `readFile`".
 *
 * ── WHAT IS NEW HERE ────────────────────────────────────────────────────────
 *
 * Both halves of R6's chain are already covered, and neither half covers this:
 *
 *   - `screen-input.integration.test.ts` drives a real §4.2 socket, but into a
 *     FAKE upstream. It proves a binary frame reaches a handler and that the
 *     bytes arrive unchanged — and it would pass just as happily if x11vnc
 *     ignored every one of them.
 *   - `rfb-input.integration.test.ts` drives the real x11vnc in the §5 image,
 *     but constructs `RfbUpstream` directly. Nothing in it goes near the
 *     socket, the gateway, the ownership check, or the multiplexer.
 *
 * So the two ends are each proven against a stub of the other. This is the
 * whole chain in one process: WebSocket -> CrewaidWsAdapter -> WsGateway ->
 * ScreenService -> RfbUpstream -> x11vnc -> X -> a file on the desktop's own
 * filesystem, read back through the sandbox session. Nothing between the two
 * ends is substituted.
 *
 * ── WHY TWO TERMINALS ───────────────────────────────────────────────────────
 *
 * §5 asks for a PointerEvent *and* a KeyEvent, and the obvious version of this
 * test cannot tell them apart: a newly mapped terminal already has focus, so
 * `touch proof.txt` lands whether or not the click did anything at all. The
 * pointer would be decorative and the test would still pass.
 *
 * Two terminals in two working directories fixes that. The second one takes
 * focus as it maps, and the typed command carries NO path — so the file can
 * only appear at /home/bot/proof.txt if the click moved focus to the first
 * terminal, and appears at /home/bot/b/proof.txt if it did not. The negative
 * assertion is what makes the PointerEvent load-bearing.
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

const BOT_PREFIX = 'm2qa05';
/** One cold boot of a full XFCE desktop, plus room for a slow host. */
const BOOT_MS = 180_000;

/** RFC 6143 §7.5.5 — type, button-mask, x, y. */
function pointerEvent(buttonMask: number, x: number, y: number): Uint8Array {
  const bytes = new Uint8Array(6);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 5);
  view.setUint8(1, buttonMask);
  view.setUint16(2, x);
  view.setUint16(4, y);
  return bytes;
}

/** RFC 6143 §7.5.4 — type, down-flag, 2 padding, keysym. */
function keyEvent(down: boolean, keysym: number): Uint8Array {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 4);
  view.setUint8(1, down ? 1 : 0);
  view.setUint32(4, keysym);
  return bytes;
}

const XK_RETURN = 0xff0d;
/** X11 keysyms coincide with the code point for printable Latin-1. */
const keysymOf = (character: string): number => character.codePointAt(0) as number;

/** Where each terminal sits on the 1280x800 framebuffer, and what its cwd is. */
const TERMINALS = [
  // §5's literal path comes from this one: its cwd is /home/bot, and the typed
  // command carries no path of its own.
  { dir: '/home/bot', geometry: '50x14+40+80', clickAt: { x: 240, y: 200 } },
  { dir: '/home/bot/b', geometry: '50x14+700+430', clickAt: { x: 900, y: 550 } },
] as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

describe.skipIf(SKIP)('M2-QA-05 screen.input round trip (real Docker, real socket)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let botId: string;
  let ws: WebSocket;
  /** Binary §4.3 frames seen on the socket; the first one proves we are live. */
  /** A watcher is sent the seat's control state once its subscription took. */
  let watching = false;
  let controlGranted = false;
  let controlEpoch = 0;
  let renew: ReturnType<typeof setInterval> | undefined;
  const inputErrors: unknown[] = [];
  let owner: SignedInUser;
  let computerId: string | undefined;
  let sessionId: string | undefined;

  /** The sandbox's own view of itself — the far end of the chain. */
  const session = async () => {
    const provider = app.get<SandboxProvider>(SANDBOX_PROVIDER);
    if (sessionId === undefined) throw new Error('fixture computer did not start');
    return provider.resumeSession({ sessionId });
  };

  /**
   * One command inside the desktop, through the provider rather than the CLI.
   * `run` already wraps the string in `sh -c`, so this is shell syntax.
   */
  const inSandbox = async (command: string): Promise<string> => {
    if (sessionId === undefined) throw new Error('fixture computer did not start');
    const seat = await app.get(SeatService).seatFor(sessionId, botId);
    if (seat === null) throw new Error('fixture seat did not start');
    const result = await (await session()).run({ command, env: seatEnv(seat) });
    return result.stdout.trim();
  };

  const send = (rfb: Uint8Array): void => {
    ws.send(encodeScreenInputFrame(botId, controlEpoch, rfb), { binary: true });
  };

  /** A click: move, press, release — the sequence a real pointer produces. */
  const clickAt = async (x: number, y: number): Promise<void> => {
    send(pointerEvent(0, x, y));
    send(pointerEvent(0b1, x, y));
    send(pointerEvent(0, x, y));
    // RFB is ordered, so this is not about delivery — it is giving xfwm4 time
    // to act on the click before the keystrokes that depend on it arrive.
    await sleep(500);
  };

  const type = async (text: string): Promise<void> => {
    for (const character of text) {
      send(keyEvent(true, keysymOf(character)));
      send(keyEvent(false, keysymOf(character)));
    }
    await sleep(250);
  };

  async function bootApp(): Promise<number> {
    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('../src/app.module.js');
    const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');
    // No `overrideProvider`. The real Docker provider and the real RfbUpstream
    // are the two things this test exists to exercise together.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useWebSocketAdapter(new CrewaidWsAdapter(app));
    await app.listen(0);
    const port = (app.getHttpServer().address() as { port: number }).port;

    prisma = app.get(PrismaService);
    return port;
  }

  async function watchWindow(port: number): Promise<void> {
    watching = false;
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${owner.token}`);
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      // Pixels have a stream of their own; nothing binary comes this way.
      expect(isBinary).toBe(false);
      const frame = JSON.parse(data.toString()) as {
        type: string;
        payload: { mode?: string; holder?: string; epoch?: number };
      };
      if (frame.type === 'error') inputErrors.push(frame.payload);
      if (
        frame.type === 'screen.control.state' &&
        frame.payload.mode === 'human' &&
        frame.payload.holder === 'self'
      ) {
        controlEpoch = frame.payload.epoch ?? 0;
      }
      if (frame.type === 'screen.control.state') {
        watching = true;
        controlGranted = frame.payload.mode === 'human' && frame.payload.holder === 'self';
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    ws.send(
      JSON.stringify({
        id: randomUUID(),
        type: 'screen.subscribe',
        ts: Date.now(),
        payload: { botId },
      }),
    );
    // The seat's control state is sent to a watcher once the subscription
    // took — §4.2 has no other acknowledgement of `screen.subscribe`. Control
    // can only be taken after the subscription exists; watching alone never
    // authorizes input.
    await waitFor(() => watching, 'the seat control state');
  }

  beforeAll(async () => {
    // The background health poll would race the desktop this test kills nothing
    // in, but it also writes states while the socket is open; off is simpler.
    process.env['SANDBOX_HEALTH_INTERVAL_MS'] = '0';

    const port = await bootApp();

    prisma = app.get(PrismaService);
    owner = await signIn(prisma, { label: 'screenroundtrip' });
    const bot = await app.get(BotsService).create(owner.userId, {
      name: `${BOT_PREFIX}-${randomUUID().slice(0, 8)}`,
      role: 'R',
      avatarColor: '#123456',
      systemPrompt: 'x',
    });
    botId = bot.id;

    const started = await app.get(SandboxService).start(owner.userId, botId);
    expect(started.state).toBe('RUNNING');
    const attached = await prisma.bot.findFirstOrThrow({
      where: { id: botId, userId: owner.userId },
      select: { sandbox: { select: { id: true, sessionId: true } } },
    });
    computerId = attached.sandbox?.id;
    sessionId = attached.sandbox?.sessionId ?? undefined;

    await watchWindow(port);
    ws.send(
      JSON.stringify({
        id: randomUUID(),
        type: 'screen.control',
        ts: Date.now(),
        payload: { botId, action: 'take' },
      }),
    );
    await waitFor(() => controlGranted, 'the human control grant');
    renew = setInterval(
      () =>
        ws.send(
          JSON.stringify({
            id: randomUUID(),
            type: 'screen.control',
            ts: Date.now(),
            payload: { botId, action: 'renew', epoch: controlEpoch },
          }),
        ),
      10000,
    );
  }, BOOT_MS);

  afterAll(async () => {
    clearInterval(renew);
    ws?.close();
    const provider = app?.get<SandboxProvider>(SANDBOX_PROVIDER);
    // A desktop left running outlives this run and the row that named it.
    await provider
      ?.attachSession({ sessionId: sessionId ?? '' })
      .then((attached) => attached?.destroy())
      .catch(() => undefined);
    // D-039: destroying the runtime deliberately leaves the workspace, so the
    // suite removes its own. After the container, never before it — Docker
    // refuses to remove a volume that is still attached.
    await promisify(execFile)('docker', [
      'volume',
      'rm',
      '--force',
      `crewaid-workspace-${computerId}`,
    ]).catch(() => undefined);
    if (owner !== undefined) await signOutAndDelete(prisma, owner.userId);
    delete process.env['SANDBOX_HEALTH_INTERVAL_MS'];
    await app?.close();
  }, BOOT_MS);

  it(
    'types proof.txt into the terminal the pointer selected (§5, R6)',
    async () => {
      const desktop = await session();

      // Setup, not the thing under test: §5's own wording is "click the
      // terminal icon", and which pixel that icon occupies is a plank layout
      // question rather than an input one. Launching the terminals directly
      // keeps the assertion on the input path.
      await inSandbox(`mkdir -p ${TERMINALS[1].dir}`);
      for (const terminal of TERMINALS) {
        await inSandbox(
          `nohup xfce4-terminal --disable-server --geometry=${terminal.geometry} ` +
            `--working-directory=${terminal.dir} >/dev/null 2>&1 &`,
        );
      }
      // `wmctrl -l` lists MAPPED windows. Waiting on the process instead would
      // open a window of most of a second in which a click lands on whatever
      // is still underneath.
      await waitFor(
        async () => (await inSandbox('wmctrl -lx | grep -ci xfce4-terminal || true')) === '2',
        'both terminals to map',
      );

      // The precondition the negative assertion rests on: the SECOND terminal
      // holds focus, so nothing typed now would reach the first one.
      const focusedX = async (): Promise<number> =>
        Number(
          /^X=(-?\d+)$/m.exec(
            await inSandbox('xdotool getwindowfocus getwindowgeometry --shell'),
          )?.[1] ?? Number.NaN,
        );
      await waitFor(async () => (await focusedX()) > 400, 'the second terminal to take focus');

      await clickAt(TERMINALS[0].clickAt.x, TERMINALS[0].clickAt.y);

      // Asserted from inside the sandbox, before anything is typed: this is the
      // PointerEvent's own effect, separate from whatever the keystrokes do.
      await waitFor(async () => (await focusedX()) < 400, 'the click to move focus');

      await type('touch proof.txt');
      send(keyEvent(true, XK_RETURN));
      send(keyEvent(false, XK_RETURN));

      // §5's assertion, through the session's own read path.
      await waitFor(async () => {
        if (inputErrors.length > 0)
          throw new Error(`Screen input was refused: ${JSON.stringify(inputErrors)}`);
        return (await desktop.readTextFile({ path: '/home/bot/proof.txt' })) !== null;
      }, 'typing to create /home/bot/proof.txt');

      // And the negative control that makes the pointer load-bearing: the
      // command carried no path, so this is where it would have landed had the
      // click done nothing.
      await expect(desktop.readTextFile({ path: '/home/bot/b/proof.txt' })).resolves.toBeNull();
    },
    BOOT_MS,
  );

  it(
    'an orchestrator restart does not grant over a replay still running in the computer',
    async () => {
      clearInterval(renew);
      ws.send(
        JSON.stringify({
          id: randomUUID(),
          type: 'screen.control',
          ts: Date.now(),
          payload: { botId, action: 'release', epoch: controlEpoch },
        }),
      );
      await waitFor(() => !controlGranted, 'hand-back before replay');
      const desktop = await session();
      const endpoint = await desktop.getPortEndpoint({ port: 7070 });
      const replayUrl = new URL(`/skill/run?botId=${encodeURIComponent(botId)}`, endpoint.url);
      const headers = { ...endpoint.headers, 'Content-Type': 'application/json' };
      const oldReplay = fetch(replayUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          script: `import { writeFile, access } from 'node:fs/promises';
        export default async () => {
          await writeFile('/home/bot/replay-started', 'started');
          const deadline = Date.now() + 20000;
          while (Date.now() < deadline) {
            try { await access('/home/bot/replay-finish'); return 'finished'; } catch {}
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          throw new Error('fixture replay was not released');
        }`,
          params: {},
        }),
        signal: AbortSignal.timeout(30000),
      });
      // Catch transport failure immediately so it cannot become an unhandled rejection.
      const outcome = oldReplay.then(async (response) => ({
        status: response.status,
        body: (await response.json()) as unknown,
      }));
      void outcome.catch(() => undefined);
      try {
        await waitFor(
          async () => (await desktop.readTextFile({ path: '/home/bot/replay-started' })) !== null,
          'the old runner to start',
        );
        ws.close();
        await app.close();
        controlGranted = false;
        inputErrors.length = 0;
        const port = await bootApp();
        await watchWindow(port);
        ws.send(
          JSON.stringify({
            id: randomUUID(),
            type: 'screen.control',
            ts: Date.now(),
            payload: { botId, action: 'take' },
          }),
        );
        await waitFor(() => inputErrors.length > 0, 'the old replay to prevent a control grant');
        expect(controlGranted).toBe(false);
        expect(inputErrors).toContainEqual(expect.objectContaining({ code: 'DRAIN_TIMEOUT' }));
        expect(app.get(SeatControlService).seats.stateFor(ws, botId)).toMatchObject({
          mode: 'agent',
          observationRequired: true,
        });
        await desktop.run({ command: 'touch /home/bot/replay-finish' });
        expect(await outcome).toMatchObject({
          status: 200,
          body: { ok: true, result: 'finished' },
        });
        inputErrors.length = 0;
        ws.send(
          JSON.stringify({
            id: randomUUID(),
            type: 'screen.control',
            ts: Date.now(),
            payload: { botId, action: 'take' },
          }),
        );
        await waitFor(() => controlGranted, 'control after the old replay exits');
        const blocked = await fetch(replayUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ script: 'export default async () => 1', params: {} }),
        });
        expect(blocked.status).toBe(409);
        expect(await blocked.json()).toMatchObject({ code: 'HUMAN_IN_CONTROL' });
      } finally {
        await desktop.run({ command: 'touch /home/bot/replay-finish' }).catch(() => undefined);
        await outcome.catch(() => undefined);
      }
    },
    BOOT_MS,
  );
});
