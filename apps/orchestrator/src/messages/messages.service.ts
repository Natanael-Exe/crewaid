import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Attachment, Bot, Message, Prisma } from '@prisma/client';
import type { DeleteMessagesResponse, SendMessageBody } from '@crewaid/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { triggerRowColumns } from '../agent/persistence/transcript.js';
import { TurnEventBus } from '../agent/turn-event.bus.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { MemoryService } from '../memory/memory.service.js';
import { LIVE_TURN_STATUSES } from '../agent/agent-turn.types.js';

/** What a `/new` boundary says in the transcript. */
export const NEW_TOPIC_TEXT = 'New topic';

/**
 * Conversation and message persistence: the rows written
 * outside a run — a person's message, a teammate's delivery, a system notice,
 * a `/new` boundary — and deletion. A run's own rows are the TanStack message
 * store's, and a thread is read through the chat route.
 */
@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
    @Inject(MemoryService) private readonly memories: MemoryService,
    /** Removes deleted messages' files once the rows are gone, as bot deletion does. */
    @Optional() @Inject(AttachmentsService) private readonly attachments?: AttachmentsService,
  ) {}

  /**
   * Persist a USER message (the trigger for the agent turn).
   *
   * Content is optional at the schema — an attachment-only send
   * (empty/absent content with ≥1 claimed attachment) is valid and persists
   * with content `''`. The Message.content is NOT NULL, so empty text is
   * stored as the empty string, not NULL.
   */
  async createUserMessage(
    userId: string,
    botId: string,
    input: SendMessageBody,
    /** The routine posting this message, which files what its turn produces. */
    provenance: { readonly routineId?: string } = {},
  ): Promise<Message & { attachments: Attachment[] }> {
    await this.findOwnedBot(userId, botId);

    return this.prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.findUnique({
        where: { botId },
        select: { id: true },
      });
      if (conversation === null) {
        // BotsService.create makes this impossible in practice; the guard
        // exists so a hand-migrated DB fails loudly here, not mid-stream.
        throw new NotFoundException('Conversation not found');
      }

      // D-021 claim filter: ids must be UNCLAIMED uploads owned by THIS
      // principal. Foreign-owned or already-attached → 404, never silently
      // bound — that's the IDOR chain D-021 exists to break.
      const attachments = input.attachmentIds ?? [];
      if (attachments.length > 0) {
        const claimable = await tx.attachment.findMany({
          // A file a deliverable holds is not an upload waiting for a
          // message, even though its own message has been deleted.
          where: { id: { in: attachments }, messageId: null, deliverable: null, ownerId: userId },
          select: { id: true },
        });
        if (claimable.length !== attachments.length) {
          throw new NotFoundException('Unknown, foreign, or already-attached attachment id');
        }
      }

      return tx.message.create({
        data: {
          conversationId: conversation.id,
          // This row IS a model message, so it is written through
          // the one validating mapper. The product facts — which routine
          // posted it, which files it claims — stay in their columns.
          ...triggerRowColumns(botId, input.content ?? ''),
          routineId: provenance.routineId ?? null,
          ...(attachments.length > 0 && {
            attachments: {
              // Claim the uploads (messageId was null).
              connect: attachments.map((id) => ({ id })),
            },
          }),
        },
        include: { attachments: true },
      });
    });
  }

  /**
   * The delivered message: what one bot said to another, in the
   * RECEIVING bot's conversation.
   *
   * `author: BOT` with the SENDER's `fromBotId`, which is the shape §6/M7
   * names. It is deliberately the same shape a bot's own reply has, because
   * the alternative — a fifth author — would mean every consumer that
   * switches on the column (the reducer, the seed, the renderer registry)
   * gaining a case, and the `MessageAuthor` is contractual (§0 rule 2).
   * What separates the two is whose id is on the row, and every reader that
   * cares reads that.
   *
   * No ownership check here: the only caller is the delivery worker, which
   * has just re-resolved BOTH bots against the job's principal in one scoped
   * query — re-deriving it from a bot id would be a second, weaker answer to
   * a question already answered.
   */
  async createInboundBotMessage(input: {
    toBotId: string;
    fromBotId: string;
    content: string;
    chainId: string;
    hopCount: number;
    /** The task the message is about, already owner-checked by the delivery. */
    taskId?: string | null;
  }): Promise<Message & { attachments: Attachment[] }> {
    const conversationId = await this.findConversationId(input.toBotId);
    return this.prisma.message.create({
      data: {
        conversationId,
        // BOT-authored with the SENDER's id, and a canonical `user`
        // body beside it, because that is what the receiving bot reads it as.
        ...triggerRowColumns(input.toBotId, input.content, input.fromBotId),
        chainId: input.chainId,
        hopCount: input.hopCount,
        taskId: input.taskId ?? null,
      },
      include: { attachments: true },
    });
  }

  /** SYSTEM/TOOL messages (limits hit, interruptions, approval notes). */
  async createSystemMessage(input: {
    botId: string;
    content: string;
    author?: 'SYSTEM' | 'TOOL';
  }): Promise<Message> {
    const conversationId = await this.findConversationId(input.botId);
    return this.prisma.message.create({
      data: {
        conversationId,
        author: input.author ?? 'SYSTEM',
        content: input.content,
      },
    });
  }

  /**
   * Delete one message, or every message in the bot's conversation
   * when `messageId` is absent ("Clear chat").
   *
   * Refused while a turn is running. The runner holds the trigger and the
   * draft it is streaming into; deleting either under it leaves a reply
   * written to a row that no longer exists, or a turn answering a message
   * the transcript no longer has.
   *
   * What survives, and why:
   * - Memories stay unless `forget` is set: `Memory.messageId` is SetNull,
   * because deleting a transcript must not delete what was learned from
   * it. With `forget`, they are forgotten and tombstoned in the same
   * transaction. A memory is linked to the reply it was written during,
   * so a USER message's lessons sit on the replies of the turns it
   * triggered, and those count as learned from it.
   * - Deliverables stay (their `messageId` is SetNull), and so does a file
   * one of them holds: it is detached from its message rather than
   * deleted with it. Every other file goes, rows now and bytes after the
   * commit.
   * - Task events keep their row; their message link goes null.
   */
  async deleteMessages(
    userId: string,
    botId: string,
    input: { readonly messageId?: string | undefined; readonly forget: boolean },
  ): Promise<DeleteMessagesResponse> {
    await this.findOwnedBot(userId, botId);
    const cleared = input.messageId === undefined;
    const inConversation: Prisma.MessageWhereInput = { conversation: { botId, bot: { userId } } };
    const target: Prisma.MessageWhereInput =
      input.messageId === undefined ? inConversation : { ...inConversation, id: input.messageId };

    const outcome = await this.prisma.$transaction(
      async (tx) => {
        const running = await tx.agentTurn.findFirst({
          // A turn parked on an approval still holds its trigger and draft.
          where: { botId, status: { in: [...LIVE_TURN_STATUSES] }, bot: { userId } },
          select: { id: true },
        });
        if (running !== null) {
          throw new ConflictException('The bot is working. Stop it or wait for the reply first.');
        }
        const rows = await tx.message.findMany({
          where: target,
          select: { id: true, runId: true },
        });
        if (input.messageId !== undefined && rows.length === 0) {
          throw new NotFoundException('Message not found');
        }
        const ids = rows.map((row) => row.id);

        const forgottenCount = input.forget
          ? await this.memories.forgetLearnedFrom(
              tx,
              userId,
              cleared
                ? inConversation
                : {
                    ...inConversation,
                    OR: [{ id: { in: ids } }, { run: { triggerMessageId: { in: ids } } }],
                  },
            )
          : 0;

        await tx.attachment.updateMany({
          where: { ownerId: userId, message: target, deliverable: { isNot: null } },
          data: { messageId: null },
        });
        const files = await tx.attachment.findMany({
          where: { ownerId: userId, message: target },
          select: { storageKey: true },
        });
        await tx.message.deleteMany({ where: target });
        // A deleted message must not come back by replay,
        // so the event log of every run that wrote or answered it goes with
        // it, and a clear takes the thread's whole log and its open pauses.
        const ownedThread: Prisma.ConversationWhereInput = { botId, bot: { userId } };
        if (cleared) {
          await tx.runEvent.deleteMany({ where: { userId, conversation: ownedThread } });
          await tx.runInterrupt.deleteMany({
            where: { userId, status: 'pending', conversation: ownedThread },
          });
        } else {
          await tx.runEvent.deleteMany({
            where: {
              userId,
              conversation: ownedThread,
              run: {
                OR: [
                  { id: { in: rows.flatMap((row) => (row.runId === null ? [] : [row.runId])) } },
                  { triggerMessageId: { in: ids } },
                ],
              },
            },
          });
        }
        return { ids, files: files.map((file) => file.storageKey), forgottenCount };
      },
      { timeout: 10_000 },
    );

    // Observational: the rows are gone, so a file that cannot be removed is a
    // leak on disk, not a failed deletion.
    if (this.attachments !== undefined && outcome.files.length > 0) {
      try {
        await this.attachments.removeStoredFiles(outcome.files);
      } catch (error: unknown) {
        this.logger.warn(`bot ${botId}: messages deleted, files not removed: ${String(error)}`);
      }
    }
    // A clear sends no ids: the flag already says "everything", and a long
    // conversation's ids would make one frame as large as its history.
    this.events.emitMessagesDeleted(botId, cleared ? [] : outcome.ids, cleared);
    return { deletedCount: outcome.ids.length, forgottenCount: outcome.forgottenCount };
  }

  /**
   * `/new`: a boundary the next turn's history starts after. No model
   * call and no turn, only a SYSTEM row the transcript draws as a divider.
   *
   * Idempotent against itself: when the newest message is already a
   * boundary, that one is returned rather than stacking a second divider
   * under it, which would say nothing the first does not.
   */
  async startTopic(
    userId: string,
    botId: string,
    boundaryId?: string,
  ): Promise<Message & { attachments: Attachment[] }> {
    await this.findOwnedBot(userId, botId);
    const conversationId = await this.findConversationId(botId);
    // Queue consumers supply a stable server-owned id. The insert itself
    // deduplicates, including a crash before the job's acknowledgement, and
    // only a new boundary is announced to already-open transcripts.
    if (boundaryId !== undefined) {
      const inserted = await this.prisma.message.createMany({
        data: {
          id: boundaryId,
          conversationId,
          author: 'SYSTEM',
          content: NEW_TOPIC_TEXT,
          startsTopic: true,
        },
        skipDuplicates: true,
      });
      const boundary = await this.prisma.message.findFirstOrThrow({
        where: {
          id: boundaryId,
          conversationId,
          startsTopic: true,
          conversation: { bot: { userId } },
        },
        include: { attachments: true },
      });
      if (inserted.count > 0) this.events.emitCreated(botId, boundary);
      return boundary;
    }
    const newest = await this.prisma.message.findFirst({
      where: { conversationId, conversation: { bot: { userId } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { attachments: true },
    });
    if (newest?.startsTopic === true) return newest;
    const created = await this.prisma.message.create({
      data: { conversationId, author: 'SYSTEM', content: NEW_TOPIC_TEXT, startsTopic: true },
      include: { attachments: true },
    });
    this.events.emitCreated(botId, created);
    return created;
  }

  /**
   * The scoped lookup every bot-addressed route funnels through — the same
   * shape as `BotsService.findOwned`. 404 covers both "absent" and "not
   * yours" so ownership never leaks through a status code.
   *
   * Extracting it is not only tidiness: every direct Prisma call site is an
   * entry in the D-010 allowlist, so folding the duplicates into one lookup
   * shrinks the surface that R7 has to audit.
   */
  private async findOwnedBot(userId: string, botId: string): Promise<Bot> {
    const bot = await this.prisma.bot.findFirst({ where: { id: botId, userId } });
    if (bot === null) {
      throw new NotFoundException('Bot not found');
    }
    return bot;
  }

  /**
   * §3 guarantees one Conversation per Bot, created with it. Callers here are
   * internal lifecycle paths that have already resolved the ownership
   * boundary; a missing row means a hand-migrated DB and must fail loudly.
   */
  private async findConversationId(botId: string): Promise<string> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { botId },
      select: { id: true },
    });
    if (conversation === null) {
      throw new NotFoundException('Conversation not found');
    }
    return conversation.id;
  }
}
