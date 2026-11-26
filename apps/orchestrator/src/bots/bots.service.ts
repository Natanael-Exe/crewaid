import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Bot, Prisma, SandboxState } from '@prisma/client';
import {
  DEFAULT_AUTO_REVIEW_RULES,
  MODEL_REF_DEFAULT,
  projectPublicSpeech,
  type CreateBotBody,
  type MarkBotReadResponse,
  type ThreadPreview,
  type UpdateBotBody,
} from '@crewaid/shared';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { openStoredMessageText } from '../prisma/message-sealing.js';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../sandbox/sandbox.provider.js';
import { SeatService } from '../sandbox/seat.service.js';
import { attachToComputer } from '../sandbox/attached-computer.js';
import { TurnEventBus } from '../agent/turn-event.bus.js';
import { recordBotDeparture } from '../work/bot-departure.js';

/**
 * Bot CRUD.
 *
 * R7/ discipline: every query carries the caller's `userId` in its where
 * clause. There are no exemptions — Bots are user-owned by construction, so
 * even direct-by-id lookups resolve through a scoped findFirst and a 404 that
 * deliberately does not distinguish "absent" from "not yours".
 */
@Injectable()
export class BotsService {
  // Explicit token: vitest/esbuild does not emit design:paramtypes, so
  // type-based DI resolution silently fails in the integration suite.
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SANDBOX_PROVIDER) private readonly sandboxes: SandboxProvider,
    @Inject(SeatService) private readonly seats: SeatService,
    /**
     * `bots.changed` (last, so positional constructions in suites keep
     * their meaning). A roster a window is not looking at is a roster that
     * went stale: a `create_bot` tool call writes the row server-side, and
     * without this frame the sidebar showed the roster from whenever it last
     * asked — "the bot did not appear until I reloaded the window".
     */
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
    /**
     * Removes a deleted bot's attachment files after the rows are gone.
     * Optional and last for the same reason as `events`: suites that build
     * the service by hand keep compiling, and simply leave files alone.
     */
    @Optional() @Inject(AttachmentsService) private readonly attachments?: AttachmentsService,
  ) {}

  private readonly logger = new Logger(BotsService.name);

  /**
   * Announce a roster change, after the write and never in its way.
   *
   * A frame that cannot be built must not fail a create or a delete: the row
   * is committed either way, and the worst case without the frame is a
   * sidebar that heals on the next `GET /bots`.
   */
  private announce(userId: string, botId: string, change: 'created' | 'updated' | 'deleted'): void {
    try {
      this.events.emitBotsChanged(userId, botId, change);
    } catch (error) {
      this.logger.warn(
        `bot ${botId}: ${change} could not be announced: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** `GET /bots` — list with sandbox state, unread counts and previews, sidebar order. */
  async list(userId: string) {
    const [bots, unread, previews] = await Promise.all([
      this.prisma.bot.findMany({
        where: { userId },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        // The thread rides with the bot, so a client can address the
        // chat routes without a second lookup per bot.
        include: { sandbox: true, conversation: { select: { id: true } } },
      }),
      this.unreadCounts(userId),
      this.previews(userId),
    ]);
    return bots.map(({ conversation, ...bot }) => ({
      ...bot,
      thread:
        conversation === null ? null : { ...conversation, preview: previews.get(bot.id) ?? null },
      unreadCount: unread.get(bot.id) ?? 0,
    }));
  }

  /**
   * The newest thing said in each bot's thread, keyed by bot.
   *
   * One query for the whole sidebar, for the reason `unreadCounts` gives: the
   * comparison that picks a row crosses rows, so it belongs in the database
   * rather than in a read per bot.
   *
   * `content` is what was SAID. A reply's `parts` also carry the model's
   * thinking, and a preview taken from those would put the reasoning
   * that opened a turn under the bot's name in the sidebar. USER and BOT only:
   * a system notice and a tool result are not conversation. Blank rows are
   * skipped so a turn that only called tools does not blank the line — the
   * last thing actually said is still the useful answer.
   */
  private async previews(userId: string): Promise<Map<string, ThreadPreview>> {
    const rows = await this.prisma.$queryRaw<
      { botId: string; author: 'USER' | 'BOT'; text: string; createdAt: Date }[]
    >`
      SELECT ranked."botId", ranked.author, ranked."text", ranked."createdAt"
      FROM (
        SELECT c."botId",
               m.author,
               m.content AS "text",
               m."createdAt",
               ROW_NUMBER() OVER (
                 PARTITION BY c."botId"
                 ORDER BY m."createdAt" DESC, m.id DESC
               ) AS rn
        FROM "Message" m
        JOIN "Conversation" c ON c.id = m."conversationId"
        JOIN "Bot" b ON b.id = c."botId"
        WHERE b."userId" = ${userId}
          AND m.author IN ('USER'::"MessageAuthor", 'BOT'::"MessageAuthor")
          AND btrim(m.content) <> ''
      ) ranked
      WHERE ranked.rn <= 10
      ORDER BY ranked."botId", ranked.rn ASC
    `;
    const result = new Map<string, ThreadPreview>();
    for (const row of rows) {
      if (result.has(row.botId)) continue;
      // Raw SQL returns the sealed value; project BOT speech through the same
      // boundary filter as live/history so leaked reasoning or legacy loops
      // fall back to the previous spoken message instead of filling the sidebar.
      const opened = openStoredMessageText(row.text);
      const clean = (row.author === 'BOT' ? projectPublicSpeech(opened) : opened)
        .replace(/\s+/g, ' ')
        .trim();
      if (clean === '') continue;
      result.set(row.botId, { text: clean, createdAt: row.createdAt });
    }
    return result;
  }

  /**
   * Each bot's messages newer than the user's last read, keyed by bot.
   *
   * One aggregate query, independent of the number of conversations. The
   * timestamp comparison crosses rows, so it belongs in the database rather
   * than in a growing OR filter built from every conversation.
   *
   * Only `author = BOT` counts, and a run's several rows count once:
   * the user's own words were read as written; a system or tool row said nothing.
   */
  private async unreadCounts(userId: string, botId?: string): Promise<Map<string, number>> {
    const rows = await this.prisma.$queryRaw<{ botId: string; unreadCount: number }[]>`
      SELECT c."botId", COUNT(DISTINCT COALESCE(m."runId", m.id))::int AS "unreadCount"
      FROM "Message" m
      JOIN "Conversation" c ON c.id = m."conversationId"
      JOIN "Bot" b ON b.id = c."botId"
      WHERE b."userId" = ${userId}
        AND (${botId ?? null}::text IS NULL OR c."botId" = ${botId ?? null})
        AND m.author = 'BOT'::"MessageAuthor"
        AND (c."lastReadAt" IS NULL OR m."createdAt" > c."lastReadAt")
      GROUP BY c."botId"
    `;
    return new Map(rows.map((row) => [row.botId, row.unreadCount]));
  }

  /**
   * `POST /bots/:id/read` — D-131. Read means every message up to now.
   * Unread puts the newest bot message back, by moving the read mark to just
   * before it; a bot that has never said anything has nothing to put back.
   */
  async markRead(userId: string, botId: string, unread: boolean): Promise<MarkBotReadResponse> {
    await this.findOwned(userId, botId);
    let lastReadAt = new Date();
    if (unread) {
      const newest = await this.prisma.message.findFirst({
        where: { author: 'BOT', conversation: { botId, bot: { userId } } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (newest !== null) lastReadAt = new Date(newest.createdAt.getTime() - 1);
    }
    await this.prisma.conversation.updateMany({
      where: { botId, bot: { userId } },
      data: { lastReadAt },
    });
    const counts = await this.unreadCounts(userId, botId);
    return { unreadCount: counts.get(botId) ?? 0 };
  }

  /**
   * A group named in a body has to be one of YOURS. The foreign key
   * only proves the group exists; the path's bot being yours says nothing
   * about the group the body points it at. One answer for absent and foreign.
   */
  private async assertGroupIsOwned(userId: string, groupId: string): Promise<void> {
    const owned = await this.prisma.botGroup.findFirst({
      where: { id: groupId, userId },
      select: { id: true },
    });
    if (owned === null) throw new NotFoundException('Group not found');
  }

  /**
   * Input types ARE the shared Zod-inferred bodies (`CreateBotBody`,
   * `UpdateBotBody`) — one contract, no hand-duplicated parameter shapes to
   * drift under `exactOptionalPropertyTypes`.
   */
  async create(userId: string, input: CreateBotBody) {
    // Same fence as `update`, for the same reason: the body may name a
    // model, and a bot born pointing at somebody else's row fails at its
    // first turn rather than here.
    if (input.modelId !== undefined) await this.assertModelIsOwned(userId, input.modelId);
    if (input.codingModelId !== undefined && input.codingModelId !== null) {
      await this.assertModelIsOwned(userId, input.codingModelId, {
        allowDefault: false,
        requireTools: true,
      });
    }
    const created = await this.prisma.$transaction(
      async (tx) => {
        const bot = await tx.bot.create({
          data: {
            userId,
            name: input.name,
            role: input.role,
            avatarColor: input.avatarColor,
            // Absent means "not chosen": the renderer derives a mascot from the
            // name, which is how every bot looked before the column existed.
            avatarShape: input.avatarShape ?? null,
            systemPrompt: input.systemPrompt,
            modelId: input.modelId ?? 'default',
            ...(input.codingModelId !== undefined && { codingModelId: input.codingModelId }),
            autoReviewRules: input.autoReviewRules ?? DEFAULT_AUTO_REVIEW_RULES,
            ...(input.approvalMode !== undefined && { approvalMode: input.approvalMode }),
          },
        });
        // One Conversation per Bot, created with it. Every bot is chatty
        // from birth — the conversation is where its messages live.
        await tx.conversation.create({ data: { botId: bot.id } });
        const computerId = await attachToComputer(tx, userId, bot.id, this.sandboxes);
        return { ...bot, sandboxId: computerId };
      },
      { timeout: 30_000 },
    );
    this.announce(userId, created.id, 'created');
    return created;
  }

  /**
   * A model reference names a row, and the row has to be one of YOURS.
   *
   * `Bot.modelId` is a plain string column holding either the `default` alias
   * or a `ProviderModel` id — not a foreign key, because it also has to hold
   * the alias. So the database cannot refuse a foreign id, and neither
   * the ownership guard nor `findOwned` looks at it: the bot in the path is
   * genuinely the caller's, and only the BODY names somebody else's row.
   *
   * Nothing leaked without this — `ModelResolutionService.resolve` re-scopes
   * by `connection.userId`, so a foreign id resolves to nothing and the turn
   * fails `UnknownModelError` rather than borrowing a key. What it did allow
   * was writing another account's row id into your own bot and finding out at
   * the next turn, in a sentence about an unknown model rather than about the
   * thing that was actually wrong.
   *
   * The refusal deliberately does not distinguish "no such model" from "not
   * yours": one message for both, or the endpoint answers whether a given id
   * exists on somebody else's account.
   */
  private async assertModelIsOwned(
    userId: string,
    modelRef: string,
    options: { readonly allowDefault?: boolean; readonly requireTools?: boolean } = {},
  ): Promise<void> {
    if (options.allowDefault !== false && modelRef === MODEL_REF_DEFAULT) return;
    const owned = await this.prisma.providerModel.findFirst({
      where: { id: modelRef, connection: { userId } },
      select: { id: true, supportsTools: true },
    });
    if (owned === null) {
      throw new BadRequestException('no such model on your connections');
    }
    if (options.requireTools === true && !owned.supportsTools) {
      throw new BadRequestException('coding model must support tool calling');
    }
  }

  async update(userId: string, botId: string, input: UpdateBotBody) {
    const owned = await this.findOwned(userId, botId);
    if (
      owned.kind === 'MAIN' &&
      (input.name !== undefined ||
        input.role !== undefined ||
        input.pinned !== undefined ||
        input.hiddenFromSidebar !== undefined ||
        input.sortOrder !== undefined ||
        input.groupId !== undefined)
    ) {
      throw new BadRequestException(
        'Crewaid’s name, role and place in the app are permanent. You can edit its working preferences, model and voice.',
      );
    }
    if (input.modelId !== undefined) await this.assertModelIsOwned(userId, input.modelId);
    if (input.codingModelId !== undefined && input.codingModelId !== null) {
      await this.assertModelIsOwned(userId, input.codingModelId, {
        allowDefault: false,
        requireTools: true,
      });
    }
    if (input.groupId !== undefined && input.groupId !== null) {
      await this.assertGroupIsOwned(userId, input.groupId);
    }
    const updated = await this.prisma.bot.update({
      where: { id: botId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.role !== undefined && { role: input.role }),
        ...(input.avatarColor !== undefined && { avatarColor: input.avatarColor }),
        ...(input.avatarShape !== undefined && { avatarShape: input.avatarShape }),
        ...(input.systemPrompt !== undefined && { systemPrompt: input.systemPrompt }),
        ...(input.modelId !== undefined && { modelId: input.modelId }),
        ...(input.codingModelId !== undefined && { codingModelId: input.codingModelId }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
        ...(input.pinned !== undefined && { pinned: input.pinned }),
        ...(input.hiddenFromSidebar !== undefined && {
          hiddenFromSidebar: input.hiddenFromSidebar,
        }),
        ...(input.autoReviewRules !== undefined && {
          autoReviewRules: input.autoReviewRules,
        }),
        ...(input.approvalMode !== undefined && { approvalMode: input.approvalMode }),
        ...(input.voiceId !== undefined && { voiceId: input.voiceId }),
        ...(input.groupId !== undefined && { groupId: input.groupId }),
      },
    });
    this.announce(userId, updated.id, 'updated');
    return updated;
  }

  /**
   * `POST /bots/:id/duplicate` — clone profile and skills, not history.
   *
   * The clone gets a fresh Conversation and defaults to `${source.name} copy`;
   * if that name is already taken, the route returns 409 rather than inventing
   * further numeric suffixes.
   */
  async duplicate(userId: string, botId: string) {
    const source = await this.prisma.bot
      .findFirst({
        where: { id: botId, userId },
        include: { skills: true },
      })
      .then((bot) => {
        if (bot === null) {
          throw new NotFoundException('Bot not found');
        }
        return bot;
      });

    if (source.kind === 'MAIN')
      throw new BadRequestException('The main assistant cannot be duplicated.');
    const cloneName = `${source.name} copy`;
    const nameTaken = await this.prisma.bot.findFirst({
      where: { userId, name: cloneName },
      select: { id: true },
    });
    if (nameTaken !== null) {
      throw new ConflictException(`A bot named "${cloneName}" already exists`);
    }

    const cloned = await this.prisma.$transaction(
      async (tx) => {
        const clone = await tx.bot.create({
          data: {
            userId,
            name: cloneName,
            role: source.role,
            avatarColor: source.avatarColor,
            avatarShape: source.avatarShape,
            avatarUrl: source.avatarUrl,
            systemPrompt: source.systemPrompt,
            modelId: source.modelId,
            codingModelId: source.codingModelId,
            // A second worker on the same material belongs where the first is.
            groupId: source.groupId,
            // Json column default "[]" means this is never null in storage, but
            // the client types it JsonValue|null, so normalize before the write.
            autoReviewRules: source.autoReviewRules ?? [],
            // A copy is trusted exactly as far as the bot it was copied from.
            approvalMode: source.approvalMode,
            voiceId: source.voiceId,
          },
        });
        await tx.conversation.create({ data: { botId: clone.id } });
        // Skills clone with version history intact; sourceRecordingId is
        // intentionally preserved (D-009: it is no longer unique).
        for (const skill of source.skills) {
          await tx.skill.create({
            data: {
              botId: clone.id,
              name: skill.name,
              description: skill.description,
              paramsSchema: skill.paramsSchema as Prisma.InputJsonValue,
              script: skill.script,
              version: skill.version,
              status: skill.status,
              sourceRecordingId: skill.sourceRecordingId,
            },
          });
        }
        // A duplicate joins the SAME machine as its original by default: the
        // point of duplicating a bot is a second worker on the same material,
        // and a second machine would give it an empty one.
        const computerId = await attachToComputer(
          tx,
          userId,
          clone.id,
          this.sandboxes,
          source.sandboxId,
        );
        return { ...clone, sandboxId: computerId };
      },
      { timeout: 30_000 },
    );
    this.announce(userId, cloned.id, 'created');
    return cloned;
  }

  /**
   * `DELETE /bots/:id` — cascade teardown.
   *
   * When the deleted bot is the sole tenant of a sandbox, teardown runs in two
   * short transactions so sandbox/Docker network I/O never runs while holding
   * Postgres row locks:
   *   1. Short tx locks User/Bot/Sandbox and fences the sandbox (`state = STARTING`).
   *   2. Out-of-tx destroys the runtime; failure restores `previousState` and rethrows.
   *   3. Short tx deletes the bot, deliverables/attachments, and empty sandbox row.
   * Workspace volume retention remains separate.
   */
  async remove(userId: string, botId: string): Promise<void> {
    type DeletionOutcome = {
      departing: { sessionId: string; computerId: string } | null;
      unassigned: string[];
      deliverables: string[];
      files: string[];
    };
    type PhaseOneResult =
      | { kind: 'done'; outcome: DeletionOutcome }
      | {
          kind: 'teardown';
          sandboxId: string;
          sessionId: string;
          previousState: SandboxState;
        };

    const first = await this.prisma.$transaction<PhaseOneResult>(
      async (tx) => {
        await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${userId} FOR NO KEY UPDATE`;
        await tx.$executeRaw`SELECT id FROM "Bot" WHERE id = ${botId} AND "userId" = ${userId} FOR UPDATE`;
        const bot = await tx.bot.findFirst({ where: { id: botId, userId } });
        if (bot === null) throw new NotFoundException('Bot not found');
        if (bot.kind === 'MAIN')
          throw new BadRequestException('The main assistant cannot be deleted.');
        await tx.$executeRaw`SELECT s.id FROM "Sandbox" s
          JOIN "Bot" b ON b."sandboxId" = s.id WHERE b.id = ${botId} FOR UPDATE OF s`;
        const sandbox =
          bot.sandboxId === null
            ? null
            : await tx.sandbox.findUnique({ where: { id: bot.sandboxId } });
        if (sandbox?.state === 'STARTING') {
          throw new ConflictException(
            'Sandbox lifecycle is in progress. Retry deletion when it settles.',
          );
        }
        const siblings =
          sandbox === null
            ? 0
            : await tx.bot.count({ where: { sandboxId: sandbox.id, id: { not: botId } } });

        // Sole tenant: fence the sandbox row and release DB locks before doing
        // provider/Docker network teardown.
        if (sandbox !== null && siblings === 0) {
          await tx.sandbox.update({
            where: { id: sandbox.id },
            data: { state: 'STARTING' },
          });
          return {
            kind: 'teardown',
            sandboxId: sandbox.id,
            sessionId: sandbox.sessionId ?? sandbox.id,
            previousState: sandbox.state,
          };
        }

        // Shared machine (siblings > 0) or no sandbox: delete rows immediately
        // without any network I/O inside the transaction.
        const departing =
          sandbox !== null && siblings > 0
            ? { sessionId: sandbox.sessionId ?? sandbox.id, computerId: sandbox.id }
            : null;
        const rows = await this.deleteBotRowsInTx(tx, userId, bot, null);
        return { kind: 'done', outcome: { departing, ...rows } };
      },
      { timeout: 10_000 },
    );

    let outcome: DeletionOutcome;
    if (first.kind === 'done') {
      outcome = first.outcome;
    } else {
      try {
        await this.destroySoleSandboxRuntime(first.sessionId, first.sandboxId);
      } catch (error: unknown) {
        await this.prisma.sandbox
          .updateMany({
            where: { id: first.sandboxId, userId, state: 'STARTING' },
            data: { state: first.previousState },
          })
          .catch(() => undefined);
        throw error;
      }

      outcome = await this.prisma.$transaction<DeletionOutcome>(
        async (tx) => {
          await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${userId} FOR NO KEY UPDATE`;
          await tx.$executeRaw`SELECT id FROM "Bot" WHERE id = ${botId} AND "userId" = ${userId} FOR UPDATE`;
          const bot = await tx.bot.findFirst({ where: { id: botId, userId } });
          if (bot === null) throw new NotFoundException('Bot not found');
          await tx.$executeRaw`SELECT s.id FROM "Sandbox" s
            JOIN "Bot" b ON b."sandboxId" = s.id WHERE b.id = ${botId} FOR UPDATE OF s`;
          const siblings = await tx.bot.count({
            where: { sandboxId: first.sandboxId, id: { not: botId } },
          });
          if (siblings > 0) {
            await tx.sandbox.update({
              where: { id: first.sandboxId },
              data: { state: 'STOPPED' },
            });
            const rows = await this.deleteBotRowsInTx(tx, userId, bot, null);
            return {
              departing: { sessionId: first.sessionId, computerId: first.sandboxId },
              ...rows,
            };
          }
          const rows = await this.deleteBotRowsInTx(tx, userId, bot, first.sandboxId);
          return { departing: null, ...rows };
        },
        { timeout: 10_000 },
      );
    }

    const { departing: orphanedSeat, unassigned, deliverables, files } = outcome;

    // Observational post-commit cleanup: the bot row is gone, so a leftover seat
    // window or file on disk is logged for reconciliation rather than failing delete.
    if (orphanedSeat !== null) {
      const { sessionId, computerId } = orphanedSeat;
      try {
        await this.sandboxes.retireBotProfile({ computerId, botId });
      } catch (error: unknown) {
        this.logger.warn(`bot ${botId}: profile retirement failed: ${String(error)}`);
      }
      try {
        if (await this.seats.releaseSeat(sessionId, botId)) {
          this.logger.log(`bot ${botId}: closed its seat on machine ${sessionId}`);
        }
      } catch (error: unknown) {
        this.logger.warn(
          `bot ${botId}: deleted, but its seat on machine ${sessionId} could not be closed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (this.attachments !== undefined && files.length > 0) {
      try {
        await this.attachments.removeStoredFiles(files);
      } catch (error: unknown) {
        this.logger.warn(`bot ${botId}: deleted, but its files were not removed: ${String(error)}`);
      }
    }
    this.announce(userId, botId, 'deleted');
    this.announceWork(userId, unassigned, deliverables);
  }

  /** Tears down a sole-tenant sandbox runtime outside any database transaction. */
  private async destroySoleSandboxRuntime(sessionId: string, sandboxId: string): Promise<void> {
    const session = await this.sandboxes.attachSession({ sessionId });
    if (session !== null) await session.destroy();
    const runtimes = await this.sandboxes.listManagedSessions();
    for (const runtime of runtimes) {
      if (runtime.botId === sandboxId) {
        await this.sandboxes.removeManagedSession({ containerId: runtime.containerId });
      }
    }
  }

  /** Deletes bot rows and collects post-commit cleanup targets inside a short transaction. */
  private async deleteBotRowsInTx(
    tx: Prisma.TransactionClient,
    userId: string,
    bot: Bot,
    deleteSandboxId: string | null,
  ): Promise<{ unassigned: string[]; deliverables: string[]; files: string[] }> {
    const unassigned = await recordBotDeparture(tx, userId, bot);
    const deliverables = await tx.deliverable.findMany({
      where: { userId, botId: bot.id },
      select: { id: true },
    });
    const held = { ownerId: userId, messageId: null, deliverable: { botId: bot.id, userId } };
    const files = await tx.attachment.findMany({
      where: { OR: [{ ownerId: userId, message: { conversation: { botId: bot.id } } }, held] },
      select: { storageKey: true },
    });
    await tx.attachment.deleteMany({ where: held });
    await tx.bot.delete({ where: { id: bot.id, userId } });
    if (deleteSandboxId !== null) {
      await tx.sandbox.delete({ where: { id: deleteSandboxId } });
    }
    return {
      unassigned,
      deliverables: deliverables.map((row) => row.id),
      files: files.map((row) => row.storageKey),
    };
  }

  /** The open Work views learn which cards and deliverables just changed. */
  private announceWork(
    userId: string,
    taskIds: readonly string[],
    deliverableIds: readonly string[],
  ): void {
    try {
      for (const taskId of taskIds) {
        this.events.emitWorkChanged(userId, 'task.changed', { taskId });
      }
      for (const deliverableId of deliverableIds) {
        this.events.emitWorkChanged(userId, 'deliverable.changed', {
          deliverableId,
          deleted: true,
        });
      }
    } catch (error) {
      this.logger.warn(`Work views could not be told about a deleted bot: ${String(error)}`);
    }
  }

  /**
   * The scoped lookup every route funnels through. Returns 404 for both
   * "doesn't exist" and "exists but belongs to someone else" — never leak
   * existence across the ownership boundary.
   */
  private async findOwned(userId: string, botId: string): Promise<Bot> {
    const bot = await this.prisma.bot.findFirst({ where: { id: botId, userId } });
    if (bot === null) {
      throw new NotFoundException('Bot not found');
    }
    return bot;
  }
}
