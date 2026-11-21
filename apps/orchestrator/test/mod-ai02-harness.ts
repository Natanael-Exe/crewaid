import { randomUUID } from 'node:crypto';
import {
  chat,
  EventType,
  type ModelMessage,
  type StreamChunk,
  type TextOptions,
  type SystemPrompt,
} from '@tanstack/ai';
import { memoryPersistence, withPersistence } from '@tanstack/ai-persistence';
import {
  JsonSchema,
  ToolApprovalRequestSchema,
  type Json,
  type ApprovalMode,
} from '@crewaid/shared';
import { z } from 'zod';
import { ScriptedAdapter } from './mod-02-tanstack-harness.js';
import { createPolicyRuntime, type PolicyState } from '../src/agent/policy/runtime.js';
import { policyHash } from '../src/agent/policy/policy.js';
import type {
  PolicyProposal,
  PolicyResolution,
  PolicyProposalStore,
} from '../src/agent/policy/proposal-store.js';
import { ToolRegistry, type RegisteredTool, type ToolContext } from '../src/agent/tool-registry.js';
import { parseToolInput, type ToolSet } from '../src/agent/tool-contract.js';
import type { SeatPort } from '../src/agent/seat-admission.js';
import { tanstackTools } from '../src/agent/execution/tanstack-tools.js';
import {
  tanstackPolicy,
  type ToolResumeAuthorizer,
} from '../src/agent/execution/tanstack-policy.js';
import { toolApproval } from '../src/agent/execution/tool-approval-interrupt.js';
import { projectToolHistory } from '../src/agent/execution/tool-history-projection.js';

type Call = { id: string; name: string; args: Json };
export class ToolScriptAdapter extends ScriptedAdapter {
  readonly observed: ModelMessage[][] = [];
  readonly prompts: Array<SystemPrompt[]> = [];
  constructor(
    readonly scripted: readonly Call[],
    readonly tools: ToolSet,
    readonly project = true,
  ) {
    super();
  }
  override async *chatStream(
    options: TextOptions<Record<string, never>>,
  ): AsyncIterable<StreamChunk> {
    const messages = this.project
      ? await projectToolHistory(options.messages, this.tools)
      : options.messages;
    this.prompts.push(options.systemPrompts ?? []);
    this.observed.push(structuredClone(messages));
    if (messages.at(-1)?.role !== 'user') {
      yield* super.chatStream({ ...options, messages });
      return;
    }
    const runId = options.runId ?? randomUUID();
    const threadId = options.threadId ?? randomUUID();
    const messageId = randomUUID();
    yield { type: EventType.RUN_STARTED, runId, threadId, timestamp: Date.now() };
    yield {
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: 'assistant',
      timestamp: Date.now(),
    };
    yield { type: EventType.TEXT_MESSAGE_END, messageId, timestamp: Date.now() };
    for (const [index, call] of this.scripted.entries()) {
      yield {
        type: EventType.TOOL_CALL_START,
        toolCallId: call.id,
        toolCallName: call.name,
        parentMessageId: messageId,
        index,
        timestamp: Date.now(),
      };
      yield {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: call.id,
        delta: JSON.stringify(call.args),
        timestamp: Date.now(),
      };
      yield { type: EventType.TOOL_CALL_END, toolCallId: call.id, timestamp: Date.now() };
    }
    yield {
      type: EventType.RUN_FINISHED,
      runId,
      threadId,
      finishReason: 'tool_calls',
      timestamp: Date.now(),
    };
  }
}

/** Owned records are an in-memory fixture here; MOD-AI-06 supplies atomic Prisma continuation. */
export function toolFixture(
  entries: readonly RegisteredTool[],
  calls: readonly Call[],
  options: {
    mode?: ApprovalMode;
    threadId?: string;
    botId?: string;
    initialRunId?: string;
    dynamicCalls?: boolean;
    seat?: SeatPort;
    authorizeResume?: ToolResumeAuthorizer;
  } = {},
) {
  const proposals = new Map<string, PolicyProposal>();
  const resolutions = new Map<string, PolicyResolution>();
  const state: PolicyState = {
    snapshot: {
      mode: options.mode ?? 'AUTO',
      rules: [],
      grantRevision: policyHash('grant-1'),
      grantValid: true,
      resourceRevision: null,
      seat: null,
    },
  };
  const dispatched = new Set<string>();
  const store: PolicyProposalStore = {
    assertLive: async () => true,
    staged: async () => [],
    rebind: async () => false,
    claimDispatch: async (id) => {
      if (dispatched.has(id)) return false;
      dispatched.add(id);
      return true;
    },
    create: async (proposal) => {
      const id = `proposal-${proposals.size}`;
      proposals.set(id, proposal);
      return id;
    },
    read: async (id) => (resolutions.has(id) ? null : (proposals.get(id) ?? null)),
    resolve: async (id, reply) => {
      if (!proposals.has(id) || resolutions.has(id)) return false;
      resolutions.set(id, reply);
      return true;
    },
    cancel: async (id) => {
      proposals.delete(id);
    },
    recordOutcome: async () => undefined,
    memory: async () =>
      [...resolutions].flatMap(([id, result]) => {
        const proposal = proposals.get(id);
        return result.approved && proposal
          ? [{ binding: result.binding, mode: proposal.mode, authority: proposal.authority }]
          : [];
      }),
    openIdentityWindow: async () => undefined,
  };
  const registry = new ToolRegistry();
  entries.forEach((entry) => registry.register(entry));
  const base = registry.resolveFor({} as ToolContext);
  const policy = createPolicyRuntime({
    project: base.projectCall,
    read: async (call) => ({
      ...state,
      ...(call.validate !== undefined && { validate: call.validate }),
    }),
    store,
  });
  const resolved = registry.resolveFor({
    policy,
    ...(options.seat !== undefined && { seat: options.seat }),
  } as ToolContext);
  const persistence = memoryPersistence();
  const adapter = new ToolScriptAdapter(calls, resolved.toolSet);
  let nextRun = 0;
  const threadId = options.threadId ?? 'owned-thread';
  const botId = options.botId ?? 'owned-bot';
  const initialRunId = options.initialRunId ?? 'run-0';
  const authorizer: ToolResumeAuthorizer = async (input) => {
    if (input.threadId !== threadId || input.parentRunId !== initialRunId)
      throw new Error('OWNED_RESUME_REQUIRED');
    // Validate the whole fixture batch before writing any answer. No request payload authorizes a tool.
    const owned = input.resolutions.map((resolution) => {
      const payload = ToolApprovalRequestSchema.parse(resolution.request.payload);
      const proposal = proposals.get(resolution.request.key);
      const original =
        options.dynamicCalls && proposal && proposal.definitionName === proposal.toolName
          ? { id: proposal.toolCallId, name: proposal.definitionName, args: proposal.args }
          : calls.find((call) => call.id === proposal?.toolCallId);
      if (
        !proposal ||
        !original ||
        payload.proposalId !== resolution.request.key ||
        payload.botId !== botId ||
        payload.runId !== input.parentRunId ||
        policyHash(payload.binding) !== policyHash(proposal.binding) ||
        payload.toolCallId !== original.id
      )
        throw new Error('OWNED_RESUME_REQUIRED');
      return { resolution, proposal, original };
    });
    const answered = [];
    for (const { resolution, proposal, original } of owned) {
      const answer = await policy.answer(
        resolution.request.key,
        resolution.status === 'resolved'
          ? resolution.response
          : { approved: false, reason: 'Cancelled' },
      );
      if (!answer?.approved)
        answered.push({
          toolCallId: original.id,
          approved: false as const,
          reason: answer?.reason ?? 'Declined',
        });
      else {
        const definition = resolved.toolSet[proposal.definitionName];
        if (!definition) throw new Error('Missing owned definition');
        // The runtime binds the original envelope and substitutes reviewed edits inside its final fence.
        answered.push({
          toolCallId: original.id,
          approved: true as const,
          dispatchArgs: JsonSchema.parse(
            await parseToolInput(definition.inputSchema, original.args),
          ),
        });
      }
    }
    return answered;
  };
  async function run(
    resume?: Parameters<typeof chat>[0]['resume'],
    controller = new AbortController(),
  ) {
    const runId = `run-${nextRun++}`;
    const chunks: StreamChunk[] = [];
    for await (const chunk of chat({
      adapter,
      messages: [],
      tools: tanstackTools(resolved.toolSet),
      interrupts: [toolApproval],
      middleware: [
        withPersistence(persistence),
        tanstackPolicy({
          botId,
          tools: resolved.toolSet,
          policy,
          authorizeResume: options.authorizeResume ?? authorizer,
        }),
      ],
      threadId,
      runId,
      ...(resume !== undefined && { resume, parentRunId: 'run-0' }),
      abortController: controller,
    }))
      chunks.push(chunk);
    return chunks;
  }
  async function start() {
    await persistence.stores.messages.saveThread(threadId, [
      { id: 'user-1', role: 'user', content: 'call the tools' },
    ]);
    return await run();
  }
  async function resume(
    answer: { approved: boolean; editedArgs?: Json },
    changed?: (value: unknown) => unknown,
  ) {
    const pending = await persistence.stores.interrupts.listPending(threadId);
    const batch = pending.map((record) => ({
      interruptId: record.interruptId,
      status: 'resolved' as const,
      payload: answer,
    }));
    return await run(
      changed === undefined
        ? batch
        : z.custom<NonNullable<Parameters<typeof chat>[0]['resume']>>().parse(changed(batch)),
    );
  }
  return {
    start,
    resume,
    run,
    state,
    proposals,
    resolutions,
    adapter,
    resolved,
    persistence,
    threadId,
    policy,
    authorizeResume: options.authorizeResume ?? authorizer,
  };
}
