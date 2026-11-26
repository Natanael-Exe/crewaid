import { describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ToolDefinition as Tool } from '../src/agent/tool-contract.js';
import type { ToolContext } from '../src/agent/tool-registry.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { StructuredLogger } from '../src/logging/structured-logger.js';
import { BoardStoreService, MANAGED_BOARD_PATH } from '../src/agent/board-store.service.js';
import { boardTools } from '../src/agent/board-tools.js';
import { BotMessageDeliveryService } from '../src/interbot/bot-message.delivery.service.js';
import type { BotMessageJobData } from '../src/interbot/bot-message.queue.js';
import { sendMessageTool } from '../src/interbot/send-message.tool.js';
import { WorkflowControlService } from '../src/interbot/workflow-control.service.js';
import type { MessagesService } from '../src/messages/messages.service.js';
import type { TanStackTurns } from '../src/agent/tanstack-turns.js';
import type { TurnEventBus } from '../src/agent/turn-event.bus.js';
import type { ChainNoticeService } from '../src/interbot/chain-notice.service.js';
import type { ChainBudgetService } from '../src/interbot/chain-budget.service.js';

function noopLogger(): StructuredLogger {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  };
  return logger as unknown as StructuredLogger;
}

describe('Phase 2 — send_message FYI, duplicate suppression, and workflow gates', () => {
  const SENDER = 'bot_gideon';
  const DIANA = { id: 'bot_diana', name: 'Diana' };
  const JULIAN = { id: 'bot_julian', name: 'Julian' };

  function makeTool(overrides?: {
    canSend?: (
      userId: string,
      chainId: string,
      fromBotId: string,
      toBotId: string,
    ) => Promise<
      | { allowed: true; wrapUp?: true }
      | { allowed: false; status: 'STOPPED' | 'WRAPPING_UP' | 'CLOSED'; reason: string }
    >;
    spentTokens?: number;
    maxTokens?: number;
  }) {
    const sent: BotMessageJobData[] = [];
    const entry = sendMessageTool({
      queue: {
        enqueue: async (job) => {
          sent.push(job);
        },
      },
      directory: { peers: async () => [DIANA, JULIAN] },
      notice: { post: async () => undefined },
      budget: {
        spentTokens: async () => overrides?.spentTokens ?? 0,
        sendsBetween: async () => 0,
        participatedInChain: async () => false,
      },
      limits: { maxHops: 0, maxTokens: overrides?.maxTokens ?? 0, maxRepeatSends: 0 },
      ...(overrides?.canSend !== undefined ? { workflow: { canSend: overrides.canSend } } : {}),
    });
    const built = entry.build({
      userId: 'usr_1',
      botId: SENDER,
      trigger: { id: 'msg_root', chainId: 'chain_launch', hopCount: 1 },
    } as unknown as ToolContext) as Tool & {
      execute: (input: unknown, options: { toolCallId: string }) => Promise<string>;
    };
    return {
      sent,
      call: (input: { toBot: string; content: string; expectReply?: boolean }, toolCallId = 'tc1') =>
        built.execute(input, { toolCallId }),
    };
  }

  it('suppresses exact duplicate sends to the same peer within a single turn', async () => {
    const { sent, call } = makeTool();
    const first = await call({ toBot: 'Diana', content: 'Update the pricing table.' }, 'tc1');
    const second = await call({ toBot: 'Diana', content: '  Update   the pricing table. ' }, 'tc2');

    expect(first).toContain('queued for Diana');
    expect(second).toContain('Duplicate message');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.deliveryKey).toBe(`msg_root:${SENDER}:${DIANA.id}:tc1`);
  });

  it('carries expectReply: false for durable FYI notices', async () => {
    const { sent, call } = makeTool();
    const result = await call(
      { toBot: 'Julian', content: 'FYI: homepage audit is complete.', expectReply: false },
      'tc_fyi',
    );
    expect(result).toContain('FYI note queued for Julian');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.expectReply).toBe(false);
  });

  it('refuses new delegations when the workflow chain is STOPPED or WRAPPING_UP', async () => {
    const { sent, call } = makeTool({
      canSend: async () => ({
        allowed: false,
        status: 'WRAPPING_UP',
        reason: 'This workflow is wrapping up, so new delegation is paused.',
      }),
    });
    const result = await call({ toBot: 'Diana', content: 'Start another audit' }, 'tc_block');
    expect(result).toContain('wrapping up');
    expect(sent).toHaveLength(0);
  });

  it("lets an owner's wrap-up reply through a spent token budget", async () => {
    const exhausted = { spentTokens: 5_000, maxTokens: 1_000 };
    const wrapping = makeTool({ ...exhausted, canSend: async () => ({ allowed: true, wrapUp: true }) });
    const reply = await wrapping.call({ toBot: 'Diana', content: 'Done: pricing.csv' }, 'tc_reply');
    expect(reply).toContain('queued for Diana');
    expect(wrapping.sent).toHaveLength(1);

    const ordinary = makeTool({ ...exhausted, canSend: async () => ({ allowed: true }) });
    const refused = await ordinary.call({ toBot: 'Diana', content: 'One more audit' }, 'tc_more');
    expect(refused).toContain('token budget');
    expect(ordinary.sent).toHaveLength(0);
  });
});

describe('Phase 2 — BotMessageDeliveryService durable FYI, idempotency, and stopped chains', () => {
  const USER = 'usr_1';
  const GIDEON = { id: 'bot_gideon', name: 'Gideon' };
  const DIANA = { id: 'bot_diana', name: 'Diana' };

  function harness(opts?: {
    chainStatus?: 'ACTIVE' | 'STOPPED' | 'WRAPPING_UP' | 'CLOSED';
    maxTokens?: number;
    spentTokens?: number;
  }) {
    const storedByKey = new Map<string, { id: string; content: string; expectReply: boolean }>();
    const createdEvents: unknown[] = [];
    const notices: string[] = [];
    const startedTurns: unknown[] = [];
    const recordedResponses: Array<{ chainId: string; ownerBotId: string }> = [];

    const prisma = {
      bot: {
        findMany: vi.fn().mockResolvedValue([GIDEON, DIANA]),
      },
      task: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;

    const messages = {
      createInboundBotMessage: vi.fn(async (input: {
        content: string;
        expectReply?: boolean;
        deliveryKey?: string | null;
      }) => {
        if (input.deliveryKey && storedByKey.has(input.deliveryKey)) {
          const existing = storedByKey.get(input.deliveryKey)!;
          return { ...existing, attachments: [], deduplicated: true };
        }
        const row = {
          id: `msg_${storedByKey.size + 1}`,
          content: input.content,
          expectReply: input.expectReply ?? true,
        };
        if (input.deliveryKey) storedByKey.set(input.deliveryKey, row);
        return { ...row, attachments: [] };
      }),
    } as unknown as MessagesService;

    const turns = {
      startStored: vi.fn(async (...args: unknown[]) => {
        startedTurns.push(args);
      }),
    } as unknown as TanStackTurns;

    const events = {
      emitCreated: vi.fn((...args: unknown[]) => createdEvents.push(args)),
    } as unknown as TurnEventBus;

    const notice = {
      post: vi.fn(async (_botId: string, _chainId: string, text: string) => {
        notices.push(text);
      }),
    } as unknown as ChainNoticeService;

    const budget = {
      sendsBetween: vi.fn().mockResolvedValue(0),
      spentTokens: vi.fn().mockResolvedValue(opts?.spentTokens ?? 0),
    } as unknown as ChainBudgetService;

    const workflow = {
      canDeliver: vi.fn(async (_u: string, _c: string, _from: string, _to: string, wrapUpKind?: 'request') => {
        const status = opts?.chainStatus ?? 'ACTIVE';
        if (status === 'STOPPED' || status === 'CLOSED') {
          return { allowed: false as const, status, reason: `chain-${status.toLowerCase()}` };
        }
        if (status === 'WRAPPING_UP' && wrapUpKind !== 'request') {
          return { allowed: false as const, status: 'WRAPPING_UP' as const, reason: 'chain-wrapping-up' };
        }
        if (status === 'WRAPPING_UP') return { allowed: true as const, wrapUp: true as const };
        return { allowed: true as const };
      }),
      recordOwnerResponse: vi.fn(async (_u: string, chainId: string, ownerBotId: string) => {
        recordedResponses.push({ chainId, ownerBotId });
      }),
    } as unknown as WorkflowControlService;

    const service = new BotMessageDeliveryService(
      prisma,
      messages,
      turns,
      events,
      notice,
      budget,
      { maxHops: 0, maxTokens: opts?.maxTokens ?? 0, maxRepeatSends: 0 },
      noopLogger(),
      workflow,
    );

    return { service, createdEvents, notices, startedTurns, recordedResponses };
  }

  it('persists expectReply: false into recipient context without starting a turn', async () => {
    const { service, createdEvents, notices, startedTurns } = harness();
    const outcome = await service.deliver({
      userId: USER,
      fromBotId: GIDEON.id,
      toBotId: DIANA.id,
      toBotName: DIANA.name,
      content: 'FYI: Gate 1 moved to Tuesday.',
      chainId: 'chain_1',
      hopCount: 1,
      expectReply: false,
      deliveryKey: 'k_fyi_1',
    });

    expect(outcome).toEqual({ kind: 'delivered', messageId: 'msg_1' });
    expect(createdEvents).toHaveLength(1);
    expect(notices).toHaveLength(1);
    expect(startedTurns).toHaveLength(0);
  });

  it('makes BullMQ retries idempotent using deliveryKey without duplicate notices or turns', async () => {
    const { service, createdEvents, notices, startedTurns } = harness();
    const job: BotMessageJobData = {
      userId: USER,
      fromBotId: GIDEON.id,
      toBotId: DIANA.id,
      toBotName: DIANA.name,
      content: 'Audit pricing copy.',
      chainId: 'chain_1',
      hopCount: 1,
      deliveryKey: 'k_retry_1',
    };

    const first = await service.deliver(job);
    const retry = await service.deliver(job);

    expect(first).toEqual({ kind: 'delivered', messageId: 'msg_1' });
    expect(retry).toEqual({ kind: 'delivered', messageId: 'msg_1', deduplicated: true });
    expect(createdEvents).toHaveLength(1);
    expect(notices).toHaveLength(1);
    expect(startedTurns).toHaveLength(1);
  });

  it('delivers wrap-up closeout prompts even after the chain spent its token budget', async () => {
    const job: BotMessageJobData = {
      userId: USER,
      fromBotId: GIDEON.id,
      toBotId: DIANA.id,
      toBotName: DIANA.name,
      content: 'Wrap-up: report finished deliverables and blockers.',
      chainId: 'chain_spent',
      hopCount: 1,
      deliveryKey: 'wrapup:chain_spent:bot_diana',
      wrapUpKind: 'request',
    };
    const wrapping = harness({ chainStatus: 'WRAPPING_UP', maxTokens: 1_000, spentTokens: 5_000 });
    await expect(wrapping.service.deliver(job)).resolves.toEqual({
      kind: 'delivered',
      messageId: 'msg_1',
    });
    expect(wrapping.startedTurns).toHaveLength(1);

    // An ordinary hop on an exhausted chain is still dropped.
    const active = harness({ maxTokens: 1_000, spentTokens: 5_000 });
    const { wrapUpKind: _omit, ...ordinary } = job;
    await expect(
      active.service.deliver({ ...ordinary, deliveryKey: 'k_ordinary' }),
    ).resolves.toEqual({ kind: 'token-budget', spent: 5_000, budget: 1_000 });
    expect(active.startedTurns).toHaveLength(0);
  });

  it('drops queued deliveries and retries when the chain is STOPPED', async () => {
    const { service, createdEvents, notices, startedTurns } = harness({ chainStatus: 'STOPPED' });
    const outcome = await service.deliver({
      userId: USER,
      fromBotId: GIDEON.id,
      toBotId: DIANA.id,
      toBotName: DIANA.name,
      content: 'Keep going',
      chainId: 'chain_stopped',
      hopCount: 2,
      deliveryKey: 'k_stop_1',
    });

    expect(outcome).toEqual({ kind: 'chain-stopped' });
    expect(createdEvents).toHaveLength(0);
    expect(notices).toHaveLength(0);
    expect(startedTurns).toHaveLength(0);
  });
});

describe('Phase 2 — WorkflowControlService Stop workflow vs Wrap up lifecycles', () => {
  function makeWorkflowHarness(deadlineMs = 120) {
    process.env['WORKFLOW_WRAP_UP_DEADLINE_MS'] = String(deadlineMs);
    const states = new Map<
      string,
      {
        chainId: string;
        userId: string;
        rootBotId: string;
        groupId: string | null;
        status: 'ACTIVE' | 'WRAPPING_UP' | 'STOPPED' | 'CLOSED';
        expectedOwners: string[];
        respondedOwners: string[];
        closeoutPublished: boolean;
        deadlineAt: Date | null;
        stoppedAt: Date | null;
        closedAt: Date | null;
        createdAt: Date;
        updatedAt: Date;
      }
    >();
    const enqueued: BotMessageJobData[] = [];
    const cancelledRuns: Array<{ userId: string; botId: string; runId: string }> = [];
    const systemMessages: Array<{ botId: string; content: string }> = [];

    const bots = [
      { id: 'bot_gideon', name: 'Gideon', groupId: 'grp_mkt' },
      { id: 'bot_diana', name: 'Diana', groupId: 'grp_mkt' },
      { id: 'bot_julian', name: 'Julian', groupId: 'grp_mkt' },
      { id: 'bot_clara', name: 'Clara', groupId: null },
    ];
    const chainMessages = [
      { id: 'chain_a', chainId: null, fromBotId: null, conversation: { botId: 'bot_gideon' } },
      { id: 'msg_a1', chainId: 'chain_a', fromBotId: 'bot_gideon', conversation: { botId: 'bot_diana' } },
      { id: 'msg_a2', chainId: 'chain_a', fromBotId: 'bot_gideon', conversation: { botId: 'bot_julian' } },
      { id: 'chain_b', chainId: null, fromBotId: null, conversation: { botId: 'bot_clara' } },
    ];
    const liveRuns = [
      { id: 'run_diana', botId: 'bot_diana', triggerMessageId: 'msg_a1', status: 'running' },
      { id: 'run_julian', botId: 'bot_julian', triggerMessageId: 'msg_a2', status: 'running' },
      { id: 'run_clara', botId: 'bot_clara', triggerMessageId: 'chain_b', status: 'running' },
    ];

    const prisma = {
      bot: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          bots.find((b) => b.id === where.id) ?? null,
        ),
        findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] }; groupId?: string } }) => {
          if (where.id?.in) return bots.filter((b) => where.id!.in.includes(b.id));
          if (where.groupId) return bots.filter((b) => b.groupId === where.groupId);
          return bots;
        }),
      },
      message: {
        findMany: vi.fn(async ({ where }: { where: { OR?: Array<{ id?: string; chainId?: string }>; fromBotId?: { in: string[] } } }) => {
          if (where.OR) {
            const target = where.OR[0]?.id ?? where.OR[1]?.chainId;
            return chainMessages.filter((m) => m.id === target || m.chainId === target);
          }
          if (where.fromBotId?.in) {
            return where.fromBotId.in.map((id) => ({
              fromBotId: id,
              content: `Finished deliverables from ${id}.`,
            }));
          }
          return [];
        }),
        findFirst: vi.fn(
          async ({
            where,
          }: {
            where: {
              OR?: Array<{
                id?: string;
                chainId?: string;
                conversation?: { botId: { in: string[] } };
                fromBotId?: { in: string[] };
              }>;
            };
          }) => {
            // Only the chain-scope check queries with OR; the other lookups find nothing.
            if (where.OR === undefined) return null;
            const hit = chainMessages.find((m) =>
              where.OR!.some(
                (clause) =>
                  (clause.id === undefined || clause.id === m.id) &&
                  (clause.chainId === undefined || clause.chainId === m.chainId) &&
                  (clause.conversation === undefined ||
                    clause.conversation.botId.in.includes(m.conversation.botId)) &&
                  (clause.fromBotId === undefined ||
                    (m.fromBotId !== null && clause.fromBotId.in.includes(m.fromBotId))),
              ),
            );
            return hit === undefined ? null : { id: hit.id };
          },
        ),
      },
      agentTurn: {
        findMany: vi.fn(async ({ where }: { where: { triggerMessageId?: { in: string[] } } }) => {
          if (where.triggerMessageId?.in) {
            return liveRuns.filter((r) => where.triggerMessageId!.in.includes(r.triggerMessageId));
          }
          return [];
        }),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      workflowChainState: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> & { chainId: string } }) => {
          if (states.has(data.chainId)) {
            throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
              code: 'P2002',
              clientVersion: 'test',
            });
          }
          const now = new Date();
          const next = {
            groupId: null,
            status: 'ACTIVE',
            expectedOwners: [],
            respondedOwners: [],
            closeoutPublished: false,
            deadlineAt: null,
            stoppedAt: null,
            closedAt: null,
            createdAt: now,
            updatedAt: now,
            ...data,
          };
          states.set(data.chainId, next as typeof states extends Map<string, infer V> ? V : never);
          return next;
        }),
        findFirst: vi.fn(async ({ where }: { where: { chainId: string; userId?: string; status?: string } }) => {
          const row = states.get(where.chainId) ?? null;
          if (row === null) return null;
          if (where.userId !== undefined && row.userId !== where.userId) return null;
          if (where.status !== undefined && row.status !== where.status) return null;
          return row;
        }),
        findMany: vi.fn(async () => [...states.values()]),
        updateMany: vi.fn(async ({ where, data }: { where: { chainId: string; userId?: string; closeoutPublished?: boolean; status?: string | { in: string[] } }; data: Record<string, unknown> }) => {
          const row = states.get(where.chainId);
          if (!row) return { count: 0 };
          if (where.userId !== undefined && row.userId !== where.userId) return { count: 0 };
          if (where.closeoutPublished !== undefined && row.closeoutPublished !== where.closeoutPublished) {
            return { count: 0 };
          }
          if (typeof where.status === 'string' && row.status !== where.status) return { count: 0 };
          if (typeof where.status === 'object' && where.status !== null && !where.status.in.includes(row.status)) {
            return { count: 0 };
          }
          Object.assign(row, data, { updatedAt: new Date() });
          return { count: 1 };
        }),
      },
    } as unknown as PrismaService;

    const messages = {
      createSystemMessage: vi.fn(async (input: { botId: string; content: string }) => {
        systemMessages.push(input);
        return { id: `sys_${systemMessages.length}`, botId: input.botId, content: input.content };
      }),
    } as unknown as MessagesService;

    const turns = {
      cancelRun: vi.fn((userId: string, botId: string, runId: string) => {
        cancelledRuns.push({ userId, botId, runId });
        return true;
      }),
    } as unknown as TanStackTurns;

    const events = { emitCreated: vi.fn() } as unknown as TurnEventBus;

    const service = new WorkflowControlService(
      prisma,
      messages,
      turns,
      events,
      { enqueue: async (job) => void enqueued.push(job) },
      noopLogger(),
    );

    return { service, states, enqueued, cancelledRuns, systemMessages };
  }

  it('Stop workflow cancels ONLY runs in the target chain and leaves unrelated chains running', async () => {
    const { service, states, cancelledRuns, systemMessages } = makeWorkflowHarness();
    const res = await service.stopWorkflow('usr_1', 'bot_gideon', 'chain_a');

    expect(res.status).toBe('STOPPED');
    expect(res.cancelledRuns).toBe(2);
    expect(cancelledRuns.map((r) => r.runId).sort()).toEqual(['run_diana', 'run_julian']);
    // Unrelated chain_b (Clara) was NOT touched.
    expect(cancelledRuns.some((r) => r.botId === 'bot_clara')).toBe(false);
    expect(states.get('chain_a')?.status).toBe('STOPPED');
    expect(systemMessages.at(-1)?.content).toContain('Workflow stopped');

    // Delivery gate blocks retries for chain_a while allowing chain_b.
    expect(
      (await service.canDeliver('usr_1', 'chain_a', 'bot_gideon', 'bot_diana')).allowed,
    ).toBe(false);
    expect(
      (await service.canDeliver('usr_1', 'chain_b', 'bot_clara', 'bot_gideon')).allowed,
    ).toBe(true);
    service.onModuleDestroy();
  });

  it('refuses a chain id outside the bot scope or held by another account, writing nothing', async () => {
    const { service, states, cancelledRuns } = makeWorkflowHarness();
    // chain_b belongs to Clara, who is not in Gideon's group.
    await expect(service.stopWorkflow('usr_1', 'bot_gideon', 'chain_b')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.wrapUpWorkflow('usr_1', 'bot_gideon', 'chain_b')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.stopWorkflow('usr_1', 'bot_gideon', 'chain_does_not_exist'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(states.size).toBe(0);
    expect(cancelledRuns).toHaveLength(0);

    // A row another account already wrote for this id is never taken over.
    const now = new Date();
    states.set('chain_a', {
      chainId: 'chain_a',
      userId: 'usr_2',
      rootBotId: 'bot_x',
      groupId: null,
      status: 'STOPPED',
      expectedOwners: [],
      respondedOwners: [],
      closeoutPublished: true,
      deadlineAt: null,
      stoppedAt: now,
      closedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await expect(service.stopWorkflow('usr_1', 'bot_gideon', 'chain_a')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(states.get('chain_a')?.userId).toBe('usr_2');
    service.onModuleDestroy();
  });

  it('refuses to wrap up a chain that is stopped or already wrapping up, without prompting anyone', async () => {
    const { service, enqueued, systemMessages, states } = makeWorkflowHarness(10_000);
    await service.stopWorkflow('usr_1', 'bot_gideon', 'chain_a');
    const afterStop = systemMessages.length;

    await expect(service.wrapUpWorkflow('usr_1', 'bot_gideon', 'chain_a')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(states.get('chain_a')?.status).toBe('STOPPED');
    expect(enqueued).toHaveLength(0);
    expect(systemMessages).toHaveLength(afterStop);
    service.onModuleDestroy();

    const second = makeWorkflowHarness(10_000);
    await second.service.wrapUpWorkflow('usr_1', 'bot_gideon', 'chain_a');
    await second.service.recordOwnerResponse('usr_1', 'chain_a', 'bot_diana');
    await expect(
      second.service.wrapUpWorkflow('usr_1', 'bot_gideon', 'chain_a'),
    ).rejects.toBeInstanceOf(ConflictException);
    // The first round's progress is kept and no second round of prompts went out.
    expect(second.states.get('chain_a')?.respondedOwners).toEqual(['bot_diana']);
    expect(second.enqueued).toHaveLength(2);
    second.service.onModuleDestroy();
  });

  it('Wrap up acknowledges immediately, prompts each owner once, and publishes closeout on deadline naming missing owners', async () => {
    const { service, enqueued, systemMessages, states } = makeWorkflowHarness(120);
    const res = await service.wrapUpWorkflow('usr_1', 'bot_gideon', 'chain_a');

    expect(res.status).toBe('WRAPPING_UP');
    expect(res.expectedOwners).toEqual(['bot_diana', 'bot_julian']);
    // Immediate acknowledgment posted.
    expect(systemMessages[0]?.content).toContain('Wrapping up this workflow now');
    // Exactly one bounded prompt per owner with deterministic deliveryKey.
    expect(enqueued).toHaveLength(2);
    expect(enqueued.map((j) => j.deliveryKey)).toEqual([
      'wrapup:chain_a:bot_diana',
      'wrapup:chain_a:bot_julian',
    ]);

    // While wrapping up: new delegations to peers are blocked, but owner replies to Gideon are allowed.
    expect((await service.canSend('usr_1', 'chain_a', 'bot_diana', 'bot_julian')).allowed).toBe(
      false,
    );
    expect((await service.canSend('usr_1', 'chain_a', 'bot_diana', 'bot_gideon')).allowed).toBe(
      true,
    );

    // Diana responds, Julian misses the deadline.
    await service.recordOwnerResponse('usr_1', 'chain_a', 'bot_diana');
    expect(states.get('chain_a')?.status).toBe('WRAPPING_UP');

    // Wait past the 120ms test deadline.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(states.get('chain_a')?.status).toBe('CLOSED');
    expect(states.get('chain_a')?.closeoutPublished).toBe(true);
    const closeout = systemMessages.at(-1)?.content ?? '';
    expect(closeout).toContain('Missing responses from: Julian');
    expect(closeout).toContain('Diana:');
    expect(closeout).toContain('Julian: No response before deadline');
    service.onModuleDestroy();
  });
});

describe('Phase 2 — BoardStoreService owner protection, initial snapshot, and shell-overwrite recovery', () => {
  function makeBoardHarness(initialDisk: string | null) {
    let disk = initialDisk;
    let diskReachable = true;
    const entries: Array<{
      id: string;
      userId: string;
      scopeKey: string;
      ownerBotId: string | null;
      ownerName: string;
      content: string;
      version: number;
      deleted: boolean;
      createdAt: Date;
    }> = [];
    const revisions: Array<{
      id: string;
      userId: string;
      scopeKey: string;
      entryId: string | null;
      ownerBotId: string | null;
      kind: string;
      snapshot: string;
    }> = [];

    const dbOps = {
      boardEntry: {
        findMany: vi.fn(async ({ where }: { where: { userId: string; scopeKey: string; deleted?: boolean } }) =>
          entries.filter(
            (e) =>
              e.userId === where.userId &&
              e.scopeKey === where.scopeKey &&
              (where.deleted === undefined || e.deleted === where.deleted),
          ),
        ),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = {
            id: `be_${entries.length + 1}`,
            userId: String(data['userId']),
            scopeKey: String(data['scopeKey']),
            ownerBotId: (data['ownerBotId'] as string | null) ?? null,
            ownerName: String(data['ownerName']),
            content: String(data['content']),
            version: Number(data['version'] ?? 1),
            deleted: false,
            createdAt: new Date(),
          };
          entries.push(row);
          return row;
        }),
        updateMany: vi.fn(async ({ where, data }: { where: { id: string }; data: { content?: string; deleted?: boolean } }) => {
          const row = entries.find((e) => e.id === where.id);
          if (!row) return { count: 0 };
          if (data.content !== undefined) row.content = data.content;
          if (data.deleted !== undefined) row.deleted = data.deleted;
          row.version += 1;
          return { count: 1 };
        }),
      },
      boardRevision: {
        findFirst: vi.fn(async ({ where }: { where: { userId: string; scopeKey: string; id?: string } }) =>
          revisions.find(
            (r) =>
              r.userId === where.userId &&
              r.scopeKey === where.scopeKey &&
              (where.id === undefined || r.id === where.id),
          ) ?? null,
        ),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = {
            id: `rev_${revisions.length + 1}`,
            userId: String(data['userId']),
            scopeKey: String(data['scopeKey']),
            entryId: (data['entryId'] as string | null) ?? null,
            ownerBotId: (data['ownerBotId'] as string | null) ?? null,
            kind: String(data['kind']),
            snapshot: String(data['snapshot']),
          };
          revisions.push(row);
          return row;
        }),
      },
      bot: {
        findFirst: vi.fn().mockResolvedValue({ name: 'FallbackBot' }),
      },
    };
    const prisma = {
      ...dbOps,
      $transaction: vi.fn(async <T>(fn: (tx: typeof dbOps) => Promise<T>) => fn(dbOps)),
    } as unknown as PrismaService;

    const store = new BoardStoreService(prisma);
    const tools = boardTools(store);

    const ctxFor = (botId: string, botName: string) =>
      ({
        userId: 'usr_1',
        botId,
        botName,
        sandboxId: 'sb_1',
        attachmentHost: () => Promise.resolve('msg_1'),
        session: async () => ({
          readTextFile: async ({ path }: { path: string }) => {
            if (path !== MANAGED_BOARD_PATH) throw new Error(path);
            if (!diskReachable) throw new Error('computer unreachable');
            return disk;
          },
          writeTextFile: async ({ path, content }: { path: string; content: string }) => {
            if (path !== MANAGED_BOARD_PATH) throw new Error(path);
            disk = content;
          },
        }),
      }) as unknown as ToolContext;

    const runTool = (name: string, ctx: ToolContext, input: unknown): Promise<string> => {
      const def = tools.find((t) => t.name === name)!;
      const built = def.build(ctx) as Tool & { execute: (args: unknown, opts: unknown) => Promise<string> };
      return built.execute(input, {});
    };

    return {
      store,
      entries,
      revisions,
      ctxFor,
      runTool,
      getDisk: () => disk,
      overwriteDiskViaShell: (text: string) => {
        disk = text;
      },
      setDiskReachable: (reachable: boolean) => {
        diskReachable = reachable;
      },
    };
  }

  it('saves outside edits to history before any projection overwrites them', async () => {
    const h = makeBoardHarness(null);
    const diana = h.ctxFor('bot_diana', 'Diana');
    await h.runTool('board_add', diana, { entry: '- [ ] Draft pricing page' });

    // A shell append keeps the marker but changes the text.
    const appended = `${h.getDisk()}- [ ] Ship v2 (added from the shell)\n`;
    h.overwriteDiskViaShell(appended);
    const read = await h.runTool('board_read', diana, {});
    expect(read).toContain('edits made outside the board tools');
    expect(h.revisions.filter((r) => r.kind === 'EXTERNAL_EDIT').map((r) => r.snapshot)).toEqual([
      appended,
    ]);

    // A write after another outside edit saves that edit too.
    h.overwriteDiskViaShell('Hand-written notes\n');
    await h.runTool('board_add', diana, { entry: '- [ ] Review hero copy' });
    expect(h.revisions.filter((r) => r.kind === 'EXTERNAL_EDIT').at(-1)?.snapshot).toBe(
      'Hand-written notes\n',
    );
    expect(h.getDisk()).toContain('Review hero copy');

    // An unchanged projection records nothing new.
    const before = h.revisions.length;
    await h.runTool('board_read', diana, {});
    expect(h.revisions).toHaveLength(before);
  });

  it('does not skip adopting a legacy board when the first read of it fails', async () => {
    const h = makeBoardHarness('- [ ] Legacy baseline task\n');
    const diana = h.ctxFor('bot_diana', 'Diana');

    h.setDiskReachable(false);
    const failed = await h.runTool('board_add', diana, { entry: '- [ ] New entry' });
    expect(failed).toContain('failed');
    expect(h.entries).toHaveLength(0);
    expect(h.revisions).toHaveLength(0);

    h.setDiskReachable(true);
    await h.runTool('board_add', diana, { entry: '- [ ] New entry' });
    expect(h.revisions[0]?.kind).toBe('INIT_SNAPSHOT');
    expect(h.getDisk()).toContain('Legacy baseline task');
    expect(h.getDisk()).toContain('New entry');
  });

  it('captures pre-existing BOARD.md as INIT_SNAPSHOT, blocks cross-bot overwrites, and recovers after shell wipe', async () => {
    const h = makeBoardHarness('- [ ] Legacy baseline task\n');
    const diana = h.ctxFor('bot_diana', 'Diana');
    const julian = h.ctxFor('bot_julian', 'Julian');

    // Concurrent adds from Diana and Julian adopt legacy board first and preserve both owners.
    await Promise.all([
      h.runTool('board_add', diana, { entry: '- [ ] Competitor claims done' }),
      h.runTool('board_add', julian, { entry: '- [ ] Pricing copy verified' }),
    ]);

    expect(h.revisions.some((r) => r.kind === 'INIT_SNAPSHOT')).toBe(true);
    expect(h.getDisk()).toContain('Legacy baseline task');
    expect(h.getDisk()).toContain('Competitor claims done');
    expect(h.getDisk()).toContain('Pricing copy verified');

    // Diana CANNOT overwrite or wipe Julian's entry.
    const refused = await h.runTool('board_update', diana, {
      find: 'Pricing copy verified',
      replace: '',
    });
    expect(refused).toContain('refused');
    expect(refused).toContain('Julian');

    // Diana CAN update her own entry.
    const updated = await h.runTool('board_update', diana, {
      find: '- [ ] Competitor claims done',
      replace: '- [x] Competitor claims done',
    });
    expect(updated).toContain('Updated');

    // Simulate a destructive shell overwrite wiping BOARD.md.
    h.overwriteDiskViaShell('WIPED BY ACCIDENT\n');
    expect(h.getDisk()).toBe('WIPED BY ACCIDENT\n');

    // Reading the board detects the corruption and restores every durable entry.
    const recovered = await h.runTool('board_read', julian, {});
    expect(recovered).toContain('restored from durable board history');
    expect(recovered).toContain('Competitor claims done');
    expect(recovered).toContain('Pricing copy verified');
    expect(h.getDisk()).toContain('Pricing copy verified');
    expect(h.revisions.some((r) => r.kind === 'RESTORE')).toBe(true);
  });
});
