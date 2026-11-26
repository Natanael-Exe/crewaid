import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { FakeProvider } from './sandbox-fakes.js';
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { GenericContainer, Wait, getContainerRuntimeClient } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { MockLanguageModelV4, scriptModel } from './model-resolution-fake.js';
import type { ScriptPart as LanguageModelV4StreamPart } from './model-resolution-fake.js';
import type { INestApplication } from '@nestjs/common';
import { EventType } from '@tanstack/ai';
import { ServerFrameSchema, type ServerFrame } from '@crewaid/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { BotsService } from '../src/bots/bots.service.js';
import { sendChat } from './chat-fixture.js';
import { signIn } from './auth-fixture.js';

/**
 * M1-QA-03 — one message, end to end, on a database this test owns.
 *
 * PRD M1 required tests: "Integration (Testcontainers Postgres, model stubbed
 * with the AI SDK's mock provider): send a message via REST, assert the
 * `message.created` → `message.delta`* → `message.completed` sequence on a
 * connected WS client, and assert final DB state."
 *
 * Since D-199 a person's message is a `POST /bots/:id/chat`, and the run that
 * answers it streams over that response as AG-UI events; the §4.2 socket
 * still carries the bot's status. The send, the stream and the settled rows
 * are what is asserted.
 *
 * Why a container and not the ambient Postgres every other integration suite
 * uses: those suites are `describe.skipIf(DATABASE_URL === undefined)`, so a
 * developer who forgets to export it gets a green run with 85 tests silently
 * gone — the D-017 failure class, one layer up. This suite provisions its own
 * Postgres and applies the migration history to it, so there is no environment
 * in which it can quietly not run. Two things fall out for free: the migration
 * history is proven against a VIRGIN database rather than one that happens to
 * be migrated already, and the run is immune to the cross-suite row pollution
 * that a shared database invites.
 *
 * Redis is in the PRD's line for this test but not in this assertion set: no
 * orchestrator code opens a Redis connection in M1 (readiness is CC-02), so a
 * Redis container here would be a process nothing talks to.
 */

const TRIGGER = 'walk the whole lifecycle';
const REPLY = 'Crewaid reads the whole lifecycle back to you.';
const REASONING = 'The operator wants the full path exercised.';
let TOKEN: string;

/** Whoever this suite signs in as — its rows are owned by that user. */
let USER_ID: string;
const ORCHESTRATOR_ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * A container runtime is the one thing this suite cannot provision for itself.
 * Missing locally, that is a legitimate skip; missing in CI it is the exact
 * silent-green failure the suite exists to prevent, so CI fails instead.
 */
async function containerRuntime(): Promise<{ available: boolean; reason: string }> {
  try {
    await getContainerRuntimeClient();
    return { available: true, reason: '' };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

const runtime = await containerRuntime();
if (!runtime.available && process.env['CI'] !== undefined && process.env['CI'] !== '') {
  throw new Error(
    `M1-QA-03 needs a container runtime and CI must never skip it: ${runtime.reason}`,
  );
}

/**
 * Reasoning ahead of the text, so `content` is a MULTI-part array. A one-part
 * array cannot tell "stored verbatim" apart from "wrapped in a single part",
 * and only the text half may reach the transcript as deltas.
 */
function lifecycleModel(): MockLanguageModelV4 {
  const chunks: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'reasoning-start', id: 'r1' },
    { type: 'reasoning-delta', id: 'r1', delta: REASONING },
    { type: 'reasoning-end', id: 'r1' },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: REPLY.slice(0, 16) },
    { type: 'text-delta', id: 't1', delta: REPLY.slice(16, 31) },
    { type: 'text-delta', id: 't1', delta: REPLY.slice(31) },
    { type: 'text-end', id: 't1' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 9, text: 9, reasoning: 0 },
      },
    },
  ];
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'mock-lifecycle-model',
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    }),
  });
}

async function connect(port: number): Promise<{ socket: WebSocket; frames: ServerFrame[] }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(TOKEN)}`);
  const frames: ServerFrame[] = [];
  socket.on('message', (data: Buffer) => {
    const frame = ServerFrameSchema.safeParse(JSON.parse(data.toString()));
    // A frame the shared schema rejects is one the renderer would drop
    // silently; §4.2 is enforced in both directions, so fail loudly here.
    expect(frame.success).toBe(true);
    if (frame.success) frames.push(frame.data);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return { socket, frames };
}

/**
 * The client's `open` fires when the 101 arrives, which can precede the server
 * handler that registers the socket with the fan-out. An answered frame proves
 * registration, so no part of the turn can start before this socket is listed.
 */
async function registered(socket: WebSocket): Promise<void> {
  const id = randomUUID();
  const answered = new Promise<void>((resolve) => {
    const onMessage = (data: Buffer): void => {
      const frame = ServerFrameSchema.safeParse(JSON.parse(data.toString()));
      if (frame.success && frame.data.type === 'error' && frame.data.id === id) {
        socket.off('message', onMessage);
        resolve();
      }
    };
    socket.on('message', onMessage);
  });
  socket.send(JSON.stringify({ id, type: 'not.a.real.event', ts: Date.now(), payload: {} }));
  await answered;
}

async function until<T>(probe: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const found = probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// @skip-reason: needs a container runtime; hard-fails instead of skipping in CI.
describe.skipIf(!runtime.available)('M1-QA-03 full message lifecycle (own Postgres)', () => {
  let container: StartedTestContainer;
  let app: INestApplication;
  let prisma: PrismaService;
  let port: number;
  let botId: string;
  let previousDatabaseUrl: string | undefined;
  /** Every frame the connected window saw, in arrival order. */
  let frames: ServerFrame[];
  /** The run's AG-UI events, as the chat response streamed them. */
  let events: Array<{ type: string; delta?: string }>;
  let sentUserMessageId: string;

  beforeAll(async () => {
    container = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_USER: 'crewaid',
        POSTGRES_PASSWORD: 'crewaid',
        POSTGRES_DB: 'crewaid',
      })
      .withExposedPorts(5432)
      // The data directory is thrown away with the container, so paying for
      // durable writes buys nothing and costs seconds on every turn.
      .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
      // Postgres announces readiness TWICE: once for the bootstrap instance
      // initdb runs on a unix socket, then again after the restart that opens
      // TCP. Waiting for the first would connect before the port is listening.
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();

    const url = `postgresql://crewaid:crewaid@${container.getHost()}:${container.getMappedPort(
      5432,
    )}/crewaid?schema=public`;

    // The same command CI runs, against a database with no schema at all — so
    // this also proves the migration history applies from empty, which the
    // ambient-Postgres suites cannot say (theirs is already migrated).
    try {
      execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
        cwd: ORCHESTRATOR_ROOT,
        env: { ...process.env, DATABASE_URL: url, MIGRATION_DATABASE_URL: url },
        stdio: 'pipe',
      });
    } catch (error) {
      // Piped output is invisible by default, and a migration that fails
      // inside beforeAll otherwise surfaces as "Command failed" with no cause
      // — the same opacity that makes a broken hook read as a broken test.
      const shell = error as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(
        `prisma migrate deploy failed against the test container:\n${
          shell.stderr?.toString() ?? ''
        }\n${shell.stdout?.toString() ?? ''}`,
      );
    }

    // PrismaService reads DATABASE_URL in its constructor, so this has to be
    // set before the module compiles — and restored in afterAll, because a
    // vitest worker is reused across files.
    previousDatabaseUrl = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = url;

    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('../src/app.module.js');
    const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');
    const model = lifecycleModel();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SANDBOX_PROVIDER)
      .useValue(new FakeProvider())
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useWebSocketAdapter(new CrewaidWsAdapter(app));
    await app.listen(0);
    port = (app.getHttpServer().address() as { port: number }).port;
    scriptModel(app, () => model);

    prisma = app.get(PrismaService);
    // V1-08: a real session for a real user, in place of the static
    // ORCH_API_TOKEN every request used to carry.
    ({ token: TOKEN, userId: USER_ID } = await signIn(prisma, { label: 'lifecycle' }));
    const bot = await app.get(BotsService).create(USER_ID, {
      name: `qa03-${randomUUID().slice(0, 8)}`,
      role: 'Lifecycle Subject',
      avatarColor: '#3A7D44',
      systemPrompt: 'you are under test',
    });
    botId = bot.id;

    // The lifecycle runs ONCE, here, and each `it` below asserts a different
    // facet of it. Doing the send inside the first test instead would make the
    // later ones silently depend on it having run — so `vitest run -t` on any
    // one of them, which this repo documents as a normal workflow, would fail
    // against a bot that never received a message.
    const client = await connect(port);
    await registered(client.socket);
    frames = client.frames;

    const sent = await sendChat(app.getHttpServer(), {
      prisma,
      headers: { Authorization: `Bearer ${TOKEN}` },
      botId,
      content: TRIGGER,
    });
    expect(sent.response.status).toBe(200);
    sentUserMessageId = sent.body.messages[0]!.id;
    events = sent.response.text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)) as { type: string; delta?: string });

    // IDLE is the first frame that means the TURN is over rather than the
    // reply: the run writes its terminal row, then drains its status chain.
    await until(
      () => frames.find((frame) => frame.type === 'bot.status' && frame.payload.status === 'IDLE'),
      'bot.status IDLE',
    );
    client.socket.close();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    if (previousDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = previousDatabaseUrl;
  }, 60_000);

  it('applies the migration history to an empty database', async () => {
    // Not ceremony: every other integration suite runs against a database
    // someone already migrated, so nothing else in the repo proves the history
    // replays from nothing. A migration that only works on an existing
    // database fails here and nowhere else.
    const applied = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
      'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name',
    );
    expect(applied.length).toBeGreaterThan(0);
    const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const names = tables.map((row) => row.table_name);
    for (const required of ['User', 'Bot', 'Conversation', 'Message', 'AgentTurn']) {
      expect(names).toContain(required);
    }
  });

  it('streams one run over the chat response, and its status over the socket', () => {
    // The order a client renders from: the run opens, answers, ends.
    // Provider reasoning stays internal to the execution engine and is excluded
    // from public SSE events.
    const shape = events
      .map((event) => event.type)
      .filter((type, index, all) => type !== all[index - 1]);
    expect(shape[0]).toBe(EventType.RUN_STARTED);
    expect(shape.at(-1)).toBe(EventType.RUN_FINISHED);
    expect(shape).not.toContain(EventType.REASONING_MESSAGE_CONTENT);

    const joined = (type: string) =>
      events
        .filter((event) => event.type === type)
        .map((event) => event.delta ?? '')
        .join('');
    expect(joined(EventType.TEXT_MESSAGE_CONTENT)).toBe(REPLY);
    expect(joined(EventType.REASONING_MESSAGE_CONTENT)).toBe('');

    // CC-25: a turn opens THINKING and ends IDLE on the §4.2 socket.
    const statuses = frames
      .filter((frame) => frame.type === 'bot.status')
      .map((frame) => frame.payload.status);
    expect(statuses[0]).toBe('THINKING');
    expect(statuses.at(-1)).toBe('IDLE');
    expect(frames.filter((frame) => frame.type !== 'error').every((f) => f.botId === botId)).toBe(
      true,
    );
  });

  it('settles the database: two messages, a completed run, a released fence', async () => {
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { botId } });
    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(messages.map((message) => message.author)).toEqual(['USER', 'BOT']);

    const [userMessage, botMessage] = messages;
    expect(userMessage?.content).toBe(TRIGGER);
    expect(userMessage?.fromBotId).toBeNull();
    expect(userMessage?.id).toBe(sentUserMessageId);

    expect(botMessage?.content).toBe(REPLY);
    expect(botMessage?.fromBotId).toBe(botId);

    const turn = await prisma.agentTurn.findFirstOrThrow({ where: { botId } });
    expect(turn.status).toBe('completed');
    expect(turn.triggerMessageId).toBe(sentUserMessageId);
    // §3: activeKey is the nullable-unique fence for one running turn per bot.
    // A completed turn that kept it would lock the bot out of every later turn.
    expect(turn.activeKey).toBeNull();
    expect(botMessage?.runId).toBe(turn.id);
  });
});
