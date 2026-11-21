import type { CreateBotBody } from '@crewaid/shared';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { WorkspaceProvisioner } from '../src/sandbox/attached-computer.js';

/** Explicitly model a migrated private computer for lifecycle/seat fixtures. */
export async function privateComputerBot(
  prisma: PrismaService,
  provider: WorkspaceProvisioner,
  userId: string,
  input: CreateBotBody,
) {
  return prisma.$transaction(async (tx) => {
    const bot = await tx.bot.create({ data: { userId, ...input, conversation: { create: {} } } });
    await tx.sandbox.create({ data: { id: bot.id, userId, bots: { connect: { id: bot.id } } } });
    await provider.provisionWorkspace({ botId: bot.id });
    return { ...bot, sandboxId: bot.id };
  });
}

export async function computerId(prisma: PrismaService, botId: string): Promise<string> {
  return (
    (await prisma.bot.findUnique({ where: { id: botId }, select: { sandboxId: true } }))
      ?.sandboxId ?? 'absent-computer'
  );
}
