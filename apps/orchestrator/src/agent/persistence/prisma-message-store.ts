import { isDeepStrictEqual } from 'node:util';
import { Prisma, type Message } from '@prisma/client';
import { modelMessagesToUIMessages, type ModelMessage } from '@tanstack/ai';
import { defineMessageStore, type MessagePage, type MessageStore } from '@tanstack/ai-persistence';
import type { StructuredLogger } from '../../logging/structured-logger.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import {
  assignTranscriptIds,
  fromTranscriptRow,
  fromTranscriptRowForOperator,
  toTranscriptRow,
  type TranscriptViolation,
} from './transcript.js';

/**
 * The library's `MessageStore` over `Conversation` and `Message`,
 * through the one Prisma client.
 *
 * A store is built for one principal and, while a run is writing, for that
 * run. The library's interface takes a bare thread id, so the principal is
 * what makes "this thread is yours" a check rather than an assumption: a
 * thread the principal does not own loads as empty and refuses a save, the
 * same answer as a thread that does not exist.
 *
 * The library's contract says `saveThread` overwrites. Crewaid's says it
 * reconciles and never deletes (D-159 §3.4): a save inserts the messages it
 * does not have and updates the ones that changed, and a stored message the
 * save left out is kept and reported. Rows leave a thread only through the
 * D-147 routes, so no history a caller sends, short or empty, can truncate
 * the server's.
 */

/** Why a store refused. Each one is a server fault or a fenced writer, never a user's. */
export type TranscriptStoreErrorCode = 'THREAD_NOT_OWNED' | 'STALE_WRITER' | 'CONTRACT_VIOLATION';

export class TranscriptStoreError extends Error {
  constructor(
    readonly code: TranscriptStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TranscriptStoreError';
  }
}

export type MessageStoreScope = {
  /** The principal every thread is authorized against. */
  readonly userId: string;
  /**
   * The run writing through this store, or null for a reader. A save from a
   * run that is no longer its thread's newest run is a stale writer: a worker
   * that lost the run, still flushing what it had.
   */
  readonly runId: string | null;
  /**
   * The inter-bot chain the writing run answers. A row the run
   * creates carries it — the reply is in the chain at the same hop, because
   * nothing was delivered by it — and a row that already exists keeps the
   * chain its writer gave it.
   */
  readonly chain?: { readonly chainId: string | null; readonly hopCount: number };
  /** Required for a leased run; checked under the same transaction as its write. */
  readonly fence?: (tx: Prisma.TransactionClient) => Promise<void>;
  /** Server-owned composition joins the terminal transaction; never supplied by a client. */
  readonly transaction?: <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
  /**
   * Who `loadThread` reads the thread for. `model` is the default and
   * is a turn's input: product rows are dropped and no column travels with a
   * message. `operator` is a hydrate: the notices and dividers are kept and
   * every message carries `metadata.crewaid`. A writer is always `model` —
   * the operator view exists on a store whose writes are refused.
   */
  readonly view?: 'model' | 'operator';
};

type Store = MessageStore & {
  /**
   * Take a message's place in the thread's order before its content exists
   * (D-159 §3.4). A reply's row is inserted when its stream starts and a tool
   * result's when its call does, so a user message admitted mid-run sorts
   * after them, and the next run reads the conversation in the order it
   * happened. The later save fills the row in.
   */
  readonly reserve: (
    threadId: string,
    message:
      | { readonly role: 'assistant'; readonly id: string }
      | { readonly role: 'tool'; readonly toolCallId: string },
  ) => Promise<void>;
  /**
   * Put one of this run's replies back to the reservation shape, which
   * no reader shows or sends to a model. For a reply that must not stand as
   * the bot's words after its text was already snapshotted.
   */
  readonly withdraw: (threadId: string, messageId: string) => Promise<void>;
};

export function createPrismaMessageStore(
  prisma: PrismaService,
  scope: MessageStoreScope,
  logger?: StructuredLogger,
): Store {
  const transaction =
    scope.transaction ??
    (<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) =>
      prisma.$transaction(operation));
  // The chain columns a row this run creates carries. Written at
  // creation and never updated later: author, sender, run and every product
  // column are the row's, written once by whoever created it.
  const chainColumns: { chainId?: string; hopCount?: number } =
    scope.chain?.chainId == null
      ? {}
      : { chainId: scope.chain.chainId, hopCount: scope.chain.hopCount };
  const ownedThread = async (threadId: string) => {
    const thread = await prisma.conversation.findFirst({
      where: { id: threadId, bot: { userId: scope.userId } },
      select: { id: true, botId: true },
    });
    return thread;
  };

  /**
   * A turn's input: the conversation as the model reads it. Product rows are
   * dropped and no column travels with a message.
   */
  const loadForModel = async (threadId: string): Promise<ModelMessage[]> => {
    const thread = await ownedThread(threadId);
    if (thread === null) return [];
    const after = await topicStart(prisma, thread.id);
    const rows = await prisma.message.findMany({
      // A `/new` boundary is where the model's conversation starts.
      // The rows before it stay in the transcript, and a save keeps them.
      where: { conversationId: thread.id, sequence: { gt: after } },
      orderBy: { sequence: 'asc' },
      select: {
        id: true,
        author: true,
        fromBotId: true,
        runId: true,
        content: true,
        parts: true,
        createdAt: true,
      },
    });
    const messages: ModelMessage[] = [];
    for (const row of rows) {
      // An ordering reservation is not output. In particular, it must not
      // satisfy a pending assistant tool call when an approval resumes.
      if (reservationRole(row, thread.botId) !== undefined) continue;
      const read = fromTranscriptRow(row, thread.botId);
      // A row that cannot be read is not skipped: a save of the shorter list
      // would then look like the thread losing a message.
      if (!read.ok) throw contract(read.violation, `message ${row.id}`);
      if (read.value !== null) messages.push(read.value);
    }
    return messages;
  };

  /**
   * A hydrate: the conversation as the operator reads it (D-192). The notices
   * and `/new` dividers the model never sees are kept, and every message
   * carries the §3.4 product projection, attachments included. A second select
   * rather than a conditional one, so Prisma types each row as what it is.
   */
  const loadForOperator = async (
    threadId: string,
    options?: { limit?: number; before?: string },
  ): Promise<ModelMessage[] | MessagePage> => {
    const thread = await ownedThread(threadId);
    if (thread === null) return [];
    const limit =
      options?.limit !== undefined && Number.isInteger(options.limit) && options.limit > 0
        ? Math.min(options.limit, 501)
        : undefined;
    let before: number | undefined;
    if (limit !== undefined && options?.before !== undefined) {
      const boundary = await prisma.message.findFirst({
        where: { id: options.before, conversationId: thread.id },
        select: { sequence: true },
      });
      if (boundary === null) return { messages: [], truncated: false };
      before = boundary.sequence;
    }
    const messages: ModelMessage[] = [];
    // One extra UI row lets the library discard a partial oldest tool group.
    // Reservations and folded tool results may require another bounded batch.
    while (true) {
      const rows = await prisma.message.findMany({
        where: {
          conversationId: thread.id,
          ...(before === undefined ? {} : { sequence: { lt: before } }),
        },
        orderBy: { sequence: limit === undefined ? 'asc' : 'desc' },
        ...(limit === undefined ? {} : { take: limit }),
        select: {
          id: true,
          author: true,
          fromBotId: true,
          runId: true,
          content: true,
          parts: true,
          createdAt: true,
          sequence: true,
          stopReason: true,
          taskId: true,
          routineId: true,
          chainId: true,
          hopCount: true,
          startsTopic: true,
          attachments: {
            select: {
              id: true,
              filename: true,
              mimeType: true,
              sizeBytes: true,
              kind: true,
              durationMs: true,
            },
            orderBy: { id: 'asc' },
          },
        },
      });
      const batch: ModelMessage[] = [];
      for (const { attachments, ...row } of limit === undefined ? rows : [...rows].reverse()) {
        if (reservationRole(row, thread.botId) !== undefined) continue;
        const read = fromTranscriptRowForOperator(row, thread.botId, attachments);
        if (!read.ok) throw contract(read.violation, `message ${row.id}`);
        batch.push(read.value);
      }
      messages.unshift(...batch);
      if (limit === undefined) return messages;
      if (rows.length < limit) return { messages, truncated: false };
      const ui = modelMessagesToUIMessages(messages);
      if (ui.length >= limit) return { messages, truncated: true, cursor: ui[0]!.id };
      before = rows.at(-1)!.sequence;
    }
  };

  function loadThread(threadId: string): Promise<ModelMessage[]>;
  function loadThread(
    threadId: string,
    options: { limit?: number; before?: string },
  ): Promise<ModelMessage[] | MessagePage>;
  async function loadThread(
    threadId: string,
    options?: { limit?: number; before?: string },
  ): Promise<ModelMessage[] | MessagePage> {
    return scope.view === 'operator' ? loadForOperator(threadId, options) : loadForModel(threadId);
  }

  const saveThread = async (threadId: string, messages: ModelMessage[]): Promise<void> => {
    await transaction(async (tx) => {
      const thread = await lockOwnedThread(tx, threadId, scope);
      const named = assignTranscriptIds(messages, { threadId, runId: scope.runId });
      if (!named.ok) throw contract(named.violation, 'a message in the save');

      const ids = named.value.map((message) => message.id ?? '');
      const prior = new Map(
        (
          await tx.message.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              conversationId: true,
              runId: true,
              parts: true,
              content: true,
              author: true,
              fromBotId: true,
              createdAt: true,
            },
          })
        ).map((row) => [row.id, row]),
      );

      for (const message of named.value) {
        const existing = prior.get(message.id ?? '');
        if (existing !== undefined && existing.conversationId !== threadId) {
          // Ids are global; one that names another thread's row is never
          // moved, overwritten or duplicated here.
          throw new TranscriptStoreError(
            'CONTRACT_VIOLATION',
            `message ${existing.id} belongs to another thread`,
          );
        }
        if (existing !== undefined) {
          const reserved = reservationRole(existing, thread.botId);
          const previous =
            reserved === undefined ? fromTranscriptRow(existing, thread.botId) : undefined;
          if (
            reserved !== undefined
              ? reserved !== message.role
              : !previous?.ok || previous.value === null || previous.value.role !== message.role
          ) {
            throw new TranscriptStoreError(
              'CONTRACT_VIOLATION',
              'A save cannot change a stored message role.',
            );
          }
        }
        const row = toTranscriptRow(message, {
          threadBotId: thread.botId,
          // A stored message keeps the run that wrote it; only a new one is
          // this run's.
          runId: existing === undefined ? scope.runId : existing.runId,
        });
        if (!row.ok) throw contract(row.violation, `message ${message.id ?? '(unnamed)'}`);

        if (existing === undefined) {
          await tx.message.create({
            data: { conversationId: threadId, ...row.value, ...chainColumns },
          });
        } else if (!isDeepStrictEqual(existing.parts, row.value.parts)) {
          // The body only. Author, sender, run and every product column are
          // the row's, written once by whoever created it.
          await tx.message.update({
            where: { id: existing.id },
            data: { parts: row.value.parts, content: row.value.content },
          });
        }
      }

      // Only rows the model was shown can be missing from its save: the ones
      // before the newest `/new` boundary were never loaded.
      const left = await tx.message.count({
        where: {
          conversationId: threadId,
          author: { not: 'SYSTEM' },
          id: { notIn: ids },
          sequence: { gt: await topicStart(tx, threadId) },
        },
      });
      if (left > 0) {
        // D-159 §3.4: kept, and said. A full-replace save that dropped them
        // would let any history a caller sent truncate the server's.
        logger?.warn('transcript.save.omitted', {
          threadId,
          runId: scope.runId,
          omitted: left,
        });
      }
    });
  };

  const reserve: Store['reserve'] = async (threadId, message) => {
    await transaction(async (tx) => {
      const thread = await lockOwnedThread(tx, threadId, scope);
      const named = assignTranscriptIds(
        [
          message.role === 'assistant'
            ? { id: message.id, role: 'assistant', content: '' }
            : { role: 'tool', toolCallId: message.toolCallId, content: '' },
        ],
        { threadId, runId: scope.runId },
      );
      const placeholder = named.ok ? named.value[0] : undefined;
      if (placeholder === undefined) {
        throw contract(named.ok ? { kind: 'missing-id' } : named.violation, 'a reservation');
      }
      const row = toTranscriptRow(placeholder, { threadBotId: thread.botId, runId: scope.runId });
      if (!row.ok) throw contract(row.violation, 'a reservation');
      const existing = await tx.message.findUnique({
        where: { id: row.value.id },
        select: {
          conversationId: true,
          parts: true,
          author: true,
          fromBotId: true,
          runId: true,
          content: true,
          id: true,
          createdAt: true,
        },
      });
      if (existing !== null) {
        const reserved = reservationRole(existing, thread.botId);
        const previous = fromTranscriptRow(existing, thread.botId);
        if (
          existing.conversationId !== threadId ||
          (reserved !== undefined
            ? reserved !== placeholder.role
            : !previous.ok || previous.value?.role !== placeholder.role)
        ) {
          throw new TranscriptStoreError(
            'CONTRACT_VIOLATION',
            'The reserved id already names another message.',
          );
        }
      }
      // Insert-if-absent: a reservation never clobbers content a save wrote.
      await tx.message.createMany({
        data: [{ conversationId: threadId, ...row.value, ...chainColumns, parts: Prisma.DbNull }],
        skipDuplicates: true,
      });
    });
  };

  const withdraw: Store['withdraw'] = async (threadId, messageId) => {
    await transaction(async (tx) => {
      const thread = await lockOwnedThread(tx, threadId, scope);
      const withdrawn = await tx.message.updateMany({
        where: {
          id: messageId,
          conversationId: threadId,
          runId: scope.runId,
          author: 'BOT',
          fromBotId: thread.botId,
        },
        data: { content: '', parts: Prisma.DbNull },
      });
      if (withdrawn.count !== 1)
        throw new TranscriptStoreError(
          'CONTRACT_VIOLATION',
          'Only this run’s reply can be withdrawn.',
        );
    });
  };

  return { ...defineMessageStore({ loadThread, saveThread }), reserve, withdraw };
}

/** Only server-authored, run-owned empty rows can represent a reservation. */
function reservationRole(
  row: Pick<Message, 'parts' | 'content' | 'author' | 'fromBotId' | 'runId'>,
  botId: string,
): 'assistant' | 'tool' | undefined {
  if (row.parts !== null || row.content !== '' || row.runId === null || row.fromBotId !== botId)
    return undefined;
  return row.author === 'BOT' ? 'assistant' : row.author === 'TOOL' ? 'tool' : undefined;
}

/**
 * Lock the thread for the length of a write and prove the principal owns it.
 *
 * `FOR UPDATE` on the conversation row serializes two saves of one thread, so
 * the second reads what the first wrote instead of racing it to an insert.
 * The ownership join is inside the same statement, so the row that is locked
 * is the row that was authorized.
 */
async function lockOwnedThread(
  tx: Prisma.TransactionClient,
  threadId: string,
  scope: MessageStoreScope,
): Promise<{ readonly botId: string }> {
  const rows = await tx.$queryRaw<{ botId: string }[]>`
    SELECT c."botId"
    FROM "Conversation" c
    JOIN "Bot" b ON b.id = c."botId"
    WHERE c.id = ${threadId} AND b."userId" = ${scope.userId}
    FOR UPDATE OF c
  `;
  const thread = rows[0];
  if (thread === undefined) {
    throw new TranscriptStoreError('THREAD_NOT_OWNED', 'no such thread');
  }

  if (scope.runId === null)
    throw new TranscriptStoreError('STALE_WRITER', 'A hydration store cannot write a transcript.');
  {
    const newest = await tx.agentTurn.findFirst({
      where: { conversationId: threadId },
      orderBy: { sequence: 'desc' },
      select: { id: true, workerId: true, driverEpoch: true },
    });
    if (newest?.id !== scope.runId) {
      throw new TranscriptStoreError(
        'STALE_WRITER',
        `run ${scope.runId} is not the newest run of its thread`,
      );
    }
    if ((newest.workerId !== null || newest.driverEpoch !== null) && scope.fence === undefined)
      throw new TranscriptStoreError(
        'STALE_WRITER',
        'A leased run requires its transactional writer fence.',
      );
    await scope.fence?.(tx);
  }
  return thread;
}

function contract(violation: TranscriptViolation, where: string): TranscriptStoreError {
  return new TranscriptStoreError('CONTRACT_VIOLATION', `${where}: ${violation.kind}`);
}

/**
 * The sequence a model's thread starts after: the newest `/new` boundary's,
 * or 0 for a thread with none (D-147).
 */
async function topicStart(
  client: Pick<Prisma.TransactionClient, 'message'>,
  conversationId: string,
): Promise<number> {
  const boundary = await client.message.findFirst({
    where: { conversationId, startsTopic: true },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });
  return boundary?.sequence ?? 0;
}
