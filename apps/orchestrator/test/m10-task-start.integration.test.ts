import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  MockLanguageModelV4,
  scriptModel,
  simulateReadableStream,
} from './model-resolution-fake.js';
import type { ScriptPart as LanguageModelV4StreamPart } from './model-resolution-fake.js';
import { CreateTaskResponseSchema, StartTaskResponseSchema } from '@crewaid/shared';

import { TanStackTurns } from '../src/agent/tanstack-turns.js';
import { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { TaskStartService } from '../src/work/task-start.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import { FakeProvider } from './sandbox-fakes.js';

/**
 * M10-BE-04 — the Start button (D-135).
 *
 * The property under test is "one brief, one event, at most one turn" for a
 * claimed Start, however it is pressed: once, twice with the same key, many
 * times at once, retried after the task finished, or recovered after the
 * dispatch never happened. Each case counts rows rather than trusting a
 * status code.
 */
const DATABASE_URL = process.env['DATABASE_URL'];

function replyModel(): MockLanguageModelV4 {
  const usage = { inputTokens: { total: 4 }, outputTokens: { total: 2 } };
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'start-model',
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
let starts: TaskStartService;
let turns: TanStackTurns;
let bus: TurnEventBus;
let ACTOR: SignedInUser;
let FOREIGN: SignedInUser;

const api = (path: string): string => `/api/v1${path}`;
const http = (): request.Agent => request(app.getHttpServer()) as unknown as request.Agent;

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')('M10-BE-04 — Start', () => {
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
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    await app.init();

    prisma = app.get(PrismaService);
    starts = app.get(TaskStartService);
    turns = app.get(TanStackTurns);
    scriptModel(app, () => replyModel());
    bus = app.get(TurnEventBus);
    ACTOR = await signIn(prisma, { label: 'work-start' });
    FOREIGN = await signIn(prisma, { label: 'work-start-foreign' });
  }, 60_000);

  afterEach(async () => {
    await starts.settled();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await starts?.settled();
    if (prisma !== undefined) {
      await signOutAndDelete(prisma, ACTOR.userId);
      await signOutAndDelete(prisma, FOREIGN.userId);
    }
    await app?.close();
  });

  async function assignedTask(extra: Record<string, unknown> = {}, owner: SignedInUser = ACTOR) {
    const bot = await prisma.bot.create({
      data: {
        userId: owner.userId,
        name: `Backend ${randomUUID().slice(0, 6)}`,
        role: 'Engineer',
        avatarColor: '#123456',
        systemPrompt: '',
      },
    });
    await prisma.conversation.create({ data: { botId: bot.id } });
    const res = await http()
      .post(api('/tasks'))
      .set(owner.headers)
      .send({ title: 'API auth', assigneeBotId: bot.id, ...extra })
      .expect(201);
    const { task } = CreateTaskResponseSchema.parse(res.body);
    if (task === null) throw new Error('expected a task');
    return { task, bot };
  }

  const start = (taskId: string, key: string | null, owner: SignedInUser = ACTOR) => {
    const req = http()
      .post(api(`/tasks/${taskId}/start`))
      .set(owner.headers);
    return key === null ? req : req.set('Idempotency-Key', key);
  };

  const briefsOf = (taskId: string) =>
    prisma.message.findMany({
      where: { taskId, author: 'USER' },
      select: { id: true, content: true },
    });
  const turnsFor = (messageId: string) =>
    prisma.agentTurn.findMany({ where: { triggerMessageId: messageId }, select: { status: true } });
  const startedEvents = (taskId: string) =>
    prisma.taskEvent.count({ where: { taskId, type: 'STARTED' } });

  it('posts one brief to the assignee, moves the task to In progress, and runs one turn', async () => {
    const project = await prisma.project.create({
      data: { userId: ACTOR.userId, name: 'Acme SaaS', color: '#4F46E5' },
    });
    const goal = await prisma.goal.create({
      data: { userId: ACTOR.userId, title: 'Ship the MVP', projectId: project.id },
    });
    const { task, bot } = await assignedTask({
      goalId: goal.id,
      dueOn: '2026-10-03',
      brief: 'JWT with refresh tokens.',
    });
    const frames = vi.spyOn(bus, 'emitCreated');
    const work = vi.spyOn(bus, 'emitWorkChanged');

    const res = await start(task.id, randomUUID()).expect(202);
    const { messageId } = StartTaskResponseSchema.parse(res.body);
    await starts.settled();

    const brief = await prisma.message.findUniqueOrThrow({
      where: { id: messageId },
      include: { conversation: { select: { botId: true } } },
    });
    expect(brief).toMatchObject({ author: 'USER', taskId: task.id });
    expect(brief.conversation.botId).toBe(bot.id);
    // D-143: the brief closes by naming the task and asking for a report back.
    expect(brief.content).toBe(
      'Task: API auth\nProject: Acme SaaS · Goal: Ship the MVP · Due: 2026-10-03\n\nJWT with refresh tokens.' +
        `\n\nTask id: ${task.id}. When you finish, use task_update to move it to Review, or to Done ` +
        'if there is nothing for the user to check, with a one-line note. If you cannot finish, ' +
        'move it to Blocked and say what you need.',
    );
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
      'IN_PROGRESS',
    );
    expect(
      await prisma.taskEvent.findFirst({ where: { taskId: task.id, type: 'STARTED' } }),
    ).toMatchObject({
      messageId,
      actor: 'USER',
    });
    expect(await turnsFor(messageId)).toEqual([{ status: 'completed' }]);
    expect(frames).toHaveBeenCalledWith(bot.id, expect.objectContaining({ id: messageId }));
    expect(work).toHaveBeenCalledWith(ACTOR.userId, 'task.changed', { taskId: task.id });
  });

  it('answers a retry with the same key with the same brief, even after the task is done', async () => {
    const { task } = await assignedTask();
    const key = randomUUID();
    const first = StartTaskResponseSchema.parse((await start(task.id, key).expect(202)).body);
    await starts.settled();
    await http()
      .patch(api(`/tasks/${task.id}`))
      .set(ACTOR.headers)
      .send({ status: 'DONE' })
      .expect(200);

    const again = StartTaskResponseSchema.parse((await start(task.id, key).expect(202)).body);
    await starts.settled();
    expect(again.messageId).toBe(first.messageId);
    expect(await briefsOf(task.id)).toHaveLength(1);
    expect(await startedEvents(task.id)).toBe(1);
    expect(await turnsFor(first.messageId)).toHaveLength(1);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('DONE');
  });

  it('makes one brief out of many presses at once, with new keys or the same one', async () => {
    const { task } = await assignedTask();
    const distinct = await Promise.all(
      Array.from({ length: 5 }, () => start(task.id, randomUUID())),
    );
    expect(distinct.map((res) => res.status).sort()).toEqual([202, 409, 409, 409, 409]);
    expect(
      distinct
        .filter((res) => res.status === 409)
        .every((res) => res.body.code === 'TASK_NOT_STARTABLE'),
    ).toBe(true);
    expect(await briefsOf(task.id)).toHaveLength(1);

    const { task: other } = await assignedTask();
    const key = randomUUID();
    const same = await Promise.all(Array.from({ length: 5 }, () => start(other.id, key)));
    expect(same.map((res) => res.status)).toEqual([202, 202, 202, 202, 202]);
    expect(new Set(same.map((res) => res.body.messageId as string)).size).toBe(1);
    await starts.settled();
    expect(await briefsOf(other.id)).toHaveLength(1);
    expect(await startedEvents(other.id)).toBe(1);
    expect(await turnsFor(same[0]?.body.messageId as string)).toHaveLength(1);
  });

  it('dispatches a brief whose first dispatch failed, on retry and on recovery, exactly once', async () => {
    const { task } = await assignedTask();
    const key = randomUUID();
    const startTurn = vi
      .spyOn(turns, 'startStored')
      .mockRejectedValueOnce(new Error('process died'));
    const { messageId } = StartTaskResponseSchema.parse(
      (await start(task.id, key).expect(202)).body,
    );
    await starts.settled();
    expect(await turnsFor(messageId)).toHaveLength(0);
    startTurn.mockRestore();

    // Recovery at boot finds it: committed, never run, nothing after it.
    expect(await starts.recoverPendingStarts()).toBeGreaterThanOrEqual(1);
    await starts.settled();
    expect(await turnsFor(messageId)).toHaveLength(1);

    // Neither a second recovery nor a retry with the same key runs it again.
    await starts.recoverPendingStarts();
    await start(task.id, key).expect(202);
    await starts.settled();
    expect(await turnsFor(messageId)).toHaveLength(1);
    expect(await briefsOf(task.id)).toHaveLength(1);
  });

  it('refuses what cannot start, and a key already used for another task', async () => {
    const { task } = await assignedTask();
    const unassigned = CreateTaskResponseSchema.parse(
      (await http().post(api('/tasks')).set(ACTOR.headers).send({ title: 'Mine' }).expect(201))
        .body,
    ).task;
    if (unassigned === null) throw new Error('expected a task');

    expect((await start(unassigned.id, randomUUID()).expect(409)).body.code).toBe(
      'TASK_UNASSIGNED',
    );
    const key = randomUUID();
    await start(task.id, key).expect(202);
    expect((await start(task.id, randomUUID()).expect(409)).body.code).toBe('TASK_NOT_STARTABLE');

    const { task: second } = await assignedTask();
    expect((await start(second.id, key).expect(409)).body.code).toBe('START_KEY_REUSED');
    expect(await briefsOf(second.id)).toHaveLength(0);

    await start(second.id, null).expect(400);
    await start(second.id, 'not-a-uuid').expect(400);

    const { task: theirs } = await assignedTask({}, FOREIGN);
    await start(theirs.id, randomUUID()).expect(404);
    expect(await briefsOf(theirs.id)).toHaveLength(0);
  });

  it('runs a task again only after it is moved back to To do and started with a new key', async () => {
    const { task } = await assignedTask();
    await start(task.id, randomUUID()).expect(202);
    await starts.settled();
    await http()
      .patch(api(`/tasks/${task.id}`))
      .set(ACTOR.headers)
      .send({ status: 'TODO' })
      .expect(200);
    await start(task.id, randomUUID()).expect(202);
    await starts.settled();
    expect(await briefsOf(task.id)).toHaveLength(2);
    expect(await startedEvents(task.id)).toBe(2);
  });
});
