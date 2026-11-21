import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { BotsModule } from '../bots/bots.module.js';
import { LoggingModule } from '../logging/logging.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { redisConnection } from '../common/queue-config.js';
import { BotMessageDeliveryService } from './bot-message.delivery.service.js';
import { ChainBudgetService } from './chain-budget.service.js';
import { ChainNoticeService } from './chain-notice.service.js';
import { CHAIN_LIMITS, readChainLimits } from './chain.config.js';
import { BotMessageProcessor } from './bot-message.processor.js';
import { PrismaPeerDirectory } from './peer-directory.js';
import { SendMessageRegistrar } from './send-message.registrar.js';
import { TaskContext } from './task-context.js';
import {
  BOT_MESSAGE_JOB,
  BOT_MESSAGE_QUEUE,
  BullBotMessageQueue,
  UNCONFIGURED_QUEUE,
  describeDeliveryConfig,
} from './bot-message.queue.js';

/**
 * Bot-to-bot messaging.
 *
 * `BotsModule` for `MessagesService`, `ChatSendService`, `TurnEventBus` and
 * `ToolRegistry`, all of which it already exports. The dependency runs one
 * way: `BotsModule` knows nothing about this module, which is what keeps
 * `send_message` registerable from here (the rule) without the cycle
 * `TurnEventsModule` was extracted to break.
 *
 * Why the wiring is conditional
 *
 * The same two environment questions `SkillsModule` asks, for the same two
 * reasons. Without `REDIS_URL` there is no queue and `UNCONFIGURED_QUEUE`
 * refuses with a sentence the model reads as a tool result; registering
 * `BullModule` anyway would open a connection that retries forever in a
 * deployment that never asked for one. Without `BOT_MESSAGE_WORKER` this
 * process enqueues but does not consume — a `@Processor` starts a worker in
 * every Nest context that has it, and the integration suites boot the
 * application many times against one shared Redis.
 *
 * THE SECOND `forRoot` IS DELIBERATE
 *
 * `BullModule.forRoot` provides one global token holding the shared
 * connection, so `SkillsModule`'s call and this one resolve to the same
 * value and the later simply rewrites it. Depending on the other module
 * having made the call would be worse in the way that matters: this module
 * would boot correctly only when an unrelated feature happened to be loaded,
 * and the suite that imports it alone would fail on a missing token rather
 * than on anything about delivery.
 */
const { redisUrl, workerEnabled } = describeDeliveryConfig();

@Module({
  imports: [
    PrismaModule,
    LoggingModule,
    BotsModule,
    ...(redisUrl === null
      ? []
      : [
          BullModule.forRoot({ connection: redisConnection(redisUrl) }),
          BullModule.registerQueue({ name: BOT_MESSAGE_JOB }),
        ]),
  ],
  providers: [
    PrismaPeerDirectory,
    ChainNoticeService,
    ChainBudgetService,
    // The ceilings, resolved once. A factory rather than a constructor
    // read so a suite proving a limit FIRES can supply one without mutating
    // the process environment; a malformed value still throws at boot.
    { provide: CHAIN_LIMITS, useFactory: () => readChainLimits() },
    BotMessageDeliveryService,
    SendMessageRegistrar,
    TaskContext,
    ...(redisUrl === null ? [] : [BullBotMessageQueue]),
    ...(redisUrl !== null && workerEnabled ? [BotMessageProcessor] : []),
    redisUrl === null
      ? { provide: BOT_MESSAGE_QUEUE, useValue: UNCONFIGURED_QUEUE }
      : { provide: BOT_MESSAGE_QUEUE, useExisting: BullBotMessageQueue },
  ],
  exports: [BOT_MESSAGE_QUEUE, BotMessageDeliveryService, CHAIN_LIMITS],
})
export class InterbotModule {}
