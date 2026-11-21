import { toolReach } from '../src/agent/tool-registry.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { ToolSet } from '../src/agent/tool-contract.js';
import {
  MockLanguageModelV4,
  scriptModel,
  simulateReadableStream,
} from './model-resolution-fake.js';
import type { ScriptPart as LanguageModelV4StreamPart } from './model-resolution-fake.js';

import { ToolRegistry, type ToolContext } from '../src/agent/tool-registry.js';
import type { BotMessageJobData } from '../src/interbot/bot-message.queue.js';
import { BotMessageDeliveryService } from '../src/interbot/bot-message.delivery.service.js';
import { PrismaPeerDirectory } from '../src/interbot/peer-directory.js';
import { sendMessageTool } from '../src/interbot/send-message.tool.js';
import { TaskContext } from '../src/interbot/task-context.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import { FakeProvider } from './sandbox-fakes.js';

/**
 * M10-BE-06 — the task tools and `send_message`'s task context, through the
 * real registry and a real database (D-138).
 *
 * What is under test is what PRD-WORK §10 asks for: any bot can change any of
 * the user's tasks and the log names it; tools see no other user's rows;
 * nothing a tool does to a task starts a turn; and a task named on a
 * delegated message — or inherited from the turn's own trigger — lands on the
 * recipient's message, while `null` clears it and a foreign id sends nothing.
 */
const DATABASE_URL = process.env['DATABASE_URL'];

function replyModel(): MockLanguageModelV4 {
  const usage = { inputTokens: { total: 4 }, outputTokens: { total: 2 } };
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'tools-model',
    doStream: async () => {
      const chunks: LanguageModelV4StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'ok' },
        { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
      ];
      return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }) };
    },
  });
}

let app: INestApplication;
let prisma: PrismaService;
let registry: ToolRegistry;
let ACTOR: SignedInUser;
let FOREIGN: SignedInUser;

type Bot = { id: string; name: string; conversationId: string };

describe.skipIf(!DATABASE_URL)('M10-BE-06 — task tools', () => {
  beforeAll(async () => {
    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('../src/app.module.js');
    const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SANDBOX_PROVIDER)
      .useValue(new FakeProvider())
      .compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new CrewaidWsAdapter(app));
    await app.init();
    scriptModel(app, () => replyModel());
    prisma = app.get(PrismaService);
    registry = app.get(ToolRegistry);
    ACTOR = await signIn(prisma, { label: 'work-tools' });
    FOREIGN = await signIn(prisma, { label: 'work-tools-foreign' });
  }, 60_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      await signOutAndDelete(prisma, ACTOR.userId);
      await signOutAndDelete(prisma, FOREIGN.userId);
    }
    await app?.close();
  });

  async function bot(owner: SignedInUser, name: string): Promise<Bot> {
    const row = await prisma.bot.create({
      data: {
        userId: owner.userId,
        name: `${name}-${randomUUID().slice(0, 6)}`,
        role: 'R',
        avatarColor: '#123456',
        systemPrompt: '',
      },
    });
    const conversation = await prisma.conversation.create({ data: { botId: row.id } });
    return { id: row.id, name: row.name, conversationId: conversation.id };
  }

  /** A turn's context: a trigger message and the BOT reply being composed. */
  async function turn(owner: SignedInUser, who: Bot, triggerTaskId: string | null = null) {
    const trigger = await prisma.message.create({
      data: {
        conversationId: who.conversationId,
        author: 'USER',
        content: 'go',
        taskId: triggerTaskId,
      },
    });
    const reply = await prisma.message.create({
      data: { conversationId: who.conversationId, author: 'BOT', fromBotId: who.id, content: '' },
    });
    const context = {
      userId: owner.userId,
      botId: who.id,
      attachmentHost: () => Promise.resolve(reply.id),
      trigger: { id: trigger.id, chainId: null, hopCount: 0 },
      browser: () => Promise.reject(new Error('no browser')),
      session: () => Promise.reject(new Error('no computer')),
      useIdentity: () => Promise.reject(new Error('no identity')),
    } as ToolContext;
    return { context, replyId: reply.id, tools: registry.toolSetFor(context) };
  }

  async function call(
    tools: ToolSet,
    name: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const tool = tools[name];
    if (tool?.execute === undefined) throw new Error(`${name} is not registered`);
    const result: unknown = await tool.execute(input, { toolCallId: randomUUID(), messages: [] });
    return String(result);
  }

  const idOf = (text: string) => /\b(c[a-z0-9]{20,})\b/.exec(text)?.[1] ?? '';

  it('is registered as five contained tools', () => {
    for (const name of ['task_list', 'task_read', 'task_create', 'task_update', 'project_create']) {
      expect(toolReach(registry.behaviorOf(name)), name).toBe('contained');
    }
  });

  it('lets a bot split work for others, starting nothing, attributed to it', async () => {
    const pm = await bot(ACTOR, 'PM');
    const backend = await bot(ACTOR, 'Backend');
    const frontend = await bot(ACTOR, 'Frontend');
    const { tools, replyId } = await turn(ACTOR, pm);
    const messagesBefore = await prisma.message.count({
      where: { conversation: { bot: { userId: ACTOR.userId } } },
    });

    const project = await call(tools, 'project_create', {
      name: 'Acme SaaS',
      goal: 'Ship the MVP',
    });
    expect(project).toMatch(/Created project .* with goal/);
    const auth = idOf(
      await call(tools, 'task_create', { title: 'API auth', assignee: backend.name }),
    );
    const login = idOf(
      await call(tools, 'task_create', { title: 'Login page', assignee: frontend.name }),
    );

    const row = await prisma.task.findUniqueOrThrow({ where: { id: auth } });
    expect(row).toMatchObject({
      status: 'TODO',
      origin: 'BOT',
      createdByBotId: pm.id,
      assigneeBotId: backend.id,
    });
    expect(
      await prisma.taskEvent.findFirst({ where: { taskId: auth, type: 'CREATED' } }),
    ).toMatchObject({
      actor: 'BOT',
      actorBotId: pm.id,
      actorLabel: pm.name,
      messageId: replyId,
    });
    expect(login).not.toBe('');
    // Rows appeared; no message and no turn did.
    expect(
      await prisma.message.count({ where: { conversation: { bot: { userId: ACTOR.userId } } } }),
    ).toBe(messagesBefore);
    expect(await prisma.agentTurn.count({ where: { bot: { userId: ACTOR.userId } } })).toBe(0);

    // Backend lists its own open work by default, and changes a task the PM made.
    const mine = await turn(ACTOR, backend);
    expect(await call(mine.tools, 'task_list', {})).toContain('API auth');
    expect(await call(mine.tools, 'task_list', {})).not.toContain('Login page');
    await call(mine.tools, 'task_update', {
      taskId: auth,
      status: 'done',
      note: 'JWT with refresh tokens',
    });
    const events = await prisma.taskEvent.findMany({
      where: { taskId: auth, actorBotId: backend.id },
    });
    expect(events.map((event) => event.type).sort()).toEqual(['NOTE', 'STATUS_CHANGED']);
    expect(events.every((event) => event.messageId === mine.replyId)).toBe(true);

    // Any bot, any task — Frontend reopens Backend's.
    const theirs = await turn(ACTOR, frontend);
    await call(theirs.tools, 'task_update', {
      taskId: auth,
      status: 'IN_PROGRESS',
      note: 'Missing logout',
    });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: auth } })).status).toBe(
      'IN_PROGRESS',
    );

    const read = await call(theirs.tools, 'task_read', { taskId: auth });
    expect(read).toContain('API auth');
    expect(read).toContain('Missing logout');
  });

  it('keeps a blocked note as the reason, recurs from one string, and lists by date', async () => {
    const coach = await bot(ACTOR, 'Coach');
    const { tools } = await turn(ACTOR, coach);
    const task = idOf(await call(tools, 'task_create', { title: 'Order parts', assignee: 'me' }));
    await call(tools, 'task_update', { taskId: task, status: 'BLOCKED', note: 'Supplier closed' });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task } })).blockedReason).toBe(
      'Supplier closed',
    );

    expect(
      await call(tools, 'task_create', { title: 'Work out', repeat: 'every morning' }),
    ).toMatch(/repeat must be/);
    const made = await call(tools, 'task_create', {
      title: 'Log weight',
      repeat: '0 8 * * * America/New_York until 2027-03-31',
    });
    expect(made).toMatch(/Created recurring task/);
    const series = await prisma.taskSeries.findFirstOrThrow({
      where: { userId: ACTOR.userId, title: 'Log weight' },
    });
    expect(series).toMatchObject({
      cron: '0 8 * * *',
      timezone: 'America/New_York',
      endsOn: '2027-03-31',
      origin: 'BOT',
    });

    for (const [day, status] of [
      ['2026-09-20', 'DONE'],
      ['2026-09-21', 'TODO'],
      ['2026-09-27', 'DONE'],
    ] as const) {
      await prisma.task.create({
        data: {
          userId: ACTOR.userId,
          title: 'Log weight',
          seriesId: series.id,
          occursOn: day,
          occursAt: new Date(`${day}T12:00:00Z`),
          status,
          rank: 'i',
        },
      });
    }
    const week = await call(tools, 'task_list', {
      assignee: 'any',
      status: 'any',
      seriesId: series.id,
      occursFrom: '2026-09-20',
      occursThrough: '2026-09-26',
    });
    expect(week.split('\n')).toHaveLength(2);
    expect(week).toContain('[DONE]');
    expect(week).toContain('[TODO]');
  });

  it("never shows or touches another user's rows", async () => {
    const mineBot = await bot(ACTOR, 'Mine');
    const theirBot = await bot(FOREIGN, 'Theirs');
    const theirs = await turn(FOREIGN, theirBot);
    const secret = idOf(
      await call(theirs.tools, 'task_create', { title: 'Their secret plan', assignee: 'me' }),
    );

    const { tools } = await turn(ACTOR, mineBot);
    expect(await call(tools, 'task_list', { assignee: 'any', status: 'any' })).not.toContain(
      'Their secret plan',
    );
    expect(await call(tools, 'task_read', { taskId: secret })).toMatch(/There is no task/);
    expect(await call(tools, 'task_update', { taskId: secret, status: 'DONE' })).toMatch(
      /There is no task/,
    );
    expect(await call(tools, 'task_create', { title: 'x', parentId: secret })).toMatch(
      /not found/i,
    );
    expect(await call(tools, 'task_create', { title: 'x', assignee: theirBot.name })).toMatch(
      /There is no bot/,
    );
    expect((await prisma.task.findUniqueOrThrow({ where: { id: secret } })).status).toBe('TODO');
  });

  describe('send_message task context', () => {
    function sender(captured: BotMessageJobData[]) {
      return sendMessageTool({
        queue: { enqueue: (job) => Promise.resolve(void captured.push(job)) },
        directory: app.get(PrismaPeerDirectory),
        notice: { post: () => Promise.resolve() },
        budget: {
          spentTokens: () => Promise.resolve(0),
          sendsBetween: () => Promise.resolve(0),
          participatedInChain: () => Promise.resolve(false),
        },
        limits: { maxHops: 0, maxTokens: 0, maxRepeatSends: 0 },
        tasks: app.get(TaskContext),
      });
    }

    async function send(
      context: ToolContext,
      captured: BotMessageJobData[],
      input: Record<string, unknown>,
    ) {
      const built = sender(captured).build(context);
      if (built.execute === undefined) throw new Error('no execute');
      return String(await built.execute(input, { toolCallId: randomUUID(), messages: [] }));
    }

    it('inherits the turn’s task, clears it on null, and refuses a foreign one', async () => {
      const pm = await bot(ACTOR, 'Lead');
      const backend = await bot(ACTOR, 'Worker');
      const task = await prisma.task.create({
        data: { userId: ACTOR.userId, title: 'API auth', rank: 'i' },
      });
      const theirTask = await prisma.task.create({
        data: { userId: FOREIGN.userId, title: 'x', rank: 'i' },
      });
      const { context } = await turn(ACTOR, pm, task.id);
      const captured: BotMessageJobData[] = [];

      await send(context, captured, { toBot: backend.name, content: 'work on API auth' });
      await send(context, captured, { toBot: backend.name, content: 'unrelated', taskId: null });
      await send(context, captured, { toBot: backend.name, content: 'explicit', taskId: task.id });
      expect(
        await send(context, captured, { toBot: backend.name, content: 'x', taskId: theirTask.id }),
      ).toMatch(/There is no task .* nothing was sent/);
      expect(captured.map((job) => job.taskId)).toEqual([task.id, null, task.id]);

      // Delivery writes it onto the recipient's message — and re-checks it.
      const delivery = app.get(BotMessageDeliveryService);
      const first = captured[0];
      if (first === undefined) throw new Error('nothing captured');
      const outcome = await delivery.deliver(first);
      expect(outcome.kind).toBe('delivered');
      const delivered = await prisma.message.findFirstOrThrow({
        where: { conversationId: backend.conversationId, fromBotId: pm.id },
      });
      expect(delivered.taskId).toBe(task.id);

      await prisma.task.delete({ where: { id: task.id } });
      const late = captured[2];
      if (late === undefined) throw new Error('nothing captured');
      await delivery.deliver(late);
      // Found by what it says after reading: stored text is sealed (D-236).
      const thread = await prisma.message.findMany({
        where: { conversationId: backend.conversationId },
      });
      const after = thread.find((row) => row.content === 'explicit');
      expect(after).toBeDefined();
      expect(after?.taskId).toBeNull();
    }, 60_000);
  });
});
