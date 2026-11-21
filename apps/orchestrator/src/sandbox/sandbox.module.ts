import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { TurnEventsModule } from '../agent/turn-events.module.js';
import { SandboxController } from './sandbox.controller.js';
import { ComputerSnapshotController } from './computer-snapshot.controller.js';
import { ComputerSnapshotService } from './computer-snapshot.service.js';
import { SandboxService } from './sandbox.service.js';
import { SandboxHealthService } from './sandbox-health.service.js';
import { SandboxIdleService } from './sandbox-idle.service.js';
import { SandboxActivityService } from './sandbox-activity.service.js';
import { SandboxReconciliationService } from './sandbox-reconciliation.service.js';
import { SandboxLeaseService } from './sandbox-lease.service.js';
import { SandboxReadinessService } from './sandbox-readiness.service.js';
import { SandboxProviderModule } from './sandbox-provider.module.js';
import { SandboxRetentionService } from './sandbox-retention.service.js';
import { SandboxMeterService } from './sandbox-meter.service.js';

/**
 * Sandbox lifecycle.
 *
 * The provider is constructed here, once, at module scope — upstream is
 * explicit that a `HarnessV1SandboxProvider` performs no I/O at construction,
 * so building it eagerly costs nothing and a misconfigured image or network
 * name surfaces at boot rather than at the first start (the `auth.guard.ts`
 * pattern).
 *
 * It is registered against a string token, not its class, so a test can supply
 * a fake without dockerode reaching the Nest context.
 *
 * TurnEventsModule is imported for TurnEventBus: WebSocket `sandbox.state` frames
 * go to the same fan-out as chat, because a client holds one socket and does
 * not care which subsystem a frame came from. It is that module rather than
 * BotsModule — where the bus used to live — so this module does not depend on
 * the whole of bots for one provider, which is what stopped BotsModule from
 * importing this one back.
 *
 * SandboxHealthService is a provider rather than a separate module because it
 * shares this module's provider token and event bus, and because it must not
 * be possible to wire the lifecycle without the poll that keeps its states
 * honest.
 *
 * SandboxIdleService and SandboxActivityService are here for the same reason.
 * Capacity admission only works if slots are actually given back,
 * so a deployment that could start sandboxes without the sweep that stops idle
 * ones would fill its host once and stay full.
 *
 * SandboxReadinessService and SandboxLeaseService complete that circle from
 * the other side: the sweep may only stop a sandbox nobody owns, so
 * the thing that wakes a computer and the thing that records who is using it
 * cannot be wired separately from the thing that stops it.
 */
@Module({
  imports: [PrismaModule, TurnEventsModule, SandboxProviderModule],
  controllers: [SandboxController, ComputerSnapshotController],
  providers: [
    SandboxService,
    SandboxReadinessService,
    SandboxLeaseService,
    SandboxHealthService,
    SandboxIdleService,
    SandboxActivityService,
    SandboxReconciliationService,
    SandboxRetentionService,
    // Counts computer time against a plan; idle where nothing bills.
    SandboxMeterService,
    // One saved copy of each computer, where the provider can make one.
    ComputerSnapshotService,
  ],
  // SANDBOX_PROVIDER is exported so the §4.3 screen transport reaches the same
  // provider instance rather than constructing a second dockerode client that
  // could disagree about which container a session id names.
  // SandboxActivityService is exported for the §4.3 input path: manual
  // takeover is activity and only ScreenService can see it happen.
  // SandboxReadinessService is exported because §16 gives every caller that
  // needs a computer — recording, skills, agent tools — the same entry point;
  // M3's own modules reach it from here rather than calling start themselves.
  exports: [
    SandboxService,
    SandboxReadinessService,
    SandboxLeaseService,
    SandboxHealthService,
    SandboxIdleService,
    SandboxActivityService,
    SandboxReconciliationService,
    SandboxProviderModule,
    SandboxRetentionService,
  ],
})
export class SandboxModule {}
