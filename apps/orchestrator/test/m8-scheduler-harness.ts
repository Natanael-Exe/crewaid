import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';

import { redisConnection } from '../src/common/queue-config.js';
import {
  ROUTINE_JOB,
  BullRoutineScheduler,
  type RoutineJobData,
} from '../src/routines/routine.queue.js';

/**
 * A real BullMQ job scheduler on a real Redis, driven by a fake CLOCK.
 *
 * Only `Date` is faked (`toFake: ['Date']`): BullMQ computes every next
 * firing and every "is this delayed job due" from the client's `Date.now()`
 * and passes it into its Lua scripts, so moving the clock is moving time as
 * far as the scheduler can tell. Timers stay real, so connections, locks and
 * `vi.waitFor` behave normally.
 *
 * One thing the clock cannot do on its own: a worker waiting for a delayed
 * job blocks in Redis for up to ten real seconds before it looks again.
 * `advanceTo` therefore also adds the queue's wake-up marker — the same
 * signal BullMQ writes when a job becomes ready — so the worker re-checks at
 * once instead of a test waiting ten seconds per firing.
 */
export class SchedulerHarness {
  readonly name = `${ROUTINE_JOB}.clock-${randomUUID().slice(0, 8)}`;
  readonly connection;
  queue: Queue<RoutineJobData>;
  scheduler: BullRoutineScheduler;
  readonly redis: Redis;
  /** Every firing a worker processed: routine id and the clock when it ran. */
  readonly fired: Array<{ routineId: string; at: number; jobId: string | undefined }> = [];
  private worker: Worker<RoutineJobData> | null = null;

  constructor(redisUrl: string, start: Date) {
    vi.useFakeTimers({ toFake: ['Date'], now: start });
    this.connection = redisConnection(redisUrl);
    this.queue = new Queue<RoutineJobData>(this.name, { connection: this.connection });
    this.scheduler = new BullRoutineScheduler(this.queue);
    this.redis = new Redis(redisUrl);
  }

  /** Start a worker — a process that owns routines coming up. */
  startWorker(): void {
    this.worker = new Worker<RoutineJobData>(
      this.name,
      (job: Job<RoutineJobData>) => {
        this.fired.push({ routineId: job.data.routineId, at: Date.now(), jobId: job.id });
        return Promise.resolve();
      },
      { connection: this.connection, concurrency: 4 },
    );
  }

  /** Stop it, as an orchestrator restart would. */
  async stopWorker(): Promise<void> {
    await this.worker?.close();
    this.worker = null;
  }

  /**
   * An orchestrator restart: the worker AND the queue client go away, and a
   * new process opens its own. Nothing survives but what is in Redis.
   */
  async restart(whileDown: () => Promise<void> = () => Promise.resolve()): Promise<void> {
    await this.stopWorker();
    await this.queue.close();
    await whileDown();
    this.queue = new Queue<RoutineJobData>(this.name, { connection: this.connection });
    this.scheduler = new BullRoutineScheduler(this.queue);
  }

  /** The schedule slot each processed firing was for, from its job id. */
  firedSlots(): number[] {
    return this.fired.map((firing) => slotOf(firing.jobId));
  }

  /** Move the clock to `at` and nudge the worker to look. */
  async advanceTo(at: number): Promise<void> {
    vi.setSystemTime(at);
    await this.redis.zadd(`bull:${this.name}:marker`, 0, '0');
  }

  /** Wait (in real time) until `count` firings have been processed. */
  async waitForFirings(count: number): Promise<void> {
    await vi.waitFor(
      () => {
        if (this.fired.length < count) throw new Error(`${this.fired.length}/${count} firings`);
      },
      { timeout: 8000, interval: 20 },
    );
  }

  /** Let a worker settle, then prove nothing further fired. */
  async settle(ms = 400): Promise<void> {
    await this.redis.zadd(`bull:${this.name}:marker`, 0, '0');
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async close(): Promise<void> {
    // The real clock first, and unconditionally: a fake `Date` left installed
    // by a cleanup that threw would leak into whichever file runs next in
    // this worker, and read there as a timing bug in code that has none.
    vi.useRealTimers();
    await this.stopWorker().catch(() => undefined);
    await this.queue.obliterate({ force: true }).catch(() => undefined);
    await this.queue.close().catch(() => undefined);
    await this.redis.quit().catch(() => undefined);
  }
}

/**
 * A scheduler's job id is `repeat:<schedulerId>:<slot millis>` — the slot is
 * read from it rather than from the clock at processing time, because the
 * slot is what the scheduler decided and the clock only says when a worker
 * got to it.
 */
export function slotOf(jobId: string | undefined): number {
  const slot = Number(jobId?.split(':').at(-1));
  if (!Number.isFinite(slot)) throw new Error(`not a scheduler job id: ${String(jobId)}`);
  return slot;
}
