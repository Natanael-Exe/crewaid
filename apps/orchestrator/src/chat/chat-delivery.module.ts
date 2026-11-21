import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { BotsModule } from '../bots/bots.module.js';
import { SandboxModule } from '../sandbox/sandbox.module.js';
import { SeatControlModule } from '../screen/seat-control.service.js';
import { ToolPolicyModule } from '../agent/policy/policy.module.js';
import { ModelsModule } from '../models/models.module.js';
import { AttachmentsModule } from '../attachments/attachments.module.js';
import { MemoryModule } from '../memory/memory.module.js';
import { LoggingModule } from '../logging/logging.module.js';
import { VoiceModule } from '../voice/voice.module.js';
import { ChatDeliveryController } from './chat-delivery.controller.js';
import { ChatDeliveryService } from './chat-delivery.service.js';
import { ChatSendService } from './chat-send.service.js';
import { RunEventRetentionService } from './run-event-retention.service.js';
import { RunEventWakeupsService } from './run-event-wakeups.service.js';
import { RunProducerService } from './run-producer.service.js';
import { RunRecoveryService } from './run-recovery.service.js';
import { RunSettlementService } from './run-settlement.service.js';

/**
 * Conversation delivery, turn admission, detached execution, post-run
 * settlement, and expired-lease recovery. Imports the shared bot, sandbox,
 * model, and policy modules so turns are assembled from one source of truth.
 */
@Module({
  imports: [
    PrismaModule,
    LoggingModule,
    BotsModule,
    SandboxModule,
    SeatControlModule,
    ToolPolicyModule,
    ModelsModule,
    AttachmentsModule,
    MemoryModule,
    VoiceModule,
  ],
  controllers: [ChatDeliveryController],
  providers: [
    ChatDeliveryService,
    RunProducerService,
    RunSettlementService,
    RunRecoveryService,
    ChatSendService,
    RunEventWakeupsService,
    RunEventRetentionService,
  ],
  exports: [RunEventWakeupsService, ChatSendService],
})
export class ChatDeliveryModule {}
