import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ListRoutinesResponseSchema, RoutineResponseSchema } from '@crewaid/shared';

import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  ROUTINE_SCHEDULER,
  RoutineQueueUnavailableError,
  type RoutineScheduler,
} from '../src/routines/routine.queue.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

/**
 * M8-BE-02 — §4.1's `/routines` CRUD and run-now, over HTTP.
 *
 * The scheduler is a recorder that can be told to refuse: whether Redis
 * holds the right keys is `routine-queue.integration.test.ts`'s claim, and
 * this suite's is that every write asks the scheduler for the right thing —
 * and that a refusal leaves the row as it was.
 *
 * Two users throughout, so every refusal of a foreign row is asserted against
 * rows that exist and that their owner can reach in the same case.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);

let app: INestApplication;
let prisma: PrismaService;
let ACTOR: SignedInUser;
let FOREIGN: SignedInUser;

const api = (path: string): string => `/api/v1${path}`;
const http = (): request.Agent => request(app.getHttpServer()) as unknown as request.Agent;

const calls: string[] = [];
let refuse = false;
const scheduler: RoutineScheduler = {
  schedule: (r) => {
    calls.push(`schedule:${r.id}:${r.cron}:${r.timezone}`);
    return refuse ? Promise.reject(new RoutineQueueUnavailableError()) : Promise.resolve();
  },
  unschedule: (id) => {
    calls.push(`unschedule:${id}`);
    return refuse ? Promise.reject(new RoutineQueueUnavailableError()) : Promise.resolve();
  },
  scheduled: () => Promise.resolve([]),
  runNow: (id) => {
    calls.push(`runNow:${id}`);
    return refuse ? Promise.reject(new RoutineQueueUnavailableError()) : Promise.resolve();
  },
};

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M8-BE-02 — /routines CRUD and run-now',
  () => {
    let seed = 0;

    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module.js');
      const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ROUTINE_SCHEDULER)
        .useValue(scheduler)
        .compile();
      app = moduleRef.createNestApplication();
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      await app.init();

      prisma = app.get(PrismaService);
      ACTOR = await signIn(prisma, { label: 'routines' });
      FOREIGN = await signIn(prisma, { label: 'routines-foreign' });
    }, 60_000);

    afterAll(async () => {
      if (prisma !== undefined) {
        await signOutAndDelete(prisma, ACTOR.userId);
        await signOutAndDelete(prisma, FOREIGN.userId);
      }
      await app?.close();
    });

    beforeEach(() => {
      calls.length = 0;
      refuse = false;
    });

    async function makeBot(owner: SignedInUser = ACTOR): Promise<string> {
      seed += 1;
      const bot = await prisma.bot.create({
        data: {
          userId: owner.userId,
          name: `Routine Bot ${RUN_ID}-${seed}`,
          role: 'Tester',
          avatarColor: '#8B6F47',
          systemPrompt: '',
        },
      });
      return bot.id;
    }

    async function makeSkill(botId: string | null): Promise<string> {
      seed += 1;
      const skill = await prisma.skill.create({
        data: {
          botId,
          name: `skill_${RUN_ID.replace(/-/g, '')}_${seed}`,
          description: 'd',
          paramsSchema: { type: 'object', properties: {} },
          script: 'export default async () => {}',
          status: 'APPROVED',
        },
      });
      return skill.id;
    }

    const create = (owner: SignedInUser, body: Record<string, unknown>) =>
      http().post(api('/routines')).set(owner.headers).send(body);

    const promptBody = (botId: string, extra: Record<string, unknown> = {}) => ({
      botId,
      name: 'Morning digest',
      cron: '0 9 * * 1-5',
      timezone: 'America/New_York',
      prompt: 'Summarise the inbox.',
      ...extra,
    });

    describe('create', () => {
      it('stores the routine, schedules it, and answers the §4.1 shape', async () => {
        const botId = await makeBot();
        const res = await create(ACTOR, promptBody(botId)).expect(201);

        const routine = RoutineResponseSchema.parse(res.body);
        expect(routine).toMatchObject({
          botId,
          cron: '0 9 * * 1-5',
          timezone: 'America/New_York',
          prompt: 'Summarise the inbox.',
          skillId: null,
          enabled: true,
          lastRunAt: null,
          lastStatus: null,
        });
        expect(calls).toEqual([`schedule:${routine.id}:0 9 * * 1-5:America/New_York`]);
      });

      it('defaults the zone to §3’s, and normalises the cron’s whitespace', async () => {
        const botId = await makeBot();
        const res = await create(
          ACTOR,
          promptBody(botId, { cron: ' */5  * * * * ', timezone: undefined }),
        ).expect(201);
        expect(res.body).toMatchObject({ cron: '*/5 * * * *', timezone: 'America/Port-au-Prince' });
      });

      it('does not schedule a routine created disabled', async () => {
        const botId = await makeBot();
        await create(ACTOR, promptBody(botId, { enabled: false })).expect(201);
        expect(calls).toEqual([]);
      });

      it('refuses a six-field cron and an unknown zone with the reason, storing nothing', async () => {
        const botId = await makeBot();
        const sixField = await create(ACTOR, promptBody(botId, { cron: '* * * * * *' })).expect(
          400,
        );
        expect(JSON.stringify(sixField.body)).toMatch(/exactly 5 fields/);
        const zone = await create(ACTOR, promptBody(botId, { timezone: 'Mars/Olympus' })).expect(
          400,
        );
        expect(JSON.stringify(zone.body)).toMatch(/Mars\/Olympus/);
        expect(await prisma.routine.count({ where: { botId } })).toBe(0);
        expect(calls).toEqual([]);
      });

      it('stores an end date, and refuses a malformed or already-passed one', async () => {
        const botId = await makeBot();
        const res = await create(ACTOR, promptBody(botId, { endsOn: '2099-09-22' })).expect(201);
        expect(res.body).toMatchObject({ endsOn: '2099-09-22' });

        await create(ACTOR, promptBody(botId, { endsOn: '2099-02-30' })).expect(400);
        const past = await create(ACTOR, promptBody(botId, { endsOn: '2020-01-01' })).expect(400);
        expect(JSON.stringify(past.body)).toMatch(/already passed/);
        expect(await prisma.routine.count({ where: { botId } })).toBe(1);
      });

      it('refuses both or neither of prompt and skillId', async () => {
        const botId = await makeBot();
        const skillId = await makeSkill(botId);
        await create(ACTOR, promptBody(botId, { skillId })).expect(400);
        await create(ACTOR, promptBody(botId, { prompt: undefined })).expect(400);
      });

      it('accepts this bot’s own skill or a global one, and not another bot’s', async () => {
        const botId = await makeBot();
        const otherBot = await makeBot();
        const own = await makeSkill(botId);
        const global = await makeSkill(null);
        const others = await makeSkill(otherBot);
        const body = (skillId: string) => promptBody(botId, { prompt: undefined, skillId });

        await create(ACTOR, body(own)).expect(201);
        await create(ACTOR, body(global)).expect(201);
        await create(ACTOR, body(others)).expect(404);
        await prisma.skill.deleteMany({ where: { id: global } });
      });

      it('answers 404 for a bot that is not the caller’s', async () => {
        const foreignBot = await makeBot(FOREIGN);
        await create(ACTOR, promptBody(foreignBot)).expect(404);
        // The presence the absence is judged against.
        await create(FOREIGN, promptBody(foreignBot)).expect(201);
      });

      it('answers 503 and keeps no row when the scheduler refuses', async () => {
        const botId = await makeBot();
        refuse = true;
        const res = await create(ACTOR, promptBody(botId)).expect(503);
        expect(JSON.stringify(res.body)).toMatch(/REDIS_URL is not set/);
        // "Saved" must mean "will fire": no row that never runs.
        expect(await prisma.routine.count({ where: { botId } })).toBe(0);
      });
    });

    describe('list', () => {
      it('lists the caller’s routines across bots, and none of anyone else’s', async () => {
        const a = await makeBot();
        const b = await makeBot();
        const foreignBot = await makeBot(FOREIGN);
        const mine1 = (await create(ACTOR, promptBody(a)).expect(201)).body as { id: string };
        const mine2 = (await create(ACTOR, promptBody(b)).expect(201)).body as { id: string };
        const theirs = (await create(FOREIGN, promptBody(foreignBot)).expect(201)).body as {
          id: string;
        };

        const res = await http().get(api('/routines')).set(ACTOR.headers).expect(200);
        const ids = ListRoutinesResponseSchema.parse(res.body).map((r) => r.id);
        expect(ids).toEqual(expect.arrayContaining([mine1.id, mine2.id]));
        expect(ids).not.toContain(theirs.id);
      });
    });

    describe('update', () => {
      async function existing(extra: Record<string, unknown> = {}) {
        const botId = await makeBot();
        const res = await create(ACTOR, promptBody(botId, extra)).expect(201);
        calls.length = 0;
        return { botId, id: (res.body as { id: string }).id };
      }

      it('reschedules when the cron or zone changes', async () => {
        const { id } = await existing();
        const res = await http()
          .patch(api(`/routines/${id}`))
          .set(ACTOR.headers)
          .send({ cron: '30 7 * * *', timezone: 'Europe/Paris' })
          .expect(200);
        expect(res.body).toMatchObject({ cron: '30 7 * * *', timezone: 'Europe/Paris' });
        expect(calls).toEqual([`schedule:${id}:30 7 * * *:Europe/Paris`]);
      });

      it('disabling unschedules, and enabling schedules again', async () => {
        const { id } = await existing();
        await http()
          .patch(api(`/routines/${id}`))
          .set(ACTOR.headers)
          .send({ enabled: false })
          .expect(200);
        await http()
          .patch(api(`/routines/${id}`))
          .set(ACTOR.headers)
          .send({ enabled: true })
          .expect(200);
        expect(calls).toEqual([`unschedule:${id}`, `schedule:${id}:0 9 * * 1-5:America/New_York`]);
      });

      it('switches a prompt routine to a skill only when the prompt is cleared too', async () => {
        const { botId, id } = await existing();
        const skillId = await makeSkill(botId);
        await http()
          .patch(api(`/routines/${id}`))
          .set(ACTOR.headers)
          .send({ skillId })
          .expect(400);
        const res = await http()
          .patch(api(`/routines/${id}`))
          .set(ACTOR.headers)
          .send({ skillId, prompt: null, skillParams: { to: 'ops' } })
          .expect(200);
        expect(res.body).toMatchObject({ skillId, prompt: null, skillParams: { to: 'ops' } });
      });

      it('refuses a bad cron without touching the row or the schedule', async () => {
        const { id } = await existing();
        await http()
          .patch(api(`/routines/${id}`))
          .set(ACTOR.headers)
          .send({ cron: '61 * * * *' })
          .expect(400);
        expect(calls).toEqual([]);
        const row = await prisma.routine.findUniqueOrThrow({ where: { id } });
        expect(row.cron).toBe('0 9 * * 1-5');
      });

      it('refuses setting a past end date, but still edits a routine that has ended', async () => {
        const { id } = await existing();
        await http()
          .patch(api(`/routines/${id}`))
          .set(ACTOR.headers)
          .send({ endsOn: '2020-01-01' })
          .expect(400);
        expect(calls).toEqual([]);

        await prisma.routine.update({ where: { id }, data: { endsOn: '2020-01-01' } });
        const renamed = await http()
          .patch(api(`/routines/${id}`))
          .set(ACTOR.headers)
          .send({ name: 'Old digest' })
          .expect(200);
        expect(renamed.body).toMatchObject({ name: 'Old digest', endsOn: '2020-01-01' });
        const extended = await http()
          .patch(api(`/routines/${id}`))
          .set(ACTOR.headers)
          .send({ endsOn: null })
          .expect(200);
        expect(extended.body).toMatchObject({ endsOn: null });
      });

      it('restores the row when the scheduler refuses', async () => {
        const { id } = await existing();
        refuse = true;
        await http()
          .patch(api(`/routines/${id}`))
          .set(ACTOR.headers)
          .send({ cron: '0 10 * * *', name: 'Renamed' })
          .expect(503);
        const row = await prisma.routine.findUniqueOrThrow({ where: { id } });
        expect(row).toMatchObject({ cron: '0 9 * * 1-5', name: 'Morning digest' });
      });

      it('answers 404 for a routine that is not the caller’s', async () => {
        const foreignBot = await makeBot(FOREIGN);
        const theirs = (await create(FOREIGN, promptBody(foreignBot)).expect(201)).body as {
          id: string;
        };
        calls.length = 0;
        await http()
          .patch(api(`/routines/${theirs.id}`))
          .set(ACTOR.headers)
          .send({ enabled: false })
          .expect(404);
        expect(calls).toEqual([]);
        await http()
          .patch(api(`/routines/${theirs.id}`))
          .set(FOREIGN.headers)
          .send({ enabled: false })
          .expect(200);
      });
    });

    describe('delete', () => {
      it('unschedules, then removes the row', async () => {
        const botId = await makeBot();
        const { id } = (await create(ACTOR, promptBody(botId)).expect(201)).body as { id: string };
        calls.length = 0;
        await http()
          .delete(api(`/routines/${id}`))
          .set(ACTOR.headers)
          .expect(204);
        expect(calls).toEqual([`unschedule:${id}`]);
        expect(await prisma.routine.findUnique({ where: { id } })).toBeNull();
      });

      it('answers 404 for a routine that is not the caller’s, and leaves it', async () => {
        const foreignBot = await makeBot(FOREIGN);
        const { id } = (await create(FOREIGN, promptBody(foreignBot)).expect(201)).body as {
          id: string;
        };
        await http()
          .delete(api(`/routines/${id}`))
          .set(ACTOR.headers)
          .expect(404);
        expect(await prisma.routine.findUnique({ where: { id } })).not.toBeNull();
      });
    });

    describe('run-now', () => {
      it('queues one firing and answers 202 with the routine', async () => {
        const botId = await makeBot();
        const { id } = (await create(ACTOR, promptBody(botId)).expect(201)).body as { id: string };
        calls.length = 0;
        const res = await http()
          .post(api(`/routines/${id}/run-now`))
          .set(ACTOR.headers)
          .expect(202);
        expect(RoutineResponseSchema.parse(res.body).id).toBe(id);
        expect(calls).toEqual([`runNow:${id}`]);
      });

      it('refuses a disabled routine with 409, queuing nothing', async () => {
        const botId = await makeBot();
        const { id } = (await create(ACTOR, promptBody(botId, { enabled: false })).expect(201))
          .body as { id: string };
        const res = await http()
          .post(api(`/routines/${id}/run-now`))
          .set(ACTOR.headers)
          .expect(409);
        expect(JSON.stringify(res.body)).toMatch(/disabled/);
        expect(calls).toEqual([]);
      });

      it('answers 503 without a queue, and 404 for a routine that is not the caller’s', async () => {
        const botId = await makeBot();
        const { id } = (await create(ACTOR, promptBody(botId)).expect(201)).body as { id: string };
        refuse = true;
        await http()
          .post(api(`/routines/${id}/run-now`))
          .set(FOREIGN.headers)
          .expect(404);
        await http()
          .post(api(`/routines/${id}/run-now`))
          .set(ACTOR.headers)
          .expect(503);
      });
    });
  },
);
