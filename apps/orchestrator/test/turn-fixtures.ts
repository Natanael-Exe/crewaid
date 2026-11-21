import type { PrismaClient } from '@prisma/client';

/**
 * The thread a hand-made `AgentTurn` row belongs to (D-165: every run has
 * one). A bot made through `BotsService` already has its conversation; a bot
 * a suite inserted directly does not, so this creates it the way the service
 * would rather than letting each suite invent its own.
 */
export async function conversationIdOf(
  prisma: Pick<PrismaClient, 'conversation'>,
  botId: string,
): Promise<string> {
  const row = await prisma.conversation.upsert({
    where: { botId },
    create: { botId },
    update: {},
    select: { id: true },
  });
  return row.id;
}
