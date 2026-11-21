import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';

import { StructuredLogger } from '../logging/structured-logger.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { reconcileSchedules } from '../routines/routine-schedule.reconciler.js';
import { TASK_SERIES_SCHEDULER, type TaskSeriesScheduler } from './task-series.queue.js';

export const TASK_SERIES_WORKER_ENABLED = 'TASK_SERIES_WORKER_ENABLED';

/**
 * At boot, Redis is made to hold exactly one job scheduler per enabled series
 * with the schedule its row says — the routine reconciliation, over
 * the series queue. A series edited or deleted while this process was down is
 * put right here rather than firing on a schedule nobody chose.
 */
@Injectable()
export class TaskSeriesReconciler implements OnApplicationBootstrap {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TASK_SERIES_SCHEDULER) private readonly scheduler: TaskSeriesScheduler,
    @Inject(TASK_SERIES_WORKER_ENABLED) private readonly enabled: boolean,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    try {
      const rows = await this.prisma.taskSeries.findMany({
        where: { enabled: true },
        select: { id: true, cron: true, timezone: true, endsOn: true },
      });
      const report = await reconcileSchedules(
        rows,
        await this.scheduler.scheduled(),
        this.scheduler,
      );
      this.logger.info('task.series.reconciled', {
        scheduled: report.scheduled.length,
        unscheduled: report.unscheduled.length,
        invalid: report.invalid.length,
      });
    } catch (error) {
      // Boot must not fail on a queue that is briefly unreachable; the next
      // edit of each series schedules it again.
      this.logger.warn('task.series.reconcile.failed', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }
}
