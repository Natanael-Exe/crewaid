import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  GoalDetailResponseSchema,
  GoalWithProgressSchema,
  ListGoalsResponseSchema,
  ListProjectsResponseSchema,
  ProjectWithCountsSchema,
} from '@crewaid/shared';

import { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

/**
 * M10-BE-02 — projects and goals over HTTP (D-133, D-134, D-137).
 *
 * Two users throughout, so every refusal of a foreign row is asserted against
 * a row that exists and that its owner can reach in the same case.
 */
const DATABASE_URL = process.env['DATABASE_URL'];

let app: INestApplication;
let prisma: PrismaService;
let bus: TurnEventBus;
let ACTOR: SignedInUser;
let FOREIGN: SignedInUser;

const api = (path: string): string => `/api/v1${path}`;
const http = (): request.Agent => request(app.getHttpServer()) as unknown as request.Agent;

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M10-BE-02 — /projects and /goals',
  () => {
    let rank = 0;
    const nextRank = () => (rank += 1).toString(36).replace(/0+$/, '') || '1';

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
      ACTOR = await signIn(prisma, { label: 'work-pg' });
      FOREIGN = await signIn(prisma, { label: 'work-pg-foreign' });
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

    const createProject = (owner: SignedInUser, body: Record<string, unknown>) =>
      http().post(api('/projects')).set(owner.headers).send(body);
    const createGoal = (owner: SignedInUser, body: Record<string, unknown>) =>
      http().post(api('/goals')).set(owner.headers).send(body);

    async function project(owner: SignedInUser = ACTOR, name = 'Acme SaaS') {
      return ProjectWithCountsSchema.parse(
        (await createProject(owner, { name, color: '#4F46E5' }).expect(201)).body,
      );
    }

    async function task(
      userId: string,
      data: {
        projectId?: string | null;
        goalId?: string | null;
        parentId?: string | null;
        status?: 'TODO' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
        seriesId?: string;
        occursAt?: Date;
      } = {},
    ) {
      return prisma.task.create({
        data: { userId, title: `Task ${randomUUID().slice(0, 6)}`, rank: nextRank(), ...data },
      });
    }

    describe('projects', () => {
      it('creates, lists with counts, renames and archives a project', async () => {
        const events = vi.spyOn(bus, 'emitWorkChanged');
        const acme = await project();
        expect(acme).toMatchObject({ status: 'ACTIVE', openTaskCount: 0, goalCount: 0 });
        expect(events).toHaveBeenCalledWith(ACTOR.userId, 'project.changed', {
          projectId: acme.id,
        });

        await createGoal(ACTOR, { title: 'Ship the MVP', projectId: acme.id }).expect(201);
        const open = await task(ACTOR.userId, { projectId: acme.id });
        await task(ACTOR.userId, { projectId: acme.id, status: 'DONE' });
        // A subtask is counted on its parent's card, not in the project's open count.
        await task(ACTOR.userId, { projectId: acme.id, parentId: open.id });

        const listed = ListProjectsResponseSchema.parse(
          (await http().get(api('/projects')).set(ACTOR.headers).expect(200)).body,
        );
        expect(listed.find((row) => row.id === acme.id)).toMatchObject({
          openTaskCount: 1,
          goalCount: 1,
        });

        const archived = ProjectWithCountsSchema.parse(
          (
            await http()
              .patch(api(`/projects/${acme.id}`))
              .set(ACTOR.headers)
              .send({ status: 'ARCHIVED', name: 'Acme' })
              .expect(200)
          ).body,
        );
        expect(archived).toMatchObject({ status: 'ARCHIVED', name: 'Acme', openTaskCount: 1 });

        const active = ListProjectsResponseSchema.parse(
          (await http().get(api('/projects?status=ACTIVE')).set(ACTOR.headers).expect(200)).body,
        );
        expect(active.map((row) => row.id)).not.toContain(acme.id);
      });

      it('refuses to delete a project that still holds work, then deletes it once empty', async () => {
        const acme = await project(ACTOR, 'Outbound Q3');
        const held = await task(ACTOR.userId, { projectId: acme.id });

        const refused = await http()
          .delete(api(`/projects/${acme.id}`))
          .set(ACTOR.headers)
          .expect(409);
        expect(refused.body).toMatchObject({ code: 'PROJECT_NOT_EMPTY' });

        await prisma.task.delete({ where: { id: held.id } });
        const events = vi.spyOn(bus, 'emitWorkChanged');
        await http()
          .delete(api(`/projects/${acme.id}`))
          .set(ACTOR.headers)
          .expect(204);
        expect(await prisma.project.findUnique({ where: { id: acme.id } })).toBeNull();
        expect(events).toHaveBeenCalledWith(ACTOR.userId, 'project.changed', {
          projectId: acme.id,
          deleted: true,
        });
      });

      it("never lists, edits or deletes another user's project", async () => {
        const mine = await project(ACTOR, 'Private');
        const theirs = ListProjectsResponseSchema.parse(
          (await http().get(api('/projects')).set(FOREIGN.headers).expect(200)).body,
        );
        expect(theirs.map((row) => row.id)).not.toContain(mine.id);

        await http()
          .patch(api(`/projects/${mine.id}`))
          .set(FOREIGN.headers)
          .send({ name: 'Taken' })
          .expect(404);
        await http()
          .delete(api(`/projects/${mine.id}`))
          .set(FOREIGN.headers)
          .expect(404);
        expect((await prisma.project.findUniqueOrThrow({ where: { id: mine.id } })).name).toBe(
          'Private',
        );
      });

      it('refuses a malformed colour and a blank name', async () => {
        await createProject(ACTOR, { name: 'X', color: 'indigo' }).expect(400);
        await createProject(ACTOR, { name: '  ', color: '#4F46E5' }).expect(400);
      });
    });

    describe('goals', () => {
      it('stands alone without a project, and refuses another user’s project', async () => {
        const alone = GoalWithProgressSchema.parse(
          (
            await createGoal(ACTOR, { title: 'Lose 8 kg by March', targetOn: '2027-03-31' }).expect(
              201,
            )
          ).body,
        );
        expect(alone).toMatchObject({
          projectId: null,
          status: 'ACTIVE',
          progress: { done: 0, total: 0 },
          series: [],
          routineCount: 0,
        });

        const theirs = await project(FOREIGN, 'Theirs');
        await createGoal(ACTOR, { title: 'Sneaky', projectId: theirs.id }).expect(404);
      });

      it('derives progress over one-off top-level tasks, and a done rate per series', async () => {
        const goal = GoalWithProgressSchema.parse(
          (await createGoal(ACTOR, { title: 'Ship the MVP' }).expect(201)).body,
        );
        // Started a day ago, so the occurrences below fall inside its lifetime.
        await prisma.goal.update({
          where: { id: goal.id },
          data: { createdAt: new Date(Date.now() - 86_400_000) },
        });
        const parent = await task(ACTOR.userId, { goalId: goal.id, status: 'DONE' });
        await task(ACTOR.userId, { goalId: goal.id, status: 'DONE' });
        await task(ACTOR.userId, { goalId: goal.id, status: 'IN_PROGRESS' });
        await task(ACTOR.userId, { goalId: goal.id, status: 'CANCELLED' });
        await task(ACTOR.userId, { goalId: goal.id, parentId: parent.id, status: 'TODO' });

        const series = await prisma.taskSeries.create({
          data: {
            userId: ACTOR.userId,
            goalId: goal.id,
            title: 'Work out',
            cron: '0 7 * * 1,3,5',
            timezone: 'UTC',
          },
        });
        const past = (hours: number) => new Date(Date.now() - hours * 3_600_000);
        await task(ACTOR.userId, {
          goalId: goal.id,
          seriesId: series.id,
          occursAt: past(3),
          status: 'DONE',
        });
        await task(ACTOR.userId, {
          goalId: goal.id,
          seriesId: series.id,
          occursAt: past(2),
          status: 'TODO',
        });
        await task(ACTOR.userId, {
          goalId: goal.id,
          seriesId: series.id,
          occursAt: past(1),
          status: 'DONE',
        });

        const bot = await prisma.bot.create({
          data: {
            userId: ACTOR.userId,
            name: `Coach ${randomUUID().slice(0, 6)}`,
            role: 'Coach',
            avatarColor: '#123456',
            systemPrompt: '',
          },
        });
        await prisma.routine.create({
          data: {
            botId: bot.id,
            name: 'Sunday review',
            cron: '0 20 * * 0',
            prompt: 'How did I do?',
            goalId: goal.id,
          },
        });

        const listed = ListGoalsResponseSchema.parse(
          (await http().get(api('/goals')).set(ACTOR.headers).expect(200)).body,
        ).find((row) => row.id === goal.id);
        expect(listed?.progress).toEqual({ done: 2, total: 3 });
        expect(listed?.series).toEqual([
          { seriesId: series.id, title: 'Work out', enabled: true, rate: { done: 2, total: 3 } },
        ]);
        expect(listed?.routineCount).toBe(1);

        const detail = GoalDetailResponseSchema.parse(
          (
            await http()
              .get(api(`/goals/${goal.id}`))
              .set(ACTOR.headers)
              .expect(200)
          ).body,
        );
        // One-off top-level tasks only: the subtask and the occurrences are
        // counted elsewhere, and the cancelled one is still listed as such.
        expect(detail.tasks).toHaveLength(4);
        expect(detail.tasks.find((row) => row.id === parent.id)?.subtasks).toEqual({
          done: 0,
          total: 1,
        });
        expect(detail.routines).toMatchObject([{ name: 'Sunday review', botId: bot.id }]);
      });

      it('closes with a timestamp, reopens without one, and never closes itself', async () => {
        const goal = GoalWithProgressSchema.parse(
          (await createGoal(ACTOR, { title: 'Finish the deck' }).expect(201)).body,
        );
        await task(ACTOR.userId, { goalId: goal.id, status: 'DONE' });
        const full = GoalWithProgressSchema.parse(
          (
            await http()
              .patch(api(`/goals/${goal.id}`))
              .set(ACTOR.headers)
              .send({ title: 'Finish the deck!' })
              .expect(200)
          ).body,
        );
        expect(full).toMatchObject({
          progress: { done: 1, total: 1 },
          status: 'ACTIVE',
          closedAt: null,
        });

        const achieved = GoalWithProgressSchema.parse(
          (
            await http()
              .patch(api(`/goals/${goal.id}`))
              .set(ACTOR.headers)
              .send({ status: 'ACHIEVED' })
              .expect(200)
          ).body,
        );
        expect(achieved.status).toBe('ACHIEVED');
        expect(achieved.closedAt).not.toBeNull();

        const reopened = GoalWithProgressSchema.parse(
          (
            await http()
              .patch(api(`/goals/${goal.id}`))
              .set(ACTOR.headers)
              .send({ status: 'ACTIVE' })
              .expect(200)
          ).body,
        );
        expect(reopened.closedAt).toBeNull();
      });

      it('moves its tasks, recurring tasks and deliverables when it moves project', async () => {
        const from = await project(ACTOR, 'From');
        const to = await project(ACTOR, 'To');
        const goal = GoalWithProgressSchema.parse(
          (await createGoal(ACTOR, { title: 'Move me', projectId: from.id }).expect(201)).body,
        );
        const onGoal = await task(ACTOR.userId, { goalId: goal.id, projectId: from.id });
        const series = await prisma.taskSeries.create({
          data: {
            userId: ACTOR.userId,
            goalId: goal.id,
            projectId: from.id,
            title: 'Standup',
            cron: '0 9 * * 1-5',
            timezone: 'UTC',
          },
        });
        const filed = await prisma.deliverable.create({
          data: {
            userId: ACTOR.userId,
            kind: 'LINK',
            title: 'Spec',
            url: 'https://example.com/spec',
            taskId: onGoal.id,
            goalId: goal.id,
            projectId: from.id,
          },
        });
        const unrelated = await task(ACTOR.userId, { projectId: from.id });

        const events = vi.spyOn(bus, 'emitWorkChanged');
        await http()
          .patch(api(`/goals/${goal.id}`))
          .set(ACTOR.headers)
          .send({ projectId: to.id })
          .expect(200);

        expect((await prisma.task.findUniqueOrThrow({ where: { id: onGoal.id } })).projectId).toBe(
          to.id,
        );
        expect(
          (await prisma.taskSeries.findUniqueOrThrow({ where: { id: series.id } })).projectId,
        ).toBe(to.id);
        expect(
          (await prisma.deliverable.findUniqueOrThrow({ where: { id: filed.id } })).projectId,
        ).toBe(to.id);
        expect(
          (await prisma.task.findUniqueOrThrow({ where: { id: unrelated.id } })).projectId,
        ).toBe(from.id);
        expect(events).toHaveBeenCalledWith(ACTOR.userId, 'project.changed', {
          projectId: from.id,
        });
        expect(events).toHaveBeenCalledWith(ACTOR.userId, 'project.changed', { projectId: to.id });

        // A foreign destination moves nothing.
        const theirs = await project(FOREIGN, 'Not yours');
        await http()
          .patch(api(`/goals/${goal.id}`))
          .set(ACTOR.headers)
          .send({ projectId: theirs.id })
          .expect(404);
        expect((await prisma.task.findUniqueOrThrow({ where: { id: onGoal.id } })).projectId).toBe(
          to.id,
        );
      });

      it('deleting a goal unlinks its work and deletes nothing else', async () => {
        const goal = GoalWithProgressSchema.parse(
          (await createGoal(ACTOR, { title: 'Delete me' }).expect(201)).body,
        );
        const linked = await task(ACTOR.userId, { goalId: goal.id });
        await http()
          .delete(api(`/goals/${goal.id}`))
          .set(ACTOR.headers)
          .expect(204);
        expect(
          (await prisma.task.findUniqueOrThrow({ where: { id: linked.id } })).goalId,
        ).toBeNull();
      });

      it("never shows, reads, edits or deletes another user's goal", async () => {
        const goal = GoalWithProgressSchema.parse(
          (await createGoal(ACTOR, { title: 'Private goal' }).expect(201)).body,
        );
        const theirs = ListGoalsResponseSchema.parse(
          (await http().get(api('/goals')).set(FOREIGN.headers).expect(200)).body,
        );
        expect(theirs.map((row) => row.id)).not.toContain(goal.id);
        await http()
          .get(api(`/goals/${goal.id}`))
          .set(FOREIGN.headers)
          .expect(404);
        await http()
          .patch(api(`/goals/${goal.id}`))
          .set(FOREIGN.headers)
          .send({ status: 'ABANDONED' })
          .expect(404);
        await http()
          .delete(api(`/goals/${goal.id}`))
          .set(FOREIGN.headers)
          .expect(404);
        expect((await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } })).status).toBe(
          'ACTIVE',
        );
      });
    });
  },
);
