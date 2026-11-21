import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DeliverableViewSchema, ListDeliverablesResponseSchema } from '@crewaid/shared';

import { AgentAttachmentService } from '../src/agent/agent-attachment.service.js';
import { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { MessagesService } from '../src/messages/messages.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

/**
 * M10-BE-07 — deliverables (D-136).
 *
 * Filing is tested rule by rule, in order, through the same call `attach_file`
 * makes; the all-or-nothing claim is tested by making the filing fail inside
 * the transaction and looking for what is left behind — no claimed attachment,
 * no deliverable, no reserved row.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const ARTIFACT_DIR = process.env['ARTIFACT_DIR'];

let app: INestApplication;
let prisma: PrismaService;
let attach: AgentAttachmentService;
let bus: TurnEventBus;
let ACTOR: SignedInUser;
let FOREIGN: SignedInUser;

const api = (path: string): string => `/api/v1${path}`;
const http = (): request.Agent => request(app.getHttpServer()) as unknown as request.Agent;

describe.skipIf(!DATABASE_URL || !ARTIFACT_DIR)('M10-BE-07 — deliverables', () => {
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
    attach = app.get(AgentAttachmentService);
    bus = app.get(TurnEventBus);
    ACTOR = await signIn(prisma, { label: 'work-deliverables' });
    FOREIGN = await signIn(prisma, { label: 'work-deliverables-foreign' });
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

  async function bot(owner: SignedInUser = ACTOR) {
    const row = await prisma.bot.create({
      data: {
        userId: owner.userId,
        name: `Maker ${randomUUID().slice(0, 6)}`,
        role: 'R',
        avatarColor: '#123456',
        systemPrompt: '',
      },
    });
    const conversation = await prisma.conversation.create({ data: { botId: row.id } });
    return { ...row, conversationId: conversation.id };
  }

  /** A turn: the message that started it, and the reply its tools attach to. */
  async function turn(
    maker: { id: string; conversationId: string },
    trigger: { taskId?: string; routineId?: string } = {},
  ) {
    const started = await prisma.message.create({
      data: { conversationId: maker.conversationId, author: 'USER', content: 'go', ...trigger },
    });
    const reply = await prisma.message.create({
      data: {
        conversationId: maker.conversationId,
        author: 'BOT',
        fromBotId: maker.id,
        content: '',
      },
    });
    return { triggerId: started.id, replyId: reply.id };
  }

  async function file(
    replyId: string,
    triggerMessageId: string,
    extra: { taskId?: string; goalId?: string; filename?: string } = {},
    owner: SignedInUser = ACTOR,
  ) {
    return attach.storeFromBot({
      userId: owner.userId,
      messageId: replyId,
      filename: extra.filename ?? `notes-${randomUUID().slice(0, 6)}.md`,
      bytes: Buffer.from('# notes'),
      filing: {
        triggerMessageId,
        sourcePath: '/home/bot/shared/notes.md',
        summary: 'Auth notes',
        ...(extra.taskId !== undefined && { taskId: extra.taskId }),
        ...(extra.goalId !== undefined && { goalId: extra.goalId }),
      },
    });
  }

  const deliverableOf = (attachmentId: string) =>
    prisma.deliverable.findUniqueOrThrow({ where: { attachmentId } });

  async function work() {
    const project = await prisma.project.create({
      data: { userId: ACTOR.userId, name: 'Acme SaaS', color: '#4F46E5' },
    });
    const goal = await prisma.goal.create({
      data: { userId: ACTOR.userId, title: 'Ship the MVP', projectId: project.id },
    });
    const task = await prisma.task.create({
      data: {
        userId: ACTOR.userId,
        title: 'API auth',
        rank: 'i',
        goalId: goal.id,
        projectId: project.id,
      },
    });
    return { project, goal, task };
  }

  describe('filing, in order (D-136)', () => {
    it('rule 2: files under the task the trigger was about, with its goal and project', async () => {
      const { project, goal, task } = await work();
      const maker = await bot();
      const { triggerId, replyId } = await turn(maker, { taskId: task.id });
      const events = vi.spyOn(bus, 'emitWorkChanged');

      const stored = await file(replyId, triggerId);
      const row = await deliverableOf(stored.id);
      expect(row).toMatchObject({
        kind: 'FILE',
        botId: maker.id,
        taskId: task.id,
        goalId: goal.id,
        projectId: project.id,
        sourcePath: '/home/bot/shared/notes.md',
        summary: 'Auth notes',
      });
      expect(
        await prisma.taskEvent.findFirst({
          where: { taskId: task.id, type: 'DELIVERABLE_LINKED' },
        }),
      ).toMatchObject({ actor: 'BOT', actorBotId: maker.id, messageId: replyId });
      expect(events).toHaveBeenCalledWith(ACTOR.userId, 'deliverable.changed', {
        deliverableId: row.id,
      });
      expect(events).toHaveBeenCalledWith(ACTOR.userId, 'task.changed', { taskId: task.id });
    });

    it('rule 1 wins over the trigger, and a task and goal that disagree are refused', async () => {
      const { goal, task } = await work();
      const other = await prisma.goal.create({ data: { userId: ACTOR.userId, title: 'Other' } });
      const maker = await bot();
      const { triggerId, replyId } = await turn(maker, { taskId: task.id });

      const byGoal = await file(replyId, triggerId, { goalId: other.id });
      expect(await deliverableOf(byGoal.id)).toMatchObject({
        taskId: null,
        goalId: other.id,
        projectId: null,
      });

      await expect(file(replyId, triggerId, { taskId: task.id, goalId: other.id })).rejects.toThrow(
        /not on that goal/,
      );
      const agreeing = await file(replyId, triggerId, { taskId: task.id, goalId: goal.id });
      expect((await deliverableOf(agreeing.id)).taskId).toBe(task.id);
    });

    it('rule 3: a routine’s run files under the routine’s goal', async () => {
      const { goal } = await work();
      const maker = await bot();
      const routine = await prisma.routine.create({
        data: {
          botId: maker.id,
          name: 'Weekly',
          cron: '0 9 * * 1',
          prompt: 'report',
          goalId: goal.id,
        },
      });
      const { triggerId, replyId } = await turn(maker, { routineId: routine.id });
      const stored = await file(replyId, triggerId);
      expect(await deliverableOf(stored.id)).toMatchObject({ taskId: null, goalId: goal.id });
    });

    it('rule 4: with no provenance it is Unfiled — a later turn does not inherit a task', async () => {
      const { task } = await work();
      const maker = await bot();
      await turn(maker, { taskId: task.id });
      const later = await turn(maker);
      const stored = await file(later.replyId, later.triggerId);
      expect(await deliverableOf(stored.id)).toMatchObject({
        taskId: null,
        goalId: null,
        projectId: null,
      });
    });
  });

  it('claims nothing and keeps nothing when filing fails, and a retry records one of each', async () => {
    const maker = await bot();
    const { triggerId, replyId } = await turn(maker);
    const theirs = await prisma.task.create({
      data: { userId: FOREIGN.userId, title: 'x', rank: 'i' },
    });
    const before = await prisma.attachment.count({ where: { ownerId: ACTOR.userId } });

    await expect(
      file(replyId, triggerId, { taskId: theirs.id, filename: 'report.md' }),
    ).rejects.toThrow(/not found/i);
    expect(await prisma.attachment.count({ where: { ownerId: ACTOR.userId } })).toBe(before);
    expect(await prisma.attachment.count({ where: { messageId: replyId } })).toBe(0);
    expect(
      await prisma.deliverable.count({ where: { userId: ACTOR.userId, title: 'report.md' } }),
    ).toBe(0);

    const retried = await file(replyId, triggerId, { filename: 'report.md' });
    expect(await prisma.attachment.count({ where: { messageId: replyId } })).toBe(1);
    expect(await prisma.deliverable.count({ where: { attachmentId: retried.id } })).toBe(1);
  });

  describe('routes', () => {
    it('lists newest first with filters, pages by cursor, and counts', async () => {
      const { task } = await work();
      const maker = await bot();
      const onTask = await turn(maker, { taskId: task.id });
      const loose = await turn(maker);
      const filed = [];
      for (let i = 0; i < 3; i += 1) filed.push(await file(onTask.replyId, onTask.triggerId));
      const unfiled = await file(loose.replyId, loose.triggerId);

      const list = async (query: string) =>
        ListDeliverablesResponseSchema.parse(
          (
            await http()
              .get(api(`/deliverables${query}`))
              .set(ACTOR.headers)
              .expect(200)
          ).body,
        );
      const byTask = await list(`?taskId=${task.id}`);
      expect(byTask.total).toBe(3);
      expect(byTask.items.map((item) => item.attachmentId)).toEqual(
        filed.map((row) => row.id).reverse(),
      );
      expect(byTask.items[0]?.task).toEqual({ id: task.id, title: 'API auth' });
      expect(byTask.items[0]?.attachment?.messageId).toBe(onTask.replyId);

      const first = await list(`?botId=${maker.id}&limit=2`);
      expect(first.items).toHaveLength(2);
      const second = await list(`?botId=${maker.id}&limit=2&before=${first.nextCursor}`);
      expect(second.nextCursor).toBeNull();
      expect([...first.items, ...second.items].map((item) => item.attachmentId)).toEqual(
        [...filed, unfiled].map((row) => row.id).reverse(),
      );
      expect((await list('?unfiled=true')).items.map((item) => item.attachmentId)).toContain(
        unfiled.id,
      );
      expect((await list('?unfiled=true')).items.map((item) => item.attachmentId)).not.toContain(
        filed[0]?.id,
      );

      const theirs = ListDeliverablesResponseSchema.parse(
        (await http().get(api('/deliverables')).set(FOREIGN.headers).expect(200)).body,
      );
      expect(theirs.items.map((item) => item.attachmentId)).not.toContain(unfiled.id);
    });

    it('narrows by words in the title or summary, any case, and still pages', async () => {
      const mark = `zeta${randomUUID().slice(0, 6)}`;
      const titled = async (title: string, summary: string | null = null) =>
        prisma.deliverable.create({
          data: { userId: ACTOR.userId, kind: 'LINK', url: 'https://example.com', title, summary },
        });
      // Oldest, so a second page that lost the query would reach it.
      await titled('Unrelated');
      const a = await titled(`Weekly ${mark} report`);
      const b = await titled('Launch plan', `The ${mark.toUpperCase()} numbers`);
      const c = await titled(`${mark} checklist`);

      const list = async (query: string) =>
        ListDeliverablesResponseSchema.parse(
          (
            await http()
              .get(api(`/deliverables${query}`))
              .set(ACTOR.headers)
              .expect(200)
          ).body,
        );
      const all = await list(`?q=${mark.toUpperCase()}`);
      expect(all.total).toBe(3);
      expect(all.items.map((item) => item.id)).toEqual([c.id, b.id, a.id]);

      // The query and the cursor each add an OR; paging must honour both.
      const first = await list(`?q=${mark}&limit=2`);
      const second = await list(`?q=${mark}&limit=2&before=${first.nextCursor}`);
      expect([...first.items, ...second.items].map((item) => item.id)).toEqual([c.id, b.id, a.id]);
      expect(second.nextCursor).toBeNull();

      await http().get(api('/deliverables?q=%20%20')).set(ACTOR.headers).expect(400);
    });

    it('re-files, renames and deletes only the record; foreign ids are 404', async () => {
      const { project, goal, task } = await work();
      const maker = await bot();
      const loose = await turn(maker);
      const stored = await file(loose.replyId, loose.triggerId);
      const row = await deliverableOf(stored.id);

      const moved = DeliverableViewSchema.parse(
        (
          await http()
            .patch(api(`/deliverables/${row.id}`))
            .set(ACTOR.headers)
            .send({ taskId: task.id, title: 'Auth notes' })
            .expect(200)
        ).body,
      );
      expect(moved).toMatchObject({
        title: 'Auth notes',
        taskId: task.id,
        goalId: goal.id,
        projectId: project.id,
      });

      const onlyProject = DeliverableViewSchema.parse(
        (
          await http()
            .patch(api(`/deliverables/${row.id}`))
            .set(ACTOR.headers)
            .send({ projectId: project.id })
            .expect(200)
        ).body,
      );
      expect(onlyProject).toMatchObject({ taskId: null, goalId: null, projectId: project.id });

      const theirGoal = await prisma.goal.create({ data: { userId: FOREIGN.userId, title: 'x' } });
      await http()
        .patch(api(`/deliverables/${row.id}`))
        .set(ACTOR.headers)
        .send({ goalId: theirGoal.id })
        .expect(404);
      await http()
        .patch(api(`/deliverables/${row.id}`))
        .set(FOREIGN.headers)
        .send({ title: 'mine' })
        .expect(404);
      await http()
        .delete(api(`/deliverables/${row.id}`))
        .set(FOREIGN.headers)
        .expect(404);

      await http()
        .delete(api(`/deliverables/${row.id}`))
        .set(ACTOR.headers)
        .expect(204);
      expect(await prisma.deliverable.findUnique({ where: { id: row.id } })).toBeNull();
      expect(await prisma.attachment.findUnique({ where: { id: stored.id } })).not.toBeNull();
    });
  });

  it('a routine’s own message carries it, and a routine takes only the user’s goal', async () => {
    const maker = await bot();
    const goal = await prisma.goal.create({ data: { userId: ACTOR.userId, title: 'Lose 8 kg' } });
    const routine = await prisma.routine.create({
      data: {
        botId: maker.id,
        name: 'Sunday',
        cron: '0 20 * * 0',
        prompt: 'review',
        goalId: goal.id,
      },
    });
    const posted = await app
      .get(MessagesService)
      .createUserMessage(ACTOR.userId, maker.id, { content: 'review' }, { routineId: routine.id });
    expect(posted.routineId).toBe(routine.id);

    const theirGoal = await prisma.goal.create({ data: { userId: FOREIGN.userId, title: 'x' } });
    const res = await http()
      .patch(api(`/routines/${routine.id}`))
      .set(ACTOR.headers)
      .send({ goalId: theirGoal.id });
    expect(res.status).toBe(404);
    expect((await prisma.routine.findUniqueOrThrow({ where: { id: routine.id } })).goalId).toBe(
      goal.id,
    );
  });
});
