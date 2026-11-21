import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import request from 'supertest';
import {
  CreateTaskResponseSchema,
  ListTasksResponseSchema,
  TaskSeriesDetailResponseSchema,
  TaskSeriesSchema,
} from '@crewaid/shared';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { TASK_SERIES_JOB } from '../src/work/task-series.queue.js';
import { TaskSeriesService } from '../src/work/task-series.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

/**
 * M10-BE-05 — recurring tasks over HTTP (D-137).
 *
 * The scheduler is real (Redis) and the firing is driven by calling the
 * service's `fire` directly, which is exactly what the queue worker does —
 * the worker is off in the suites, so nothing fires behind a case's back.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const REDIS_URL = process.env['REDIS_URL'];

let app: INestApplication;
let prisma: PrismaService;
let series: TaskSeriesService;
let queue: Queue;
let ACTOR: SignedInUser;
let FOREIGN: SignedInUser;

const api = (path: string): string => `/api/v1${path}`;
const http = (): request.Agent => request(app.getHttpServer()) as unknown as request.Agent;

describe.skipIf(!DATABASE_URL || !REDIS_URL)('M10-BE-05 — recurring tasks', () => {
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
    series = app.get(TaskSeriesService);
    queue = app.get<Queue>(getQueueToken(TASK_SERIES_JOB));
    ACTOR = await signIn(prisma, { label: 'work-series' });
    FOREIGN = await signIn(prisma, { label: 'work-series-foreign' });
  }, 60_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      const mine = await prisma.taskSeries.findMany({
        where: { userId: { in: [ACTOR.userId, FOREIGN.userId] } },
        select: { id: true },
      });
      for (const row of mine) await queue.removeJobScheduler(row.id);
      await signOutAndDelete(prisma, ACTOR.userId);
      await signOutAndDelete(prisma, FOREIGN.userId);
    }
    await app?.close();
  });

  async function createSeries(body: Record<string, unknown>, owner: SignedInUser = ACTOR) {
    const res = await http()
      .post(api('/tasks'))
      .set(owner.headers)
      .send({ repeat: { cron: '0 7 * * 1,3,5', timezone: 'America/New_York' }, ...body })
      .expect(201);
    const parsed = CreateTaskResponseSchema.parse(res.body);
    if (parsed.series === null) throw new Error('expected a series');
    expect(parsed.task).toBeNull();
    return parsed.series;
  }

  const schedulerIds = async () => (await queue.getJobSchedulers()).map((row) => row.key);

  it('creates a series, schedules it in Redis, and fires ordinary occurrences dated in its zone', async () => {
    const goal = await prisma.goal.create({ data: { userId: ACTOR.userId, title: 'Lose 8 kg' } });
    const workout = await createSeries({ title: 'Work out', goalId: goal.id });
    expect(workout).toMatchObject({ origin: 'OPERATOR', enabled: true, goalId: goal.id });
    expect(await schedulerIds()).toContain(workout.id);

    // 07:00 in New York on Monday 2026-09-21 is 11:00Z; 01:00Z on the 22nd is
    // still the 21st there. The date is the series' zone's, not UTC's.
    expect(await series.fire(workout.id, new Date('2026-09-21T11:00:00Z'))).toBe('created');
    expect(await series.fire(workout.id, new Date('2026-09-22T01:00:00Z'))).toBe('created');
    const rows = await prisma.task.findMany({
      where: { seriesId: workout.id },
      orderBy: { occursAt: 'asc' },
    });
    expect(rows.map((row) => [row.occursOn, row.status, row.goalId])).toEqual([
      ['2026-09-21', 'TODO', goal.id],
      ['2026-09-21', 'TODO', goal.id],
    ]);
  });

  it('absorbs a retried firing, and an assigned series starts no turn', async () => {
    const bot = await prisma.bot.create({
      data: {
        userId: ACTOR.userId,
        name: `Coach ${randomUUID().slice(0, 6)}`,
        role: 'Coach',
        avatarColor: '#123456',
        systemPrompt: '',
      },
    });
    await prisma.conversation.create({ data: { botId: bot.id } });
    const standup = await createSeries({ title: 'Standup notes', assigneeBotId: bot.id });
    const instant = new Date('2026-09-23T11:00:00Z');

    expect(await series.fire(standup.id, instant)).toBe('created');
    expect(await series.fire(standup.id, instant)).toBe('duplicate');
    const occurrences = await prisma.task.findMany({ where: { seriesId: standup.id } });
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.assigneeBotId).toBe(bot.id);
    // The presence above, the absence here.
    expect(await prisma.message.count({ where: { conversation: { botId: bot.id } } })).toBe(0);
    expect(await prisma.agentTurn.count({ where: { botId: bot.id } })).toBe(0);
  });

  it('shows one card per series with its history, and keeps older open occurrences reachable', async () => {
    const weigh = await createSeries({
      title: 'Log my weight',
      repeat: { cron: '0 8 * * *', timezone: 'Etc/UTC' },
    });
    const day = (n: number) => new Date(Date.UTC(2026, 8, n, 8));
    for (const n of [1, 2, 3, 4, 5, 6]) await series.fire(weigh.id, day(n));
    const byDay = await prisma.task.findMany({
      where: { seriesId: weigh.id },
      orderBy: { occursAt: 'asc' },
    });
    // Done on the 1st, 3rd, 4th and 6th; the 2nd was cancelled; the 5th was missed.
    for (const [index, status] of [
      [0, 'DONE'],
      [1, 'CANCELLED'],
      [2, 'DONE'],
      [3, 'DONE'],
      [5, 'DONE'],
    ] as const) {
      await prisma.task.update({ where: { id: byDay[index]!.id }, data: { status } });
    }

    const cards = ListTasksResponseSchema.parse(
      (
        await http()
          .get(api(`/tasks?seriesId=${weigh.id}&status=TODO,DONE,CANCELLED`))
          .set(ACTOR.headers)
          .expect(200)
      ).body,
    );
    const newest = cards.find((card) => card.id === byDay[5]!.id);
    expect(newest?.series).toEqual({
      recent: { done: 4, total: 5 },
      olderOpenCount: 1,
      newest: true,
    });
    expect(cards.find((card) => card.id === byDay[4]!.id)?.series?.newest).toBe(false);

    const detail = TaskSeriesDetailResponseSchema.parse(
      (
        await http()
          .get(api(`/task-series/${weigh.id}`))
          .set(ACTOR.headers)
          .expect(200)
      ).body,
    );
    expect(detail.occurrences.map((row) => row.id)).toEqual(
      [...byDay].reverse().map((row) => row.id),
    );
  });

  it('edits future occurrences only, stops on enabled:false, and keeps occurrences when deleted', async () => {
    const plants = await createSeries({ title: 'Water plants' });
    await series.fire(plants.id, new Date('2026-09-21T11:00:00Z'));

    const renamed = TaskSeriesSchema.parse(
      (
        await http()
          .patch(api(`/task-series/${plants.id}`))
          .set(ACTOR.headers)
          .send({ title: 'Water the plants', cron: '0 9 * * *' })
          .expect(200)
      ).body,
    );
    expect(renamed).toMatchObject({ title: 'Water the plants', cron: '0 9 * * *' });
    expect((await prisma.task.findFirstOrThrow({ where: { seriesId: plants.id } })).title).toBe(
      'Water plants',
    );
    expect((await queue.getJobSchedulers()).find((row) => row.key === plants.id)?.pattern).toBe(
      '0 9 * * *',
    );

    await http()
      .patch(api(`/task-series/${plants.id}`))
      .set(ACTOR.headers)
      .send({ enabled: false })
      .expect(200);
    expect(await schedulerIds()).not.toContain(plants.id);
    expect(await series.fire(plants.id, new Date('2026-09-22T13:00:00Z'))).toBe('skipped');

    await http()
      .delete(api(`/task-series/${plants.id}`))
      .set(ACTOR.headers)
      .expect(204);
    expect(await prisma.taskSeries.findUnique({ where: { id: plants.id } })).toBeNull();
    expect(
      await prisma.task.count({
        where: { userId: ACTOR.userId, title: 'Water plants', seriesId: null },
      }),
    ).toBe(1);
  });

  it('refuses a bad schedule, a past end date, a repeating subtask, and foreign rows', async () => {
    const send = (body: Record<string, unknown>) =>
      http().post(api('/tasks')).set(ACTOR.headers).send(body);
    await send({ title: 'x', repeat: { cron: '61 * * * *', timezone: 'Etc/UTC' } }).expect(400);
    await send({ title: 'x', repeat: { cron: '0 8 * * *', timezone: 'Mars/Olympus' } }).expect(400);
    await send({
      title: 'x',
      repeat: { cron: '0 8 * * *', timezone: 'Etc/UTC', endsOn: '2020-01-01' },
    }).expect(400);
    const parent = CreateTaskResponseSchema.parse(
      (await send({ title: 'parent' }).expect(201)).body,
    ).task;
    await send({
      title: 'x',
      parentId: parent?.id,
      repeat: { cron: '0 8 * * *', timezone: 'Etc/UTC' },
    }).expect(400);

    const theirGoal = await prisma.goal.create({
      data: { userId: FOREIGN.userId, title: 'Theirs' },
    });
    await send({
      title: 'x',
      goalId: theirGoal.id,
      repeat: { cron: '0 8 * * *', timezone: 'Etc/UTC' },
    }).expect(404);

    const theirs = await createSeries({ title: 'Theirs' }, FOREIGN);
    await http()
      .get(api(`/task-series/${theirs.id}`))
      .set(ACTOR.headers)
      .expect(404);
    await http()
      .patch(api(`/task-series/${theirs.id}`))
      .set(ACTOR.headers)
      .send({ enabled: false })
      .expect(404);
    await http()
      .delete(api(`/task-series/${theirs.id}`))
      .set(ACTOR.headers)
      .expect(404);
    expect(await schedulerIds()).toContain(theirs.id);
  });
});
