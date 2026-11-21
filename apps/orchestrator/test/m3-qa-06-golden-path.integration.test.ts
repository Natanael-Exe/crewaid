import { SeatControlService } from '../src/screen/seat-control.service.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { WebSocket } from 'ws';
import { encodeScreenBinaryFrame } from '@crewaid/shared';

import { waitForSettledPage } from './m3-qa-06-settle.js';

/**
 * M3-QA-06 — the golden path, with the real parts (PRD §6/M3).
 *
 *   "record 'open Chrome, go to example.com, screenshot the page', then run
 *    the generated skill on a freshly restarted sandbox and reach the same
 *    final page", run twice to check determinism.
 *
 * ── WHAT IS REAL HERE ───────────────────────────────────────────────────────
 *
 * Everything on the product's path except the Electron renderer: the app
 * (in-process, the same `AppModule` every suite boots — the real Docker
 * sandbox provider, the real RFB input path, the real BullMQ compile worker,
 * the real skill executor in the container), a REAL sandbox container from
 * `SANDBOX_IMAGE`, a REAL recording tee over the §4.2 WebSocket (the exact
 * wire the desktop sends), and a REAL model: the compile goes to
 * `DEFAULT_MODEL_ID` through `resolveModel` — no mock provider anywhere.
 *
 * The input half of "record" is driven over the real WS wire because that is
 * what the desktop app does (M2-QA-05's proof.txt test owns that chain); the
 * renderer's own legs — teach/stop controls, the review surface — are
 * M3-FE-01/02's committed e2e. What no other test owns is the full span:
 * demonstrate on a live desktop → compile with the real model → approve →
 * run the generated skill on a FRESHLY RESTARTED sandbox → the same page.
 *
 * "Open Chrome" is the image's own boot state: the entrypoint launches Chrome
 * before the bridge answers (infra/sandbox-image), so the demonstrated task is
 * the operator's: click the omnibox, type the address, Return. "Screenshot
 * the page" is how the outcome is judged — the run's own evidence is the
 * screenshot captured after each execution plus the CDP target read.
 *
 * Determinism: ONE recording, ONE compile, and the generated skill executed
 * TWICE, each time on a sandbox that was stopped and started again (Chrome
 * reboots to its New Tab page; the persisted profile must NOT hand the skill
 * a free pass). Both executions must reach the same final page; the two
 * screenshots and CDP reads are compared. The guard waits for the page to
 * STOP MOVING (expected url + title held across two identical reads) before
 * it records anything — never the instant the URL first matches (PR #108
 * HOLD fix; the settle logic lives in m3-qa-06-settle.ts).
 *
 * ── WHY IT IS @slow (D-017) ─────────────────────────────────────────────────
 *
 * It needs a Docker daemon, the built `crewaid/sandbox` image, a live PostgreSQL,
 * Redis (the compile queue runs for real in this process) and REAL provider
 * credentials. CI does not have the sandbox image or model keys, so the suite
 * is skipped there and belongs to the nightly population PRD §6 names. To run:
 *
 *   set -a; source infra/compose/.env; set +a
 *   export DATABASE_URL=... (a scratch database) CREWAID_DOCKER_TESTS=1
 *   export CREWAID_QA_EVIDENCE_DIR=/tmp/qa06/evidence   # optional, for artefacts
 *   pnpm --filter @crewaid/orchestrator exec vitest run test/m3-qa-06-golden-path.integration.test.ts
 *
 * @skip-reason: @slow nightly — real Docker + real model + live DB/Redis.
 * Without the full set above the suite skips by design.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const REDIS_URL = process.env['REDIS_URL'];
const DOCKER_TESTS = process.env['CREWAID_DOCKER_TESTS'];
const MODEL_ENV = [
  'DEFAULT_MODEL_ID',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
] as const;
const missingModelEnv = MODEL_ENV.filter((name) => {
  const value = process.env[name];
  return value === undefined || value === '';
});
const SKIP =
  DATABASE_URL === undefined ||
  DATABASE_URL === '' ||
  REDIS_URL === undefined ||
  REDIS_URL === '' ||
  DOCKER_TESTS === undefined ||
  DOCKER_TESTS === '' ||
  missingModelEnv.length > 0;

const TOKEN = 'm3-qa-06-golden-path-token';
const BOT_PREFIX = 'm3qa06';
/** Entrypoint boot of a full desktop (Chrome + XFCE), with slack for a slow host. */
const BOOT_MS = 240_000;
/** §6's compile bound is 60 s per model call; the queue adds latency around it. */
const COMPILE_MS = 300_000;
/** One restarted desktop plus one skill run, generously bounded. */
const RUN_MS = 600_000;

/** The task the operator states before demonstrating (PRD §6/M3, verbatim). */
const INTENT = 'open Chrome, go to example.com, screenshot the page';
/** The omnibox on a booted 1280x800 desktop, measured against the real image. */
const OMNIBOX = { x: 555, y: 72 };
const EXPECTED_URL = 'https://example.com/';
const EXPECTED_TITLE = 'Example Domain';
/** The literal the operator demonstrated into the omnibox; the URL parameter's value. */
const DEMONSTRATED_URL = 'example.com';

const EVIDENCE_DIR = process.env['CREWAID_QA_EVIDENCE_DIR'];

function saveEvidence(name: string, data: string | Buffer): void {
  if (EVIDENCE_DIR === undefined || EVIDENCE_DIR === '') return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, name);
  writeFileSync(file, data);
  // The narrative rides the evidence itself: vitest drops test stdout when its
  // own stdout is a pipe, so the phase line lands in a file the suite owns.
  appendFileSync(
    path.join(EVIDENCE_DIR, 'narrative.log'),
    `${new Date().toISOString()} ${name} (${typeof data === 'string' ? data.length : data.byteLength} B)\n`,
  );
  console.log(`[qa06] evidence: ${file}`);
}

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

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

describe.skipIf(SKIP)('M3-QA-06 golden path — real sandbox, real model, run twice', () => {
  let app: INestApplication;
  let prisma: import('../src/prisma/prisma.service.js').PrismaService;
  let port: number;
  let botId: string;
  let recordingId: string;
  let skillId: string;
  let skillScript: string;
  /** The values the operator supplies for the compiled skill's parameters. */
  const skillParams: Record<string, unknown> = {};
  /** The recording's stored event counts, carried into the final summary. */
  let recordingCounts: { x11: number; cdp: number; atspi: number } | null = null;
  let ws: WebSocket;
  /** Every JSON frame the socket received, in order — the §4.2 wire, verbatim. */
  const wsFrames: { type: string; payload: unknown }[] = [];
  /** Phase timings for the report; milliseconds. */
  const timeline: Record<string, number> = {};
  interface RunRecord {
    index: number;
    baselineUrl: string | null;
    runId: string;
    status: string | null;
    error: string | null;
    logs: string | null;
    finalUrl: string | null;
    finalTitle: string | null;
    restartedChromeWasFresh: boolean;
    durationMs: number;
  }
  const runs: RunRecord[] = [];
  /** Env values as this file found them; restored in afterAll. */
  const previousEnv = new Map<string, string | undefined>();

  const api = async <T>(
    method: 'GET' | 'POST',
    route: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> => {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${route}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = (text === '' ? null : JSON.parse(text)) as T;
    return { status: response.status, body: parsed };
  };

  const sandboxState = async (): Promise<string | null> => {
    const answer = await api<{ state: string }>('GET', `/bots/${botId}/sandbox`);
    return answer.body?.state ?? null;
  };

  /** The sandbox's own view of itself, through the real provider session. */
  const inSandbox = async (command: string): Promise<string> => {
    const { SANDBOX_PROVIDER } = await import('../src/sandbox/sandbox.provider.js');
    const provider = app.get<{
      resumeSession(input: { sessionId: string }): Promise<{
        run(input: { command: string }): Promise<{ stdout: string }>;
      } | null>;
    }>(SANDBOX_PROVIDER);
    const session = await provider.resumeSession({ sessionId: botId });
    if (session === null) throw new Error('no container is attached to the scratch bot');
    const result = await session.run({ command });
    return result.stdout.trim();
  };

  /**
   * Chrome's targets, read from inside the container over this bot's SEAT.
   *
   * This read `127.0.0.1:9222` until D-060, when the machine stopped running a
   * browser of its own — every bot's seat has one now, on its own relay, and
   * 9222 answers nothing. The seat's port is asked for rather than computed:
   * the bridge hands out the slot, and a test that assumed 9301 would pass on a
   * machine with one bot and silently read someone else's browser on a machine
   * with two.
   */
  const cdpTargets = async (): Promise<{ url: string; title: string }[]> => {
    const seatRaw = await inSandbox(
      `curl -fsS --max-time 3 'http://127.0.0.1:7070/seats?botId=${botId}'`,
    );
    const seat = (JSON.parse(seatRaw) as { seat?: { cdpPort?: number } }).seat;
    if (typeof seat?.cdpPort !== 'number') {
      throw new Error(`bot ${botId} has no seat to read targets from: ${seatRaw}`);
    }
    const raw = await inSandbox(
      `curl -fsS --max-time 3 http://127.0.0.1:${seat.cdpPort}/json/list`,
    );
    return JSON.parse(raw) as { url: string; title: string }[];
  };

  const pageTarget = async (): Promise<{ url: string; title: string } | null> => {
    const targets = await cdpTargets();
    return (
      targets.find((target) => target.url.startsWith('http')) ??
      targets.find((target) => target.url.startsWith('chrome://newtab')) ??
      null
    );
  };

  /** Capture the desktop as the operator sees it; returns the PNG, or null. */
  const captureScreen = async (): Promise<Buffer | null> => {
    try {
      // `--overwrite` is load-bearing: scrot exits 0 while leaving an existing
      // file untouched, so a stale capture would masquerade as a fresh one.
      const raw = await inSandbox(
        'scrot --overwrite /tmp/qa06-shot.png >/dev/null 2>&1 && base64 -w0 /tmp/qa06-shot.png',
      );
      return Buffer.from(raw, 'base64');
    } catch (error: unknown) {
      console.log(`[qa06] screenshot failed: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  };

  const send = (rfb: Uint8Array): void => {
    ws.send(encodeScreenBinaryFrame(botId, rfb), { binary: true });
  };

  const clickAt = async (x: number, y: number): Promise<void> => {
    send(pointerEvent(0, x, y));
    await sleep(120);
    send(pointerEvent(0b1, x, y));
    await sleep(80);
    send(pointerEvent(0, x, y));
  };

  const typeText = async (text: string): Promise<void> => {
    for (const character of text) {
      send(keyEvent(true, keysymOf(character)));
      send(keyEvent(false, keysymOf(character)));
      await sleep(40);
    }
    await sleep(250);
  };

  const pressReturn = async (): Promise<void> => {
    send(keyEvent(true, XK_RETURN));
    await sleep(60);
    send(keyEvent(false, XK_RETURN));
  };

  /** The documented demonstration: the omnibox, the address, Return. */
  const demonstrate = async (): Promise<void> => {
    await clickAt(OMNIBOX.x, OMNIBOX.y);
    await sleep(400);
    await typeText('example.com');
    await pressReturn();
    // The settle guard, not just the URL match, so the capture that follows
    // is a painted page (PR #108 HOLD: a URL match can precede the render).
    await waitForSettledPage(
      pageTarget,
      { url: EXPECTED_URL, title: EXPECTED_TITLE },
      'the demonstrated page to settle on example.com',
      { timeoutMs: 30_000 },
    );
  };

  beforeAll(async () => {
    // The queue's worker is disabled for the whole vitest run (vitest.config.mts)
    // so no suite consumes another's compile jobs. THIS suite is the exception:
    // it exists to watch one real compile run, so the flag is on before the
    // app module (and its conditional `@Processor` wiring) is ever imported.
    // Both values are restored at the end so later files see the run's own env.
    previousEnv.set('SKILL_COMPILE_WORKER', process.env['SKILL_COMPILE_WORKER']);
    previousEnv.set('ORCH_API_TOKEN', process.env['ORCH_API_TOKEN']);
    previousEnv.set('ARTIFACT_DIR', process.env['ARTIFACT_DIR']);
    process.env['SKILL_COMPILE_WORKER'] = 'true';
    process.env['ORCH_API_TOKEN'] = TOKEN;
    process.env['ARTIFACT_DIR'] ??= path.join(
      tmpdir(),
      `crewaid-m3qa06-${randomUUID().slice(0, 8)}`,
    );

    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('../src/app.module.js');
    const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');
    const { BotsService } = await import('../src/bots/bots.service.js');
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { SINGLETON_USER_ID } = await import('../src/auth/singleton-user.js');
    // No `overrideProvider`: the real Docker provider and the real registry are
    // the two halves this suite exists to exercise together.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useWebSocketAdapter(new CrewaidWsAdapter(app));
    await app.listen(0);
    port = (app.getHttpServer().address() as { port: number }).port;

    prisma = app.get(PrismaService);
    await prisma.user.upsert({
      where: { id: SINGLETON_USER_ID },
      create: {
        id: SINGLETON_USER_ID,
        name: 'Test User',
        email: `${SINGLETON_USER_ID}@test.invalid`,
      },
      update: {},
    });
    await prisma.bot.deleteMany({ where: { name: { startsWith: `${BOT_PREFIX}-` } } });

    const created = await app.get(BotsService).create(SINGLETON_USER_ID, {
      name: `${BOT_PREFIX}-${randomUUID().slice(0, 8)}`,
      role: 'Golden path',
      avatarColor: '#1f6feb',
      systemPrompt: 'Reproduces the M3 golden path.',
    });
    botId = created.id;
    app.get(SeatControlService).seats.observed(botId);
    console.log(`[qa06] bot ${botId} created; waking its computer to record`);

    const wakeStart = Date.now();
    const started = await api<{ recordingId: string }>('POST', `/bots/${botId}/recordings`, {
      intent: INTENT,
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    recordingId = started.body.recordingId;
    timeline.wakeToRecordingMs = Date.now() - wakeStart;
    expect(await sandboxState()).toBe('RUNNING');
    console.log(`[qa06] recording ${recordingId} live after ${timeline.wakeToRecordingMs} ms`);

    ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      // Pixels have a stream of their own; nothing binary comes this way.
      if (isBinary) return;
      try {
        const frame = JSON.parse(data.toString()) as { type: string; payload: unknown };
        wsFrames.push({ type: frame.type, payload: frame.payload });
      } catch {
        /* not our contract's problem in a test */
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
    // Membership is what authorises input (D-036); the seat's control state,
    // sent to every new watcher, is the proof the subscription took, since
    // §4.2 sends no other acknowledgement.
    await waitFor(
      () => wsFrames.some((frame) => frame.type === 'screen.control.state'),
      'the seat control state',
      60_000,
    );
  }, BOOT_MS);

  it('records the golden path on a live desktop and compiles it with the real model', async () => {
    const demoStart = Date.now();
    await demonstrate();
    timeline.demoMs = Date.now() - demoStart;
    const baseline = await captureScreen();
    if (baseline !== null) saveEvidence('01-demonstrated-page.png', baseline);
    console.log(`[qa06] demonstrated in ${timeline.demoMs} ms`);

    // The trace must exist before the compile can mean anything: the give-away
    // would be a "successful" compile of an empty or single-event trace.
    await sleep(600);
    const stopStart = Date.now();
    const stopped = await api<{ state: string; counts: { x11: number }; error: string | null }>(
      'POST',
      `/recordings/${recordingId}/stop`,
    );
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(stopped.body.state).toBe('COMPILING');
    expect(stopped.body.counts.x11, 'the tee must have captured real input').toBeGreaterThan(4);
    console.log(
      `[qa06] capture ended: ${stopped.body.counts.x11} X11 rows in the trace; compiling`,
    );

    // The real model compiles through the real BullMQ queue in this process.
    let status: {
      state: string;
      error: string | null;
      skillId: string | null;
      counts: { x11: number; cdp: number; atspi: number };
    } | null = null;
    await waitFor(
      async () => {
        const answer = await api<typeof status>('GET', `/recordings/${recordingId}`);
        status = answer.body;
        return status?.state === 'READY' || status?.state === 'FAILED';
      },
      'the compile to settle',
      COMPILE_MS,
    );
    timeline.compileMs = Date.now() - stopStart;
    if (status === null) throw new Error('unreachable: waitFor resolved without a status');
    // Assigned inside the poll closure; re-read through a settled alias so
    // every assertion below is on the value that ended the wait.
    const settledStatus = status as {
      state: string;
      error: string | null;
      skillId: string | null;
      counts: { x11: number; cdp: number; atspi: number };
    };
    recordingCounts = settledStatus.counts;
    console.log(
      `[qa06] compile settled ${settledStatus.state} in ${timeline.compileMs} ms ` +
        `(error: ${settledStatus.error ?? 'none'})`,
    );
    saveEvidence('recording-settled.json', JSON.stringify(settledStatus, null, 2));
    expect(settledStatus.state, `recording error: ${settledStatus.error ?? 'none'}`).toBe('READY');
    expect(settledStatus.error).toBeNull();
    expect(settledStatus.skillId, 'a READY recording names the skill it compiled').not.toBeNull();
    skillId = settledStatus.skillId as string;
    timeline.compiledSkillVersion = 0; // overwritten by the skill read below

    type SkillRow = {
      id: string;
      name: string;
      description: string;
      script: string;
      version: number;
      status: string;
      sourceRecordingId: string | null;
      paramsSchema: unknown;
    };
    const skill = await api<SkillRow>('GET', `/skills/${skillId}`);
    expect(skill.status).toBe(200);
    skillScript = skill.body.script;
    timeline.compiledSkillVersion = skill.body.version;
    console.log(
      `[qa06] compiled skill ${skill.body.name} v${skill.body.version} ` +
        `(${skill.body.status}) — script:\n${skillScript}`,
    );
    saveEvidence('skill-v1.ts', skillScript);
    saveEvidence('skill-v1.json', JSON.stringify(skill.body, null, 2));
    expect(skill.body.status).toBe('DRAFT');
    expect(skill.body.version).toBe(1);
    expect(skill.body.sourceRecordingId).toBe(recordingId);
    expect(skill.body.name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(skill.body.script).not.toMatch(/sleep\(|setTimeout\(/);

    // The skill's parameters are part of its contract, and the compiler
    // prompt DIRECTS the model to turn a URL into one — so running the skill
    // means supplying the value the operator demonstrated. This is that
    // step: fill the URL-shaped parameters with the demonstrated site, and
    // refuse to invent anything else the schema demands.
    const schema = skill.body.paramsSchema as {
      required?: string[];
      properties?: Record<string, { description?: string }>;
    };
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      const describesUrl =
        /url|address|website|site|link/i.test(name) ||
        /url|address|website|site/i.test(property.description ?? '');
      if (describesUrl) {
        skillParams[name] = DEMONSTRATED_URL;
      } else if ((schema.required ?? []).includes(name)) {
        throw new Error(
          `the compiler asked for a required parameter this suite cannot invent: ` +
            `${name} (${property.description ?? 'no description'})`,
        );
      }
    }
    console.log(`[qa06] skill parameters for the run: ${JSON.stringify(skillParams)}`);
    saveEvidence(
      'skill-params.json',
      JSON.stringify({ schema: skill.body.paramsSchema, supplied: skillParams }, null, 2),
    );

    // The compiled frame must have crossed the §4.2 wire — that is how the
    // operator learns a draft is ready.
    const compiledFrame = wsFrames.find((frame) => frame.type === 'skill.compiled');
    expect(compiledFrame, 'skill.compiled was never received on the wire').toBeDefined();
    expect(wsFrames.some((frame) => frame.type === 'recording.state')).toBe(true);

    // §6: a DRAFT skill cannot be run — and the refusal must be the state's,
    // not a crash. Then the operator approves.
    const refused = await api<{ message: string }>('POST', `/skills/${skillId}/run`, {
      params: {},
    });
    expect(refused.status).toBe(409);
    console.log(`[qa06] DRAFT run refused with 409: ${refused.body.message}`);

    const approved = await api<{ status: string }>('POST', `/skills/${skillId}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('APPROVED');
    console.log('[qa06] skill approved');

    saveEvidence(
      'timeline.json',
      JSON.stringify({ timeline, counts: settledStatus.counts, frames: wsFrames }, null, 2),
    );
  }, 480_000);

  /** Stop → start: the skill must work from a desktop that never saw the demo. */
  const freshlyRestartSandbox = async (index: number): Promise<{ baselineUrl: string | null }> => {
    const restartStart = Date.now();
    const stop = await api<{ state: string }>('POST', `/bots/${botId}/sandbox/stop`);
    expect(stop.status, JSON.stringify(stop.body)).toBe(200);
    await waitFor(async () => (await sandboxState()) === 'STOPPED', 'sandbox STOPPED', 120_000);
    const start = await api<{ state: string }>('POST', `/bots/${botId}/sandbox/start`);
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    await waitFor(async () => (await sandboxState()) === 'RUNNING', 'sandbox RUNNING', BOOT_MS);
    timeline[`restart${index}Ms`] = Date.now() - restartStart;

    // The fresh desktop must hand the skill the same start the demo had — and
    // NOT the demonstrated result: a restored example.com would make the run
    // vacuous. Wait (bounded) for Chrome to be back on, and settled on, its
    // New Tab page. No title is pinned: the NTP's own chrome varies by build.
    const settledBaseline = await waitForSettledPage(
      pageTarget,
      { url: 'chrome://newtab/' },
      'the restarted Chrome to settle on its New Tab page',
      { timeoutMs: 30_000 },
    );
    const baselineUrl = settledBaseline.url;
    const freshShot = await captureScreen();
    if (freshShot !== null) saveEvidence(`run-${index}-baseline.png`, freshShot);
    console.log(
      `[qa06] run ${index}: sandbox restarted in ${timeline[`restart${index}Ms`]} ms; ` +
        `Chrome baseline ${baselineUrl}`,
    );
    return { baselineUrl };
  };

  const executeSkill = async (index: number, baselineUrl: string | null): Promise<void> => {
    const runStart = Date.now();
    const started = await api<{ runId: string }>('POST', `/skills/${skillId}/run`, {
      params: skillParams,
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const runId = started.body.runId;
    console.log(`[qa06] run ${index}: skill run ${runId} accepted`);

    let row: {
      status: string;
      error: string | null;
      logs: string | null;
      params: unknown;
      startedAt: string | null;
      endedAt: string | null;
    } | null = null;
    await waitFor(
      async () => {
        const answer = await api<typeof row>('GET', `/skills/${skillId}/runs/${runId}`);
        row = answer.body;
        return row?.status === 'SUCCEEDED' || row?.status === 'FAILED';
      },
      `skill run ${index} to settle`,
      RUN_MS,
    );
    if (row === null) throw new Error('unreachable: waitFor resolved without a run row');
    // `row` is assigned inside the poll closure; re-read it through a settled
    // alias so every assertion below is on the value that ended the wait.
    const settled = row as {
      status: string;
      error: string | null;
      logs: string | null;
      params: unknown;
    };
    const durationMs = Date.now() - runStart;
    expect(settled.params, 'the run row must carry the operator-supplied parameters').toEqual(
      skillParams,
    );
    console.log(
      `[qa06] run ${index}: ${settled.status} in ${durationMs} ms; error: ${settled.error ?? 'none'}\n` +
        `logs:\n${settled.logs ?? '(none)'}`,
    );
    saveEvidence(`run-${index}-row.json`, JSON.stringify(settled, null, 2));
    expect(settled.status, `run ${index} failed: ${settled.error ?? 'no error recorded'}`).toBe(
      'SUCCEEDED',
    );
    expect(settled.error).toBeNull();

    // The acceptance: the same final page, whatever the trace's waits were —
    // and whenever the run row settled. A run can settle SUCCEEDED while its
    // navigation is still visibly in flight (PR #108 HOLD: `url` flipped,
    // title and pixels still the New Tab page), so the guard waits for the
    // page to STOP MOVING (expected url + title held across two identical
    // reads) and FAILS on timeout — it never records a mid-flight instant.
    const final = await waitForSettledPage(
      pageTarget,
      { url: EXPECTED_URL, title: EXPECTED_TITLE },
      `run ${index} to settle on example.com ("${EXPECTED_TITLE}")`,
      { timeoutMs: 60_000 },
    );
    const finalShot = await captureScreen();
    if (finalShot !== null) saveEvidence(`run-${index}-final.png`, finalShot);
    const record: RunRecord = {
      index,
      baselineUrl,
      runId,
      status: settled.status,
      error: settled.error,
      logs: settled.logs,
      finalUrl: final.url,
      finalTitle: final.title,
      restartedChromeWasFresh: baselineUrl === 'chrome://newtab/',
      durationMs,
    };
    runs.push(record);
    saveEvidence(`run-${index}.json`, JSON.stringify(record, null, 2));
    console.log(`[qa06] run ${index}: final page ${record.finalUrl} — "${record.finalTitle}"`);
  };

  it(
    'runs the generated skill on a freshly restarted sandbox — first run',
    async () => {
      const { baselineUrl } = await freshlyRestartSandbox(1);
      await executeSkill(1, baselineUrl);
    },
    RUN_MS + 120_000,
  );

  it(
    'runs it again for determinism — same page from a second fresh restart',
    async () => {
      const { baselineUrl } = await freshlyRestartSandbox(2);
      await executeSkill(2, baselineUrl);

      expect(runs).toHaveLength(2);
      const [first, second] = runs as [RunRecord, RunRecord];
      // Determinism, in the terms the criterion sets: same page, twice, from
      // two desktops that never saw the demonstration.
      expect(first.restartedChromeWasFresh && second.restartedChromeWasFresh).toBe(true);
      expect(second.finalUrl).toBe(first.finalUrl);
      expect(second.finalTitle).toBe(first.finalTitle);
      expect([first.finalUrl, second.finalUrl]).toEqual([EXPECTED_URL, EXPECTED_URL]);
      saveEvidence('runs.json', JSON.stringify(runs, null, 2));
      saveEvidence(
        'runs-summary.json',
        JSON.stringify({ timeline, counts: recordingCounts, frames: wsFrames, runs }, null, 2),
      );
    },
    RUN_MS + 120_000,
  );

  afterAll(async () => {
    try {
      ws?.close();
    } catch {
      /* already gone */
    }
    const { SANDBOX_PROVIDER } = await import('../src/sandbox/sandbox.provider.js');
    const provider = app?.get<{
      attachSession(input: { sessionId: string }): Promise<{ destroy(): Promise<void> } | null>;
    }>(SANDBOX_PROVIDER);
    // A desktop left running outlives this run and the row that named it.
    await provider
      ?.attachSession({ sessionId: botId })
      .then((attached) => attached?.destroy())
      .catch(() => undefined);
    // D-039: destroying the runtime deliberately leaves the workspace, so the
    // suite removes its own. After the container, never before it.
    await promisify(execFile)('docker', [
      'volume',
      'rm',
      '--force',
      `crewaid-workspace-${botId}`,
    ]).catch(() => undefined);
    await prisma?.bot.deleteMany({ where: { name: { startsWith: `${BOT_PREFIX}-` } } });
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await app?.close();
  }, BOOT_MS);
});
