import { Inject, Injectable } from '@nestjs/common';
import type { Json } from '@crewaid/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { ToolApprovalHub } from './policy/approval-hub.js';
import { TanStackTurns } from './tanstack-turns.js';

/**
 * The operator's controls over a bot's work that are not a chat request:
 * Stop, an approval answered over the socket, and what is waiting now.
 *
 * A TanStack run's own approvals are answered through `POST /bots/:id/chat`,
 * which records the decision before anything acts on it. What the
 * hub still waits on here is a scheduled skill's question.
 */
@Injectable()
export class TurnControlService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ToolApprovalHub) private readonly approvalHub: ToolApprovalHub,
    @Inject(TanStackTurns) private readonly tanstack: TanStackTurns,
  ) {}

  /** The Stop: the bot's run, and any question a scheduled skill is waiting on. */
  cancelTurn(userId: string, botId: string): boolean {
    const waiting = this.approvalHub.cancelBot(userId, botId);
    const stopped = this.tanstack.cancel(userId, botId);
    return stopped || waiting;
  }

  /** Rows are the pending authority; the hub's waiters are scoped to the principal. */
  listPendingApprovals(userId: string, botId: string) {
    return this.approvalHub.list(userId, botId);
  }

  async respondToApproval(
    userId: string,
    toolCallId: string,
    approved: boolean,
    reason?: string,
    editedArgs?: Json,
  ): Promise<'delivered' | 'not-waiting' | 'wrong-route'> {
    // A run's interrupt is answered on its chat route, where the durable
    // admission sees it; delivering it here would approve a call that never did.
    const run = await this.prisma.runInterrupt.findFirst({
      where: { id: toolCallId, userId },
      select: { id: true },
    });
    if (run !== null) return 'wrong-route';
    const delivered = await this.approvalHub.respond(userId, toolCallId, {
      approved,
      ...(reason !== undefined && { reason }),
      ...(editedArgs !== undefined && { editedArgs }),
    });
    return delivered ? 'delivered' : 'not-waiting';
  }
}
