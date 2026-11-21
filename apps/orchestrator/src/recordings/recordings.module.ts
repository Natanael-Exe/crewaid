import { SeatControlModule } from '../screen/seat-control.service.js';
import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { BotsModule } from '../bots/bots.module.js';
import { SandboxModule } from '../sandbox/sandbox.module.js';
import { SkillsModule } from '../skills/skills.module.js';
import { BotRecordingsController, RecordingsController } from './recordings.controller.js';
import { RecordingsService } from './recordings.service.js';
import { RecordingTeeService } from './recording-tee.service.js';
import { ClickScreenshotService } from './click-screenshot.service.js';
import { CdpAttachService } from './cdp-attach.service.js';
import { CdpCaptureService } from './cdp-capture.service.js';
import { ClickCorrelatorService } from './click-correlator.service.js';

/**
 * Recording capture and lifecycle.
 *
 * `SandboxModule` for ensure-ready (D-039 §16) and `BotsModule` for
 * `TurnEventBus`, both already-exported providers rather than second instances.
 *
 * `SkillsModule` for the `skill.compile` queue: REST stop route
 * is "stop and enqueue compilation". The dependency runs one way — nothing in
 * skills imports recordings back.
 *
 * `RecordingTeeService` is exported because `ScreenModule` needs it on the
 * §4.3 input path. The dependency runs one way — the tee knows nothing about
 * the screen — so there is no cycle to break with a port here, unlike the
 * gateway/agent-turn pair.
 *
 * `ClickScreenshotService` is NOT exported. Its only caller is the
 * tee, which is the one place that can tell a button-down from a move, and a
 * second caller reaching the bridge on the click path is the thing the
 * per-bot endpoint cache exists to make unnecessary.
 *
 * `CdpAttachService` is NOT exported either. Its caller is the
 * lifecycle below, which is the only thing that knows when a recording
 * begins and ends; the tasks that will talk to the browser (M4-BE-02/04) do
 * it through the connection it hands back, not by resolving this service
 * from outside the module.
 *
 * `CdpCaptureService` is the first of those tasks: the injected
 * capture script and its binding. It reaches the browser through
 * `CdpAttachService.connectionFor` and writes what pages report to the tee,
 * so it is wired to the lifecycle the same way the attach is — armed when a
 * recording starts, disarmed before the row settles. NOT exported, for the
 * same reason as the attach: nothing outside this module has any business
 * starting or stopping capture.
 *
 * `ClickCorrelatorService` is the pass the lifecycle runs between
 * "capture ended" and "COMPILING": pairing the two layers' clicks in the
 * durable trace so the compiler can emit one step. Its only caller is the
 * settle path, which is the only thing that knows the trace is complete —
 * NOT exported, and for the same reason.
 */
@Module({
  imports: [PrismaModule, BotsModule, SandboxModule, SkillsModule, SeatControlModule],
  controllers: [BotRecordingsController, RecordingsController],
  providers: [
    RecordingsService,
    RecordingTeeService,
    ClickScreenshotService,
    CdpAttachService,
    CdpCaptureService,
    ClickCorrelatorService,
  ],
  exports: [RecordingsService, RecordingTeeService],
})
export class RecordingsModule {}
