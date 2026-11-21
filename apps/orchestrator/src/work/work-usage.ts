import type { Prisma } from '@prisma/client';
import type { WorkUsage } from '@crewaid/shared';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * What a piece of work has cost: the summed tokens of the
 * turns started by the messages `about` selects — a Start brief, a delegated
 * message carrying the task, a routine's run. A turn a bot started on its own
 * initiative is about nothing and counts nowhere, which is the honest answer:
 * nothing links it to the work.
 */
export async function workUsage(
  prisma: PrismaService,
  userId: string,
  about: Prisma.MessageWhereInput,
): Promise<WorkUsage> {
  const triggers = await prisma.message.findMany({
    where: { ...about, conversation: { bot: { userId } } },
    select: { id: true },
  });
  if (triggers.length === 0) return { turns: 0, inputTokens: 0, outputTokens: 0 };
  const sum = await prisma.agentTurn.aggregate({
    where: { bot: { userId }, triggerMessageId: { in: triggers.map((row) => row.id) } },
    _count: { _all: true },
    _sum: { inputTokens: true, outputTokens: true },
  });
  return {
    turns: sum._count._all,
    inputTokens: sum._sum.inputTokens ?? 0,
    outputTokens: sum._sum.outputTokens ?? 0,
  };
}
