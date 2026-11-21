import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { redisConnection } from '../src/common/queue-config.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ROUTINE_JOB, type RoutineJobData } from '../src/routines/routine.queue.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

/**
 * M8-BE-05 / M8-QA-05 — §6/M8: "Disabling removes the repeatable job from
 * Redis, verified by inspecting the queue."
 *
 * End to end and nothing faked: the HTTP route, `RoutinesService`, the real
 * `BullRoutineScheduler` on the production queue name, and Redis read with a
 * plain client. Every assertion is about THIS case's routine ids, because
 * the queue name is shared with anything else that ever pointed at this
 * Redis. `ROUTINE_WORKER` is off for the run (vitest.config.mts), so no
 * worker consumes the firings and no boot reconciliation rewrites them.
 *
 * Each absence is asserted after the same key was shown PRESENT, or it would
 * pass against a scheduler that never wrote anything.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const REDIS_URL = process.env['REDIS_URL'];
const RUN_ID = randomUUID().slice(0, 8);

describe.skipIf(!DATABASE_URL || !REDIS_URL)(
  'disable removes the repeatable job key from Redis (real db, real redis)',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let redis: Redis;
    let queue: Queue<RoutineJobData>;
    let ACTOR: SignedInUser;
    const routineIds: string[] = [];

    const api = (path: string): string => `/api/v1${path}`;
    const http = (): request.Agent => request(app.getHttpServer()) as unknown as request.Agent;
    const repeatKey = (id: string) => `bull:${ROUTINE_JOB}:repeat:${id}`;
    const repeatSet = `bull:${ROUTINE_JOB}:repeat`;

    /** What Redis holds for one routine, read the way an operator would. */
    async function inRedis(id: string) {
      const delayed = await queue.getDelayed();
      return {
        hash: await redis.exists(repeatKey(id)),
        inRepeatSet: (await redis.zscore(repeatSet, id)) !== null,
        scheduler: (await queue.getJobScheduler(id)) !== undefined,
        pendingFirings: delayed.filter((job) => job.data.routineId === id).length,
      };
    }
    const scheduledState = { hash: 1, inRepeatSet: true, scheduler: true, pendingFirings: 1 };
    const goneState = { hash: 0, inRepeatSet: false, scheduler: false, pendingFirings: 0 };

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
      redis = new Redis(REDIS_URL!);
      queue = new Queue<RoutineJobData>(ROUTINE_JOB, { connection: redisConnection(REDIS_URL!) });
      ACTOR = await signIn(prisma, { label: 'qa05' });
    }, 60_000);

    afterAll(async () => {
      for (const id of routineIds) await queue?.removeJobScheduler(id).catch(() => undefined);
      if (prisma !== undefined) await signOutAndDelete(prisma, ACTOR.userId);
      await queue?.close();
      await redis?.quit();
      await app?.close();
    });

    async function createRoutine(): Promise<string> {
      const bot = await prisma.bot.create({
        data: {
          userId: ACTOR.userId,
          name: `QA05 Bot ${RUN_ID}-${routineIds.length}`,
          role: 'Tester',
          avatarColor: '#8B6F47',
          systemPrompt: '',
        },
      });
      const res = await http()
        .post(api('/routines'))
        .set(ACTOR.headers)
        .send({
          botId: bot.id,
          name: 'Every five minutes',
          cron: '*/5 * * * *',
          timezone: 'America/New_York',
          prompt: 'Check the queue.',
        })
        .expect(201);
      const id = (res.body as { id: string }).id;
      routineIds.push(id);
      return id;
    }

    const patch = (id: string, body: Record<string, unknown>) =>
      http()
        .patch(api(`/routines/${id}`))
        .set(ACTOR.headers)
        .send(body)
        .expect(200);

    it('create writes the repeatable job: hash, repeat-set entry, one pending firing', async () => {
      const id = await createRoutine();
      expect(await inRedis(id)).toEqual(scheduledState);
      expect(await queue.getJobScheduler(id)).toMatchObject({
        pattern: '*/5 * * * *',
        tz: 'America/New_York',
      });
    });

    it('disabling removes all of it, and leaves the row', async () => {
      const id = await createRoutine();
      expect(await inRedis(id)).toEqual(scheduledState);

      await patch(id, { enabled: false });

      expect(await inRedis(id)).toEqual(goneState);
      const row = await prisma.routine.findUniqueOrThrow({ where: { id } });
      expect(row.enabled).toBe(false);
    });

    it('re-enabling writes it back, with exactly one pending firing', async () => {
      const id = await createRoutine();
      await patch(id, { enabled: false });
      expect(await inRedis(id)).toEqual(goneState);

      await patch(id, { enabled: true });

      expect(await inRedis(id)).toEqual(scheduledState);
    });

    it('editing a disabled routine does not schedule it', async () => {
      const id = await createRoutine();
      await patch(id, { enabled: false });

      await patch(id, { cron: '0 9 * * *', name: 'Mornings' });

      expect(await inRedis(id)).toEqual(goneState);
    });

    it('deleting removes it too', async () => {
      const id = await createRoutine();
      expect(await inRedis(id)).toEqual(scheduledState);

      await http()
        .delete(api(`/routines/${id}`))
        .set(ACTOR.headers)
        .expect(204);

      expect(await inRedis(id)).toEqual(goneState);
    });

    it('leaves other routines’ repeatable jobs in place', async () => {
      const kept = await createRoutine();
      const disabled = await createRoutine();

      await patch(disabled, { enabled: false });

      expect(await inRedis(disabled)).toEqual(goneState);
      expect(await inRedis(kept)).toEqual(scheduledState);
    });
  },
);
