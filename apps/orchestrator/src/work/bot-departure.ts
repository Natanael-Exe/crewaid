import type { Prisma } from '@prisma/client';
import { writeTaskEvent, USER_ACTOR } from './task-events.js';

/**
 * Before a bot is deleted: every task assigned to it gets an
 * UNASSIGNED event naming it, written while the name can still be read. The
 * foreign key then clears the assignee. The tasks themselves stay — they are
 * the user's plan, not the bot's output — and the user is the actor, because
 * deleting the bot was their act.
 *
 * Runs inside the deletion's own transaction and returns the task ids, which
 * the caller announces after commit.
 */
export async function recordBotDeparture(
  tx: Prisma.TransactionClient,
  userId: string,
  bot: { readonly id: string; readonly name: string },
): Promise<string[]> {
  const assigned = await tx.task.findMany({
    where: { userId, assigneeBotId: bot.id },
    select: { id: true },
  });
  for (const task of assigned) {
    await writeTaskEvent(tx, userId, task.id, USER_ACTOR, 'UNASSIGNED', {
      botId: bot.id,
      botName: bot.name,
      reason: 'BOT_DELETED',
    });
  }
  return assigned.map((task) => task.id);
}
