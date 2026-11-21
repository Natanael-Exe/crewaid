import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Queue, QueueEvents, Worker, type Job } from 'bullmq';

import { redisConnection } from '../src/common/queue-config.js';
import type { StructuredLogger } from '../src/logging/structured-logger.js';
import { heldBy, type FiringRef } from '../src/routines/routine-overlap.js';
import { ROUTINE_JOB, type RoutineJobData } from '../src/routines/routine.queue.js';
import { RoutineProcessor } from '../src/routines/routine.processor.js';
import type {
  RoutineRunOutcome,
  RoutineRunnerService,
} from '../src/routines/routine-runner.service.js';

/**
 * M8-BE-04 / M8-QA-04 — §6/M8: "if the previous run is still active, the new
 * one is skipped and logged, not queued."
 */

describe('heldBy — which firing holds a routine', () => {
  const firing = (id: string, timestamp: number, routineId = 'r'): FiringRef => ({
    id,
    timestamp,
    routineId,
  });

  it('lets a firing run when nothing else of its routine is active', () => {
    const me = firing('2', 200);
    expect(heldBy(me, [me])).toBeNull();
    expect(heldBy(me, [me, firing('1', 100, 'other-routine')])).toBeNull();
  });

  it('is held by an older active firing of the same routine', () => {
    const older = firing('1', 100);
    expect(heldBy(firing('2', 200), [older, firing('2', 200)])).toBe(older);
  });

  it('is not held by a NEWER one: the older firing is the one that runs', () => {
    expect(heldBy(firing('1', 100), [firing('1', 100), firing('2', 200)])).toBeNull();
  });

  it('breaks an exact tie by id, so exactly one of the two yields', () => {
    // Deferring to "any other" would have both skip, and the slot run zero times.
    const a = firing('a', 100);
    const b = firing('b', 100);
    const aHeld = heldBy(a, [a, b]) !== null;
    const bHeld = heldBy(b, [a, b]) !== null;
    expect([aHeld, bHeld].filter(Boolean)).toHaveLength(1);
    expect(bHeld).toBe(true);
  });
});

const REDIS_URL = process.env['REDIS_URL'];

describe.skipIf(REDIS_URL === undefined || REDIS_URL === '')(
  'overlap suppression with a deliberately slow run (real redis)',
  () => {
    const closeables: Array<{ close: () => Promise<unknown> }> = [];
    const queues: Queue[] = [];

    afterAll(async () => {
      for (const closeable of closeables) await closeable.close().catch(() => undefined);
      for (const queue of queues) await queue.obliterate({ force: true }).catch(() => undefined);
    });

    /**
     * A queue of its own, a worker with room for several firings at once —
     * overlap is only possible when the worker could run two — and a runner
     * that takes as long as the case says.
     */
    function harness(runMs: number) {
      const name = `${ROUTINE_JOB}.qa04-${randomUUID().slice(0, 8)}`;
      const connection = redisConnection(REDIS_URL!);
      const queue = new Queue<RoutineJobData>(name, { connection });
      const events = new QueueEvents(name, { connection });
      queues.push(queue);
      closeables.push(queue, events);

      const started: string[] = [];
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runner = {
        run: async (routineId: string): Promise<RoutineRunOutcome> => {
          started.push(routineId);
          await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, runMs))]);
          return { kind: 'ran', status: 'SUCCEEDED' };
        },
      } as unknown as RoutineRunnerService;
      const skipped: Array<Record<string, unknown>> = [];
      const logger = {
        info: (event: string, fields: Record<string, unknown>) => {
          if (event === 'routine.run.skipped') skipped.push(fields);
        },
      } as unknown as StructuredLogger;

      const processor = new RoutineProcessor(runner, queue, logger);
      const outcomes = new Map<string, RoutineRunOutcome>();
      const worker = new Worker<RoutineJobData>(
        name,
        async (job: Job<RoutineJobData>) => {
          const outcome = await processor.process(job);
          outcomes.set(job.id ?? '', outcome);
          return outcome;
        },
        { connection, concurrency: 4 },
      );
      closeables.push(worker);

      const fire = async (routineId: string) => {
        const job = await queue.add(
          ROUTINE_JOB,
          { routineId },
          { removeOnComplete: true, removeOnFail: true },
        );
        return job.id!;
      };
      const finished = (jobId: string) =>
        new Promise<void>((resolve) => {
          const done = ({ jobId: id }: { jobId: string }) => {
            if (id === jobId) resolve();
          };
          events.on('completed', done);
          events.on('failed', done);
        });
      return { queue, events, started, skipped, outcomes, fire, finished, release };
    }

    it('skips a firing that arrives while the previous one is running, and queues nothing', async () => {
      const h = harness(10_000);
      await h.events.waitUntilReady();

      const first = await h.fire('slow-routine');
      await expect.poll(() => h.started.length, { timeout: 5000 }).toBe(1);

      const secondDone = h.finished(await h.fire('slow-routine'));
      await secondDone;

      // Exactly one run started; the second firing ended as a skip, logged
      // with the job that held the routine.
      expect(h.started).toEqual(['slow-routine']);
      expect(h.skipped).toHaveLength(1);
      expect(h.skipped[0]).toMatchObject({
        routineId: 'slow-routine',
        reason: 'overlap',
        heldByJobId: first,
      });
      // Not queued: nothing is waiting or delayed behind the running one.
      expect(await h.queue.getWaitingCount()).toBe(0);
      expect(await h.queue.getDelayedCount()).toBe(0);

      const firstDone = h.finished(first);
      h.release();
      await firstDone;
      expect(h.started).toEqual(['slow-routine']);
      expect(h.outcomes.get(first)).toEqual({ kind: 'ran', status: 'SUCCEEDED' });
    }, 20_000);

    it('does not hold back a different routine', async () => {
      const h = harness(10_000);
      await h.events.waitUntilReady();

      await h.fire('routine-a');
      await expect.poll(() => h.started.length, { timeout: 5000 }).toBe(1);
      await h.fire('routine-b');
      await expect.poll(() => h.started.length, { timeout: 5000 }).toBe(2);

      expect(h.started).toEqual(['routine-a', 'routine-b']);
      expect(h.skipped).toEqual([]);
      h.release();
    }, 20_000);

    it('runs the next firing once the previous one has finished', async () => {
      const h = harness(50);
      await h.events.waitUntilReady();

      const first = await h.fire('quick-routine');
      await h.finished(first);
      const second = await h.fire('quick-routine');
      await h.finished(second);

      expect(h.started).toEqual(['quick-routine', 'quick-routine']);
      expect(h.skipped).toEqual([]);
    }, 20_000);
  },
);
