import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service.js';

const DATABASE_URL = process.env['DATABASE_URL'];

/**
 * D-133 / D-139 — what the Work migration promises that the drift guard cannot
 * check: the hand-written search indexes, the uniqueness that makes a
 * recurring firing idempotent, and what each delete does to the rows around
 * it. Every assertion here is about the database, so none of it goes through
 * a service; the services are tested against these guarantees, not instead of
 * them.
 */
describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')('D-133 Work schema', () => {
  let prisma: PrismaService;
  const createdUsers: string[] = [];

  async function user(): Promise<string> {
    const id = `usr_work_${randomUUID().slice(0, 12)}`;
    await prisma.user.create({ data: { id, name: 'Work', email: `${id}@work.invalid` } });
    createdUsers.push(id);
    return id;
  }

  async function bot(userId: string, name = 'Backend'): Promise<string> {
    const row = await prisma.bot.create({
      data: { userId, name, role: 'R', avatarColor: '#123456', systemPrompt: 'work schema' },
    });
    return row.id;
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
    await prisma.$disconnect();
  });

  it.each([
    ['Task', 'Task_search_fts_idx', `((title || ' '::text) || COALESCE(brief, ''::text))`],
    ['Goal', 'Goal_search_fts_idx', `((title || ' '::text) || COALESCE(outcome, ''::text))`],
    [
      'Deliverable',
      'Deliverable_search_fts_idx',
      `((((title || ' '::text) || COALESCE(summary, ''::text)) || ' '::text) || COALESCE("searchText", ''::text))`,
    ],
  ])('has the %s full-text index search repeats', async (table, name, expression) => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ${table} AND indexname = ${name}
    `;
    expect(rows, `${name} is missing — search still works, silently by seq scan`).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('gin');
    expect(rows[0]?.indexdef).toContain(`to_tsvector('english'::regconfig, ${expression})`);
  });

  it('absorbs a retried firing, and keeps two firings on the same local date', async () => {
    const userId = await user();
    const series = await prisma.taskSeries.create({
      data: { userId, title: 'Hydrate', cron: '0 * * * *', timezone: 'America/New_York' },
    });
    const firing = (occursAt: Date, rank: string) =>
      prisma.task.create({
        data: {
          userId,
          title: 'Hydrate',
          seriesId: series.id,
          occursAt,
          occursOn: '2026-09-23',
          rank,
        },
      });

    await firing(new Date('2026-09-23T13:00:00Z'), 'i');
    await firing(new Date('2026-09-23T14:00:00Z'), 'j');
    await expect(firing(new Date('2026-09-23T13:00:00Z'), 'k')).rejects.toMatchObject({
      code: 'P2002',
    });
    expect(await prisma.task.count({ where: { seriesId: series.id } })).toBe(2);

    // One-off tasks carry no series and no instant; NULLs never collide.
    await prisma.task.createMany({
      data: [
        { userId, title: 'one', rank: 'a' },
        { userId, title: 'two', rank: 'b' },
      ],
    });
    expect(await prisma.task.count({ where: { userId, seriesId: null } })).toBe(2);
  });

  it('records a Start key once per user', async () => {
    const userId = await user();
    const task = await prisma.task.create({ data: { userId, title: 'API auth', rank: 'i' } });
    const startKey = randomUUID();
    const started = {
      taskId: task.id,
      userId,
      actor: 'USER' as const,
      actorLabel: 'You',
      type: 'STARTED' as const,
      payload: {},
      startKey,
    };
    await prisma.taskEvent.create({ data: started });
    await expect(prisma.taskEvent.create({ data: started })).rejects.toMatchObject({
      code: 'P2002',
    });
    // Events without a key (every other kind) never collide.
    await prisma.taskEvent.createMany({
      data: [
        { ...started, type: 'NOTE', payload: { text: 'a' }, startKey: null },
        { ...started, type: 'NOTE', payload: { text: 'b' }, startKey: null },
      ],
    });
  });

  it('deleting a bot takes its deliverables and leaves its tasks, series and history', async () => {
    const userId = await user();
    const botId = await bot(userId);
    const task = await prisma.task.create({
      data: { userId, title: 'API auth', rank: 'i', assigneeBotId: botId, createdByBotId: botId },
    });
    const series = await prisma.taskSeries.create({
      data: {
        userId,
        title: 'Standup',
        cron: '0 9 * * 1-5',
        timezone: 'UTC',
        assigneeBotId: botId,
      },
    });
    const event = await prisma.taskEvent.create({
      data: {
        taskId: task.id,
        userId,
        actor: 'BOT',
        actorBotId: botId,
        actorLabel: 'Backend',
        type: 'NOTE',
        payload: { text: 'JWT + refresh' },
      },
    });
    const attachment = await prisma.attachment.create({
      data: {
        ownerId: userId,
        filename: 'auth.md',
        mimeType: 'text/markdown',
        sizeBytes: 3,
        storageKey: `work-schema/${randomUUID()}`,
      },
    });
    const deliverable = await prisma.deliverable.create({
      data: {
        userId,
        kind: 'FILE',
        title: 'auth.md',
        botId,
        attachmentId: attachment.id,
        taskId: task.id,
      },
    });

    await prisma.bot.delete({ where: { id: botId } });

    expect(await prisma.deliverable.findUnique({ where: { id: deliverable.id } })).toBeNull();
    expect(await prisma.task.findUnique({ where: { id: task.id } })).toMatchObject({
      assigneeBotId: null,
      createdByBotId: null,
    });
    expect(await prisma.taskSeries.findUnique({ where: { id: series.id } })).toMatchObject({
      assigneeBotId: null,
    });
    expect(await prisma.taskEvent.findUnique({ where: { id: event.id } })).toMatchObject({
      actorBotId: null,
      actorLabel: 'Backend',
    });
  });

  it('deleting a task unfiles its deliverables and removes its subtasks and events', async () => {
    const userId = await user();
    const parent = await prisma.task.create({ data: { userId, title: 'Billing', rank: 'i' } });
    const child = await prisma.task.create({
      data: { userId, title: 'Stripe webhook', rank: 'i', parentId: parent.id },
    });
    await prisma.taskEvent.create({
      data: {
        taskId: parent.id,
        userId,
        actor: 'USER',
        actorLabel: 'You',
        type: 'CREATED',
        payload: {},
      },
    });
    const link = await prisma.deliverable.create({
      data: { userId, kind: 'LINK', title: 'Spec', url: 'https://example.com', taskId: parent.id },
    });

    await prisma.task.delete({ where: { id: parent.id } });

    expect(await prisma.task.findUnique({ where: { id: child.id } })).toBeNull();
    expect(await prisma.taskEvent.count({ where: { taskId: parent.id } })).toBe(0);
    expect(await prisma.deliverable.findUnique({ where: { id: link.id } })).toMatchObject({
      taskId: null,
    });
  });

  it('refuses to delete a project that still holds work, but lets its user go', async () => {
    const userId = await user();
    const project = await prisma.project.create({
      data: { userId, name: 'Acme SaaS', color: '#4F46E5' },
    });
    const goal = await prisma.goal.create({
      data: { userId, projectId: project.id, title: 'Ship the MVP' },
    });
    await prisma.task.create({
      data: { userId, title: 'API auth', rank: 'i', projectId: project.id, goalId: goal.id },
    });
    await prisma.taskSeries.create({
      data: {
        userId,
        title: 'Standup',
        cron: '0 9 * * 1-5',
        timezone: 'UTC',
        projectId: project.id,
      },
    });

    await expect(prisma.project.delete({ where: { id: project.id } })).rejects.toThrow();

    // NoAction, not Restrict: the check runs at the end of the statement, so a
    // user's cascade can remove the project and everything in it at once.
    await prisma.user.delete({ where: { id: userId } });
    expect(await prisma.project.findUnique({ where: { id: project.id } })).toBeNull();
    expect(await prisma.task.count({ where: { userId } })).toBe(0);
  });

  it('deleting a goal unlinks its tasks, series and routines', async () => {
    const userId = await user();
    const botId = await bot(userId, 'Coach');
    const goal = await prisma.goal.create({ data: { userId, title: 'Lose 8 kg by March' } });
    const task = await prisma.task.create({
      data: { userId, title: 'Weigh in', rank: 'i', goalId: goal.id },
    });
    const series = await prisma.taskSeries.create({
      data: { userId, title: 'Work out', cron: '0 7 * * 1,3,5', timezone: 'UTC', goalId: goal.id },
    });
    const routine = await prisma.routine.create({
      data: { botId, name: 'Weekly', cron: '0 20 * * 0', prompt: 'How did I do?', goalId: goal.id },
    });

    await prisma.goal.delete({ where: { id: goal.id } });

    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).goalId).toBeNull();
    expect(
      (await prisma.taskSeries.findUniqueOrThrow({ where: { id: series.id } })).goalId,
    ).toBeNull();
    expect(
      (await prisma.routine.findUniqueOrThrow({ where: { id: routine.id } })).goalId,
    ).toBeNull();
  });
});
