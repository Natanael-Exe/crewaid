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

import { AgentAttachmentService } from '../src/agent/agent-attachment.service.js';
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
 * M10-QA-01 — PRD-WORK §0.2's reference scenario, step by step, through the
 * real registry, the real delivery path and a real database, with a stubbed
 * model for the turns a delivery starts.
 *
 * Two properties run through every step:
 *
 * - **Provenance files the work.** The PM's PRD is filed by its explicit
 *   goalId; Backend's file is filed under the delegated task without Backend
 *   naming it; a later unrelated turn's file is Unfiled.
 * - **The app acts on nothing by itself (D-132).** Messages are COUNTED around
 *   every task create, update and status change — which change rows — and
 *   only `send_message` (and, in the Start suite, Start) adds any.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const ARTIFACT_DIR = process.env['ARTIFACT_DIR'];

function quietModel(): MockLanguageModelV4 {
  const usage = { inputTokens: { total: 4 }, outputTokens: { total: 2 } };
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'scenario-model',
    doStream: async () => {
      const chunks: LanguageModelV4StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'On it.' },
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
let USER: SignedInUser;

type Bot = { id: string; name: string; conversationId: string };

describe.skipIf(!DATABASE_URL || !ARTIFACT_DIR)('M10-QA-01 — the reference scenario', () => {
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
    scriptModel(app, () => quietModel());
    prisma = app.get(PrismaService);
    registry = app.get(ToolRegistry);
    USER = await signIn(prisma, { label: 'work-qa01' });
  }, 60_000);

  afterAll(async () => {
    if (prisma !== undefined) await signOutAndDelete(prisma, USER.userId);
    await app?.close();
  });

  async function bot(name: string): Promise<Bot> {
    const row = await prisma.bot.create({
      data: {
        userId: USER.userId,
        name: `${name}-${randomUUID().slice(0, 4)}`,
        role: name,
        avatarColor: '#123456',
        systemPrompt: '',
      },
    });
    const conversation = await prisma.conversation.create({ data: { botId: row.id } });
    return { id: row.id, name: row.name, conversationId: conversation.id };
  }

  /** A turn of `who`, started by `triggerId` (or a fresh user message), composing a new reply. */
  async function turn(who: Bot, triggerId?: string) {
    const trigger =
      triggerId ??
      (
        await prisma.message.create({
          data: { conversationId: who.conversationId, author: 'USER', content: 'go' },
        })
      ).id;
    const reply = await prisma.message.create({
      data: { conversationId: who.conversationId, author: 'BOT', fromBotId: who.id, content: '' },
    });
    const context = {
      userId: USER.userId,
      botId: who.id,
      attachmentHost: () => Promise.resolve(reply.id),
      trigger: { id: trigger, chainId: null, hopCount: 0 },
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
    return String(await tool.execute(input, { toolCallId: randomUUID(), messages: [] }));
  }

  const idOf = (text: string) => /\b(c[a-z0-9]{20,})\b/.exec(text)?.[1] ?? '';
  const messages = () =>
    prisma.message.count({ where: { conversation: { bot: { userId: USER.userId } } } });

  /** What `attach_file` does once it has the bytes: store, claim and file in one transaction. */
  const attach = (
    replyId: string,
    triggerMessageId: string,
    filename: string,
    ids: { taskId?: string; goalId?: string } = {},
  ) =>
    app.get(AgentAttachmentService).storeFromBot({
      userId: USER.userId,
      messageId: replyId,
      filename,
      bytes: Buffer.from(`# ${filename}`),
      filing: { triggerMessageId, sourcePath: `/home/bot/shared/${filename}`, ...ids },
    });

  it('runs end to end: provenance files the work, and only send_message adds messages', async () => {
    const pm = await bot('PM');
    const frontend = await bot('Frontend');
    const backend = await bot('Backend');
    const captured: BotMessageJobData[] = [];
    const sender = sendMessageTool({
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
    const send = async (context: ToolContext, input: Record<string, unknown>) => {
      const built = sender.build(context);
      if (built.execute === undefined) throw new Error('no execute');
      return String(await built.execute(input, { toolCallId: randomUUID(), messages: [] }));
    };

    // 1. The user asks the PM for a project with a goal.
    const pmTurn = await turn(pm);
    const before = await messages();
    const made = await call(pmTurn.tools, 'project_create', {
      name: 'Acme SaaS',
      goal: 'Ship the MVP',
    });
    const goal = await prisma.goal.findFirstOrThrow({
      where: { userId: USER.userId, title: 'Ship the MVP' },
    });
    expect(made).toContain(goal.id);

    // 4. The PM writes the PRD and attaches it to the goal: a deliverable on the goal.
    const prd = await attach(pmTurn.replyId, pmTurn.context.trigger.id, 'PRD.md', {
      goalId: goal.id,
    });
    expect(
      await prisma.deliverable.findUniqueOrThrow({ where: { attachmentId: prd.id } }),
    ).toMatchObject({
      goalId: goal.id,
      projectId: goal.projectId,
      botId: pm.id,
    });

    // 5. The PM turns the PRD into tasks, assigned — all in To do, nothing starts.
    const auth = idOf(
      await call(pmTurn.tools, 'task_create', {
        title: 'API auth',
        goalId: goal.id,
        assignee: backend.name,
      }),
    );
    const login = idOf(
      await call(pmTurn.tools, 'task_create', {
        title: 'Login page',
        goalId: goal.id,
        assignee: frontend.name,
      }),
    );
    expect(await prisma.task.count({ where: { id: { in: [auth, login] }, status: 'TODO' } })).toBe(
      2,
    );
    expect(await messages()).toBe(before); // rows changed; no message did
    expect(await prisma.agentTurn.count({ where: { bot: { userId: USER.userId } } })).toBe(0);

    // 6. The PM tells Backend to work on API auth, with the task.
    await send(pmTurn.context, { toBot: backend.name, content: 'Work on API auth.', taskId: auth });
    const job = captured.at(-1);
    if (job === undefined) throw new Error('nothing was sent');
    expect(job.taskId).toBe(auth);
    await app.get(BotMessageDeliveryService).deliver(job);
    const delivered = await prisma.message.findFirstOrThrow({
      where: { conversationId: backend.conversationId, fromBotId: pm.id },
    });
    expect(delivered.taskId).toBe(auth);
    const afterDelivery = await messages();
    expect(afterDelivery).toBeGreaterThan(before); // the delivery, and Backend's reply to it

    // Backend reads the task, does the work, attaches without naming the task, and finishes.
    const backendTurn = await turn(backend, delivered.id);
    expect(await call(backendTurn.tools, 'task_read', { taskId: auth })).toContain('API auth');
    const notes = await attach(backendTurn.replyId, delivered.id, 'auth-notes.md');
    expect(
      await prisma.deliverable.findUniqueOrThrow({ where: { attachmentId: notes.id } }),
    ).toMatchObject({
      taskId: auth,
      goalId: goal.id,
      botId: backend.id,
    });
    const settled = await messages();
    await call(backendTurn.tools, 'task_update', {
      taskId: auth,
      status: 'DONE',
      note: 'JWT with refresh tokens',
    });
    expect(await messages()).toBe(settled);
    expect(
      await prisma.taskEvent.findFirstOrThrow({ where: { taskId: auth, type: 'STATUS_CHANGED' } }),
    ).toMatchObject({ actor: 'BOT', actorBotId: backend.id, messageId: backendTurn.replyId });

    // 7. The PM verifies, finds something missing, and reopens it with a note — still no message.
    const verify = await turn(pm);
    const beforeReopen = await messages();
    await call(verify.tools, 'task_update', {
      taskId: auth,
      status: 'IN_PROGRESS',
      note: 'Logout is missing',
    });
    expect(await messages()).toBe(beforeReopen);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: auth } })).status).toBe(
      'IN_PROGRESS',
    );

    // A later, unrelated turn of Backend's: what it attaches is Unfiled.
    const later = await turn(backend);
    const loose = await attach(later.replyId, later.context.trigger.id, 'scratch.md');
    expect(
      await prisma.deliverable.findUniqueOrThrow({ where: { attachmentId: loose.id } }),
    ).toMatchObject({
      taskId: null,
      goalId: null,
      projectId: null,
    });

    // taskId: null clears inherited context on the next hop.
    await send(backendTurn.context, {
      toBot: pm.name,
      content: 'Unrelated question',
      taskId: null,
    });
    expect(captured.at(-1)?.taskId).toBeNull();
    await send(backendTurn.context, { toBot: pm.name, content: 'Done with auth' });
    expect(captured.at(-1)?.taskId).toBe(auth);

    // 8. The record: who changed what, and what was delivered where.
    const log = await prisma.taskEvent.findMany({
      where: { taskId: auth },
      orderBy: { createdAt: 'asc' },
    });
    expect(log.map((event) => [event.type, event.actorLabel])).toEqual([
      ['CREATED', pm.name],
      ['ASSIGNED', pm.name],
      ['DELIVERABLE_LINKED', backend.name],
      ['STATUS_CHANGED', backend.name],
      ['NOTE', backend.name],
      ['STATUS_CHANGED', pm.name],
      ['NOTE', pm.name],
    ]);
  }, 60_000);
});
