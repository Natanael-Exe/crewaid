import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';

import { redisConnection } from '../src/common/queue-config.js';
import { StructuredLogger } from '../src/logging/structured-logger.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { reconcileSchedules } from '../src/routines/routine-schedule.reconciler.js';
import type { WorkEvents } from '../src/work/work-events.js';
import {
  BullTaskSeriesScheduler,
  TASK_SERIES_JOB,
  scheduledInstant,
  type TaskSeriesJobData,
} from '../src/work/task-series.queue.js';
import { TaskSeriesService } from '../src/work/task-series.service.js';

/**
 * M10-BE-05 — a series fires on the routine machinery (D-137, D-122):
 * exactly one occurrence per scheduled instant across a DST change and a
 * restart, two on one local date when the schedule says so, and one — not a
 * backlog — after a long outage.
 *
 * Real Redis and a real database; only `Date` is faked, the way the M8
 * scheduler suites do it, and the worker calls the service's `fire` exactly
 * as the production processor does.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const REDIS_URL = process.env['REDIS_URL'];
const NY = 'America/New_York';
const USER = `usr_series_clock_${randomUUID().slice(0, 8)}`;

class SeriesClock {
  readonly name = `${TASK_SERIES_JOB}.clock-${randomUUID().slice(0, 8)}`;
  readonly connection;
  queue: Queue<TaskSeriesJobData>;
  scheduler: BullTaskSeriesScheduler;
  readonly redis: Redis;
  fired = 0;
  private worker: Worker<TaskSeriesJobData> | null = null;

  constructor(
    redisUrl: string,
    start: Date,
    private readonly service: () => TaskSeriesService,
  ) {
    vi.useFakeTimers({ toFake: ['Date'], now: start });
    this.connection = redisConnection(redisUrl);
    this.queue = new Queue(this.name, { connection: this.connection });
    this.scheduler = new BullTaskSeriesScheduler(this.queue);
    this.redis = new Redis(redisUrl);
  }

  startWorker(): void {
    this.worker = new Worker<TaskSeriesJobData>(
      this.name,
      async (job: Job<TaskSeriesJobData>) => {
        await this.service().fire(job.data.seriesId, scheduledInstant(job));
        this.fired += 1;
      },
      { connection: this.connection, concurrency: 1 },
    );
  }

  async restart(whileDown: () => Promise<void> = () => Promise.resolve()): Promise<void> {
    await this.worker?.close();
    this.worker = null;
    await this.queue.close();
    await whileDown();
    this.queue = new Queue(this.name, { connection: this.connection });
    this.scheduler = new BullTaskSeriesScheduler(this.queue);
  }

  async advanceTo(at: number): Promise<void> {
    vi.setSystemTime(at);
    await this.redis.zadd(`bull:${this.name}:marker`, 0, '0');
  }

  async waitForFirings(count: number): Promise<void> {
    await vi.waitFor(
      () => {
        if (this.fired < count) throw new Error(`${this.fired}/${count} firings`);
      },
      { timeout: 8000, interval: 20 },
    );
  }

  async settle(ms = 400): Promise<void> {
    await this.redis.zadd(`bull:${this.name}:marker`, 0, '0');
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async close(): Promise<void> {
    vi.useRealTimers();
    await this.worker?.close().catch(() => undefined);
    await this.queue.obliterate({ force: true }).catch(() => undefined);
    await this.queue.close().catch(() => undefined);
    await this.redis.quit().catch(() => undefined);
  }
}

describe.skipIf(!DATABASE_URL || !REDIS_URL)('M10-BE-05 — series on the scheduler', () => {
  let prisma: PrismaService;
  let clock: SeriesClock | undefined;
  const noEvents = { task: () => {}, goal: () => {}, project: () => {} } as unknown as WorkEvents;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.user.create({ data: { id: USER, name: 'Clock', email: `${USER}@test.invalid` } });
  });

  afterEach(async () => {
    await clock?.close();
    clock = undefined;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: USER } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  function start(at: string): SeriesClock {
    const made: SeriesClock = new SeriesClock(
      REDIS_URL!,
      new Date(at),
      () => new TaskSeriesService(prisma, made.scheduler, noEvents, new StructuredLogger()),
    );
    return made;
  }

  async function series(cron: string) {
    return prisma.taskSeries.create({
      data: { userId: USER, title: `Series ${randomUUID().slice(0, 6)}`, cron, timezone: NY },
    });
  }

  const occurrences = async (seriesId: string) =>
    (
      await prisma.task.findMany({
        where: { seriesId },
        orderBy: { occursAt: 'asc' },
        select: { occursAt: true, occursOn: true },
      })
    ).map((row) => [row.occursAt?.toISOString(), row.occursOn]);

  it('fires once per instant across spring-forward, dated in its own zone', async () => {
    // 07:00 New York every day. On 2026-03-08 the clocks jump from 02:00 to
    // 03:00, so 07:00 moves from 12:00Z to 11:00Z.
    clock = start('2026-03-07T06:00:00Z');
    const row = await series('0 7 * * *');
    await clock.scheduler.schedule(row);
    clock.startWorker();

    for (const [at, count] of [
      ['2026-03-07T12:00:00Z', 1],
      ['2026-03-08T11:00:00Z', 2],
      ['2026-03-09T11:00:00Z', 3],
    ] as const) {
      await clock.advanceTo(Date.parse(at));
      await clock.waitForFirings(count);
    }
    await clock.settle();

    expect(await occurrences(row.id)).toEqual([
      ['2026-03-07T12:00:00.000Z', '2026-03-07'],
      ['2026-03-08T11:00:00.000Z', '2026-03-08'],
      ['2026-03-09T11:00:00.000Z', '2026-03-09'],
    ]);
  }, 30_000);

  it('fires once on the fall-back date, when its local time happens twice', async () => {
    // 01:30 New York every day. On 2026-11-01 the clocks fall back from 02:00
    // EDT to 01:00 EST, so 01:30 happens at 05:30Z and again at 06:30Z; the
    // series is due once that day, not twice.
    clock = start('2026-10-31T04:00:00Z');
    const row = await series('30 1 * * *');
    await clock.scheduler.schedule(row);
    clock.startWorker();

    for (const [at, count] of [
      ['2026-10-31T05:30:00Z', 1],
      ['2026-11-01T05:30:00Z', 2],
      ['2026-11-02T06:30:00Z', 3],
    ] as const) {
      await clock.advanceTo(Date.parse(at));
      await clock.waitForFirings(count);
    }
    await clock.settle();

    expect(await occurrences(row.id)).toEqual([
      ['2026-10-31T05:30:00.000Z', '2026-10-31'],
      ['2026-11-01T05:30:00.000Z', '2026-11-01'],
      ['2026-11-02T06:30:00.000Z', '2026-11-02'],
    ]);
  }, 30_000);

  it('makes two occurrences for two firings on one local date', async () => {
    clock = start('2026-06-01T12:30:00Z');
    const row = await series('0 */1 * * *');
    await clock.scheduler.schedule(row);
    clock.startWorker();
    await clock.advanceTo(Date.parse('2026-06-01T13:00:00Z'));
    await clock.waitForFirings(1);
    await clock.advanceTo(Date.parse('2026-06-01T14:00:00Z'));
    await clock.waitForFirings(2);
    await clock.settle();

    expect(await occurrences(row.id)).toEqual([
      ['2026-06-01T13:00:00.000Z', '2026-06-01'],
      ['2026-06-01T14:00:00.000Z', '2026-06-01'],
    ]);
  }, 30_000);

  it('neither duplicates nor skips across a restart between firings', async () => {
    clock = start('2026-06-01T13:02:00Z');
    const row = await series('*/5 * * * *');
    await clock.scheduler.schedule(row);
    clock.startWorker();
    await clock.advanceTo(Date.parse('2026-06-01T13:05:00Z'));
    await clock.waitForFirings(1);

    const c = clock;
    await c.restart(() => c.advanceTo(Date.parse('2026-06-01T13:07:00Z')));
    await reconcileSchedules([row], await c.scheduler.scheduled(), c.scheduler);
    c.startWorker();
    await c.advanceTo(Date.parse('2026-06-01T13:10:00Z'));
    await c.waitForFirings(2);
    await c.settle();

    expect((await occurrences(row.id)).map(([at]) => at)).toEqual([
      '2026-06-01T13:05:00.000Z',
      '2026-06-01T13:10:00.000Z',
    ]);
  }, 30_000);

  it('coalesces a long outage into one occurrence, then resumes', async () => {
    clock = start('2026-06-01T13:02:00Z');
    const row = await series('*/5 * * * *');
    await clock.scheduler.schedule(row);
    clock.startWorker();
    await clock.advanceTo(Date.parse('2026-06-01T13:05:00Z'));
    await clock.waitForFirings(1);

    const c = clock;
    await c.restart(() => c.advanceTo(Date.parse('2026-06-01T15:02:00Z')));
    await reconcileSchedules([row], await c.scheduler.scheduled(), c.scheduler);
    c.startWorker();
    await c.waitForFirings(2);
    await c.advanceTo(Date.parse('2026-06-01T15:05:00Z'));
    await c.waitForFirings(3);
    await c.settle();

    // Two hours down is 23 missed slots; the board gets one card for them.
    expect(await occurrences(row.id)).toHaveLength(3);
  }, 30_000);

  it('removes the job scheduler from Redis when the series stops', async () => {
    clock = start('2026-06-01T13:02:00Z');
    const row = await series('*/5 * * * *');
    await clock.scheduler.schedule(row);
    expect((await clock.queue.getJobSchedulers()).map((entry) => entry.key)).toEqual([row.id]);

    const service = new TaskSeriesService(
      prisma,
      clock.scheduler,
      noEvents,
      new StructuredLogger(),
    );
    await service.update(USER, row.id, { enabled: false });
    expect(await clock.queue.getJobSchedulers()).toEqual([]);
    expect(await clock.redis.exists(`bull:${clock.name}:repeat:${row.id}`)).toBe(0);
  }, 30_000);
});
