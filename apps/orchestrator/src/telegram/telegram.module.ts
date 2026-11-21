import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { LoggingModule } from '../logging/logging.module.js';
import { ChatDeliveryModule } from '../chat/chat-delivery.module.js';
import { BotsModule } from '../bots/bots.module.js';
import { AttachmentsModule } from '../attachments/attachments.module.js';
import { VoiceModule } from '../voice/voice.module.js';
import { TELEGRAM_CONFIG, telegramConfig, type TelegramConfig } from './telegram.config.js';
import { TELEGRAM_CLIENTS, TelegramClientFactory } from './telegram-api.js';
import { TelegramAccountsService } from './telegram-accounts.service.js';
import { TelegramBotsService } from './telegram-bots.service.js';
import { TelegramMessagingService } from './telegram-messaging.service.js';
import { TelegramQueueService } from './telegram-queue.service.js';
import { TelegramController } from './telegram.controller.js';

@Module({
  imports: [
    PrismaModule,
    LoggingModule,
    ChatDeliveryModule,
    BotsModule,
    AttachmentsModule,
    VoiceModule,
  ],
  controllers: [TelegramController],
  providers: [
    { provide: TELEGRAM_CONFIG, useFactory: () => telegramConfig() },
    {
      provide: TELEGRAM_CLIENTS,
      useFactory: (config: TelegramConfig | null) =>
        new TelegramClientFactory(config?.manager?.token ?? null),
      inject: [TELEGRAM_CONFIG],
    },
    TelegramBotsService,
    TelegramAccountsService,
    TelegramMessagingService,
    TelegramQueueService,
  ],
})
export class TelegramModule {}
