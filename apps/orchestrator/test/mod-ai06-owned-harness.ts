/**
 * One owned producer assembled the way a worker process would: a fresh policy
 * runtime and backend over nothing but a lease and database rows. Shared by
 * the in-process acceptance suite and the crash child it SIGKILLs.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Json } from '@crewaid/shared';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import {
  TanStackExecutionBackend,
  type TanStackExecutionPersistence,
} from '../src/agent/execution/tanstack-execution-backend.js';
import type {
  ExecutionPorts,
  ExecutionRequest,
  ExecutionResume,
} from '../src/agent/execution/execution-backend.port.js';
import { executeOwned } from '../src/agent/persistence/owned-tanstack-persistence.js';
import { RunLeaseService, type RunLease } from '../src/agent/persistence/run-lease.js';
import { RunEventWakeups } from '../src/agent/persistence/run-event-log.js';
import { toTranscriptRow } from '../src/agent/persistence/transcript.js';
import { createPolicyProposalStore } from '../src/agent/policy/proposal-store.js';
import { createDispatchLedger } from '../src/agent/policy/dispatch-ledger.js';
import { createPolicyRuntime, type PolicyState } from '../src/agent/policy/runtime.js';
import { policyHash } from '../src/agent/policy/policy.js';
import { SENSITIVE_BUILTIN } from '../src/agent/tool-registry.js';
import { tool } from '../src/agent/tool-contract.js';
import { ScriptedAdapter } from './mod-02-tanstack-harness.js';

export type OwnedThread = {
  readonly userId: string;
  readonly botId: string;
  readonly threadId: string;
  readonly triggerMessageId: string;
};
export type OwnedResume = {
  readonly parentRunId: string;
  readonly batch: readonly ExecutionResume[];
};

const ASK: PolicyState = {
  snapshot: {
    mode: 'ASK',
    rules: [],
    grantRevision: policyHash(['grant']),
    grantValid: true,
    seat: null,
    resourceRevision: null,
  },
};

/** A TANSTACK thread whose user message makes the scripted model call the gated tool. */
export async function ownedThread(
  prisma: PrismaService,
  userId: string,
): Promise<OwnedThread & { readonly first: RunLease }> {
  const bot = await prisma.bot.create({
    data: {
      userId,
      name: `resume-${randomUUID()}`,
      role: 'fixture',
      avatarColor: '#8B6F47',
      systemPrompt: '',
    },
  });
  const conversation = await prisma.conversation.create({
    data: { botId: bot.id },
  });
  const triggerMessageId = await userMessage(prisma, bot.id, conversation.id, 'gated please');
  const claim = await new RunLeaseService(prisma).claim({
    userId,
    botId: bot.id,
    threadId: conversation.id,
    runId: randomUUID(),
    triggerMessageId,
  });
  if (claim.kind !== 'claimed') throw new Error('fixture');
  return { userId, botId: bot.id, threadId: conversation.id, triggerMessageId, first: claim.lease };
}

export async function userMessage(
  prisma: PrismaService,
  botId: string,
  threadId: string,
  content: string,
): Promise<string> {
  const id = randomUUID();
  const body = toTranscriptRow({ id, role: 'user', content }, { threadBotId: botId, runId: null });
  if (!body.ok) throw new Error('fixture');
  await prisma.message.create({ data: { conversationId: threadId, ...body.value } });
  return id;
}

export function produceOwned(
  prisma: PrismaService,
  t: OwnedThread,
  lease: RunLease,
  action: (args: Json) => Promise<unknown>,
  resume?: OwnedResume,
  options: {
    readonly leases?: RunLeaseService;
    readonly maxSteps?: number;
    readonly wakeups?: RunEventWakeups;
    /** `FULL` lets the policy allow the call by itself, with no approval. */
    readonly mode?: 'ASK' | 'FULL';
    /** Attach the run's D-197 dispatch ledger, fenced by the lease. */
    readonly ledger?: boolean;
    readonly ports?: Partial<ExecutionPorts>;
    readonly adapter?: ScriptedAdapter;
  } = {},
) {
  const state: PolicyState =
    options.mode === 'FULL' ? { snapshot: { ...ASK.snapshot, mode: 'FULL' } } : ASK;
  const policy = createPolicyRuntime({
    project: (name, args) => ({ name, args, behavior: SENSITIVE_BUILTIN }),
    read: async () => state,
    ...(options.ledger === true && {
      dispatches: createDispatchLedger(
        prisma,
        { userId: t.userId, conversationId: t.threadId, runId: lease.runId },
        lease,
      ),
    }),
    store: createPolicyProposalStore(prisma, {
      userId: t.userId,
      botId: t.botId,
      conversationId: t.threadId,
      runId: lease.runId,
    }),
  });
  const backend = (persistence: TanStackExecutionPersistence) =>
    new TanStackExecutionBackend({
      logger: { warn: () => undefined },
      loadAttachments: async () => new Map(),
      resolveModel: async () => ({
        adapter: options.adapter ?? new ScriptedAdapter(),
        modelId: 'fixture',
        kind: 'custom',
        connectionId: 'fixture',
        connectionName: 'Fixture',
        upstreamModelId: 'fixture',
        label: 'Fixture',
        contextWindow: 10000,
        capabilities: { tools: true, vision: false, reasoning: false },
      }),
      openPersistence: async () => persistence,
    });
  const request: ExecutionRequest = {
    runId: lease.runId,
    threadId: t.threadId,
    botId: t.botId,
    triggerMessageId: t.triggerMessageId,
    model: { userId: t.userId, modelRef: 'fixture' },
    instructions: { identity: { name: 'Fixture', role: 'Test' } },
    tools: {
      send_email: tool({
        description: 'Send an email.',
        inputSchema: z.object({ to: z.string() }),
        execute: (input, options) =>
          policy.execute('send_email', input, options.toolCallId, action),
      }),
    },
    policy,
    ...(resume === undefined ? {} : { resume: resume.batch, parentRunId: resume.parentRunId }),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
  };
  const ports: ExecutionPorts = {
    appendEvent: async () => undefined,
    checkpoint: async () => undefined,
    releaseForApproval: async () => undefined,
    persistUsage: async () => undefined,
    status: () => undefined,
    ...options.ports,
  };
  return executeOwned({
    prisma,
    leases: options.leases ?? new RunLeaseService(prisma),
    wakeups: options.wakeups ?? new RunEventWakeups(),
    lease,
    backend,
    request,
    ports,
  });
}
