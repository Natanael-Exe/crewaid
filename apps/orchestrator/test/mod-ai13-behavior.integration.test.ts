/**
 * @skip-reason: on-demand real-token acceptance; requires
 * MODAI13_REAL_MODEL, EVAL_API_KEY_<KIND> and DATABASE_URL. EVAL_JUDGE scores
 * the rubric checks; without it they report NOT SCORED.
 *
 * D-162's behaviour line for MOD-AI-13: every CC-18 case that passes on the AI
 * SDK the same day passes on TanStack. Both subjects run here, one after the
 * other, on the same model and the same judge, so "the same day" is one run.
 *
 * The AI SDK subject is the CC-18 in-process runner unchanged. The TanStack
 * subject is the run a worker makes: a TANSTACK thread in Postgres, a claimed
 * lease, `executeOwned` over the real backend, the owner's encrypted BYOK
 * connection resolved by `ModelResolutionService`, and the case's tools behind
 * the policy runtime. Each user line is its own run on the same thread, so the
 * backend loads the earlier turns from the transcript rather than from the
 * harness. What a turn replied is read back from the BOT rows it stored, not
 * from the stream, because the stored reply is the one the operator keeps.
 *
 *   MODAI13_REAL_MODEL=openrouter:z-ai/glm-5.3-flash EVAL_JUDGE=openrouter:z-ai/glm-5.3 \
 *   MODAI13_OUT=/tmp/crewaid-behavior-eval \
 *   pnpm --filter @crewaid/orchestrator exec vitest run test/mod-ai13-behavior.integration.test.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ProviderKindSchema, type Json } from '@crewaid/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { CredentialService } from '../src/credentials/credential.service.js';
import { ModelResolutionService } from '../src/models/model-resolution.service.js';
import { buildLanguageModel } from '../src/models/provider-factory.js';
import { toDbKind } from '../src/providers/provider-connections.service.js';
import { TanStackExecutionBackend } from '../src/agent/execution/tanstack-execution-backend.js';
import { executeOwned } from '../src/agent/persistence/owned-tanstack-persistence.js';
import { RunLeaseService } from '../src/agent/persistence/run-lease.js';
import { RunEventWakeups } from '../src/agent/persistence/run-event-log.js';
import { createPolicyProposalStore } from '../src/agent/policy/proposal-store.js';
import { createPolicyRuntime, type PolicyState } from '../src/agent/policy/runtime.js';
import { policyHash } from '../src/agent/policy/policy.js';
import { OBSERVING_BUILTIN } from '../src/agent/tool-registry.js';
import { tool, type ToolSet } from '../src/agent/tool-contract.js';
import { CASES } from './behavior-eval/cases.js';
import {
  modelJudge,
  renderReport,
  runSuite,
  runnerSubject,
  type EvalCase,
  type EvalSubject,
  type EvalToolCall,
  type TranscriptTurn,
} from './behavior-eval/harness.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import { userMessage } from './mod-ai06-owned-harness.js';

const MODEL = process.env['MODAI13_REAL_MODEL'] ?? '';
const JUDGE = process.env['EVAL_JUDGE'] ?? '';
const OUT = process.env['MODAI13_OUT'];
const DATABASE_URL = process.env['DATABASE_URL'];

function keyFor(modelKey: string) {
  const separator = modelKey.indexOf(':');
  const kind = ProviderKindSchema.parse(modelKey.slice(0, separator));
  if (kind === 'custom' || kind === 'crewaid') throw new Error(`${kind} is not a direct provider`);
  const apiKey = process.env[`EVAL_API_KEY_${kind.toUpperCase()}`];
  if (!apiKey) throw new Error(`EVAL_API_KEY_${kind.toUpperCase()} is required for ${modelKey}`);
  return { kind, apiKey, upstreamModelId: modelKey.slice(separator + 1) };
}

function languageModel(modelKey: string) {
  const { kind, apiKey, upstreamModelId } = keyFor(modelKey);
  return buildLanguageModel({ kind, apiKey, endpoint: null, upstreamModelId });
}

const FULL: PolicyState = {
  snapshot: {
    mode: 'FULL',
    rules: [],
    grantRevision: policyHash(['grant']),
    grantValid: true,
    seat: null,
    resourceRevision: null,
  },
};

/** The calls a run's events say the model made, with the arguments it streamed. */
function callsIn(events: readonly Json[]): EvalToolCall[] {
  const calls = new Map<string, { tool: string; args: string }>();
  for (const event of events) {
    const parsed = z
      .object({
        type: z.string(),
        toolCallId: z.string().optional(),
        toolCallName: z.string().optional(),
        delta: z.string().optional(),
      })
      .safeParse(event);
    if (!parsed.success || parsed.data.toolCallId === undefined) continue;
    const { type, toolCallId, toolCallName, delta } = parsed.data;
    if (type === 'TOOL_CALL_START') calls.set(toolCallId, { tool: toolCallName ?? '?', args: '' });
    if (type === 'TOOL_CALL_ARGS') {
      const call = calls.get(toolCallId);
      if (call !== undefined) call.args += delta ?? '';
    }
  }
  return [...calls.values()].map((call) => {
    let args: Record<string, unknown> = {};
    try {
      const value: unknown = JSON.parse(call.args === '' ? '{}' : call.args);
      if (typeof value === 'object' && value !== null) args = value as Record<string, unknown>;
    } catch {
      args = { unparsed: call.args };
    }
    return { tool: call.tool, args };
  });
}

describe.skipIf(!MODEL || !DATABASE_URL)('MOD-AI-13 CC-18 on both stacks, same model', () => {
  const prisma = new PrismaService();
  let owner: SignedInUser;
  let models: ModelResolutionService;
  let modelId = '';
  const leases = new RunLeaseService(prisma);
  const wakeups = new RunEventWakeups();

  beforeAll(async () => {
    vi.stubEnv('CREWAID_CREDENTIAL_KEYRING', JSON.stringify({ 1: '8'.repeat(64) }));
    vi.stubEnv('CREWAID_CREDENTIAL_KEY_ACTIVE', '1');
    await prisma.$connect();
    owner = await signIn(prisma, { label: 'modai13eval' });
    const { kind, apiKey, upstreamModelId } = keyFor(MODEL);
    const connection = await prisma.providerConnection.create({
      data: { userId: owner.userId, kind: toDbKind(kind), name: 'MOD-AI-13 controlled BYOK' },
    });
    const credentials = new CredentialService(prisma);
    await credentials.setCredential(owner.userId, connection.id, apiKey);
    const model = await prisma.providerModel.create({
      data: {
        connectionId: connection.id,
        upstreamModelId,
        label: 'MOD-AI-13 real model',
        contextWindow: 200000,
        supportsTools: true,
      },
      select: { id: true },
    });
    modelId = model.id;
    models = new ModelResolutionService(prisma, credentials);
  });

  afterAll(async () => {
    if (owner) await signOutAndDelete(prisma, owner.userId);
    await prisma.$disconnect();
    vi.unstubAllEnvs();
  });

  /** One user line as one owned run on the case's thread; the reply is what it stored. */
  async function turn(
    evalCase: EvalCase,
    thread: { botId: string; threadId: string },
    user: string,
  ): Promise<TranscriptTurn> {
    const triggerMessageId = await userMessage(prisma, thread.botId, thread.threadId, user);
    const claim = await leases.claim({
      userId: owner.userId,
      botId: thread.botId,
      threadId: thread.threadId,
      runId: randomUUID(),
      triggerMessageId,
    });
    if (claim.kind !== 'claimed') throw new Error(`run not claimed: ${claim.kind}`);
    const lease = claim.lease;
    const policy = createPolicyRuntime({
      project: (name, args) => ({ name, args, behavior: OBSERVING_BUILTIN }),
      read: async () => FULL,
      store: createPolicyProposalStore(prisma, {
        userId: owner.userId,
        botId: thread.botId,
        conversationId: thread.threadId,
        runId: lease.runId,
      }),
    });
    const tools: ToolSet = {};
    for (const entry of evalCase.tools ?? []) {
      tools[entry.name] = tool({
        description: entry.description,
        inputSchema: (entry.inputSchema as z.ZodType | undefined) ?? z.looseObject({}),
        execute: (input, options) =>
          policy.execute(entry.name, input, options.toolCallId, () =>
            Promise.resolve(entry.result),
          ),
      });
    }
    const events: Json[] = [];
    const outcome = await executeOwned({
      prisma,
      leases,
      wakeups,
      lease,
      backend: (persistence) =>
        new TanStackExecutionBackend({
          logger: { warn: () => undefined },
          resolveModel: (model) => models.resolveText(model.userId, model.modelRef),
          openPersistence: () => Promise.resolve(persistence),
          loadAttachments: async () => new Map(),
        }),
      request: {
        runId: lease.runId,
        threadId: thread.threadId,
        botId: thread.botId,
        triggerMessageId,
        model: { userId: owner.userId, modelRef: modelId },
        instructions: {
          identity: { name: evalCase.bot.name, role: evalCase.bot.role },
          ...(evalCase.bot.systemPrompt !== undefined && { botPrompt: evalCase.bot.systemPrompt }),
        },
        tools,
        policy,
      },
      ports: {
        appendEvent: async (event) => {
          events.push(event);
        },
        checkpoint: async () => undefined,
        releaseForApproval: async () => undefined,
        persistUsage: async () => undefined,
        status: () => undefined,
      },
    });
    if (outcome.status !== 'completed') {
      throw new Error(`run ${outcome.status}: ${outcome.error?.code ?? outcome.finishReason}`);
    }
    const rows = await prisma.message.findMany({
      where: { conversationId: thread.threadId, runId: lease.runId, author: 'BOT' },
      orderBy: { sequence: 'asc' },
      select: { content: true },
    });
    return {
      user,
      reply: rows.map((row) => row.content).join(''),
      calls: callsIn(events),
      stopReason: outcome.finishReason ?? 'unknown',
    };
  }

  const tanstack: EvalSubject = {
    name: `tanstack ${MODEL}`,
    unsupported: () => null,
    async run(evalCase) {
      const bot = await prisma.bot.create({
        data: {
          userId: owner.userId,
          name: evalCase.bot.name,
          role: evalCase.bot.role,
          avatarColor: '#556677',
          systemPrompt: evalCase.bot.systemPrompt ?? '',
          modelId,
        },
        select: { id: true },
      });
      const thread = await prisma.conversation.create({
        data: { botId: bot.id },
        select: { id: true },
      });
      const turns: TranscriptTurn[] = [];
      for (const user of evalCase.user) {
        turns.push(await turn(evalCase, { botId: bot.id, threadId: thread.id }, user));
      }
      return { turns };
    },
  };

  it('runs every case on the AI SDK and on TanStack, and reports both', async () => {
    const aiSdk = runnerSubject(`ai-sdk ${MODEL}`, () => languageModel(MODEL));
    const results = await runSuite(
      CASES,
      [aiSdk, tanstack],
      JUDGE === '' ? undefined : modelJudge(languageModel(JUDGE)),
    );
    const report = renderReport(results);
    if (OUT) {
      const dir = resolve(process.cwd(), '../..', OUT);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        resolve(dir, 'report.txt'),
        `model ${MODEL}\njudge ${JUDGE || 'none (rubric checks NOT SCORED)'}\n` +
          `recorded ${new Date().toISOString()}\n\n${report}\n`,
      );
      writeFileSync(resolve(dir, 'report.json'), `${JSON.stringify(results, null, 2)}\n`);
    }
    console.log(report);
    // A harness error proves nothing either way; a failed case is the finding, not a crash.
    expect(results.filter((result) => result.status === 'error')).toEqual([]);
  }, 1_800_000);
});
