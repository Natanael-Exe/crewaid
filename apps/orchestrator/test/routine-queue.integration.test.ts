import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';

import { redisConnection } from '../src/common/queue-config.js';
import type { StructuredLogger } from '../src/logging/structured-logger.js';
import { RoutineScheduleError } from '../src/routines/routine-schedule.js';
import { BullRoutineScheduler, type RoutineJobData } from '../src/routines/routine.queue.js';
import { RoutineProcessor } from '../src/routines/routine.processor.js';
import type {
  RoutineRunOutcome,
  RoutineRunnerService,
} from '../src/routines/routine-runner.service.js';

/**
 * M8-BE-01 — a routine's schedule as BullMQ holds it, against a real Redis.
 *
 * Every case uses a queue of its own. The production queue name is shared by
 * every orchestrator that has ever pointed at this Redis, and a suite that
 * asserted "exactly one scheduler" over it would be asserting about them.
 */

const REDIS_URL = process.env['REDIS_URL'];
const NY = 'America/New_York';
const silentLogger = { info: () => undefined } as unknown as StructuredLogger;

describe.skipIf(REDIS_URL === undefined || REDIS_URL === '')(
  'BullRoutineScheduler (real redis)',
  () => {
    const opened: Array<{ close: () => Promise<unknown> }> = [];
    const queues: Queue[] = [];

    afterAll(async () => {
      for (const queue of queues) await queue.obliterate({ force: true }).catch(() => undefined);
      for (const closeable of opened) await closeable.close().catch(() => undefined);
    });

    function fresh(): { queue: Queue<RoutineJobData>; scheduler: BullRoutineScheduler } {
      const name = `routine.run.test-${randomUUID().slice(0, 8)}`;
      const queue = new Queue<RoutineJobData>(name, { connection: redisConnection(REDIS_URL!) });
      opened.push(queue);
      queues.push(queue);
      return { queue, scheduler: new BullRoutineScheduler(queue) };
    }

    const routine = (id: string, cron = '*/5 * * * *', timezone = NY) => ({ id, cron, timezone });

    it('stores one scheduler per routine, keyed by its id, with pattern and zone', async () => {
      const { queue, scheduler } = fresh();
      await scheduler.schedule(routine('r-a'));

      const stored = await queue.getJobScheduler('r-a');
      expect(stored).toMatchObject({ key: 'r-a', pattern: '*/5 * * * *', tz: NY });
      await expect(scheduler.scheduled()).resolves.toEqual([
        { routineId: 'r-a', pattern: '*/5 * * * *', tz: NY, endDate: null },
      ]);
    });

    it('passes the inclusive end date to BullMQ', async () => {
      const { queue, scheduler } = fresh();
      await scheduler.schedule({ ...routine('r-ends'), endsOn: '2099-09-22' });
      const stored = await queue.getJobScheduler('r-ends');
      expect(stored?.endDate).toBe(new Date('2099-09-23T03:59:59.999Z').getTime());
    });

    it('schedules exactly one next firing, carrying only the routine id', async () => {
      const { queue, scheduler } = fresh();
      await scheduler.schedule(routine('r-b'));

      const delayed = await queue.getDelayed();
      expect(delayed).toHaveLength(1);
      expect(delayed[0]?.data).toEqual({ routineId: 'r-b' });
      // The firing is on a five-minute mark in real time — */5 has the same
      // marks in every whole-hour zone, so this checks the pattern landed.
      const at = (delayed[0]?.timestamp ?? 0) + (delayed[0]?.delay ?? 0);
      expect(new Date(at).getUTCMinutes() % 5).toBe(0);
    });

    it('does not duplicate the next firing when the same schedule is written again', async () => {
      // What an edit that changes nothing, and every boot, does.
      const { queue, scheduler } = fresh();
      await scheduler.schedule(routine('r-c'));
      await scheduler.schedule(routine('r-c'));
      await scheduler.schedule(routine('r-c'));

      expect(await queue.getJobSchedulersCount()).toBe(1);
      expect(await queue.getDelayed()).toHaveLength(1);
    });

    it('replaces the schedule when the pattern or zone changes', async () => {
      const { queue, scheduler } = fresh();
      await scheduler.schedule(routine('r-d'));
      await scheduler.schedule(routine('r-d', '0 9 * * *', 'Europe/Paris'));

      expect(await queue.getJobScheduler('r-d')).toMatchObject({
        pattern: '0 9 * * *',
        tz: 'Europe/Paris',
      });
      expect(await queue.getJobSchedulersCount()).toBe(1);
    });

    it('refuses a bad schedule before anything reaches Redis', async () => {
      const { queue, scheduler } = fresh();
      await expect(scheduler.schedule(routine('r-e', '* * * * * *'))).rejects.toThrow(
        RoutineScheduleError,
      );
      expect(await queue.getJobSchedulersCount()).toBe(0);
    });

    it('unschedule removes the repeat key and the pending firing', async () => {
      const { queue, scheduler } = fresh();
      await scheduler.schedule(routine('r-f'));
      await scheduler.schedule(routine('r-keep'));

      const redis = new Redis(REDIS_URL!);
      opened.push({ close: () => redis.quit() });
      const repeatKey = `bull:${queue.name}:repeat:r-f`;
      // Assert against a presence first, or the absence below proves nothing.
      expect(await redis.exists(repeatKey)).toBe(1);

      await scheduler.unschedule('r-f');

      expect(await redis.exists(repeatKey)).toBe(0);
      expect(await redis.zscore(`bull:${queue.name}:repeat`, 'r-f')).toBeNull();
      expect(await queue.getJobScheduler('r-f')).toBeUndefined();
      const delayed = await queue.getDelayed();
      expect(delayed.map((job) => job.data.routineId)).toEqual(['r-keep']);
    });

    it('unschedule of a routine that was never scheduled resolves', async () => {
      const { scheduler } = fresh();
      await expect(scheduler.unschedule('never')).resolves.toBeUndefined();
    });

    it('a firing reaches the processor once and the next one is scheduled behind it', async () => {
      const { queue, scheduler } = fresh();
      await scheduler.schedule(routine('r-g'));

      const ran: string[] = [];
      const runner = {
        run: (routineId: string): Promise<RoutineRunOutcome> => {
          ran.push(routineId);
          return Promise.resolve({ kind: 'ran', status: 'SUCCEEDED' });
        },
      } as unknown as RoutineRunnerService;
      const processor = new RoutineProcessor(runner, queue, silentLogger);

      const completed = new Promise<void>((resolve) => {
        const worker = new Worker<RoutineJobData>(
          queue.name,
          (job: Job<RoutineJobData>) => processor.process(job),
          { connection: redisConnection(REDIS_URL!) },
        );
        opened.push(worker);
        worker.on('completed', () => resolve());
      });

      // Bring the scheduled firing forward rather than wait up to five
      // minutes for it: `promote` moves the very job the scheduler created.
      const [next] = await queue.getDelayed();
      expect(next).toBeDefined();
      const firstId = next!.id;
      await next!.promote();
      await completed;

      expect(ran).toEqual(['r-g']);
      const after = await queue.getDelayed();
      expect(after).toHaveLength(1);
      expect(after[0]?.id).not.toBe(firstId);
      expect(after[0]?.data).toEqual({ routineId: 'r-g' });
    });
  },
);
