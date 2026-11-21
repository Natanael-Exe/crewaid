import { Inject, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { TASK_SERIES_JOB, scheduledInstant, type TaskSeriesJobData } from './task-series.queue.js';
import { TaskSeriesService, type FireOutcome } from './task-series.service.js';

/**
 * Turns one scheduled firing into one occurrence on the board. It
 * starts nothing: no message, no turn, even for a series assigned to a bot.
 */
@Processor(TASK_SERIES_JOB, { concurrency: 4 })
export class TaskSeriesProcessor extends WorkerHost {
  private readonly logger = new Logger(TaskSeriesProcessor.name);

  constructor(@Inject(TaskSeriesService) private readonly series: TaskSeriesService) {
    super();
  }

  process(job: Job<TaskSeriesJobData>): Promise<FireOutcome> {
    return this.series.fire(job.data.seriesId, scheduledInstant(job));
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<TaskSeriesJobData> | undefined, error: Error): void {
    this.logger.error(
      `${TASK_SERIES_JOB} job ${job?.id ?? 'unknown'} (series ${job?.data.seriesId ?? 'unknown'}) ` +
        `failed: ${error.message}`,
    );
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(`${TASK_SERIES_JOB} worker error: ${error.message}`);
  }
}
