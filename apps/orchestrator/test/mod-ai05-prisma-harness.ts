/** Real PostgreSQL transcript/reservation; controlled model and fixture run/interrupt stores. */
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { composePersistence } from '@tanstack/ai-persistence';
import { z } from 'zod';
import type { Json } from '@crewaid/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createPrismaMessageStore } from '../src/agent/persistence/prisma-message-store.js';
import { toTranscriptRow } from '../src/agent/persistence/transcript.js';
import { TanStackExecutionBackend } from '../src/agent/execution/tanstack-execution-backend.js';
import type {
  ExecutionPorts,
  ExecutionCheckpoint,
  ExecutionRequest,
} from '../src/agent/execution/execution-backend.port.js';
import { tool } from '../src/agent/tool-contract.js';
import { OBSERVING_BUILTIN, SENSITIVE_BUILTIN } from '../src/agent/tool-registry.js';
import type { SignedInUser } from './auth-fixture.js';
import { toolFixture, ToolScriptAdapter } from './mod-ai02-harness.js';

import type { TanStackExecutionDeps } from '../src/agent/execution/tanstack-execution-backend.js';

const emptyUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  reportedCalls: 0,
  unreportedCalls: 0,
};
export async function prismaExecutionFixture(
  prisma: PrismaService,
  owner: SignedInUser,
  options: {
    write?: boolean;
    dynamicCalls?: boolean;
    resolveModel?: TanStackExecutionDeps['resolveModel'];
    smallResult?: boolean;
  } = {},
) {
  const write = options.write ?? false;
  const bot = await prisma.bot.create({
    data: {
      userId: owner.userId,
      name: 'Quill',
      role: 'fixture',
      avatarColor: '#8B6F47',
      systemPrompt: '',
    },
  });
  const thread = await prisma.conversation.create({
    data: { botId: bot.id },
  });
  const triggerId = `u_${randomUUID()}`;
  const row = toTranscriptRow(
    { id: triggerId, role: 'user', content: 'Call fixture_action once and then answer.' },
    { threadBotId: bot.id, runId: null },
  );
  if (!row.ok) throw new Error('fixture');
  await prisma.message.create({ data: { conversationId: thread.id, ...row.value } });
  const run = await prisma.agentTurn.create({
    data: { botId: bot.id, conversationId: thread.id, triggerMessageId: triggerId },
  });
  const effects = vi.fn((args: unknown) => ({
    args,
    full: options.smallResult ? 'Action complete.' : 'x'.repeat(180000),
  }));
  const f = toolFixture(
    [
      {
        name: 'fixture_action',
        behavior: write ? SENSITIVE_BUILTIN : OBSERVING_BUILTIN,
        build: () =>
          tool({
            inputSchema: z.object({ value: z.string().default('default') }),
            execute: effects,
          }),
      },
    ],
    [{ id: 'call-1', name: 'fixture_action', args: {} }],
    {
      botId: bot.id,
      threadId: thread.id,
      initialRunId: run.id,
      mode: write ? 'AUTO' : 'FULL',
      ...(options.dynamicCalls ? { dynamicCalls: true } : {}),
    },
  );
  const adapter = new ToolScriptAdapter(
    [{ id: 'call-1', name: 'fixture_action', args: {} }],
    f.resolved.toolSet,
    false,
  );
  const events: Json[] = [];
  const checkpoints: ExecutionCheckpoint[] = [];
  const ports: ExecutionPorts = {
    appendEvent: async (event) => {
      events.push(event);
    },
    checkpoint: async (step) => {
      checkpoints.push(step);
    },
    persistUsage: async () => undefined,
    status: async () => undefined,
    releaseForApproval: async () => undefined,
  };
  const request: ExecutionRequest = {
    model: { userId: owner.userId, modelRef: 'fixture' },
    botId: bot.id,
    threadId: thread.id,
    runId: run.id,
    triggerMessageId: triggerId,
    instructions: { identity: { name: bot.name, role: bot.role } },
    tools: f.resolved.toolSet,
    policy: f.policy,
  };
  const budget = { steps: 0, workingMs: 0, usage: { ...emptyUsage } };
  const backend = new TanStackExecutionBackend({
    logger: { warn: vi.fn() },
    resolveModel:
      options.resolveModel ??
      (async () => ({
        adapter,
        kind: 'custom',
        modelId: 'fixture',
        connectionId: 'fixture',
        connectionName: 'Fixture',
        upstreamModelId: 'fixture',
        label: 'Fixture',
        contextWindow: 200000,
        capabilities: { tools: true, vision: true, reasoning: false },
      })),
    openPersistence: async (input) => {
      // This harness deliberately retains unleased fixture run/interrupt stores.
      await f.persistence.stores.runs.createOrResume({
        runId: input.runId,
        threadId: input.threadId,
        startedAt: Date.now(),
      });
      const messages = createPrismaMessageStore(prisma, {
        userId: input.model.userId,
        runId: input.runId,
      });
      return {
        persistence: composePersistence(f.persistence, { overrides: { messages } }),
        reserve: messages.reserve,
        withdraw: messages.withdraw,
        boundary: async (_next, operation) => operation(),
        assertLive: async () => {
          const owned = await prisma.agentTurn.findFirst({
            where: {
              id: input.runId,
              botId: input.botId,
              conversationId: input.threadId,
              triggerMessageId: input.triggerMessageId,
              status: 'running',
              bot: { userId: input.model.userId },
            },
          });
          if (owned === null) throw new Error('RUN_NOT_OWNED');
        },
        progress: async () => undefined,
        authorizeResume: f.authorizeResume,
        budget,
      };
    },
    loadAttachments: async () => new Map(),
  });
  return {
    bot,
    thread,
    run,
    effects,
    f,
    adapter,
    events,
    checkpoints,
    ports,
    request,
    backend,
    budget,
  };
}
