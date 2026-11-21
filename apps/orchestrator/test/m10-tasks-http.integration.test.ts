import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  CreateTaskResponseSchema,
  ListTasksResponseSchema,
  TaskCardSchema,
  TaskDetailResponseSchema,
  TaskEventSchema,
  type TaskCard,
} from '@crewaid/shared';

import { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

/**
 * M10-BE-03 — tasks over HTTP (D-132 … D-134).
 *
 * The rules under test are data rules only: one level of subtasks, placement
 * that agrees with the goal, owner-checked references, an activity row per
 * change. And the one the whole feature rests on — changing a task starts
 * nothing — asserted by counting messages and turns beside rows that did
 * change, so the absence is measured against a presence.
 */
const DATABASE_URL = process.env['DATABASE_URL'];

let app: INestApplication;
let prisma: PrismaService;
let bus: TurnEventBus;
let ACTOR: SignedInUser;
let FOREIGN: SignedInUser;

const api = (path: string): string => `/api/v1${path}`;
const http = (): request.Agent => request(app.getHttpServer()) as unknown as request.Agent;

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')('M10-BE-03 — /tasks', () => {
  beforeAll(async () => {
    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('../src/app.module.js');
    const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new CrewaidWsAdapter(app));
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    await app.init();

    prisma = app.get(PrismaService);
    bus = app.get(TurnEventBus);
    ACTOR = await signIn(prisma, { label: 'work-tasks' });
    FOREIGN = await signIn(prisma, { label: 'work-tasks-foreign' });
  }, 60_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (prisma !== undefined) {
      await signOutAndDelete(prisma, ACTOR.userId);
      await signOutAndDelete(prisma, FOREIGN.userId);
    }
    await app?.close();
  });

  async function bot(owner: SignedInUser = ACTOR, name = 'Backend') {
    const row = await prisma.bot.create({
      data: {
        userId: owner.userId,
        name: `${name} ${randomUUID().slice(0, 6)}`,
        role: 'Engineer',
        avatarColor: '#123456',
        systemPrompt: '',
      },
    });
    await prisma.conversation.create({ data: { botId: row.id } });
    return row;
  }

  async function create(body: Record<string, unknown>, owner: SignedInUser = ACTOR) {
    const res = await http().post(api('/tasks')).set(owner.headers).send(body).expect(201);
    const parsed = CreateTaskResponseSchema.parse(res.body);
    if (parsed.task === null) throw new Error('expected a task');
    return parsed.task;
  }

  async function patch(id: string, body: Record<string, unknown>, status = 200) {
    const res = await http()
      .patch(api(`/tasks/${id}`))
      .set(ACTOR.headers)
      .send(body)
      .expect(status);
    return status === 200 ? TaskCardSchema.parse(res.body) : null;
  }

  async function detail(id: string) {
    return TaskDetailResponseSchema.parse(
      (
        await http()
          .get(api(`/tasks/${id}`))
          .set(ACTOR.headers)
          .expect(200)
      ).body,
    );
  }

  async function list(query = ''): Promise<TaskCard[]> {
    return ListTasksResponseSchema.parse(
      (
        await http()
          .get(api(`/tasks${query}`))
          .set(ACTOR.headers)
          .expect(200)
      ).body,
    );
  }

  const messagesAndTurns = async () => ({
    messages: await prisma.message.count({
      where: { conversation: { bot: { userId: ACTOR.userId } } },
    }),
    turns: await prisma.agentTurn.count({ where: { bot: { userId: ACTOR.userId } } }),
  });

  it('creates, assigns, moves and finishes a task without sending anyone anything', async () => {
    const backend = await bot();
    const before = await messagesAndTurns();
    const events = vi.spyOn(bus, 'emitWorkChanged');

    const task = await create({
      title: 'API auth',
      brief: 'JWT + refresh',
      assigneeBotId: backend.id,
    });
    expect(task).toMatchObject({ status: 'TODO', origin: 'OPERATOR', assigneeBotId: backend.id });
    expect(events).toHaveBeenCalledWith(ACTOR.userId, 'task.changed', { taskId: task.id });

    await patch(task.id, { status: 'IN_PROGRESS', rank: 'z' });
    const done = await patch(task.id, { status: 'DONE' });
    expect(done?.completedAt).not.toBeNull();
    expect(done?.startedAt).not.toBeNull();

    // The presence: the rows and the log moved…
    const log = (await detail(task.id)).events.map((event) => event.type);
    expect(log).toEqual(['STATUS_CHANGED', 'STATUS_CHANGED', 'ASSIGNED', 'CREATED']);
    // …and the absence: no message, no turn, for anybody.
    expect(await messagesAndTurns()).toEqual(before);
  });

  it('records who did what: the user on the board, with no message link', async () => {
    const task = await create({ title: 'Billing page' });
    await http()
      .post(api(`/tasks/${task.id}/notes`))
      .set(ACTOR.headers)
      .send({ text: 'Stripe first' })
      .expect(201);
    await patch(task.id, { status: 'BLOCKED', blockedReason: 'Waiting on keys' });

    const { events, blockedReason } = await detail(task.id);
    expect(blockedReason).toBe('Waiting on keys');
    expect(events[0]).toMatchObject({
      type: 'STATUS_CHANGED',
      actor: 'USER',
      actorLabel: 'You',
      messageId: null,
      payload: { from: 'TODO', to: 'BLOCKED', blockedReason: 'Waiting on keys' },
    });
    expect(events[1]).toMatchObject({ type: 'NOTE', payload: { text: 'Stripe first' } });
    for (const event of events) expect(TaskEventSchema.safeParse(event).success).toBe(true);

    // Leaving BLOCKED clears the reason; reopening DONE clears completedAt.
    expect((await patch(task.id, { status: 'DONE' }))?.blockedReason).toBeNull();
    expect((await patch(task.id, { status: 'TODO' }))?.completedAt).toBeNull();
  });

  it('keeps subtasks one level deep, on their parent’s project and goal, counted on the parent', async () => {
    const project = await prisma.project.create({
      data: { userId: ACTOR.userId, name: 'Acme', color: '#4F46E5' },
    });
    const goal = await prisma.goal.create({
      data: { userId: ACTOR.userId, title: 'Ship', projectId: project.id },
    });
    const parent = await create({ title: 'Login page', goalId: goal.id });
    expect(parent.projectId).toBe(project.id);

    const events = vi.spyOn(bus, 'emitWorkChanged');
    const first = await create({ title: 'Form', parentId: parent.id });
    const second = await create({ title: 'Validation', parentId: parent.id, projectId: null });
    expect(first).toMatchObject({ projectId: project.id, goalId: goal.id, parentId: parent.id });
    expect(second.rank > first.rank).toBe(true);
    expect(events).toHaveBeenCalledWith(ACTOR.userId, 'task.changed', { taskId: parent.id });

    await http()
      .post(api('/tasks'))
      .set(ACTOR.headers)
      .send({ title: 'Too deep', parentId: first.id })
      .expect(400);
    await patch(first.id, { status: 'DONE' });
    expect((await detail(parent.id)).subtasks).toEqual({ done: 1, total: 2 });
    expect((await detail(parent.id)).subtaskRows.map((row) => row.id)).toEqual([
      first.id,
      second.id,
    ]);

    // Top-level lists leave subtasks out; asking by parent lists them.
    expect((await list()).map((row) => row.id)).not.toContain(first.id);
    expect((await list(`?parentId=${parent.id}`)).map((row) => row.id)).toEqual([
      first.id,
      second.id,
    ]);

    // A subtask cannot be moved on its own…
    await patch(first.id, { projectId: null }, 400);
    // …and follows its parent when the parent moves.
    await patch(parent.id, { goalId: null, projectId: null });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({
      projectId: null,
      goalId: null,
    });
  });

  it('puts a task on a goal in that goal’s project, and refuses another project', async () => {
    const acme = await prisma.project.create({
      data: { userId: ACTOR.userId, name: 'Acme', color: '#4F46E5' },
    });
    const other = await prisma.project.create({
      data: { userId: ACTOR.userId, name: 'Other', color: '#16A34A' },
    });
    const goal = await prisma.goal.create({
      data: { userId: ACTOR.userId, title: 'Ship', projectId: acme.id },
    });

    await http()
      .post(api('/tasks'))
      .set(ACTOR.headers)
      .send({ title: 'x', goalId: goal.id, projectId: other.id })
      .expect(400);
    const task = await create({ title: 'API docs' });
    const moved = await patch(task.id, { goalId: goal.id });
    expect(moved).toMatchObject({ goalId: goal.id, projectId: acme.id });
    await patch(task.id, { projectId: other.id }, 400);
    expect((await detail(task.id)).events[0]).toMatchObject({
      type: 'EDITED',
      payload: { fields: ['projectId', 'goalId'] },
    });
  });

  it('answers 404 for every foreign reference and every foreign task', async () => {
    const theirProject = await prisma.project.create({
      data: { userId: FOREIGN.userId, name: 'Theirs', color: '#000000' },
    });
    const theirGoal = await prisma.goal.create({
      data: { userId: FOREIGN.userId, title: 'Theirs' },
    });
    const theirBot = await bot(FOREIGN);
    const theirTask = await create({ title: 'Theirs' }, FOREIGN);

    for (const body of [
      { title: 'x', projectId: theirProject.id },
      { title: 'x', goalId: theirGoal.id },
      { title: 'x', parentId: theirTask.id },
      { title: 'x', assigneeBotId: theirBot.id },
    ]) {
      await http().post(api('/tasks')).set(ACTOR.headers).send(body).expect(404);
    }
    const mine = await create({ title: 'Mine' });
    await patch(mine.id, { assigneeBotId: theirBot.id }, 404);

    await http()
      .get(api(`/tasks/${theirTask.id}`))
      .set(ACTOR.headers)
      .expect(404);
    await http()
      .patch(api(`/tasks/${theirTask.id}`))
      .set(ACTOR.headers)
      .send({ status: 'DONE' })
      .expect(404);
    await http()
      .post(api(`/tasks/${theirTask.id}/notes`))
      .set(ACTOR.headers)
      .send({ text: 'hi' })
      .expect(404);
    await http()
      .delete(api(`/tasks/${theirTask.id}`))
      .set(ACTOR.headers)
      .expect(404);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: theirTask.id } })).status).toBe(
      'TODO',
    );
    expect((await list()).map((row) => row.id)).not.toContain(theirTask.id);
  });

  it('filters the board: cancelled hidden, Inbox, archived projects, and the Done window', async () => {
    const archived = await prisma.project.create({
      data: { userId: ACTOR.userId, name: 'Old', color: '#4F46E5', status: 'ARCHIVED' },
    });
    const inbox = await create({ title: 'Inbox task' });
    const hidden = await create({ title: 'In an archived project', projectId: archived.id });
    const cancelled = await create({ title: 'Cancelled' });
    await patch(cancelled.id, { status: 'CANCELLED' });
    const oldDone = await create({ title: 'Done long ago' });
    await patch(oldDone.id, { status: 'DONE' });
    await prisma.task.update({
      where: { id: oldDone.id },
      data: { completedAt: new Date('2026-01-01T00:00:00Z') },
    });

    const board = (await list()).map((row) => row.id);
    expect(board).toContain(inbox.id);
    expect(board).not.toContain(hidden.id);
    expect(board).not.toContain(cancelled.id);
    expect(board).toContain(oldDone.id);

    const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
    expect((await list(`?doneSince=${since}`)).map((row) => row.id)).not.toContain(oldDone.id);
    expect((await list('?status=CANCELLED')).map((row) => row.id)).toContain(cancelled.id);
    expect((await list(`?projectId=${archived.id}`)).map((row) => row.id)).toEqual([hidden.id]);
    expect((await list('?inbox=true')).map((row) => row.id)).not.toContain(hidden.id);
  });

  it('deleting a task takes its subtasks and log, and only unfiles its deliverables', async () => {
    const parent = await create({ title: 'Parent' });
    const child = await create({ title: 'Child', parentId: parent.id });
    const link = await prisma.deliverable.create({
      data: {
        userId: ACTOR.userId,
        kind: 'LINK',
        title: 'Spec',
        url: 'https://example.com',
        taskId: child.id,
      },
    });
    const events = vi.spyOn(bus, 'emitWorkChanged');
    await http()
      .delete(api(`/tasks/${parent.id}`))
      .set(ACTOR.headers)
      .expect(204);

    expect(await prisma.task.findUnique({ where: { id: child.id } })).toBeNull();
    expect(await prisma.taskEvent.count({ where: { taskId: parent.id } })).toBe(0);
    expect(
      (await prisma.deliverable.findUniqueOrThrow({ where: { id: link.id } })).taskId,
    ).toBeNull();
    expect(events).toHaveBeenCalledWith(ACTOR.userId, 'task.changed', {
      taskId: parent.id,
      deleted: true,
    });
    expect(events).toHaveBeenCalledWith(ACTOR.userId, 'deliverable.changed', {
      deliverableId: link.id,
    });
  });

  it('deleting a bot unassigns its tasks with an event naming it, and takes its deliverables', async () => {
    const backend = await bot(ACTOR, 'Leaving');
    const task = await create({ title: 'Assigned work', assigneeBotId: backend.id });
    const attachment = await prisma.attachment.create({
      data: {
        ownerId: ACTOR.userId,
        filename: 'a.md',
        mimeType: 'text/markdown',
        sizeBytes: 1,
        storageKey: `t/${randomUUID()}`,
      },
    });
    const made = await prisma.deliverable.create({
      data: {
        userId: ACTOR.userId,
        kind: 'FILE',
        title: 'a.md',
        botId: backend.id,
        attachmentId: attachment.id,
        taskId: task.id,
      },
    });
    const events = vi.spyOn(bus, 'emitWorkChanged');

    await http()
      .delete(api(`/bots/${backend.id}`))
      .set(ACTOR.headers)
      .expect(204);

    const after = await detail(task.id);
    expect(after.assigneeBotId).toBeNull();
    expect(after.events[0]).toMatchObject({
      type: 'UNASSIGNED',
      actor: 'USER',
      payload: { botId: backend.id, botName: backend.name, reason: 'BOT_DELETED' },
    });
    expect(await prisma.deliverable.findUnique({ where: { id: made.id } })).toBeNull();
    expect(events).toHaveBeenCalledWith(ACTOR.userId, 'task.changed', { taskId: task.id });
    expect(events).toHaveBeenCalledWith(ACTOR.userId, 'deliverable.changed', {
      deliverableId: made.id,
      deleted: true,
    });
  });

  // ARTIFACT_DIR is where the bytes live; CI sets it for every suite, and
  // without it there are no files to remove.
  it.skipIf(!process.env['ARTIFACT_DIR'])(
    'deleting a bot removes the files of what it attached, and no other bot’s',
    async () => {
      const root = process.env['ARTIFACT_DIR']!;
      const stored = async (botId: string) => {
        const conversation = await prisma.conversation.findUniqueOrThrow({ where: { botId } });
        const reply = await prisma.message.create({
          data: {
            conversationId: conversation.id,
            author: 'BOT',
            fromBotId: botId,
            content: 'Here.',
          },
        });
        const storageKey = `m10-bot-delete/${randomUUID()}.md`;
        await mkdir(path.join(root, 'm10-bot-delete'), { recursive: true });
        await writeFile(path.join(root, storageKey), '# notes\n');
        await prisma.attachment.create({
          data: {
            ownerId: ACTOR.userId,
            messageId: reply.id,
            filename: 'notes.md',
            mimeType: 'text/markdown',
            sizeBytes: 8,
            storageKey,
          },
        });
        return path.join(root, storageKey);
      };
      const leaving = await bot(ACTOR, 'Leaving');
      const staying = await bot(ACTOR, 'Staying');
      const gone = await stored(leaving.id);
      const kept = await stored(staying.id);
      expect(existsSync(gone)).toBe(true);

      await http()
        .delete(api(`/bots/${leaving.id}`))
        .set(ACTOR.headers)
        .expect(204);

      expect(existsSync(gone)).toBe(false);
      expect(existsSync(kept)).toBe(true);
    },
  );

  it('opens the assignee’s most recent task-linked message', async () => {
    const backend = await bot();
    const task = await create({ title: 'Linked', assigneeBotId: backend.id });
    expect((await detail(task.id)).lastLinkedMessageId).toBeNull();
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { botId: backend.id },
    });
    const first = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        author: 'USER',
        content: 'Task: Linked',
        taskId: task.id,
        createdAt: new Date(Date.now() - 1000),
      },
    });
    const second = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        author: 'BOT',
        fromBotId: backend.id,
        content: 'On it',
        taskId: task.id,
      },
    });
    await prisma.message.create({
      data: { conversationId: conversation.id, author: 'USER', content: 'unrelated' },
    });
    expect((await detail(task.id)).lastLinkedMessageId).toBe(second.id);
    expect(first.id).not.toBe(second.id);
  });

  it('refuses a malformed body', async () => {
    await http().post(api('/tasks')).set(ACTOR.headers).send({ title: '' }).expect(400);
    await http()
      .patch(api(`/tasks/${(await create({ title: 'x' })).id}`))
      .set(ACTOR.headers)
      .send({})
      .expect(400);
  });
});
