import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  DeliverableResponseSchema,
  GoalDetailResponseSchema,
  SearchResponseSchema,
  TaskDetailResponseSchema,
} from '@crewaid/shared';

import { AgentAttachmentService } from '../src/agent/agent-attachment.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { extractSearchText, SEARCH_TEXT_MAX_CHARS } from '../src/work/search-text.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import { conversationIdOf } from './turn-fixtures.js';

/**
 * M10-BE-09 — PRD-WORK §2.2's extras that need no new tool definition
 * (D-141): the user records a link or saves a transcript message as a
 * deliverable; a text-like file's words become searchable; and a task or
 * goal shows what its turns cost.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const ARTIFACT_DIR = process.env['ARTIFACT_DIR'];

let app: INestApplication;
let prisma: PrismaService;
let USER: SignedInUser;
let FOREIGN: SignedInUser;
const api = (path: string): string => `/api/v1${path}`;
const http = (): request.Agent => request(app.getHttpServer()) as unknown as request.Agent;

describe('M10-BE-09 — search text extraction', () => {
  it('reads text-like files only, bounded, without NUL', () => {
    expect(extractSearchText('notes.md', Buffer.from('# Acme\nRollout plan'))).toBe(
      '# Acme\nRollout plan',
    );
    for (const name of ['a.txt', 'b.CSV', 'c.json', 'd.markdown']) {
      expect(extractSearchText(name, Buffer.from('word'))).toBe('word');
    }
    expect(extractSearchText('shot.png', Buffer.from('word'))).toBeNull();
    expect(extractSearchText('empty.txt', Buffer.from('  \n'))).toBeNull();
    expect(extractSearchText('nul.txt', Buffer.from('a\u0000b'))).toBe('ab');
    const long = extractSearchText('big.txt', Buffer.from('x'.repeat(SEARCH_TEXT_MAX_CHARS * 2)));
    expect(long).toHaveLength(SEARCH_TEXT_MAX_CHARS);
  });
});

describe.skipIf(!DATABASE_URL || !ARTIFACT_DIR)('M10-BE-09 — P1 extras', () => {
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
    USER = await signIn(prisma, { label: 'work-be09' });
    FOREIGN = await signIn(prisma, { label: 'work-be09-foreign' });
  }, 60_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      await signOutAndDelete(prisma, USER.userId);
      await signOutAndDelete(prisma, FOREIGN.userId);
    }
    await app?.close();
  });

  async function botWithConversation(userId: string, name = 'Writer') {
    const bot = await prisma.bot.create({
      data: {
        userId,
        name: `${name}-${randomUUID().slice(0, 4)}`,
        role: 'Writer',
        avatarColor: '#2563EB',
        systemPrompt: '',
      },
    });
    const conversation = await prisma.conversation.create({ data: { botId: bot.id } });
    return { bot, conversation };
  }

  async function task(userId: string, data: { goalId?: string; parentId?: string } = {}) {
    return prisma.task.create({
      data: { userId, title: `Task ${randomUUID().slice(0, 4)}`, rank: 'm', ...data },
    });
  }

  /** A turn triggered by `triggerMessageId`, with its reply. */
  async function turn(
    botId: string,
    conversationId: string,
    triggerMessageId: string,
    tokens: { inputTokens: number; outputTokens: number },
    content = 'Done.',
  ) {
    const row = await prisma.agentTurn.create({
      data: {
        botId,
        conversationId: await conversationIdOf(prisma, botId),
        triggerMessageId,
        status: 'completed',
        ...tokens,
      },
    });
    return prisma.message.create({
      data: { conversationId, author: 'BOT', fromBotId: botId, content, runId: row.id },
    });
  }

  it('records a link the user files under a task, and refuses one under a foreign task', async () => {
    const mine = await task(USER.userId);
    const res = await http()
      .post(api('/deliverables'))
      .set(USER.headers)
      .send({ kind: 'LINK', url: 'https://docs.example.com/q3', title: 'Q3 plan', taskId: mine.id })
      .expect(201);
    const view = DeliverableResponseSchema.parse(res.body);
    expect(view).toMatchObject({
      kind: 'LINK',
      url: 'https://docs.example.com/q3',
      title: 'Q3 plan',
      taskId: mine.id,
      botId: null,
      attachment: null,
    });
    const events = await prisma.taskEvent.findMany({ where: { taskId: mine.id } });
    expect(events.map((row) => [row.type, row.actor])).toEqual([['DELIVERABLE_LINKED', 'USER']]);

    const theirs = await task(FOREIGN.userId);
    await http()
      .post(api('/deliverables'))
      .set(USER.headers)
      .send({ kind: 'LINK', url: 'https://x.example.com', title: 'x', taskId: theirs.id })
      .expect(404);
    await http()
      .post(api('/deliverables'))
      .set(USER.headers)
      .send({ kind: 'LINK', url: 'javascript:alert(1)', title: 'x' })
      .expect(400);
  });

  it('saves a bot reply as a deliverable, filed where its turn came from and searchable by its words', async () => {
    const { bot, conversation } = await botWithConversation(USER.userId);
    const onTask = await task(USER.userId);
    const brief = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        author: 'USER',
        content: 'Write it',
        taskId: onTask.id,
      },
    });
    const word = `quokka${randomUUID().slice(0, 6)}`;
    const reply = await turn(
      bot.id,
      conversation.id,
      brief.id,
      { inputTokens: 10, outputTokens: 5 },
      `The weekly report: churn is down, ${word} is up.`,
    );

    const res = await http()
      .post(api('/deliverables'))
      .set(USER.headers)
      .send({ kind: 'MESSAGE', messageId: reply.id, title: 'Weekly report' })
      .expect(201);
    expect(DeliverableResponseSchema.parse(res.body)).toMatchObject({
      kind: 'MESSAGE',
      messageId: reply.id,
      botId: bot.id,
      taskId: onTask.id,
    });

    const found = SearchResponseSchema.parse(
      (
        await http()
          .get(api(`/search?q=${word}&types=deliverable`))
          .set(USER.headers)
          .expect(200)
      ).body,
    );
    expect(found.deliverables.map((hit) => hit.title)).toEqual(['Weekly report']);

    // A user's own message is theirs, not a bot's; a foreign message is not found.
    const own = await http()
      .post(api('/deliverables'))
      .set(USER.headers)
      .send({ kind: 'MESSAGE', messageId: brief.id, title: 'My brief' })
      .expect(201);
    expect(own.body).toMatchObject({ botId: null, taskId: onTask.id });
    const other = await botWithConversation(FOREIGN.userId);
    const foreign = await prisma.message.create({
      data: { conversationId: other.conversation.id, author: 'USER', content: 'not yours' },
    });
    await http()
      .post(api('/deliverables'))
      .set(USER.headers)
      .send({ kind: 'MESSAGE', messageId: foreign.id, title: 'x' })
      .expect(404);
  });

  it('makes a text-like file a bot attaches searchable by what is inside it', async () => {
    const { conversation } = await botWithConversation(USER.userId);
    const trigger = await prisma.message.create({
      data: { conversationId: conversation.id, author: 'USER', content: 'go' },
    });
    const reply = await prisma.message.create({
      data: { conversationId: conversation.id, author: 'BOT', content: '' },
    });
    const word = `wombat${randomUUID().slice(0, 6)}`;
    await app.get(AgentAttachmentService).storeFromBot({
      userId: USER.userId,
      messageId: reply.id,
      filename: 'findings.md',
      bytes: Buffer.from(`# Findings\n\nThe ${word} cohort converts best.`),
      filing: { triggerMessageId: trigger.id },
    });
    const found = SearchResponseSchema.parse(
      (
        await http()
          .get(api(`/search?q=${word}`))
          .set(USER.headers)
          .expect(200)
      ).body,
    );
    expect(found.deliverables.map((hit) => hit.title)).toEqual(['findings.md']);
    // The extract is for search only; the view never carries it.
    const listed = await http().get(api('/deliverables')).set(USER.headers).expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(word);
  });

  it('shows what a task and a goal cost: the turns their messages started, and nothing else', async () => {
    const { bot, conversation } = await botWithConversation(USER.userId);
    const goal = await prisma.goal.create({ data: { userId: USER.userId, title: 'Ship it' } });
    const parent = await task(USER.userId, { goalId: goal.id });
    const child = await task(USER.userId, { goalId: goal.id, parentId: parent.id });
    const sibling = await task(USER.userId, { goalId: goal.id });
    const routine = await prisma.routine.create({
      data: {
        botId: bot.id,
        name: 'Weekly',
        cron: '0 9 * * 1',
        timezone: 'Europe/London',
        prompt: 'Review.',
        enabled: false,
        goalId: goal.id,
      },
    });
    const post = (data: { taskId?: string; routineId?: string }) =>
      prisma.message.create({
        data: { conversationId: conversation.id, author: 'USER', content: 'go', ...data },
      });

    await turn(bot.id, conversation.id, (await post({ taskId: parent.id })).id, {
      inputTokens: 1000,
      outputTokens: 100,
    });
    await turn(bot.id, conversation.id, (await post({ taskId: child.id })).id, {
      inputTokens: 200,
      outputTokens: 20,
    });
    await turn(bot.id, conversation.id, (await post({ taskId: sibling.id })).id, {
      inputTokens: 30,
      outputTokens: 3,
    });
    await turn(bot.id, conversation.id, (await post({ routineId: routine.id })).id, {
      inputTokens: 4,
      outputTokens: 1,
    });
    // About nothing: counts nowhere.
    await turn(bot.id, conversation.id, (await post({})).id, {
      inputTokens: 99_999,
      outputTokens: 9_999,
    });

    const detail = TaskDetailResponseSchema.parse(
      (
        await http()
          .get(api(`/tasks/${parent.id}`))
          .set(USER.headers)
          .expect(200)
      ).body,
    );
    expect(detail.usage).toEqual({ turns: 2, inputTokens: 1200, outputTokens: 120 });
    const quiet = TaskDetailResponseSchema.parse(
      (
        await http()
          .get(api(`/tasks/${(await task(USER.userId)).id}`))
          .set(USER.headers)
          .expect(200)
      ).body,
    );
    expect(quiet.usage).toEqual({ turns: 0, inputTokens: 0, outputTokens: 0 });

    const goalDetail = GoalDetailResponseSchema.parse(
      (
        await http()
          .get(api(`/goals/${goal.id}`))
          .set(USER.headers)
          .expect(200)
      ).body,
    );
    expect(goalDetail.usage).toEqual({ turns: 4, inputTokens: 1234, outputTokens: 124 });
  });
});
