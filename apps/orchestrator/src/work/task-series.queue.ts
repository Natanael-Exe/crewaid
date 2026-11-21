import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

import { parseRoutineSchedule, routineEndDate } from '../routines/routine-schedule.js';
import {
  RoutineQueueUnavailableError,
  type RoutineScheduler,
  type SchedulableRoutine,
  type ScheduledRoutine,
} from '../routines/routine.queue.js';

/**
 * Recurring tasks ride the routine machinery: the same cron and
 * timezone parsing, the same end-date rule, and one BullMQ job scheduler per
 * series keyed by its id, so DST, restarts and a long outage behave exactly
 * as D-119/D-122 verified for routines — one firing per scheduled instant,
 * and an outage coalesced into one.
 *
 * Its own queue, though, not the routine queue: a series firing puts a task
 * on the board and nothing else, and it must never meet the routine worker's
 * overlap rule or its wake-the-computer step.
 *
 * The shape is `RoutineScheduler`'s, so the boot reconciliation is the
 * routine one too; `routineId` in that interface is the series id here.
 */
export type TaskSeriesScheduler = RoutineScheduler;

export interface TaskSeriesJobData {
  readonly seriesId: string;
}

export const TASK_SERIES_JOB = 'task.series';
export const TASK_SERIES_SCHEDULER = 'TASK_SERIES_SCHEDULER';

/** Without Redis a series can be validated but never fire, so creating one is refused. */
export const UNCONFIGURED_SERIES_SCHEDULER: TaskSeriesScheduler = {
  // `async` so a bad schedule arrives as a rejection, as it does from the
  // Redis-backed scheduler, and is reported as bad before Redis is mentioned.
  // eslint-disable-next-line @typescript-eslint/require-await
  schedule: async (series) => {
    parseRoutineSchedule(series.cron, series.timezone);
    if (series.endsOn) routineEndDate(series.endsOn, series.timezone);
    throw new RoutineQueueUnavailableError();
  },
  unschedule: () => Promise.resolve(),
  scheduled: () => Promise.resolve([]),
  runNow: () => Promise.reject(new RoutineQueueUnavailableError()),
};

@Injectable()
export class BullTaskSeriesScheduler implements TaskSeriesScheduler {
  constructor(@InjectQueue(TASK_SERIES_JOB) private readonly queue: Queue<TaskSeriesJobData>) {}

  schedule = async (series: SchedulableRoutine): Promise<void> => {
    const { pattern, tz } = parseRoutineSchedule(series.cron, series.timezone);
    const endDate = series.endsOn ? routineEndDate(series.endsOn, tz) : null;
    if (endDate !== null && endDate.getTime() < Date.now()) {
      await this.unschedule(series.id);
      return;
    }
    await this.queue.upsertJobScheduler(
      series.id,
      { pattern, tz, ...(endDate !== null && { endDate }) },
      {
        name: TASK_SERIES_JOB,
        data: { seriesId: series.id },
        // Retries of one firing carry the same scheduled instant, and
        // @@unique([seriesId, occursAt]) absorbs them — so a transient
        // database error is worth a retry rather than a missed occurrence.
        opts: {
          removeOnComplete: true,
          removeOnFail: true,
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
        },
      },
    );
  };

  unschedule = async (seriesId: string): Promise<void> => {
    await this.queue.removeJobScheduler(seriesId);
  };

  scheduled = async (): Promise<ScheduledRoutine[]> => {
    const schedulers = await this.queue.getJobSchedulers();
    return schedulers.map((scheduler) => ({
      routineId: scheduler.key,
      pattern: scheduler.pattern ?? null,
      tz: scheduler.tz ?? null,
      endDate: scheduler.endDate ?? null,
    }));
  };

  runNow = async (seriesId: string): Promise<void> => {
    await this.queue.add(
      TASK_SERIES_JOB,
      { seriesId },
      { removeOnComplete: true, removeOnFail: true },
    );
  };
}

/**
 * The scheduled instant a firing stands for. A job scheduler stamps it into
 * `prevMillis` and into the job id (`repeat:<seriesId>:<millis>`); a firing
 * with neither (a manual `runNow`) stands for the moment it was added.
 */
export function scheduledInstant(job: {
  readonly id?: string | undefined;
  readonly timestamp: number;
  readonly opts: { readonly prevMillis?: number | undefined };
}): Date {
  if (typeof job.opts.prevMillis === 'number' && job.opts.prevMillis > 0) {
    return new Date(job.opts.prevMillis);
  }
  const fromId = Number(job.id?.split(':').at(-1));
  if (job.id?.startsWith('repeat:') && Number.isFinite(fromId)) return new Date(fromId);
  return new Date(job.timestamp);
}
