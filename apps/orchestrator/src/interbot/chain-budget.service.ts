import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

/**
 * What one chain has already used up.
 *
 * Two allowances, both "what this chain has already spent": tokens across
 * every participant, and messages from one bot to one particular peer. They
 * live together because they answer the same question at the same moment —
 * the two checks run back to back on both the send and the delivery path —
 * and because a second service would mean a second Prisma call site to audit
 * for the same R7 scoping.
 *
 * Where the number comes from
 *
 * `AgentTurn` carries the four D-009(3) counters, and a run's
 * `triggerMessageId` names the message that started it — so a chain's runs
 * are exactly the ones its messages triggered: the message that began it
 * (whose own id is the chain's), and every delivery carrying the chain id.
 * The sum is one aggregate rather than a join written by hand.
 *
 * The four counters are summed the way `costOfTurn` sums them, deliberately:
 * the number that stops a chain and the number an operator reads in `/usage`
 * have to be the same number, or the wall arrives at a total nobody can find.
 *
 * What the count includes that it did not before
 *
 * The turn that STARTED the chain. Its run's trigger is the message whose id
 * IS the chain's, so it is in the sum — and that is the honest reading of
 * §6/M7's "actual tokens spent" for the notice that stops the chain: the
 * first bot's work answering the operator is what can push a chain over, and
 * a wall that ignored it would arrive one hop late. Everything from that
 * first answer onwards is in, including the reply each recipient composes.
 */
@Injectable()
export class ChainBudgetService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * §6/M7's "more than 3 messages to the same bot within one chain", counted.
   *
   * The delivered rows ARE the count: each is a message in the receiving
   * bot's conversation carrying the chain and the sender's id, so nothing
   * has to be tallied separately and a restart cannot lose it. Scoped
   * through the receiving bot's owner.
   */
  sendsBetween = async (
    userId: string,
    chainId: string,
    fromBotId: string,
    toBotId: string,
  ): Promise<number> => {
    return this.prisma.message.count({
      where: {
        chainId,
        fromBotId,
        author: 'BOT',
        conversation: { botId: toBotId, bot: { userId } },
        // A DELIVERED message, not any BOT row in that conversation. A bot's
        // own reply is stored with its own `fromBotId` in its own
        // conversation, so without this the two are indistinguishable and a
        // bot's replies count as messages it sent to itself. Unreachable
        // through the tool — the peer directory excludes self — but a count
        // that is only correct because of a filter somewhere else is a count
        // that breaks the day that filter moves.
        NOT: { fromBotId: toBotId },
      },
    });
  };

  /**
   * Whether this bot has already taken part in this chain.
   *
   * §6/M7 posts the termination note "to both bots", and the send path
   * cannot simply obey that: a bot six hops into a chain with one peer may
   * be refused while addressing a THIRD bot for the first time, and a note
   * in that bot's transcript would be the first it heard of a conversation
   * it was never in.
   *
   * Participation is the discriminator, and the rows already answer it: a
   * bot that has taken part has messages of this chain in its conversation,
   * whether it sent them or received them. Asked only on a refusal, which
   * is the end of a chain rather than a step in one.
   */
  participatedInChain = async (
    userId: string,
    chainId: string,
    botId: string,
  ): Promise<boolean> => {
    const seen = await this.prisma.message.count({
      where: { chainId, conversation: { botId, bot: { userId } } },
      take: 1,
    });
    return seen > 0;
  };

  spentTokens = async (userId: string, chainId: string): Promise<number> => {
    // A chain's runs are the ones its messages triggered: the message that
    // began it (whose id is the chain's), and every delivery carrying it.
    const triggers = await this.prisma.message.findMany({
      where: { OR: [{ id: chainId }, { chainId }], conversation: { bot: { userId } } },
      select: { id: true },
    });
    const totals = await this.prisma.agentTurn.aggregate({
      where: { bot: { userId }, triggerMessageId: { in: triggers.map((row) => row.id) } },
      _sum: {
        inputTokens: true,
        outputTokens: true,
        cachedInputTokens: true,
        cacheCreationTokens: true,
      },
    });
    const sum = totals._sum;
    return (
      (sum.inputTokens ?? 0) +
      (sum.outputTokens ?? 0) +
      (sum.cachedInputTokens ?? 0) +
      (sum.cacheCreationTokens ?? 0)
    );
  };
}
