import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TurnEventsModule } from '../agent/turn-events.module.js';
import { redisConnection } from '../common/queue-config.js';
import { LoggingModule } from '../logging/logging.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { describeRoutineConfig } from '../routines/routine.queue.js';
import { DeliverablesController } from './deliverables.controller.js';
import { DeliverablesService } from './deliverables.service.js';
import { GoalsController } from './goals.controller.js';
import { GoalsService } from './goals.service.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';
import { TaskSeriesController } from './task-series.controller.js';
import { TaskSeriesProcessor } from './task-series.processor.js';
import {
  BullTaskSeriesScheduler,
  TASK_SERIES_JOB,
  TASK_SERIES_SCHEDULER,
  UNCONFIGURED_SERIES_SCHEDULER,
} from './task-series.queue.js';
import { TASK_SERIES_WORKER_ENABLED, TaskSeriesReconciler } from './task-series.reconciler.js';
import { TaskSeriesService } from './task-series.service.js';
import { TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';
import { WorkEvents } from './work-events.js';

// Recurring tasks run where routines run: the same Redis, and the same
// ROUTINE_WORKER switch, because a process that should not fire routines
// should not fire their board-side twin either.
const { redisUrl, workerEnabled } = describeRoutineConfig();

/**
 * Work: the user's projects, goals, tasks and deliverables.
 * A record the user and their bots read and write — nothing in this module
 * starts, schedules or messages anything on its own. The one scheduled act is
 * a recurring task's next occurrence, which the user asked for and which puts
 * a card on the board and nothing else.
 */
@Module({
  imports: [
    PrismaModule,
    LoggingModule,
    TurnEventsModule,
    ...(redisUrl === null
      ? []
      : [
          BullModule.forRoot({ connection: redisConnection(redisUrl) }),
          BullModule.registerQueue({ name: TASK_SERIES_JOB }),
        ]),
  ],
  controllers: [
    ProjectsController,
    GoalsController,
    TasksController,
    TaskSeriesController,
    DeliverablesController,
    SearchController,
  ],
  providers: [
    WorkEvents,
    ProjectsService,
    GoalsService,
    TasksService,
    TaskSeriesService,
    DeliverablesService,
    SearchService,
    TaskSeriesReconciler,
    { provide: TASK_SERIES_WORKER_ENABLED, useValue: redisUrl !== null && workerEnabled },
    ...(redisUrl === null ? [] : [BullTaskSeriesScheduler]),
    ...(redisUrl !== null && workerEnabled ? [TaskSeriesProcessor] : []),
    redisUrl === null
      ? { provide: TASK_SERIES_SCHEDULER, useValue: UNCONFIGURED_SERIES_SCHEDULER }
      : { provide: TASK_SERIES_SCHEDULER, useExisting: BullTaskSeriesScheduler },
  ],
  exports: [
    WorkEvents,
    ProjectsService,
    GoalsService,
    TasksService,
    TaskSeriesService,
    DeliverablesService,
    TASK_SERIES_SCHEDULER,
  ],
})
export class WorkModule {}
