import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TelegramConnection, TelegramPendingBot } from '@prisma/client';
import type { TelegramBotRegistered, TelegramLinkResponse, TelegramStatus } from '@crewaid/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { TelegramBotsService } from './telegram-bots.service.js';
import { TELEGRAM_CONFIG, telegramDigest, type TelegramConfig } from './telegram.config.js';
import {
  PAIRING_CODE_TTL_MS,
  PAIRING_CONFIRM_TTL_MS,
  PAIRING_MAX_ATTEMPTS,
  createBotLink,
  newPairingCode,
  openBotLink,
  pairingCodeIn,
} from './telegram-pairing.js';
import { privateSender, type TelegramJob, type TelegramUpdate } from './telegram.protocol.js';
import { openPendingToken, sealConnectionToken } from './telegram-tokens.js';

const OWNER_STANDING = { user: { select: { banned: true, banExpires: true } } } as const;

function unbanned(
  row: (TelegramConnection & { user: { banned: boolean | null; banExpires: Date | null } }) | null,
): TelegramConnection | null {
  if (
    !row ||
    (row.user.banned && (row.user.banExpires === null || row.user.banExpires > new Date()))
  )
    return null;
  return row;
}

/**
 * What became of a code sent to a pending bot. `claimed` is not a link yet:
 * it waits for the account's Confirm in Crewaid.
 */
export type TelegramClaim =
  | { outcome: 'claimed'; displaced: TelegramPendingBot | null }
  | { outcome: 'awaiting' | 'wrong' | 'locked' | 'unknown' };

export type TelegramClaimant = { telegramUserId: string; chatId: string; displayName: string };

@Injectable()
export class TelegramAccountsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TELEGRAM_CONFIG) private readonly config: TelegramConfig | null,
    @Inject(TelegramBotsService) private readonly bots: TelegramBotsService,
  ) {}

  async status(userId: string): Promise<TelegramStatus> {
    const [row, pending, creator] = await Promise.all([
      this.prisma.telegramConnection.findUnique({ where: { userId } }),
      this.prisma.telegramPendingBot.findUnique({ where: { userId } }),
      this.config ? this.bots.creator() : Promise.resolve(null),
    ]);
    const waiting = pending && pending.expiresAt > new Date() && !row ? pending : null;
    return {
      configured: this.config !== null,
      canCreateBots: creator !== null,
      connection:
        row === null
          ? null
          : {
              botUsername: row.botUsername,
              displayName: row.displayName,
              selectedBotId: row.selectedBotId,
              connectedAt: row.createdAt,
            },
      pending:
        waiting === null
          ? null
          : {
              botUsername: waiting.botUsername,
              telegramName: waiting.claimedAt ? (waiting.claimDisplayName ?? '') : null,
              expiresAt: waiting.expiresAt,
            },
    };
  }

  /** A fresh code, and the QR code's create link when this server has a manager bot. */
  async link(userId: string): Promise<TelegramLinkResponse> {
    if (!this.config)
      throw new ServiceUnavailableException('Telegram is not configured on this server.');
    const creator = await this.bots.creator();
    const issued = await this.issueCode(userId);
    return {
      code: issued.code,
      expiresAt: issued.expiresAt,
      createUrl: creator ? createBotLink(creator.username, issued.name) : null,
    };
  }

  /** A bot made in BotFather: registered now, linked by the code its Start link carries. */
  async registerBot(userId: string, token: string): Promise<TelegramBotRegistered> {
    if (!this.config)
      throw new ServiceUnavailableException('Telegram is not configured on this server.');
    const bot = await this.bots.registerToken(userId, token);
    const issued = await this.issueCode(userId);
    return {
      botUsername: bot.botUsername,
      code: issued.code,
      expiresAt: issued.expiresAt,
      openUrl: openBotLink(bot.botUsername, issued.code),
    };
  }

  private async issueCode(
    userId: string,
    attempt = 0,
  ): Promise<{ code: string; expiresAt: Date; name: string | null }> {
    const code = newPairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
    try {
      const name = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
        if (await tx.telegramConnection.findUnique({ where: { userId } }))
          throw new ConflictException('Disconnect your current Telegram bot first.');
        await tx.telegramLinkTicket.upsert({
          where: { userId },
          create: { userId, tokenHash: telegramDigest(code), expiresAt },
          update: { tokenHash: telegramDigest(code), expiresAt },
        });
        const user = await tx.user.findUnique({ where: { id: userId }, select: { name: true } });
        return user?.name ?? null;
      });
      return { code, expiresAt, name };
    } catch (error) {
      // Another account holds the same code right now: one in hundreds of billions, so once.
      if (
        attempt === 0 &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        return this.issueCode(userId, attempt + 1);
      throw error;
    }
  }

  /**
   * A code sent to a pending bot. A managed bot hears only from its creator; a
   * pasted bot only accepts its own account's code. The right code consumes
   * the ticket and records who sent it, and that is all: the account still
   * confirms in Crewaid before anything is linked.
   */
  async claim(
    telegramBotId: string,
    claimant: TelegramClaimant,
    codeHash: string,
  ): Promise<TelegramClaim> {
    try {
      return await this.prisma.$transaction(async (tx): Promise<TelegramClaim> => {
        await tx.$queryRaw`SELECT "telegramBotId" FROM "TelegramPendingBot" WHERE "telegramBotId" = ${telegramBotId} FOR UPDATE`;
        const pending = await tx.telegramPendingBot.findUnique({ where: { telegramBotId } });
        const now = new Date();
        if (!pending || pending.expiresAt <= now) return { outcome: 'unknown' };
        if (pending.managed && pending.ownerTelegramUserId !== claimant.telegramUserId)
          return { outcome: 'unknown' };
        if (pending.claimedAt) return { outcome: 'awaiting' };
        if (pending.failedAttempts >= PAIRING_MAX_ATTEMPTS) return { outcome: 'locked' };
        const ticket = await tx.telegramLinkTicket.findUnique({ where: { tokenHash: codeHash } });
        let userId =
          ticket &&
          ticket.expiresAt > now &&
          (pending.userId === null || pending.userId === ticket.userId)
            ? ticket.userId
            : null;
        if (userId !== null) {
          const users = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM "User" WHERE id = ${userId}
            AND ("banned" IS NOT TRUE OR "banExpires" < now()) FOR UPDATE`;
          if (users.length !== 1 || (await tx.telegramConnection.findUnique({ where: { userId } })))
            userId = null;
        }
        if (userId !== null) {
          const consumed = await tx.telegramLinkTicket.deleteMany({
            where: { tokenHash: codeHash, userId, expiresAt: { gt: now } },
          });
          if (consumed.count !== 1) userId = null;
        }
        if (userId === null) {
          const failed = await tx.telegramPendingBot.update({
            where: { telegramBotId },
            data: { failedAttempts: { increment: 1 } },
          });
          return { outcome: failed.failedAttempts >= PAIRING_MAX_ATTEMPTS ? 'locked' : 'wrong' };
        }
        // An account waits on one bot at a time: claiming this one lets go of another.
        const previous = await tx.telegramPendingBot.findUnique({ where: { userId } });
        const displaced = previous && previous.telegramBotId !== telegramBotId ? previous : null;
        if (displaced)
          await tx.telegramPendingBot.deleteMany({
            where: { telegramBotId: displaced.telegramBotId, userId },
          });
        await tx.telegramPendingBot.update({
          where: { telegramBotId },
          data: {
            userId,
            claimedAt: now,
            claimTelegramUserId: claimant.telegramUserId,
            claimChatId: claimant.chatId,
            claimDisplayName: claimant.displayName,
            expiresAt: new Date(now.getTime() + PAIRING_CONFIRM_TTL_MS),
          },
        });
        return { outcome: 'claimed', displaced };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        return { outcome: 'wrong' };
      throw error;
    }
  }

  /** The account's own Confirm in Crewaid: the claimed bot becomes its connection. */
  async confirm(userId: string): Promise<TelegramConnection> {
    return this.prisma.$transaction(async (tx) => {
      const users = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "User" WHERE id = ${userId}
        AND ("banned" IS NOT TRUE OR "banExpires" < now()) FOR UPDATE`;
      const pending = await tx.telegramPendingBot.findUnique({ where: { userId } });
      if (
        users.length !== 1 ||
        !pending?.claimedAt ||
        pending.expiresAt <= new Date() ||
        !pending.claimTelegramUserId ||
        !pending.claimChatId
      )
        throw new NotFoundException('Nothing is waiting to be confirmed. Connect Telegram again.');
      if (await tx.telegramConnection.findUnique({ where: { userId } }))
        throw new ConflictException('Disconnect your current Telegram bot first.');
      const token = openPendingToken(pending);
      const connection = await tx.telegramConnection.create({
        data: {
          userId,
          telegramBotId: pending.telegramBotId,
          botUsername: pending.botUsername,
          managed: pending.managed,
          tokenCiphertext: sealConnectionToken(userId, pending.telegramBotId, token),
          webhookSecretHash: pending.webhookSecretHash,
          webhookUrl: pending.webhookUrl,
          telegramUserId: pending.claimTelegramUserId,
          chatId: pending.claimChatId,
          displayName: pending.claimDisplayName ?? '',
        },
      });
      await tx.telegramPendingBot.deleteMany({
        where: { telegramBotId: pending.telegramBotId, userId },
      });
      return connection;
    });
  }

  /** Disconnects, cancels whatever is pending, and retires the bots involved. */
  async disconnect(userId: string, connectionId?: string): Promise<void> {
    const removed = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
      const connection = await tx.telegramConnection.findFirst({
        where: { userId, ...(connectionId === undefined ? {} : { id: connectionId }) },
      });
      if (connection)
        await tx.telegramConnection.deleteMany({ where: { id: connection.id, userId } });
      let pending: TelegramPendingBot | null = null;
      // A delayed /unlink from a former connection cannot cancel what came after it.
      if (connectionId === undefined || connection) {
        pending = await tx.telegramPendingBot.findUnique({ where: { userId } });
        if (pending)
          await tx.telegramPendingBot.deleteMany({
            where: { telegramBotId: pending.telegramBotId, userId },
          });
        await tx.telegramLinkTicket.deleteMany({ where: { userId } });
      }
      return { connection, pending };
    });
    if (removed.connection) await this.bots.retire(this.bots.connectionTarget(removed.connection));
    if (removed.pending) await this.bots.retire(this.bots.pendingTarget(removed.pending));
  }

  /** The webhook verified the bot's secret before this identity lookup. */
  async prepare(update: TelegramUpdate, telegramBotId: string): Promise<TelegramJob | null> {
    const sender = privateSender(update);
    if (!sender) return null;
    const connection = await this.resolve(telegramBotId, sender.telegramUserId, sender.chatId);
    // Only an unlinked chat can be pairing; on a linked bot eight letters are just a message.
    const code = connection ? null : pairingCodeIn(update.message?.text);
    return {
      telegramBotId,
      update:
        code && update.message
          ? { ...update, message: { ...update.message, text: '/start' } }
          : update,
      connectionId: connection?.id ?? null,
      ...(code ? { codeHash: telegramDigest(code) } : {}),
    };
  }

  async resolve(
    telegramBotId: string,
    telegramUserId: string,
    chatId: string,
    connectionId?: string,
  ): Promise<TelegramConnection | null> {
    const row = await this.prisma.telegramConnection.findFirst({
      where: {
        telegramBotId,
        telegramUserId,
        chatId,
        ...(connectionId === undefined ? {} : { id: connectionId }),
      },
      include: OWNER_STANDING,
    });
    return unbanned(row);
  }

  /** The revocation fence before every send, so it is one query. */
  async owned(userId: string, id: string): Promise<TelegramConnection | null> {
    return unbanned(
      await this.prisma.telegramConnection.findFirst({
        where: { userId, id },
        include: OWNER_STANDING,
      }),
    );
  }
}
