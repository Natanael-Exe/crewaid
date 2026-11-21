import { ToolPolicyModule } from '../agent/policy/policy.module.js';
import { SeatControlModule } from '../screen/seat-control.service.js';
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { PrismaModule } from '../prisma/prisma.module.js';
import { ModelsModule } from '../models/models.module.js';
import { BotsModule } from '../bots/bots.module.js';
import { SandboxModule } from '../sandbox/sandbox.module.js';
import { SkillCompileService } from './skill-compile.service.js';
import { SkillCompileProcessor } from './skill-compile.processor.js';
import { AttachmentsModule } from '../attachments/attachments.module.js';
import { SkillReviseService } from './skill-revise.service.js';
import { SkillRunService } from './skill-run.service.js';
import { SkillToolsRegistrar } from './skill-tools.registrar.js';
import { SkillsController } from './skills.controller.js';
import { SkillsService } from './skills.service.js';
import {
  BullSkillCompileQueue,
  SKILL_COMPILE_JOB,
  SKILL_COMPILE_QUEUE,
  UNCONFIGURED_QUEUE,
  describeQueueConfig,
  redisConnection,
} from './skill-compile.queue.js';

/**
 * Skill compilation and the review surface that gets a
 * compiled skill approved and run.
 *
 * `BotsModule` for `TurnEventBus` — the same already-exported provider chat
 * and sandboxes emit through, because a client holds one socket and does not
 * care which subsystem a frame came from.
 *
 * `SandboxModule` for the run path: `SkillRunService` reaches the
 * bot's bridge through `SandboxReadinessService` and the provider, which is
 * the one entry point §16 gives every caller that needs a computer. The
 * dependency runs one way — sandbox knows nothing about skills — so there is
 * no cycle.
 *
 * This module deliberately knows nothing about `RecordingsModule`, though it
 * reads and settles `Recording` rows. The dependency runs one way — recordings
 * enqueue, this compiles — and pointing it back the other way to reuse
 * `RecordingsService.settle` would be a cycle bought for one `update`. The
 * compare-and-set on `state: 'COMPILING'` is what keeps the two honest instead.
 *
 * Why the wiring is conditional
 *
 * Two things below are decided from the environment at module definition, and
 * both decide whether a Redis connection is opened at all:
 *
 * - Without `REDIS_URL` there is no queue, and `UNCONFIGURED_QUEUE` refuses
 * with the sentence that becomes `Recording.error`. Registering
 * `BullModule` anyway would open a connection that retries forever behind
 * every request in a deployment that never asked for one.
 * - Without `SKILL_COMPILE_WORKER` this process enqueues but does not
 * consume. A `@Processor` starts a worker in EVERY Nest context that has
 * it, and thirteen integration suites boot the application against one
 * shared Redis; `vitest.config.mts` turns it off for the whole run, the
 * same way `SANDBOX_RECONCILE_ON_BOOT` does for reconciliation.
 *
 * Read here rather than in a provider factory because they select which
 * PROVIDERS exist, not how one behaves — and a misconfigured value throws at
 * import, which is as close to the `auth.guard.ts` boot-time failure as module
 * composition allows.
 */
const { redisUrl, workerEnabled } = describeQueueConfig();

@Module({
  imports: [
    ToolPolicyModule,
    SeatControlModule,
    PrismaModule,
    BotsModule,
    SandboxModule,
    // The compiler resolves its model per recording OWNER now.
    ModelsModule,
    // Explicit even though AttachmentsModule is @Global: a global provider
    // only exists once its module is LOADED, and a suite that imports this
    // module alone would otherwise fail to resolve AgentAttachmentService at
    // boot. Depending on another module's loading order is not a dependency.
    AttachmentsModule,
    ...(redisUrl === null
      ? []
      : [
          BullModule.forRoot({ connection: redisConnection(redisUrl) }),
          BullModule.registerQueue({ name: SKILL_COMPILE_JOB }),
        ]),
  ],
  controllers: [SkillsController],
  providers: [
    // Run_skill/attach_file/send_message join the registry here,
    // where SkillRunService already is.
    SkillToolsRegistrar,
    SkillCompileService,
    SkillReviseService,
    SkillRunService,
    SkillsService,
    ...(redisUrl === null ? [] : [BullSkillCompileQueue]),
    ...(redisUrl !== null && workerEnabled ? [SkillCompileProcessor] : []),
    redisUrl === null
      ? { provide: SKILL_COMPILE_QUEUE, useValue: UNCONFIGURED_QUEUE }
      : { provide: SKILL_COMPILE_QUEUE, useExisting: BullSkillCompileQueue },
  ],
  exports: [SkillCompileService, SkillRunService, SKILL_COMPILE_QUEUE],
})
export class SkillsModule {}
