import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { TelegramBotTokenRequestSchema, type Principal } from '@crewaid/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { StructuredLogger } from '../logging/structured-logger.js';
import { TelegramAccountsService } from './telegram-accounts.service.js';
import { TelegramBotsService } from './telegram-bots.service.js';
import { TelegramMessagingService } from './telegram-messaging.service.js';
import {
  TELEGRAM_CONFIG,
  telegramDigest,
  validTelegramSecret,
  type TelegramConfig,
} from './telegram.config.js';
import { TELEGRAM_MANAGER, TelegramUpdateSchema } from './telegram.protocol.js';
import { TelegramQueueService } from './telegram-queue.service.js';

@Controller('channels/telegram')
export class TelegramController {
  constructor(
    @Inject(TelegramAccountsService) private readonly accounts: TelegramAccountsService,
    @Inject(TelegramBotsService) private readonly bots: TelegramBotsService,
    @Inject(TelegramMessagingService) private readonly messaging: TelegramMessagingService,
    @Inject(TelegramQueueService) private readonly queue: TelegramQueueService,
    @Inject(TELEGRAM_CONFIG) private readonly config: TelegramConfig | null,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  @Get()
  status(@CurrentUser() principal: Principal) {
    return this.accounts.status(principal.userId);
  }

  @Post('link')
  link(@CurrentUser() principal: Principal) {
    return this.accounts.link(principal.userId);
  }

  @Post('bot')
  registerBot(@CurrentUser() principal: Principal, @Body() body: unknown) {
    const parsed = TelegramBotTokenRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Paste the token @BotFather gave you.');
    return this.accounts.registerBot(principal.userId, parsed.data.token);
  }

  @Post('confirm')
  async confirm(@CurrentUser() principal: Principal) {
    const connection = await this.accounts.confirm(principal.userId);
    // The link is made; a hello that Telegram refuses or delays doesn't undo it.
    await this.messaging
      .welcome(connection)
      .catch(() => this.logger.warn('telegram.welcome.failed'));
    return { connected: true };
  }

  @Delete()
  async disconnect(@CurrentUser() principal: Principal) {
    await this.accounts.disconnect(principal.userId);
    return { disconnected: true };
  }

  /** The manager bot: bots created through it, and the odd hello from someone who found it. */
  @Post('manager/webhook')
  @HttpCode(200)
  async managerWebhook(
    @Headers('x-telegram-bot-api-secret-token') secret: unknown,
    @Body() body: unknown,
  ) {
    if (!this.config?.manager || !validTelegramSecret(this.config.manager.secret, secret))
      throw new UnauthorizedException();
    const parsed = TelegramUpdateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid Telegram update');
    if (parsed.data.managed_bot || parsed.data.message)
      await this.queue.enqueue({
        telegramBotId: TELEGRAM_MANAGER,
        update: parsed.data,
        connectionId: null,
      });
    return { ok: true };
  }

  /** One person's bot. Its own secret, kept only as a digest, authenticates the post. */
  @Post('bots/:telegramBotId/webhook')
  @HttpCode(200)
  async botWebhook(
    @Param('telegramBotId') telegramBotId: string,
    @Headers('x-telegram-bot-api-secret-token') secret: unknown,
    @Body() body: unknown,
  ) {
    if (!this.config || !/^\d{1,20}$/.test(telegramBotId) || typeof secret !== 'string')
      throw new UnauthorizedException();
    const expected = await this.bots.webhookSecretHash(telegramBotId);
    if (expected === null || !validTelegramSecret(expected, telegramDigest(secret)))
      throw new UnauthorizedException();
    const parsed = TelegramUpdateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid Telegram update');
    const job = await this.accounts.prepare(parsed.data, telegramBotId);
    if (job) await this.queue.enqueue(job);
    return { ok: true };
  }
}
