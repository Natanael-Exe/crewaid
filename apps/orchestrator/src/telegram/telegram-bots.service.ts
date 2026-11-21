import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { API_PREFIX } from '@crewaid/shared';
import type { TelegramConnection, TelegramPendingBot } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { StructuredLogger } from '../logging/structured-logger.js';
import {
  TELEGRAM_BOT_UPDATES,
  TELEGRAM_CLIENTS,
  TELEGRAM_MANAGER_UPDATES,
  TelegramApiError,
  type TelegramApi,
  type TelegramClients,
  type TelegramIdentity,
} from './telegram-api.js';
import {
  TELEGRAM_CONFIG,
  newTelegramWebhookSecret,
  telegramBotWebhookUrl,
  telegramDigest,
  telegramManagerWebhookUrl,
  type TelegramConfig,
} from './telegram.config.js';
import { PENDING_BOTS_PER_CREATOR, PENDING_BOT_TTL_MS } from './telegram-pairing.js';
import type { TelegramManagedBot } from './telegram.protocol.js';
import {
  openConnectionToken,
  openPendingToken,
  sealConnectionToken,
  sealPendingToken,
} from './telegram-tokens.js';

type Retirable = { telegramBotId: string; managed: boolean; token: string | null };

/**
 * A person's own bot, from its creation (by the manager bot, or a
 * pasted BotFather token) to its retirement. Everything here that talks to
 * Telegram is on a bot's own token; nothing here holds a conversation.
 */
@Injectable()
export class TelegramBotsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TELEGRAM_CONFIG) private readonly config: TelegramConfig | null,
    @Inject(TELEGRAM_CLIENTS) private readonly clients: TelegramClients,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  /**
   * The manager bot when it may create bots, else null. Telegram turns that
   * on in BotFather ("Bot Management Mode"), which only a restart re-reads.
   */
  async creator(): Promise<TelegramIdentity | null> {
    const manager = this.clients.manager();
    if (!manager) return null;
    try {
      const me = await manager.me();
      return me.canManageBots ? me : null;
    } catch {
      return null;
    }
  }

  clientForConnection(
    row: Pick<TelegramConnection, 'userId' | 'telegramBotId' | 'tokenCiphertext'>,
  ): TelegramApi {
    return this.clients.forToken(openConnectionToken(row));
  }

  clientForPending(
    row: Pick<TelegramPendingBot, 'telegramBotId' | 'tokenCiphertext'>,
  ): TelegramApi {
    return this.clients.forToken(openPendingToken(row));
  }

  manager() {
    return this.clients.manager();
  }

  /** The digest a webhook's secret must match, whether its bot is linked or still pending. */
  async webhookSecretHash(telegramBotId: string): Promise<string | null> {
    const [connection, pending] = await Promise.all([
      this.prisma.telegramConnection.findUnique({
        where: { telegramBotId },
        select: { webhookSecretHash: true },
      }),
      this.prisma.telegramPendingBot.findUnique({
        where: { telegramBotId },
        select: { webhookSecretHash: true },
      }),
    ]);
    return connection?.webhookSecretHash ?? pending?.webhookSecretHash ?? null;
  }

  pending(telegramBotId: string): Promise<TelegramPendingBot | null> {
    return this.prisma.telegramPendingBot.findUnique({ where: { telegramBotId } });
  }

  /**
   * `managed_bot` fires when a person creates a bot through the manager, and
   * again when its token or owner changes. A new bot is held pending, open
   * only to its creator, until a code and the app's Confirm link it.
   */
  async onManagedBot(update: TelegramManagedBot): Promise<void> {
    const manager = this.clients.manager();
    const config = this.config;
    if (!manager || !config) return;
    const telegramBotId = String(update.bot.id);
    const owner = String(update.user.id);
    // Replacing a retired token emits this same update. Its durable marker
    // must be checked before fetching the replacement token or creating a row.
    if (await this.prisma.telegramRetiredBot.findUnique({ where: { telegramBotId } })) return;

    const connection = await this.prisma.telegramConnection.findUnique({
      where: { telegramBotId },
    });
    if (connection) {
      // Ownership moved in Telegram: the link no longer speaks for the person who confirmed it.
      if (connection.telegramUserId !== owner) {
        await this.removeConnection(connection);
        return;
      }
      const token = await manager.managedBotToken(telegramBotId);
      const secret = newTelegramWebhookSecret();
      const webhookUrl = telegramBotWebhookUrl(config, telegramBotId);
      await this.prisma.telegramConnection.updateMany({
        where: { id: connection.id, userId: connection.userId },
        data: {
          tokenCiphertext: sealConnectionToken(connection.userId, telegramBotId, token),
          webhookSecretHash: telegramDigest(secret),
          webhookUrl: '',
        },
      });
      await this.clients.forToken(token).setWebhook(webhookUrl, secret, TELEGRAM_BOT_UPDATES);
      await this.prisma.telegramConnection.updateMany({
        where: {
          id: connection.id,
          userId: connection.userId,
          webhookSecretHash: telegramDigest(secret),
        },
        data: { webhookUrl },
      });
      return;
    }

    const pending = await this.pending(telegramBotId);
    if (pending && pending.ownerTelegramUserId !== owner) {
      await this.removePending(pending);
      return;
    }
    if (!pending) {
      const waiting = await this.prisma.telegramPendingBot.count({
        where: { ownerTelegramUserId: owner, claimedAt: null, expiresAt: { gt: new Date() } },
      });
      if (waiting >= PENDING_BOTS_PER_CREATOR) {
        this.logger.warn('telegram.managed_bot.refused', { reason: 'too_many_pending' });
        return;
      }
    }
    const token = await manager.managedBotToken(telegramBotId);
    await manager.restrictManagedBot(telegramBotId);
    const secret = newTelegramWebhookSecret();
    const webhookUrl = telegramBotWebhookUrl(config, telegramBotId);
    const sealed = {
      tokenCiphertext: sealPendingToken(telegramBotId, token),
      webhookSecretHash: telegramDigest(secret),
      webhookUrl: '',
    };
    // The row exists before Telegram can post, so the first Start is
    // authenticated rather than refused. A retry of this job lands here with
    // the row already present and simply registers again under a new secret.
    try {
      await this.prisma.telegramPendingBot.upsert({
        where: { telegramBotId },
        create: {
          telegramBotId,
          botUsername: update.bot.username,
          managed: true,
          ownerTelegramUserId: owner,
          expiresAt: new Date(Date.now() + PENDING_BOT_TTL_MS),
          ...sealed,
        },
        update: { botUsername: update.bot.username, ...sealed },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
      throw error;
    }
    await this.clients.forToken(token).setWebhook(webhookUrl, secret, TELEGRAM_BOT_UPDATES);
    await this.prisma.telegramPendingBot.updateMany({
      where: { telegramBotId, webhookSecretHash: telegramDigest(secret) },
      data: { webhookUrl },
    });
  }

  /** A bot the person made in BotFather themselves. It waits for its code like a created one. */
  async registerToken(
    userId: string,
    token: string,
  ): Promise<{ telegramBotId: string; botUsername: string }> {
    const config = this.config;
    if (!config)
      throw new ServiceUnavailableException('Telegram is not configured on this server.');
    const client = this.clients.forToken(token);
    const me = await client.me().catch((error: unknown) => {
      if (error instanceof TelegramApiError && [401, 404].includes(error.status))
        throw new BadRequestException(
          'Telegram didn’t accept that token. Copy it again from @BotFather.',
        );
      throw new ServiceUnavailableException('Telegram is unavailable. Try again shortly.');
    });
    const manager = await this.clients
      .manager()
      ?.me()
      .catch(() => null);
    if (manager?.id === me.id)
      throw new BadRequestException('That is this server’s own bot. Create one of your own.');
    const telegramBotId = String(me.id);
    const secret = newTelegramWebhookSecret();
    const webhookUrl = telegramBotWebhookUrl(config, telegramBotId);
    const sealed = {
      botUsername: me.username,
      managed: false,
      ownerTelegramUserId: null,
      userId,
      tokenCiphertext: sealPendingToken(telegramBotId, token),
      webhookSecretHash: telegramDigest(secret),
      webhookUrl: '',
      failedAttempts: 0,
      claimedAt: null,
      claimTelegramUserId: null,
      claimChatId: null,
      claimDisplayName: null,
      expiresAt: new Date(Date.now() + PENDING_BOT_TTL_MS),
    };
    const displaced = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
      if (await tx.telegramConnection.findUnique({ where: { userId } }))
        throw new ConflictException('Disconnect your current Telegram bot first.');
      if (await tx.telegramConnection.findUnique({ where: { telegramBotId } }))
        throw new ConflictException('That bot is already connected to a Crewaid account.');
      const holder = await tx.telegramPendingBot.findUnique({ where: { telegramBotId } });
      if (holder && holder.userId !== userId)
        throw new ConflictException('That bot is already being connected to a Crewaid account.');
      const previous = await tx.telegramPendingBot.findUnique({ where: { userId } });
      if (previous && previous.telegramBotId !== telegramBotId)
        await tx.telegramPendingBot.deleteMany({
          where: { telegramBotId: previous.telegramBotId, userId },
        });
      await tx.telegramPendingBot.upsert({
        where: { telegramBotId },
        create: { telegramBotId, ...sealed },
        update: sealed,
      });
      return previous && previous.telegramBotId !== telegramBotId ? previous : null;
    });
    if (displaced) await this.retire(this.pendingTarget(displaced));
    try {
      await client.setWebhook(webhookUrl, secret, TELEGRAM_BOT_UPDATES);
      await this.prisma.telegramPendingBot.updateMany({
        where: { telegramBotId, userId, webhookSecretHash: telegramDigest(secret) },
        data: { webhookUrl },
      });
    } catch {
      await this.prisma.telegramPendingBot.deleteMany({ where: { telegramBotId, userId } });
      throw new ServiceUnavailableException('Telegram is unavailable. Try again shortly.');
    }
    return { telegramBotId, botUsername: me.username };
  }

  /**
   * Stop listening and let go: Telegram stops posting, and a managed bot's
   * token is replaced so the copy Crewaid held is dead. A pasted token can't be
   * revoked from here; the person can do that in BotFather. Best effort: the
   * row is gone either way, and a dead token is not worth a retry loop.
   */
  async retire(target: Retirable): Promise<void> {
    if (target.managed)
      await this.prisma.telegramRetiredBot.upsert({
        where: { telegramBotId: target.telegramBotId },
        create: { telegramBotId: target.telegramBotId },
        update: {},
      });
    if (target.token)
      await this.clients
        .forToken(target.token)
        .deleteWebhook()
        .catch(() => this.logger.warn('telegram.retire.webhook_failed'));
    if (target.managed)
      await this.clients
        .manager()
        ?.revokeManagedBotToken(target.telegramBotId)
        .catch(() => this.logger.warn('telegram.retire.revoke_failed'));
  }

  pendingTarget(row: TelegramPendingBot): Retirable {
    return {
      telegramBotId: row.telegramBotId,
      managed: row.managed,
      token: readable(() => openPendingToken(row)),
    };
  }

  connectionTarget(row: TelegramConnection): Retirable {
    return {
      telegramBotId: row.telegramBotId,
      managed: row.managed,
      token: readable(() => openConnectionToken(row)),
    };
  }

  /** Removes a pending bot (only if still expired by `expiredBy`, when given) and retires it. */
  async removePending(row: TelegramPendingBot, expiredBy?: Date): Promise<void> {
    const removed = await this.prisma.telegramPendingBot.deleteMany({
      where: {
        telegramBotId: row.telegramBotId,
        ...(expiredBy ? { expiresAt: { lte: expiredBy } } : {}),
      },
    });
    if (removed.count > 0) await this.retire(this.pendingTarget(row));
  }

  private async removeConnection(row: TelegramConnection): Promise<void> {
    const removed = await this.prisma.telegramConnection.deleteMany({
      where: { id: row.id, userId: row.userId },
    });
    if (removed.count > 0) await this.retire(this.connectionTarget(row));
  }

  /** Expired codes, and bots that waited too long for theirs. */
  async cleanup(): Promise<void> {
    const now = new Date();
    await this.prisma.telegramLinkTicket.deleteMany({ where: { expiresAt: { lte: now } } });
    const expired = await this.prisma.telegramPendingBot.findMany({
      where: { expiresAt: { lte: now } },
      orderBy: { expiresAt: 'asc' },
      take: 100,
    });
    for (const row of expired) await this.removePending(row, now);
  }

  /**
   * Point the manager at this server, and move every bot whose confirmed
   * webhook names another public URL (or whose registration failed). An empty
   * URL keeps an in-flight registration discoverable after a crash or timeout.
   */
  async reconcile(): Promise<void> {
    const config = this.config;
    if (!config) return;
    const manager = this.clients.manager();
    if (manager && config.manager) {
      try {
        const me = await manager.me();
        if (!me.canManageBots) this.logger.warn('telegram.manager.cannot_manage_bots');
        await manager.setWebhook(
          telegramManagerWebhookUrl(config),
          config.manager.secret,
          TELEGRAM_MANAGER_UPDATES,
        );
      } catch {
        this.logger.warn('telegram.manager.unavailable');
      }
    }
    const moved = { NOT: { webhookUrl: { startsWith: `${config.publicUrl}${API_PREFIX}/` } } };
    const connections = await this.prisma.telegramConnection.findMany({
      where: moved,
      take: 1000,
    });
    for (const row of connections) {
      const secret = newTelegramWebhookSecret();
      const webhookUrl = telegramBotWebhookUrl(config, row.telegramBotId);
      try {
        const client = this.clientForConnection(row);
        await this.prisma.telegramConnection.updateMany({
          where: { id: row.id, userId: row.userId },
          data: { webhookSecretHash: telegramDigest(secret), webhookUrl: '' },
        });
        await client.setWebhook(webhookUrl, secret, TELEGRAM_BOT_UPDATES);
        await this.prisma.telegramConnection.updateMany({
          where: { id: row.id, userId: row.userId, webhookSecretHash: telegramDigest(secret) },
          data: { webhookUrl },
        });
      } catch {
        this.logger.warn('telegram.webhook.move_failed');
      }
    }
    const pending = await this.prisma.telegramPendingBot.findMany({ where: moved, take: 1000 });
    for (const row of pending) {
      const secret = newTelegramWebhookSecret();
      const webhookUrl = telegramBotWebhookUrl(config, row.telegramBotId);
      try {
        const client = this.clientForPending(row);
        await this.prisma.telegramPendingBot.updateMany({
          where: { telegramBotId: row.telegramBotId },
          data: { webhookSecretHash: telegramDigest(secret), webhookUrl: '' },
        });
        await client.setWebhook(webhookUrl, secret, TELEGRAM_BOT_UPDATES);
        await this.prisma.telegramPendingBot.updateMany({
          where: { telegramBotId: row.telegramBotId, webhookSecretHash: telegramDigest(secret) },
          data: { webhookUrl },
        });
      } catch {
        this.logger.warn('telegram.webhook.move_failed');
      }
    }
  }
}

/** A token that no longer opens (the key changed) is simply not retired on Telegram's side. */
function readable(open: () => string): string | null {
  try {
    return open();
  } catch {
    return null;
  }
}
