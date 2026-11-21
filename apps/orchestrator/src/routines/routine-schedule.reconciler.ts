import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';

import { StructuredLogger } from '../logging/structured-logger.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parseRoutineSchedule, routineEndDate, RoutineScheduleError } from './routine-schedule.js';
import {
  ROUTINE_SCHEDULER,
  type RoutineScheduler,
  type SchedulableRoutine,
  type ScheduledRoutine,
} from './routine.queue.js';

/** Whether this process owns routines — `ROUTINE_WORKER`, resolved once. */
export const ROUTINE_WORKER_ENABLED = 'ROUTINE_WORKER_ENABLED';

/** What one reconciliation changed, for its log line and the tests. */
export interface ReconcileReport {
  readonly scheduled: string[];
  readonly unscheduled: string[];
  readonly invalid: string[];
}

/**
 * Make Redis hold exactly the enabled routines' schedules.
 *
 * Why this is not how a restart survives
 *
 * It is tempting to read a boot pass as the thing that brings routines back
 * after a restart. It is not: the schedule lives in Redis and never left, and
 * the firing that came due while the process was down is a delayed job
 * waiting for a worker. This pass exists for the cases where the database and
 * Redis DISAGREE — a delete whose unschedule never reached Redis, a Redis
 * that was flushed or replaced, a row edited by hand.
 *
 * Why a matching schedule is left alone
 *
 * An upsert with an unchanged schedule is harmless to the NEXT firing — its
 * job id is derived from the scheduler id and the slot — but it is not
 * obviously harmless to one that is already overdue, which is exactly the
 * firing a restart exists to deliver. Touching only what differs keeps this
 * pass out of the one path that has to stay exactly as Redis left it.
 */
export async function reconcileSchedules(
  rows: readonly SchedulableRoutine[],
  current: readonly ScheduledRoutine[],
  scheduler: RoutineScheduler,
): Promise<ReconcileReport> {
  const report: ReconcileReport = { scheduled: [], unscheduled: [], invalid: [] };
  const byId = new Map(current.map((entry) => [entry.routineId, entry]));
  const wanted = new Set<string>();

  for (const row of rows) {
    let schedule: { pattern: string; tz: string };
    try {
      schedule = parseRoutineSchedule(row.cron, row.timezone);
      if (row.endsOn) routineEndDate(row.endsOn, row.timezone);
    } catch (error) {
      if (!(error instanceof RoutineScheduleError)) throw error;
      // A row the CRUD could never have accepted, so it was written some
      // other way. Not scheduled — and not left scheduled under an old,
      // valid pattern either, which would keep it firing on a schedule the
      // row no longer says.
      report.invalid.push(row.id);
      continue;
    }
    const endDate = row.endsOn ? routineEndDate(row.endsOn, row.timezone).getTime() : null;
    if (endDate !== null && endDate < Date.now()) continue;
    wanted.add(row.id);
    const existing = byId.get(row.id);
    if (
      existing?.pattern === schedule.pattern &&
      existing.tz === schedule.tz &&
      (existing.endDate ?? null) === endDate
    )
      continue;
    await scheduler.schedule(row);
    report.scheduled.push(row.id);
  }

  for (const entry of current) {
    if (wanted.has(entry.routineId)) continue;
    await scheduler.unschedule(entry.routineId);
    report.unscheduled.push(entry.routineId);
  }
  return report;
}

/**
 * Runs `reconcileSchedules` once, on boot, in the process that owns routines.
 *
 * Gated on `ROUTINE_WORKER` for the reason the worker is: the integration
 * suites boot the application many times against one database and one Redis,
 * and a pass in each would schedule every other suite's routines.
 *
 * A failure is logged, not thrown. Chat, sandboxes and every other feature
 * work without this pass, and a Redis that is briefly away at boot is not a
 * reason to take them down; the schedules already in Redis keep firing.
 */
@Injectable()
export class RoutineScheduleReconciler implements OnApplicationBootstrap {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ROUTINE_SCHEDULER) private readonly scheduler: RoutineScheduler,
    @Inject(ROUTINE_WORKER_ENABLED) private readonly enabled: boolean,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    try {
      const report = await this.reconcile();
      this.logger.info('routine.schedule.reconciled', {
        scheduled: report.scheduled.length,
        unscheduled: report.unscheduled.length,
        invalid: report.invalid.length,
      });
    } catch (error) {
      this.logger.warn('routine.schedule.reconcile-failed', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  async reconcile(): Promise<ReconcileReport> {
    const rows = await this.prisma.routine.findMany({
      where: { enabled: true },
      select: { id: true, cron: true, timezone: true, endsOn: true },
    });
    return reconcileSchedules(rows, await this.scheduler.scheduled(), this.scheduler);
  }
}
