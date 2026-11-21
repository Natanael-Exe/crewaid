import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { BotsModule } from '../bots/bots.module.js';
import { redisConnection } from '../common/queue-config.js';
import { LoggingModule } from '../logging/logging.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { SandboxModule } from '../sandbox/sandbox.module.js';
import { SkillsModule } from '../skills/skills.module.js';
import { RoutineProcessor } from './routine.processor.js';
import {
  BullRoutineScheduler,
  ROUTINE_JOB,
  ROUTINE_SCHEDULER,
  UNCONFIGURED_SCHEDULER,
  describeRoutineConfig,
} from './routine.queue.js';
import { RoutineRunnerService } from './routine-runner.service.js';
import { RoutinesController } from './routines.controller.js';
import { RoutinesService } from './routines.service.js';
import { RoutineToolsRegistrar } from './routine-tools.registrar.js';
import {
  ROUTINE_WORKER_ENABLED,
  RoutineScheduleReconciler,
} from './routine-schedule.reconciler.js';

/**
 * Routines.
 *
 * `BotsModule` for the message and turn services a prompt routine uses, and
 * `SkillsModule` for the skill run a skill routine uses. Neither knows this
 * module exists: a routine is a caller of both, the way `InterbotModule` is
 * a caller of `BotsModule`.
 *
 * The wiring is conditional on the same two questions `InterbotModule` asks,
 * for the same reasons — see the comment there. The `forRoot` repeated here
 * is deliberate for the reason it is repeated there: this module must boot
 * on its own, not only when another feature happens to be loaded.
 */
const { redisUrl, workerEnabled } = describeRoutineConfig();

@Module({
  imports: [
    PrismaModule,
    LoggingModule,
    BotsModule,
    SkillsModule,
    // The shared ensure-ready path a prompt routine wakes its computer through.
    SandboxModule,
    ...(redisUrl === null
      ? []
      : [
          BullModule.forRoot({ connection: redisConnection(redisUrl) }),
          BullModule.registerQueue({ name: ROUTINE_JOB }),
        ]),
  ],
  controllers: [RoutinesController],
  providers: [
    RoutinesService,
    RoutineToolsRegistrar,
    RoutineRunnerService,
    RoutineScheduleReconciler,
    // Resolved once, so the reconciler asks the same question the provider
    // list below was built from rather than re-reading the environment.
    { provide: ROUTINE_WORKER_ENABLED, useValue: redisUrl !== null && workerEnabled },
    ...(redisUrl === null ? [] : [BullRoutineScheduler]),
    ...(redisUrl !== null && workerEnabled ? [RoutineProcessor] : []),
    redisUrl === null
      ? { provide: ROUTINE_SCHEDULER, useValue: UNCONFIGURED_SCHEDULER }
      : { provide: ROUTINE_SCHEDULER, useExisting: BullRoutineScheduler },
  ],
  exports: [ROUTINE_SCHEDULER, RoutineRunnerService],
})
export class RoutinesModule {}
