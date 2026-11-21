import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import request from 'supertest';
import { SearchResponseSchema } from '@crewaid/shared';

import { ToolRegistry, type ToolContext } from '../src/agent/tool-registry.js';
import { TaskContext } from '../src/interbot/task-context.js';
import {
  OWNED_RESOURCE,
  type OwnedResourceKind,
  type OwnedResourceSpec,
} from '../src/ownership/owned-resource.decorator.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { resolveFiling } from '../src/work/deliverable-filing.js';
import { DeliverablesController } from '../src/work/deliverables.controller.js';
import { GoalsController } from '../src/work/goals.controller.js';
import { ProjectsController } from '../src/work/projects.controller.js';
import { TaskSeriesController } from '../src/work/task-series.controller.js';
import { TaskStartController } from '../src/work/task-start.controller.js';
import { TasksController } from '../src/work/tasks.controller.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

/**
 * M10-QA-04 — PRD-WORK §8: one user's Work is unreachable from another's.
 *
 * Two signed-in users each own a full set of rows — a bot, a project, a goal,
 * a task with a subtask, a recurring series, a deliverable, a goal-linked
 * routine and a message about the task — and one of them tries every way in
 * to the other's: each by-id route, each id a body or a filter can carry,
 * each id a bot's tools accept, and search. Every refusal is paired with the
 * owner reaching the same row, so a 404 or an empty list means "not yours"
 * rather than "not there".
 *
 * The by-id routes are read off the Work controllers' own decorators, so a
 * route added later is swept without anyone remembering to list it here.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const TOKEN = `zebracorn${randomUUID().slice(0, 6)}`;

let app: INestApplication;
let prisma: PrismaService;
let ACTOR: SignedInUser;
let OWNER: SignedInUser;
const api = (path: string): string => `/api/v1${path}`;
const http = (): request.Agent => request(app.getHttpServer()) as unknown as request.Agent;

type Rows = Awaited<ReturnType<typeof seed>>;
let mine: Rows;
let theirs: Rows;

/** A full set of Work rows for one user; `mark` goes in every searchable field. */
async function seed(userId: string, mark: string) {
  const bot = await prisma.bot.create({
    data: {
      userId,
      // Not the mark: a refusal may echo back the name the bot itself typed.
      name: `Bot ${randomUUID().slice(0, 6)}`,
      role: 'Engineer',
      avatarColor: '#2563EB',
      systemPrompt: '',
    },
  });
  const conversation = await prisma.conversation.create({ data: { botId: bot.id } });
  const project = await prisma.project.create({
    data: { userId, name: `Project ${mark}`, color: '#2563EB' },
  });
  const goal = await prisma.goal.create({
    data: { userId, title: `Goal ${mark}`, outcome: `Outcome ${mark}`, projectId: project.id },
  });
  const task = await prisma.task.create({
    data: {
      userId,
      title: `Task ${mark}`,
      brief: `Brief ${mark}`,
      rank: 'm',
      projectId: project.id,
      goalId: goal.id,
      assigneeBotId: bot.id,
    },
  });
  const subtask = await prisma.task.create({
    data: {
      userId,
      title: `Subtask ${mark}`,
      rank: 'n',
      parentId: task.id,
      projectId: project.id,
      goalId: goal.id,
    },
  });
  const series = await prisma.taskSeries.create({
    data: {
      userId,
      title: `Series ${mark}`,
      cron: '0 7 * * 1',
      timezone: 'UTC',
      enabled: false,
      goalId: goal.id,
      projectId: project.id,
    },
  });
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      author: 'USER',
      content: `About ${mark}`,
      taskId: task.id,
    },
  });
  const deliverable = await prisma.deliverable.create({
    data: {
      userId,
      kind: 'LINK',
      title: `Deliverable ${mark}`,
      url: 'https://example.com/spec',
      botId: bot.id,
      taskId: task.id,
      goalId: goal.id,
      projectId: project.id,
    },
  });
  const routine = await prisma.routine.create({
    data: {
      botId: bot.id,
      name: `Routine ${mark}`,
      cron: '0 20 * * 0',
      timezone: 'UTC',
      prompt: 'Review.',
      enabled: false,
      goalId: goal.id,
    },
  });
  return { bot, conversation, project, goal, task, subtask, series, message, deliverable, routine };
}

/** Everything the owner has, as it is stored; compared before and after the sweep. */
async function snapshot(userId: string) {
  const [projects, goals, tasks, series, deliverables, events, routines, messages] =
    await Promise.all([
      prisma.project.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
      prisma.goal.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
      prisma.task.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
      prisma.taskSeries.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
      prisma.deliverable.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
      prisma.taskEvent.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
      prisma.routine.findMany({ where: { bot: { userId } }, orderBy: { id: 'asc' } }),
      prisma.message.findMany({
        where: { conversation: { bot: { userId } } },
        orderBy: { id: 'asc' },
      }),
    ]);
  return { projects, goals, tasks, series, deliverables, events, routines, messages };
}

type Route = { method: 'get' | 'post' | 'patch' | 'delete'; path: string; kind: OwnedResourceKind };

const VERBS: Partial<Record<number, Route['method']>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete',
};

/** Every by-id Work route, from the controllers' route and ownership decorators. */
function workRoutes(): Route[] {
  const controllers = [
    ProjectsController,
    GoalsController,
    TasksController,
    TaskStartController,
    TaskSeriesController,
    DeliverablesController,
  ];
  const routes: Route[] = [];
  for (const controller of controllers) {
    const base = String(Reflect.getMetadata('path', controller) ?? '');
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler: unknown = (controller.prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function' || name === 'constructor') continue;
      const spec = Reflect.getMetadata(OWNED_RESOURCE, handler) as OwnedResourceSpec | undefined;
      const method = VERBS[Reflect.getMetadata('method', handler) as number];
      if (spec === undefined || method === undefined) continue;
      const sub = String(Reflect.getMetadata('path', handler) ?? '');
      routes.push({ method, path: `/${[base, sub].filter(Boolean).join('/')}`, kind: spec.kind });
    }
  }
  return routes;
}

const idOf = (rows: Rows, kind: OwnedResourceKind): string => {
  switch (kind) {
    case 'project':
      return rows.project.id;
    case 'goal':
      return rows.goal.id;
    case 'task':
      return rows.task.id;
    case 'taskSeries':
      return rows.series.id;
    case 'deliverable':
      return rows.deliverable.id;
    default:
      throw new Error(`no ${kind} row in the seed`);
  }
};

/** A body the route would accept from its owner, so only ownership can refuse it. */
const bodyFor = (route: Route): Record<string, unknown> => {
  if (route.path.endsWith('/notes')) return { text: 'Taken' };
  if (route.method !== 'patch') return {};
  return route.kind === 'project' ? { name: 'Taken' } : { title: 'Taken' };
};

describe.skipIf(!DATABASE_URL)('M10-QA-04 — ownership and search isolation', () => {
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
    ACTOR = await signIn(prisma, { label: 'work-qa04-actor' });
    OWNER = await signIn(prisma, { label: 'work-qa04-owner' });
    mine = await seed(ACTOR.userId, 'mine');
    theirs = await seed(OWNER.userId, TOKEN);
  }, 60_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      await signOutAndDelete(prisma, ACTOR.userId);
      await signOutAndDelete(prisma, OWNER.userId);
    }
    await app?.close();
  });

  it('answers every by-id Work route with 404 for another user’s row, and changes nothing', async () => {
    const routes = workRoutes();
    // The sweep is only as good as its reach: every Work kind, every verb.
    expect(new Set(routes.map((route) => route.kind))).toEqual(
      new Set(['project', 'goal', 'task', 'taskSeries', 'deliverable']),
    );
    expect(routes.length).toBeGreaterThanOrEqual(13);

    const before = await snapshot(OWNER.userId);
    for (const route of routes) {
      const path = api(route.path.replace(':id', idOf(theirs, route.kind)));
      const res = await http()
        [route.method](path)
        .set(ACTOR.headers)
        .set('Idempotency-Key', randomUUID())
        .send(bodyFor(route));
      expect({ route: `${route.method} ${route.path}`, status: res.status }).toEqual({
        route: `${route.method} ${route.path}`,
        status: 404,
      });
    }
    expect(await snapshot(OWNER.userId)).toEqual(before);

    // The same rows are there for their owner.
    for (const path of [
      `/tasks/${theirs.task.id}`,
      `/goals/${theirs.goal.id}`,
      `/task-series/${theirs.series.id}`,
    ]) {
      await http().get(api(path)).set(OWNER.headers).expect(200);
    }
  });

  it('refuses another user’s id wherever a body names one', async () => {
    const before = await snapshot(OWNER.userId);
    const refusals: Array<[string, () => request.Test]> = [
      [
        'task in their project',
        () => http().post(api('/tasks')).send({ title: 'x', projectId: theirs.project.id }),
      ],
      [
        'task on their goal',
        () => http().post(api('/tasks')).send({ title: 'x', goalId: theirs.goal.id }),
      ],
      [
        'subtask of their task',
        () => http().post(api('/tasks')).send({ title: 'x', parentId: theirs.task.id }),
      ],
      [
        'task for their bot',
        () => http().post(api('/tasks')).send({ title: 'x', assigneeBotId: theirs.bot.id }),
      ],
      [
        'series on their goal',
        () =>
          http()
            .post(api('/tasks'))
            .send({
              title: 'x',
              goalId: theirs.goal.id,
              repeat: { cron: '0 7 * * 1', timezone: 'America/New_York' },
            }),
      ],
      [
        'goal in their project',
        () => http().post(api('/goals')).send({ title: 'x', projectId: theirs.project.id }),
      ],
      [
        'move my task to their goal',
        () =>
          http()
            .patch(api(`/tasks/${mine.task.id}`))
            .send({ goalId: theirs.goal.id }),
      ],
      [
        'move my task to their project',
        () =>
          http()
            .patch(api(`/tasks/${mine.task.id}`))
            .send({ projectId: theirs.project.id, goalId: null }),
      ],
      [
        'give my task to their bot',
        () =>
          http()
            .patch(api(`/tasks/${mine.task.id}`))
            .send({ assigneeBotId: theirs.bot.id }),
      ],
      [
        'move my goal to their project',
        () =>
          http()
            .patch(api(`/goals/${mine.goal.id}`))
            .send({ projectId: theirs.project.id }),
      ],
      [
        'move my series to their goal',
        () =>
          http()
            .patch(api(`/task-series/${mine.series.id}`))
            .send({ goalId: theirs.goal.id }),
      ],
      [
        'file my deliverable under their task',
        () =>
          http()
            .patch(api(`/deliverables/${mine.deliverable.id}`))
            .send({ taskId: theirs.task.id }),
      ],
      [
        'file my deliverable under their goal',
        () =>
          http()
            .patch(api(`/deliverables/${mine.deliverable.id}`))
            .send({ goalId: theirs.goal.id }),
      ],
      [
        'record a link under their task',
        () =>
          http().post(api('/deliverables')).send({
            kind: 'LINK',
            url: 'https://x.example.com',
            title: 'x',
            taskId: theirs.task.id,
          }),
      ],
      [
        'record a link under their goal',
        () =>
          http().post(api('/deliverables')).send({
            kind: 'LINK',
            url: 'https://x.example.com',
            title: 'x',
            goalId: theirs.goal.id,
          }),
      ],
      [
        'save their message',
        () =>
          http()
            .post(api('/deliverables'))
            .send({ kind: 'MESSAGE', messageId: theirs.message.id, title: 'x' }),
      ],
      [
        'link my routine to their goal',
        () =>
          http().post(api('/routines')).send({
            botId: mine.bot.id,
            name: 'x',
            cron: '0 8 * * *',
            timezone: 'America/New_York',
            prompt: 'x',
            enabled: false,
            goalId: theirs.goal.id,
          }),
      ],
      [
        'relink my routine to their goal',
        () =>
          http()
            .patch(api(`/routines/${mine.routine.id}`))
            .send({ goalId: theirs.goal.id }),
      ],
    ];
    for (const [what, pending] of refusals) {
      const res = await pending().set(ACTOR.headers);
      expect({ what, status: res.status }).toEqual({ what, status: 404 });
    }
    expect(await snapshot(OWNER.userId)).toEqual(before);

    // The complement: the same bodies with the actor's own ids go through.
    await http()
      .post(api('/tasks'))
      .set(ACTOR.headers)
      .send({ title: 'mine', parentId: mine.task.id, assigneeBotId: mine.bot.id })
      .expect(201);
    await http()
      .patch(api(`/deliverables/${mine.deliverable.id}`))
      .set(ACTOR.headers)
      .send({ goalId: mine.goal.id })
      .expect(200);
  });

  it('lists none of another user’s rows under any filter', async () => {
    const filters: Array<[string, string]> = [
      ['/tasks', `projectId=${theirs.project.id}`],
      ['/tasks', `goalId=${theirs.goal.id}`],
      ['/tasks', `assigneeBotId=${theirs.bot.id}`],
      ['/tasks', `parentId=${theirs.task.id}`],
      ['/tasks', `seriesId=${theirs.series.id}`],
      ['/tasks', 'status=TODO,IN_PROGRESS,IN_REVIEW,BLOCKED,DONE,CANCELLED'],
      ['/goals', `projectId=${theirs.project.id}`],
      ['/goals', ''],
      ['/projects', ''],
      ['/deliverables', `projectId=${theirs.project.id}`],
      ['/deliverables', `goalId=${theirs.goal.id}`],
      ['/deliverables', `taskId=${theirs.task.id}`],
      ['/deliverables', `botId=${theirs.bot.id}`],
      ['/deliverables', ''],
    ];
    for (const [path, query] of filters) {
      const res = await http()
        .get(api(`${path}?${query}`))
        .set(ACTOR.headers);
      // A filter naming a foreign id may refuse outright or answer empty;
      // what it may never do is return one of the owner's rows.
      expect([200, 404]).toContain(res.status);
      expect({ path, query, leaked: JSON.stringify(res.body).includes(TOKEN) }).toEqual({
        path,
        query,
        leaked: false,
      });
    }

    // The owner, asking the same unfiltered lists, does see the rows.
    for (const path of ['/tasks', '/goals', '/projects', '/deliverables']) {
      const res = await http().get(api(path)).set(OWNER.headers).expect(200);
      expect(JSON.stringify(res.body)).toContain(TOKEN);
    }
  });

  it('finds none of another user’s rows in search, while their owner finds each kind', async () => {
    const theirsFound = SearchResponseSchema.parse(
      (
        await http()
          .get(api(`/search?q=${TOKEN}`))
          .set(OWNER.headers)
          .expect(200)
      ).body,
    );
    expect(theirsFound.tasks.length).toBeGreaterThan(0);
    expect(theirsFound.goals.length).toBeGreaterThan(0);
    expect(theirsFound.projects.length).toBeGreaterThan(0);
    expect(theirsFound.deliverables.length).toBeGreaterThan(0);
    expect(theirsFound.messages.length).toBeGreaterThan(0);

    for (const query of [`q=${TOKEN}`, `q=${TOKEN}&botId=${theirs.bot.id}`]) {
      const res = await http()
        .get(api(`/search?${query}`))
        .set(ACTOR.headers);
      expect([200, 404]).toContain(res.status);
      if (res.status === 200) {
        const found = SearchResponseSchema.parse(res.body);
        expect(found).toMatchObject({
          tasks: [],
          goals: [],
          projects: [],
          deliverables: [],
          messages: [],
        });
      }
    }
  });

  it('scopes a bot’s Work tools, its task context and its filing to its own user', async () => {
    const trigger = await prisma.message.create({
      data: { conversationId: mine.conversation.id, author: 'USER', content: 'go' },
    });
    const reply = await prisma.message.create({
      data: {
        conversationId: mine.conversation.id,
        author: 'BOT',
        fromBotId: mine.bot.id,
        content: '',
      },
    });
    const tools = app.get(ToolRegistry).toolSetFor({
      userId: ACTOR.userId,
      botId: mine.bot.id,
      messageId: reply.id,
      trigger: { id: trigger.id, chainId: null, hopCount: 0 },
      browser: () => Promise.reject(new Error('no browser')),
      session: () => Promise.reject(new Error('no computer')),
      useIdentity: () => Promise.reject(new Error('no identity')),
    } as ToolContext);
    const call = async (name: string, input: Record<string, unknown>): Promise<string> => {
      const tool = tools[name];
      if (tool?.execute === undefined) throw new Error(`${name} is not registered`);
      return String(await tool.execute(input, { toolCallId: randomUUID(), messages: [] }));
    };

    const before = await snapshot(OWNER.userId);
    const answers = [
      await call('task_read', { taskId: theirs.task.id }),
      await call('task_update', { taskId: theirs.task.id, status: 'DONE', note: 'Taken' }),
      await call('task_update', { taskId: mine.task.id, goalId: theirs.goal.id }),
      await call('task_update', { taskId: mine.task.id, assignee: theirs.bot.name }),
      await call('task_list', { assignee: 'any', status: 'any' }),
      await call('task_list', { assignee: 'any', status: 'any', projectId: theirs.project.id }),
      await call('task_list', { assignee: 'any', status: 'any', goalId: theirs.goal.id }),
      await call('task_list', { assignee: 'any', status: 'any', seriesId: theirs.series.id }),
      await call('task_list', { assignee: theirs.bot.name, status: 'any' }),
      await call('task_create', { title: 'x', parentId: theirs.task.id }),
      await call('task_create', { title: 'x', goalId: theirs.goal.id }),
      await call('task_create', { title: 'x', projectId: theirs.project.id }),
      await call('task_create', { title: 'x', assignee: theirs.bot.name }),
    ];
    for (const text of answers) expect(text).not.toContain(TOKEN);
    expect(await snapshot(OWNER.userId)).toEqual(before);
    // Nothing the actor made landed under the owner's rows, or on their bot.
    expect(
      await prisma.task.count({
        where: {
          userId: ACTOR.userId,
          OR: [
            { parentId: theirs.task.id },
            { goalId: theirs.goal.id },
            { projectId: theirs.project.id },
            { assigneeBotId: theirs.bot.id },
          ],
        },
      }),
    ).toBe(0);
    // The complement: the same tool reads its own user's task.
    expect(await call('task_read', { taskId: mine.task.id })).toContain('Task mine');

    // send_message's task and a delegated trigger's task are owner-checked.
    const context = app.get(TaskContext);
    expect(await context.owned(ACTOR.userId, theirs.task.id)).toBeNull();
    expect(await context.ofMessage(ACTOR.userId, theirs.message.id)).toBeNull();
    expect(await context.owned(OWNER.userId, theirs.task.id)).toBe(theirs.task.id);

    // attach_file's filing refuses a foreign task or goal, and a foreign
    // trigger files nothing rather than filing under its task.
    await expect(
      resolveFiling(prisma, ACTOR.userId, { taskId: theirs.task.id, triggerMessageId: null }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      resolveFiling(prisma, ACTOR.userId, { goalId: theirs.goal.id, triggerMessageId: null }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await resolveFiling(prisma, ACTOR.userId, { triggerMessageId: theirs.message.id }),
    ).toEqual({
      taskId: null,
      goalId: null,
      projectId: null,
    });
    expect(
      await resolveFiling(prisma, OWNER.userId, { triggerMessageId: theirs.message.id }),
    ).toEqual({
      taskId: theirs.task.id,
      goalId: theirs.goal.id,
      projectId: theirs.project.id,
    });
  });
});
