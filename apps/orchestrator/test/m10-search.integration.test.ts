import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { SearchResponseSchema } from '@crewaid/shared';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

/**
 * M10-BE-08 — global search and jump-to-message (D-139, D-134).
 *
 * The phrase under test is planted in a transcript, a task brief, a goal and
 * a deliverable of the user — and in the same places for a second user, so
 * "no foreign hits" is asserted against foreign rows that exist and match.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const WORD = `zephyrine${randomUUID().slice(0, 6)}`;

let app: INestApplication;
let prisma: PrismaService;
let ACTOR: SignedInUser;
let FOREIGN: SignedInUser;

const api = (path: string): string => `/api/v1${path}`;
const http = (): request.Agent => request(app.getHttpServer()) as unknown as request.Agent;

type Planted = {
  botId: string;
  messageId: string;
  taskId: string;
  goalId: string;
  deliverableId: string;
  projectId: string;
};

describe.skipIf(!DATABASE_URL)('M10-BE-08 — search', () => {
  let mine: Planted;
  let theirs: Planted;

  async function plant(owner: SignedInUser): Promise<Planted> {
    const bot = await prisma.bot.create({
      data: {
        userId: owner.userId,
        name: `PM ${randomUUID().slice(0, 6)}`,
        role: 'R',
        avatarColor: '#123456',
        systemPrompt: '',
      },
    });
    const conversation = await prisma.conversation.create({ data: { botId: bot.id } });
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        author: 'BOT',
        fromBotId: bot.id,
        content: `The ${WORD} PRD covers auth, billing and onboarding.`,
      },
    });
    const project = await prisma.project.create({
      data: { userId: owner.userId, name: `Acme ${WORD}`, color: '#4F46E5' },
    });
    const goal = await prisma.goal.create({
      data: {
        userId: owner.userId,
        title: 'Ship the MVP',
        outcome: `Everything in the ${WORD} plan`,
        projectId: project.id,
      },
    });
    const task = await prisma.task.create({
      data: {
        userId: owner.userId,
        title: 'Split the PRD into tasks',
        brief: `Use the ${WORD} document`,
        rank: 'i',
        projectId: project.id,
      },
    });
    const deliverable = await prisma.deliverable.create({
      data: {
        userId: owner.userId,
        kind: 'LINK',
        title: `${WORD} PRD`,
        url: 'https://example.com/prd',
        botId: bot.id,
        projectId: project.id,
      },
    });
    return {
      botId: bot.id,
      messageId: message.id,
      taskId: task.id,
      goalId: goal.id,
      deliverableId: deliverable.id,
      projectId: project.id,
    };
  }

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
    ACTOR = await signIn(prisma, { label: 'work-search' });
    FOREIGN = await signIn(prisma, { label: 'work-search-foreign' });
    mine = await plant(ACTOR);
    theirs = await plant(FOREIGN);
  }, 60_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      await signOutAndDelete(prisma, ACTOR.userId);
      await signOutAndDelete(prisma, FOREIGN.userId);
    }
    await app?.close();
  });

  async function search(query: string, owner: SignedInUser = ACTOR) {
    return SearchResponseSchema.parse(
      (
        await http()
          .get(api(`/search?${query}`))
          .set(owner.headers)
          .expect(200)
      ).body,
    );
  }

  it('finds one phrase in a transcript, a task, a goal, a project and a deliverable, grouped', async () => {
    const hits = await search(`q=${WORD}`);
    expect(hits.messages.map((hit) => hit.id)).toEqual([mine.messageId]);
    expect(hits.tasks.map((hit) => hit.id)).toEqual([mine.taskId]);
    expect(hits.goals.map((hit) => hit.id)).toEqual([mine.goalId]);
    expect(hits.projects.map((hit) => hit.id)).toEqual([mine.projectId]);
    expect(hits.deliverables.map((hit) => hit.id)).toEqual([mine.deliverableId]);
    expect(hits.messages[0]).toMatchObject({ botId: mine.botId, author: 'BOT' });
    expect(hits.messages[0]?.excerpt).toContain(`<<${WORD}>>`);
    expect(hits.tasks[0]?.excerpt).toContain(`<<${WORD}>>`);
  });

  it('returns no foreign hits, though the foreign rows match', async () => {
    const hits = await search(`q=${WORD}`);
    const ids = [
      ...hits.messages,
      ...hits.tasks,
      ...hits.goals,
      ...hits.projects,
      ...hits.deliverables,
    ].map((hit) => hit.id);
    for (const id of Object.values(theirs)) expect(ids).not.toContain(id);
    // …and the foreign user does find their own.
    expect((await search(`q=${WORD}`, FOREIGN)).tasks.map((hit) => hit.id)).toEqual([
      theirs.taskId,
    ]);
  });

  it('narrows by type, by bot and by project', async () => {
    const onlyTasks = await search(`q=${WORD}&types=task`);
    expect(onlyTasks.tasks).toHaveLength(1);
    expect(onlyTasks.messages).toEqual([]);
    expect(onlyTasks.deliverables).toEqual([]);

    const otherBot = await prisma.bot.create({
      data: {
        userId: ACTOR.userId,
        name: `Quiet ${randomUUID().slice(0, 6)}`,
        role: 'R',
        avatarColor: '#123456',
        systemPrompt: '',
      },
    });
    const byBot = await search(`q=${WORD}&botId=${otherBot.id}`);
    expect(byBot.messages).toEqual([]);
    expect(byBot.deliverables).toEqual([]);

    const elsewhere = await prisma.project.create({
      data: { userId: ACTOR.userId, name: 'Elsewhere', color: '#000000' },
    });
    const byProject = await search(`q=${WORD}&projectId=${elsewhere.id}`);
    expect(byProject.tasks).toEqual([]);
    expect(byProject.messages).toEqual([]);
    expect((await search(`q=${WORD}&projectId=${mine.projectId}`)).tasks).toHaveLength(1);

    await http().get(api('/search?q=')).set(ACTOR.headers).expect(400);
    await http()
      .get(api(`/search?q=${WORD}&types=files`))
      .set(ACTOR.headers)
      .expect(400);
  });

  it.each([
    [
      'Task',
      'Task_search_fts_idx',
      `to_tsvector('english', "title" || ' ' || coalesce("brief", ''))`,
    ],
    [
      'Goal',
      'Goal_search_fts_idx',
      `to_tsvector('english', "title" || ' ' || coalesce("outcome", ''))`,
    ],
    [
      'Deliverable',
      'Deliverable_search_fts_idx',
      `to_tsvector('english', "title" || ' ' || coalesce("summary", '') || ' ' || coalesce("searchText", ''))`,
    ],
  ])('the %s query uses %s', async (table, index, expression) => {
    // With sequential scans off, the planner can only avoid one through an
    // index whose expression the query repeats exactly — the property a
    // mismatched spelling would silently lose.
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN SELECT id FROM "${table}" WHERE ${expression} @@ websearch_to_tsquery('english', 'prd')`,
      );
    });
    expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain(index);
  });
});
