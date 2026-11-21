import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { WebSocket } from 'ws';
import {
  MockLanguageModelV4,
  scriptModel,
  simulateReadableStream,
} from './model-resolution-fake.js';
import type { ScriptPart as LanguageModelV4StreamPart } from './model-resolution-fake.js';
import type { INestApplication } from '@nestjs/common';
import { workspaceVolumeNameFor } from '@crewaid/sandbox-docker';
import {
  SCREEN_STREAM_PATH,
  ScreenGrantResponseSchema,
  ScreenStreamServerMessageSchema,
} from '@crewaid/shared';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { BotsService } from '../src/bots/bots.service.js';
import { SandboxService } from '../src/sandbox/sandbox.service.js';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../src/sandbox/sandbox.provider.js';
import { chatBody, threadOf } from './chat-fixture.js';
import { signIn } from './auth-fixture.js';

/**
 * M5-QA-10 — two bots on one computer, end to end.
 *
 * D-046 put several bots on one machine, and rests on three claims. Each is
 * provable somewhere already, and each is provable there only in part:
 *
 *   PARALLEL   M5-BE-18 showed two seats have distinct CDP targets, X windows
 *              and RFB streams, INSIDE the machine. What it could not show is
 *              two TURNS running at once and each driving its own browser —
 *              the thing an operator actually does, and the thing that breaks
 *              if a seat is resolved from anything but the acting bot's id.
 *   HANDOFF    The shared workspace is asserted by `shared-computer-docker`
 *              through the provider. Through the AGENT it is not: the claim
 *              that makes a team is one bot writing and another READING, with
 *              no message between them, which is a claim about the tools.
 *   SCREENS    Each bot's grant names its OWN seat, and the stream it opens
 *              shows that seat's desktop. `screen-stream-host` drives a fake
 *              upstream; this is two real seats behind real grants.
 *
 * Plus the negative that makes the boundary real: a bot on a DIFFERENT
 * computer sees neither the file nor the screen. Without it "shared" is
 * unfalsifiable — everything would also pass if every bot shared everything.
 *
 * ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
 *
 * The board note also asks for the M4 capture suites to be re-run against a
 * machine that HAS seats, since they still drive a seatless one and exercise
 * the no-seat fallback rather than M5-BE-24's filter. That is not done here
 * and is recorded on the task: those suites do not pass on this machine even
 * on `main`, so running them would measure the environment rather than the
 * filter.
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

/** A real session (V1-08): the chat route answers a signed-in user, never the static token. */
let USER_ID: string;
let TOKEN: string;

/** Two cold boots of a full XFCE desktop and a Chrome, plus a slow host. */
const BOOT_MS = 360_000;

const FIXTURE_PORT = 7575;
const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;
const FIXTURE_SERVER_PATH = '/home/bot/qa10-fixture-server.mjs';
const FIXTURE_SERVER_LOG = '/home/bot/qa10-fixture-server.log';

/**
 * Two pages whose accessibility trees cannot be mistaken for each other.
 *
 * The parallel claim is asserted by which heading each bot read back, so the
 * headings carry the whole weight: anything a fresh tab or the tool's own
 * plumbing could produce would make a stolen target look like a success.
 */
const PAGES: Record<string, { heading: string; body: string }> = {
  '/alpha': { heading: 'Alpha quarterly pricing', body: 'The Alpha plan costs 11 credits.' },
  '/beta': { heading: 'Beta quarterly pricing', body: 'The Beta plan costs 22 credits.' },
};

function fixtureServerSource(): string {
  return `import { createServer } from 'node:http';

const PAGES = ${JSON.stringify(PAGES)};

createServer((request, response) => {
  const path = (request.url ?? '/').split('?')[0];
  const page = PAGES[path];
  if (page === undefined) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + page.heading +
    '</title></head><body><h1>' + page.heading + '</h1><p>' + page.body + '</p></body></html>');
}).listen(${FIXTURE_PORT}, '127.0.0.1', () => {
  console.log('qa10 fixture listening on ${FIXTURE_ORIGIN}');
});
`;
}

const run = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Act =
  { readonly call: string; readonly input?: Record<string, unknown> } | { readonly say: string };

/**
 * One scripted model per BOT, not one for the suite.
 *
 * The parallel case runs two turns at once, and a single shared script would
 * hand whichever turn called first whatever act happened to be at the front
 * of the queue — a test that passes or fails on scheduling. Keyed by bot id,
 * each turn consumes only its own bot's acts.
 */
function scriptedModels(): {
  resolve: () => MockLanguageModelV4;
  load: (botId: string, ...acts: Act[]) => void;
  promptsFor: (botId: string) => unknown[];
  /** The bot whose turn is being served, set by the harness before each send. */
  serving: (botId: string) => void;
} {
  const acts = new Map<string, Act[]>();
  const prompts = new Map<string, unknown[]>();
  let current = '';
  let calls = 0;
  const usage = { inputTokens: { total: 3 }, outputTokens: { total: 2 } };

  const model = new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'mock-qa10-model',
    doStream: async (options: { prompt?: unknown }) => {
      // Which bot this call belongs to is read off the prompt rather than off
      // `current`: two turns run at once here, and `current` is whoever was
      // sent last. The system prompt carries the bot's own name, which is the
      // one thing in the prompt that differs between them.
      const text = JSON.stringify(options.prompt ?? '');
      const botId = [...acts.keys()].find((id) => text.includes(`bot-marker-${id}`)) ?? current;
      (prompts.get(botId) ?? []).push(options.prompt);
      calls += 1;
      const queue = acts.get(botId) ?? [];
      const act = queue.shift() ?? { say: 'the script ran out' };
      const chunks: LanguageModelV4StreamPart[] =
        'say' in act
          ? [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: act.say },
              { type: 'text-end', id: 't' },
              { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: `qa10-call-${calls}`,
                toolName: act.call,
                input: JSON.stringify(act.input ?? {}),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage,
              },
            ];
      return {
        stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }),
      };
    },
  });

  return {
    resolve: () => model,
    load: (botId, ...next) => {
      acts.set(botId, [...next]);
      prompts.set(botId, []);
    },
    promptsFor: (botId) => prompts.get(botId) ?? [],
    serving: (botId) => {
      current = botId;
    },
  };
}

/** Every tool result the model was handed, once each, in the order it ran. */
function toolResults(prompts: readonly unknown[]): Array<{ toolName: string; output: string }> {
  const found: Array<{ toolName: string; output: string }> = [];
  const seen = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    if (record['type'] === 'tool-result') {
      const id = String(record['toolCallId'] ?? '');
      if (!seen.has(id)) {
        seen.add(id);
        found.push({
          toolName: String(record['toolName'] ?? ''),
          output: JSON.stringify(record['output'] ?? null).slice(0, 20_000),
        });
      }
    }
    for (const item of Object.values(record)) walk(item);
  };
  walk(prompts);
  return found;
}

async function until<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  what: string,
  ms = 60_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

describe.skipIf(SKIP)('M5-QA-10 two bots on one computer', () => {
  let app: INestApplication;
  let port: number;
  let prisma: PrismaService;
  let bots: BotsService;
  let sandboxes: SandboxService;
  let provider: SandboxProvider;
  let script: ReturnType<typeof scriptedModels>;

  /** Two tenants of one machine, and a third on a machine of its own. */
  let alpha = '';
  let beta = '';
  let outsider = '';
  let shared = '';
  let elsewhere = '';
  const createdBotIds: string[] = [];
  const createdComputerIds: string[] = [];

  /**
   * A bot's screen as the app opens it: a grant, then a stream socket that
   * acks every mark. Counts the framebuffer updates it is shown.
   */
  async function openStream(
    bot: string,
  ): Promise<{ readonly socket: WebSocket; readonly seatPort: number; updates: number }> {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/bots/${bot}/screen/grant`)
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(response.status).toBe(200);
    const grant = ScreenGrantResponseSchema.parse(response.body);
    expect(grant.endpoint).toEqual({ kind: 'orchestrator' });
    const claims = JSON.parse(
      Buffer.from(grant.ticket.split('.')[0] ?? '', 'base64url').toString('utf8'),
    ) as { port: number };
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}${SCREEN_STREAM_PATH}?ticket=${encodeURIComponent(grant.ticket)}&quality=5`,
    );
    const stream = { socket, seatPort: claims.port, updates: 0 };
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        if (data[0] === 0) stream.updates += 1;
        return;
      }
      const message = ScreenStreamServerMessageSchema.parse(JSON.parse(data.toString()));
      if (message.t === 'mark') socket.send(JSON.stringify({ t: 'ack', seq: message.seq }));
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return stream;
  }

  async function stateOf(computer: string): Promise<string> {
    const row = await prisma.sandbox.findUniqueOrThrow({
      where: { id: computer },
      select: { state: true },
    });
    return row.state;
  }

  /**
   * A person's message, and the id of the run that answers it (D-160: the
   * client's run id is the run's). Not awaited past the send: two of these run
   * at once, and the response streams for as long as its run works.
   */
  async function send(bot: string, content: string): Promise<string> {
    script.serving(bot);
    const body = chatBody(await threadOf(prisma, bot), content);
    void request(app.getHttpServer())
      .post(`/api/v1/bots/${bot}/chat`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(body)
      .then(
        () => undefined,
        () => undefined,
      );
    return body.runId;
  }

  async function settledTurn(runId: string): Promise<{ status: string }> {
    return until(
      async () => {
        const turn = await prisma.agentTurn.findFirst({
          where: { id: runId },
          select: { status: true },
        });
        if (turn === null) return undefined;
        return turn.status === 'running' || turn.status === 'interrupted'
          ? undefined
          : { status: turn.status };
      },
      `run ${runId} to settle`,
      BOOT_MS,
    );
  }

  /** A machine running, with the fixture served on it. Idempotent. */
  async function machineReady(computer: string, viaBot: string): Promise<void> {
    if ((await stateOf(computer)) !== 'RUNNING') await sandboxes.start(USER_ID, viaBot);
    const session = await provider.attachSession({ sessionId: computer });
    if (session === null) throw new Error(`no container is attached to ${computer}`);
    const serving = async (): Promise<boolean> => {
      const probe = await session.run({
        command: `curl -fsS -o /dev/null -w '%{http_code}' ${FIXTURE_ORIGIN}/alpha || true`,
      });
      return probe.stdout.trim() === '200';
    };
    if (await serving()) return;
    await session.writeTextFile({ path: FIXTURE_SERVER_PATH, content: fixtureServerSource() });
    await session.spawn({
      command: `nohup node ${FIXTURE_SERVER_PATH} > ${FIXTURE_SERVER_LOG} 2>&1 &`,
    });
    await until(
      async () => ((await serving()) ? true : undefined),
      `the fixture to answer on ${FIXTURE_ORIGIN}`,
    );
  }

  beforeAll(async () => {
    process.env['ARTIFACT_DIR'] ??= mkdtempSync(join(tmpdir(), 'crewaid-qa10-artifacts-'));

    script = scriptedModels();
    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('../src/app.module.js');
    const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useWebSocketAdapter(new CrewaidWsAdapter(app));
    await app.listen(0);
    port = (app.getHttpServer().address() as { port: number }).port;
    scriptModel(app, () => script.resolve());

    prisma = app.get(PrismaService);
    ({ token: TOKEN, userId: USER_ID } = await signIn(prisma, { label: 'm5qa10' }));
    bots = app.get(BotsService);
    sandboxes = app.get(SandboxService);
    provider = app.get(SANDBOX_PROVIDER);
    await prisma.user.upsert({
      where: { id: USER_ID },
      create: { id: USER_ID, name: 'Test User', email: `${USER_ID}@test.invalid` },
      update: {},
    });

    /**
     * The system prompt carries a marker the model can read back.
     *
     * Two turns run at the same time here, so "which bot is this provider call
     * for" cannot be answered by a variable the harness set before the send —
     * by the time the second call arrives, that variable is the second bot.
     * The prompt is the only thing that differs per turn, so the marker goes
     * in it.
     */
    async function newBot(label: string): Promise<string> {
      const bot = await bots.create(USER_ID, {
        name: `m5qa10-${label}-${randomUUID().slice(0, 8)}`,
        role: 'Tenant',
        avatarColor: '#A78BFA',
        systemPrompt: `You are ${label}.`,
        autoReviewRules: [{ toolPattern: '*', decision: 'allow' }],
      });
      createdBotIds.push(bot.id);
      await prisma.bot.update({
        where: { id: bot.id },
        data: { systemPrompt: `You are ${label}. bot-marker-${bot.id}` },
      });
      return bot.id;
    }

    async function newComputer(): Promise<string> {
      const computer = await prisma.sandbox.create({
        data: { userId: USER_ID },
        select: { id: true },
      });
      createdComputerIds.push(computer.id);
      await provider.provisionWorkspace({ botId: computer.id });
      return computer.id;
    }

    alpha = await newBot('Alpha');
    beta = await newBot('Beta');
    outsider = await newBot('Outsider');
    shared = await newComputer();
    elsewhere = await newComputer();
    // Two tenants on one machine is the subject; the third is the boundary.
    await prisma.bot.updateMany({
      where: { id: { in: [alpha, beta] } },
      data: { sandboxId: shared },
    });
    await prisma.bot.update({ where: { id: outsider }, data: { sandboxId: elsewhere } });
  }, BOOT_MS);

  afterAll(async () => {
    for (const id of createdBotIds) {
      await prisma?.bot.delete({ where: { id } }).catch(() => null);
    }
    for (const id of createdComputerIds) {
      for (const runtime of await provider.listManagedSessions()) {
        if (runtime.botId === id) {
          await provider.removeManagedSession({ containerId: runtime.containerId }).catch(() => {});
        }
      }
      await prisma?.sandbox.delete({ where: { id } }).catch(() => null);
      await run('docker', ['volume', 'rm', workspaceVolumeNameFor(id)]).catch(() => null);
    }
    await app?.close();
  }, BOOT_MS);

  it(
    'runs both tenants at once and neither drives the other’s browser',
    async () => {
      await machineReady(shared, alpha);

      script.load(
        alpha,
        { call: 'browser_navigate', input: { url: `${FIXTURE_ORIGIN}/alpha` } },
        { call: 'browser_read' },
        { say: 'Alpha is on its own page.' },
      );
      script.load(
        beta,
        { call: 'browser_navigate', input: { url: `${FIXTURE_ORIGIN}/beta` } },
        { call: 'browser_read' },
        { say: 'Beta is on its own page.' },
      );

      // Started together rather than one after the other. Sequential turns
      // would pass even if the second bot simply inherited the first's
      // window, which is the failure D-046 has to rule out.
      const alphaMessage = await send(alpha, `open ${FIXTURE_ORIGIN}/alpha and read it`);
      const betaMessage = await send(beta, `open ${FIXTURE_ORIGIN}/beta and read it`);
      const [alphaTurn, betaTurn] = await Promise.all([
        settledTurn(alphaMessage),
        settledTurn(betaMessage),
      ]);
      expect(alphaTurn.status).toBe('completed');
      expect(betaTurn.status).toBe('completed');

      const alphaRead = toolResults(script.promptsFor(alpha)).find(
        (result) => result.toolName === 'browser_read',
      );
      const betaRead = toolResults(script.promptsFor(beta)).find(
        (result) => result.toolName === 'browser_read',
      );

      // Each bot read ITS page, and — the half that matters — not the other's.
      // A stolen target shows up here as both reads naming the same heading.
      expect(alphaRead?.output).toContain('Alpha quarterly pricing');
      expect(alphaRead?.output).not.toContain('Beta quarterly pricing');
      expect(betaRead?.output).toContain('Beta quarterly pricing');
      expect(betaRead?.output).not.toContain('Alpha quarterly pricing');
    },
    BOOT_MS,
  );

  it(
    'hands work from one tenant to the other with no message between them',
    async () => {
      await machineReady(shared, alpha);

      const entry = `- [ ] Priced by Alpha at ${randomUUID().slice(0, 8)}`;
      script.load(alpha, { call: 'board_add', input: { entry } }, { say: 'On the board.' });
      expect((await settledTurn(await send(alpha, 'put it on the board'))).status).toBe(
        'completed',
      );

      // Beta is told nothing about what Alpha did. The only path between them
      // is the machine they share — no §4.2 frame, no send_message, no
      // conversation in common.
      script.load(beta, { call: 'board_read' }, { say: 'Read the board.' });
      expect((await settledTurn(await send(beta, 'what is on the board?'))).status).toBe(
        'completed',
      );

      const read = toolResults(script.promptsFor(beta)).find(
        (result) => result.toolName === 'board_read',
      );
      expect(read?.output).toContain(entry.slice(0, 40));
    },
    BOOT_MS,
  );

  it(
    'gives each tenant a stream of its own seat',
    async () => {
      await machineReady(shared, alpha);

      const alphaStream = await openStream(alpha);
      const betaStream = await openStream(beta);
      try {
        // Two grants on one machine name two seats — two displays, two
        // x11vncs — and each stream shows its own. A seat resolved from
        // anything but the bot's id would name one port twice.
        expect(alphaStream.seatPort).not.toBe(betaStream.seatPort);
        await until(
          () => (alphaStream.updates > 0 && betaStream.updates > 0 ? true : undefined),
          'a picture on each tenant’s stream',
        );
      } finally {
        alphaStream.socket.close();
        betaStream.socket.close();
      }
    },
    BOOT_MS,
  );

  it(
    'shows a bot on another computer neither the file nor the screen',
    async () => {
      await machineReady(shared, alpha);
      await machineReady(elsewhere, outsider);

      // Alpha writes here rather than relying on the handoff case above.
      // An absence is only evidence when the thing is present somewhere: run
      // alone, this case would assert that the outsider cannot see a board
      // nobody had written, and pass however the boundary behaved. The
      // falsification run caught exactly that — the mutation that puts every
      // bot on one computer left this case green.
      const secret = `- [ ] Priced by Alpha at ${randomUUID().slice(0, 8)}`;
      script.load(alpha, { call: 'board_add', input: { entry: secret } }, { say: 'On the board.' });
      expect((await settledTurn(await send(alpha, 'put it on the board'))).status).toBe(
        'completed',
      );
      const alphaRead = toolResults(script.promptsFor(alpha)).find(
        (result) => result.toolName === 'board_add',
      );
      expect(alphaRead?.output).toContain('Added to');

      // The board Alpha wrote to is on the shared machine's volume. The
      // outsider reads the same PATH on a different machine, which is the
      // whole of the boundary: same tool, same path, different volume.
      script.load(outsider, { call: 'board_read' }, { say: 'Nothing here.' });
      expect((await settledTurn(await send(outsider, 'what is on the board?'))).status).toBe(
        'completed',
      );
      const read = toolResults(script.promptsFor(outsider)).find(
        (result) => result.toolName === 'board_read',
      );
      expect(read?.output).not.toContain(secret);
      expect(read?.output).toContain('does not exist yet');

      // And the screen. The outsider's grant names its own computer's seat,
      // and its stream shows a desktop; that the bytes come from the right
      // CONTAINER is M5-BE-18's claim, proved inside the machine, because two
      // freshly booted identical desktops are a weaker instrument than that.
      const stream = await openStream(outsider);
      try {
        await until(
          () => (stream.updates > 0 ? true : undefined),
          'a picture on the outsider’s stream',
        );
      } finally {
        stream.socket.close();
      }
    },
    BOOT_MS,
  );
});
