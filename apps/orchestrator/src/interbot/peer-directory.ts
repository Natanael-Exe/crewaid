import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import type { Peer, PeerDirectoryPort } from './send-message.tool.js';

/**
 * Who a bot may message: the principal's other bots.
 *
 * The scoping is the whole of the security story for `send_message`. A bot
 * can only ever name something in this list — the tool resolves against what
 * comes back and refuses anything else — so an id belonging to another user
 * is not a forbidden target, it is an unknown one. That is the same posture
 * `findOwned` takes everywhere else: absent and foreign are the same
 * answer, so ownership never leaks through the difference.
 *
 * `id: { not: senderBotId }` rather than filtering afterwards: a bot messaging
 * itself would deliver a message that starts a turn that can message itself
 * again, which is a loop with a hop count that never reaches anyone.
 */
@Injectable()
export class PrismaPeerDirectory implements PeerDirectoryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  peers = async (userId: string, senderBotId: string): Promise<Peer[]> => {
    return this.prisma.bot.findMany({
      where: { userId, id: { not: senderBotId } },
      select: { id: true, name: true },
      // The operator's own ordering, so a model reading the list in a refusal
      // sees the team in the order the sidebar shows it.
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  };
}
