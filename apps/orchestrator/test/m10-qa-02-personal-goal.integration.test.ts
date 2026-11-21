import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import request from 'supertest';
import {
  CreateTaskResponseSchema,
  GoalWithProgressSchema,
  GoalDetailResponseSchema,
} from '@crewaid/shared';

import { ToolRegistry, type ToolContext } from '../src/agent/tool-registry.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TASK_SERIES_JOB } from '../src/work/task-series.queue.js';
import { TaskSeriesService } from '../src/work/task-series.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

/**
 * M10-QA-02 — PRD-WORK §0.3: "lose 8 kg by March". A goal with no project,
 * two recurring tasks and a Sunday routine; a week of occurrences, some done
 * and some missed; the coach bot's `task_list` over that week; and the goal's
 * done rates. An assigned recurring task makes occurrences and starts no turn.
 *
 * The scheduler's own guarantees — one occurrence per scheduled instant across
 * DST and restarts, two on one date, an outage coalesced — are measured
 * against Redis in m10-series-schedule.integration.test.ts; here each firing
 * is driven through `fire`, exactly as the worker calls it.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const REDIS_URL = process.env['REDIS_URL'];
const NY = 'America/New_York';

let app: INestApplication;
let prisma: PrismaService;
let USER: SignedInUser;
const api = (path: string): string => `/api/v1${path}`;
const http = (): request.Agent => request(app.getHttpServer()) as unknown as request.Agent;

describe.skipIf(!DATABASE_URL || !REDIS_URL)('M10-QA-02 — a personal goal', () => {
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
    USER = await signIn(prisma, { label: 'work-qa02' });
  }, 60_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      const queue = app.get<Queue>(getQueueToken(TASK_SERIES_JOB));
      for (const row of await prisma.taskSeries.findMany({ where: { userId: USER.userId } })) {
        await queue.removeJobScheduler(row.id);
      }
      await signOutAndDelete(prisma, USER.userId);
    }
    await app?.close();
  });

  it('tracks a week of workouts and weigh-ins, reviewed by a coach bot, with nothing started', async () => {
    const coach = await prisma.bot.create({
      data: {
        userId: USER.userId,
        name: `Coach-${randomUUID().slice(0, 4)}`,
        role: 'Coach',
        avatarColor: '#16A34A',
        systemPrompt: '',
      },
    });
    const conversation = await prisma.conversation.create({ data: { botId: coach.id } });

    // The goal, with no project.
    const goal = GoalWithProgressSchema.parse(
      (
        await http()
          .post(api('/goals'))
          .set(USER.headers)
          .send({ title: 'Lose 8 kg by March', targetOn: '2027-03-31' })
          .expect(201)
      ).body,
    );
    expect(goal.projectId).toBeNull();
    // Began before the week, so its occurrences count toward the rates.
    await prisma.goal.update({
      where: { id: goal.id },
      data: { createdAt: new Date('2026-09-01T00:00:00Z') },
    });

    // "Work out", Mon/Wed/Fri, unassigned; "Log my weight", every morning, assigned to the coach.
    const series = async (title: string, cron: string, assigneeBotId?: string) => {
      const res = await http()
        .post(api('/tasks'))
        .set(USER.headers)
        .send({
          title,
          goalId: goal.id,
          repeat: { cron, timezone: NY },
          ...(assigneeBotId && { assigneeBotId }),
        })
        .expect(201);
      const made = CreateTaskResponseSchema.parse(res.body).series;
      if (made === null) throw new Error('no series');
      return made;
    };
    const workout = await series('Work out', '0 7 * * 1,3,5');
    const weigh = await series('Log my weight', '0 8 * * *', coach.id);

    // The routine: Coach, Sundays at 8 pm, linked to the goal.
    await http()
      .post(api('/routines'))
      .set(USER.headers)
      .send({
        botId: coach.id,
        name: 'Weekly review',
        cron: '0 20 * * 0',
        timezone: NY,
        prompt: 'Look at my week and tell me how I did.',
        goalId: goal.id,
        enabled: false,
      })
      .expect(201);

    // A week of firings, New York time: Mon 14 – Sun 20 September 2026. A
    // done rate counts only occurrences already due, so the week is a past one.
    const service = app.get(TaskSeriesService);
    const at = (day: number, hourUtc: number) => new Date(Date.UTC(2026, 8, day, hourUtc));
    for (const day of [14, 16, 18]) await service.fire(workout.id, at(day, 11)); // 07:00 EDT
    for (let day = 14; day <= 20; day += 1) await service.fire(weigh.id, at(day, 12)); // 08:00 EDT

    // The user ticks off 2 of 3 workouts and 6 of 7 weigh-ins; one is noted.
    const occurrences = await prisma.task.findMany({
      where: { seriesId: { in: [workout.id, weigh.id] } },
      orderBy: { occursAt: 'asc' },
    });
    const done = [
      ...occurrences.filter((row) => row.seriesId === workout.id).slice(0, 2),
      ...occurrences.filter((row) => row.seriesId === weigh.id).slice(0, 6),
    ];
    for (const row of done) {
      await http()
        .patch(api(`/tasks/${row.id}`))
        .set(USER.headers)
        .send({ status: 'DONE' })
        .expect(200);
    }
    await http()
      .post(api(`/tasks/${done[2]!.id}/notes`))
      .set(USER.headers)
      .send({ text: '82.4 kg' })
      .expect(201);

    // The occurrences are ordinary tasks dated in the series' zone, and the
    // assigned series started nothing.
    expect(occurrences.map((row) => row.occursOn)).toContain('2026-09-20');
    expect(occurrences.every((row) => row.projectId === null && row.goalId === goal.id)).toBe(true);
    expect(await prisma.message.count({ where: { conversationId: conversation.id } })).toBe(0);
    expect(await prisma.agentTurn.count({ where: { botId: coach.id } })).toBe(0);

    // Sunday: the coach reads the week, completed and missed alike.
    const trigger = await prisma.message.create({
      data: { conversationId: conversation.id, author: 'USER', content: 'review' },
    });
    const reply = await prisma.message.create({
      data: { conversationId: conversation.id, author: 'BOT', fromBotId: coach.id, content: '' },
    });
    const tools = app.get(ToolRegistry).toolSetFor({
      userId: USER.userId,
      botId: coach.id,
      messageId: reply.id,
      trigger: { id: trigger.id, chainId: null, hopCount: 0 },
      browser: () => Promise.reject(new Error('no browser')),
      session: () => Promise.reject(new Error('no computer')),
      useIdentity: () => Promise.reject(new Error('no identity')),
    } as ToolContext);
    const list = tools['task_list'];
    if (list?.execute === undefined) throw new Error('task_list is not registered');
    const week = String(
      await list.execute(
        {
          assignee: 'any',
          status: 'any',
          goalId: goal.id,
          occursFrom: '2026-09-14',
          occursThrough: '2026-09-20',
        },
        { toolCallId: randomUUID(), messages: [] },
      ),
    );
    const lines = week.split('\n');
    expect(lines).toHaveLength(10);
    expect(
      lines.filter((line) => line.includes('Work out') && line.includes('[DONE]')),
    ).toHaveLength(2);
    expect(
      lines.filter((line) => line.includes('Work out') && line.includes('[TODO]')),
    ).toHaveLength(1);
    expect(
      lines.filter((line) => line.includes('Log my weight') && line.includes('[DONE]')),
    ).toHaveLength(6);

    // The goal card: no one-off tasks, two done rates, one routine.
    const card = GoalDetailResponseSchema.parse(
      (
        await http()
          .get(api(`/goals/${goal.id}`))
          .set(USER.headers)
          .expect(200)
      ).body,
    );
    expect(card.progress).toEqual({ done: 0, total: 0 });
    expect(Object.fromEntries(card.series.map((row) => [row.title, row.rate]))).toEqual({
      'Work out': { done: 2, total: 3 },
      'Log my weight': { done: 6, total: 7 },
    });
    expect(card.routineCount).toBe(1);
    expect(card.routines.map((routine) => routine.name)).toEqual(['Weekly review']);

    // Later the user groups health goals into a project: grouping is optional at every level.
    const health = await http()
      .post(api('/projects'))
      .set(USER.headers)
      .send({ name: 'Health', color: '#16A34A' })
      .expect(201);
    await http()
      .patch(api(`/goals/${goal.id}`))
      .set(USER.headers)
      .send({ projectId: health.body.id })
      .expect(200);
    expect(await prisma.task.count({ where: { goalId: goal.id, projectId: health.body.id } })).toBe(
      10,
    );
    expect(
      (await prisma.taskSeries.findUniqueOrThrow({ where: { id: workout.id } })).projectId,
    ).toBe(health.body.id);
  }, 60_000);
});
