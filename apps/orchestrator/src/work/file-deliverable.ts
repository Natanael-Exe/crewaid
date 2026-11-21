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
): Promise<{ deliverableId: string; taskId: string | null }> {
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
      ...place,
    },
  });
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
  return { deliverableId: deliverable.id, taskId: place.taskId };
}
