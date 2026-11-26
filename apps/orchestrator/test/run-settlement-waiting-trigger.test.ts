import { describe, expect, it } from 'vitest';
import { RunSettlementService } from '../src/chat/run-settlement.service.js';
import type { RunLease } from '../src/agent/persistence/run-lease.js';
import type { TurnBot } from '../src/agent/turn-assembly.js';
import type { StoredTriggerStarter } from '../src/chat/chat-run.types.js';
import type { StructuredLogger } from '../src/logging/structured-logger.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { TurnEventBus } from '../src/agent/turn-event.bus.js';
import type { MessagesService } from '../src/messages/messages.service.js';

type Row = {
  id: string;
  sequence: number;
  author: 'USER' | 'BOT' | 'SYSTEM';
  fromBotId: string | null;
  expectReply: boolean;
  runId: string | null;
  chainId: string | null;
  hopCount: number;
  content: string;
};

/** Evaluates the subset of Prisma `where` shapes the settlement queries use. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'conversation' || key === 'bot' || key === 'conversationId' || key === 'botId') {
      return true;
    }
    if (key === 'AND') {
      return (condition as Record<string, unknown>[]).every((inner) => matches(row, inner));
    }
    if (key === 'OR') {
      return (condition as Record<string, unknown>[]).some((inner) => matches(row, inner));
    }
    if (key === 'NOT') return !matches(row, condition as Record<string, unknown>);
    const actual = row[key];
    if (condition !== null && typeof condition === 'object') {
      const ops = condition as Record<string, unknown>;
      if ('gt' in ops) return (actual as number) > (ops['gt'] as number);
      if ('in' in ops) return (ops['in'] as unknown[]).includes(actual);
      if ('not' in ops) return actual !== ops['not'];
    }
    return actual === condition;
  });
}

function harness(rows: Row[], claimedTriggers: string[]) {
  const started: string[] = [];
  const prisma = {
    message: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
        rows
          .filter((row) => matches(row, where))
          .sort((a, b) => b.sequence - a.sequence)
          .slice(0, take ?? rows.length),
    },
    agentTurn: {
      findMany: async ({ where }: { where: { triggerMessageId: { in: string[] } } }) =>
        claimedTriggers
          .filter((id) => where.triggerMessageId.in.includes(id))
          .map((triggerMessageId) => ({ triggerMessageId })),
    },
    workflowChainState: { findMany: async () => [] },
  } as unknown as PrismaService;
  const service = new RunSettlementService(
    prisma,
    {} as TurnEventBus,
    {} as MessagesService,
  );
  const runStored: StoredTriggerStarter = async (_userId, _bot, _thread, trigger) => {
    started.push(trigger.id);
    return { settled: Promise.resolve() };
  };
  const logger = { info: () => undefined, warn: () => undefined } as unknown as StructuredLogger;
  const lease: RunLease = {
    userId: 'user_1',
    botId: 'bot_a',
    threadId: 'thread_a',
    runId: 'run_current',
    workerId: 'worker',
    epoch: 1,
  };
  const bot = { id: 'bot_a' } as TurnBot;
  const answer = (triggerMessageId: string, priority?: string): Promise<boolean> =>
    (
      service as unknown as {
        answerWaitingTrigger: (
          lease: RunLease,
          bot: TurnBot,
          triggerMessageId: string,
          logger: StructuredLogger,
          runStored: StoredTriggerStarter,
          priorityTriggerId?: string,
        ) => Promise<boolean>;
      }
    ).answerWaitingTrigger(lease, bot, triggerMessageId, logger, runStored, priority);
  return { answer, started };
}

const user = (id: string, sequence: number): Row => ({
  id,
  sequence,
  author: 'USER',
  fromBotId: null,
  expectReply: true,
  runId: null,
  chainId: null,
  hopCount: 0,
  content: id,
});

const peer = (id: string, sequence: number, expectReply = true): Row => ({
  id,
  sequence,
  author: 'BOT',
  fromBotId: 'bot_b',
  expectReply,
  runId: null,
  chainId: 'chain_1',
  hopCount: 1,
  content: id,
});

describe('RunSettlementService waiting-trigger selection', () => {
  it('answers a peer message that arrived mid-run even when older user messages exist', async () => {
    const { answer, started } = harness(
      [user('u1', 1), user('u2', 3), peer('m', 5)],
      ['u1', 'u2'],
    );
    await expect(answer('u2')).resolves.toBe(true);
    expect(started).toEqual(['m']);
  });

  it('never re-answers an older message an earlier run already folded in', async () => {
    // u2 was folded into u3's run (no AgentTurn of its own); nothing is newer than u3.
    const { answer, started } = harness([user('u1', 1), user('u2', 2), user('u3', 3)], ['u1', 'u3']);
    await expect(answer('u3')).resolves.toBe(false);
    expect(started).toEqual([]);
  });

  it('prefers a newer user message over a newer peer message', async () => {
    const { answer, started } = harness(
      [user('u1', 1), user('u2', 4), peer('m', 6), user('u3', 7)],
      ['u1', 'u2'],
    );
    await expect(answer('u2')).resolves.toBe(true);
    expect(started).toEqual(['u3']);
  });

  it('skips a newer row another run already claimed', async () => {
    const { answer, started } = harness(
      [user('u1', 1), user('u2', 4), peer('m', 6), user('u3', 7)],
      ['u1', 'u3'],
    );
    // u3 is newest but already claimed by another run, so the waiting peer message wins.
    await expect(answer('u2')).resolves.toBe(true);
    expect(started).toEqual(['m']);
  });

  it('ignores FYI peer notices that request no reply', async () => {
    const { answer, started } = harness([user('u1', 1), peer('fyi', 2, false)], ['u1']);
    await expect(answer('u1')).resolves.toBe(false);
    expect(started).toEqual([]);
  });

  it('gives a Stop-and-send message priority over other waiting rows', async () => {
    const { answer, started } = harness(
      [user('u1', 1), user('stop_and_send', 2), peer('m', 3)],
      ['u1'],
    );
    await expect(answer('u1', 'stop_and_send')).resolves.toBe(true);
    expect(started).toEqual(['stop_and_send']);
  });
});
