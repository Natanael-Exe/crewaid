import type { Prisma } from '@prisma/client';
import { resolveFiling } from './deliverable-filing.js';
import { writeTaskEvent } from './task-events.js';

/** What a bot's attachment says about itself when it becomes a deliverable. */
export type DeliverableFiling = {
  /** The message that started the turn: filing rules 2 and 3 read it. */
  readonly triggerMessageId: string;
  /** Filing rule 1: ids the bot named on `attach_file`. */
  readonly taskId?: string | undefined;
  readonly goalId?: string | undefined;
  /** Where in the workspace the file was attached from, for `fs_read` later. */
  readonly sourcePath?: string | undefined;
  /** The bot's one-line note about the file. */
  readonly summary?: string | undefined;
};

/**
 * The FILE deliverable for an attachment a bot's reply just claimed, inside
 * the claim's own transaction. Filed by the rules, attributed to the bot
 * whose reply it is, and — when it lands on a task — logged on that task as
 * DELIVERABLE_LINKED with a link to the reply.
 */
export async function recordFileDeliverable(
  tx: Prisma.TransactionClient,
  input: {
    readonly userId: string;
    readonly attachmentId: string;
    readonly replyId: string;
    readonly title: string;
    readonly filing: DeliverableFiling;
    /** A text-like file's head, for search (`extractSearchText`). */
    readonly searchText?: string | null;
  },
): Promise<{
  deliverableId: string;
  taskId: string | null;
  version: number;
  supersededDeliverableId: string | null;
}> {
  const { userId, filing } = input;
  const reply = await tx.message.findFirst({
    where: { id: input.replyId, conversation: { bot: { userId } } },
    select: { conversation: { select: { bot: { select: { id: true, name: true } } } } },
  });
  const bot = reply?.conversation.bot ?? null;
  const place = await resolveFiling(tx, userId, {
    taskId: filing.taskId,
    goalId: filing.goalId,
    triggerMessageId: filing.triggerMessageId,
  });

  // Preserve immutable prior snapshots of the SAME file and chain the newest
  // active snapshot to supersede them. A filename alone is not an identity —
  // every project has a `report.md` — so only snapshots filed in the same
  // place (task, else goal, else the same bot's unfiled work at the same
  // workspace path) count as earlier revisions.
  const sameFile: Prisma.DeliverableWhereInput =
    place.taskId !== null
      ? { taskId: place.taskId }
      : place.goalId !== null
        ? { taskId: null, goalId: place.goalId }
        : {
            taskId: null,
            goalId: null,
            botId: bot?.id ?? null,
            ...(filing.sourcePath === undefined || filing.sourcePath === ''
              ? {}
              : { sourcePath: filing.sourcePath }),
          };
  const priorSnapshots = await tx.deliverable.findMany({
    where: {
      userId,
      kind: 'FILE',
      title: input.title,
      ...sameFile,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, supersededById: true },
  });
  const activePriorIds = priorSnapshots
    .filter((row) => row.supersededById === null)
    .map((row) => row.id);
  const version = priorSnapshots.length + 1;

  const deliverable = await tx.deliverable.create({
    data: {
      userId,
      kind: 'FILE',
      title: input.title,
      summary: filing.summary ?? null,
      botId: bot?.id ?? null,
      attachmentId: input.attachmentId,
      sourcePath: filing.sourcePath ?? null,
      searchText: input.searchText ?? null,
      reviewState: 'READY',
      ...place,
    },
  });

  if (activePriorIds.length > 0) {
    await tx.deliverable.updateMany({
      where: { userId, id: { in: activePriorIds }, supersededById: null },
      data: { supersededById: deliverable.id },
    });
  }

  if (place.taskId !== null) {
    await writeTaskEvent(
      tx,
      userId,
      place.taskId,
      bot === null
        ? { kind: 'USER' }
        : { kind: 'BOT', botId: bot.id, botName: bot.name, messageId: input.replyId },
      'DELIVERABLE_LINKED',
      { deliverableId: deliverable.id, title: deliverable.title },
    );
  }
  return {
    deliverableId: deliverable.id,
    taskId: place.taskId,
    version,
    supersededDeliverableId: activePriorIds[0] ?? null,
  };
}
