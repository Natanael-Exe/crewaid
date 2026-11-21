import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ListTurnsQuery } from '@crewaid/shared';

import { PrismaService } from '../prisma/prisma.service.js';

/**
 * `GET /bots/:id/turns` — a bot's recent turns, newest first, with the
 * step count and token usage each one recorded.
 *
 * A read of durable rows, kept out of `ChatSendService`: that service runs
 * turns, and a history query has none of its state.
 *
 * The `select` is `TurnSummarySchema`'s fields and no others. `AgentTurn`
 * also carries coordination columns — `activeKey`, the chain and run ids —
 * that are the orchestrator's bookkeeping, not part of what REST promises a
 * client, and a row returned whole would put them on the wire.
 */
@Injectable()
export class TurnHistoryService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(userId: string, botId: string, query: ListTurnsQuery) {
    // 404 for absent and foreign alike, as `BotsService.findOwned` answers:
    // an empty list for somebody else's bot would confirm nothing, but a 403
    // would confirm it exists.
    const bot = await this.prisma.bot.findFirst({
      where: { id: botId, userId },
      select: { id: true },
    });
    if (bot === null) throw new NotFoundException('Bot not found');

    const turns = await this.prisma.agentTurn.findMany({
      where: { botId: bot.id, bot: { userId } },
      orderBy: { startedAt: 'desc' },
      take: query.limit,
      select: {
        id: true,
        botId: true,
        triggerMessageId: true,
        status: true,
        stepIndex: true,
        steps: true,
        inputTokens: true,
        outputTokens: true,
        cachedInputTokens: true,
        cacheCreationTokens: true,
        startedAt: true,
        endedAt: true,
        stopReason: true,
      },
    });
    // `stepIndex` is advanced in the same statement that appends a step
    // (`appendTurnStep`), so it is the count of steps the row holds.
    return turns.map((turn) => ({ ...turn, stepCount: turn.stepIndex }));
  }
}
