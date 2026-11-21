// Production execution and SSE encoding, consumed by the standalone AG-UI client.
import { describe, expect, it } from 'vitest';
import {
  AbstractAgent,
  buildResumeArray,
  runHttpRequest,
  transformHttpEventStream,
} from '@ag-ui/client';
import type { RunAgentInput } from '@ag-ui/core';
import {
  EventType,
  memoryStream,
  resumeServerSentEventsResponse,
  type StreamChunk,
  type TextOptions,
} from '@tanstack/ai';
import { z } from 'zod';
import type { Json } from '@crewaid/shared';
import { tool } from '../src/agent/tool-contract.js';
import { OBSERVING_BUILTIN, SENSITIVE_BUILTIN } from '../src/agent/tool-registry.js';
import { TanStackExecutionBackend } from '../src/agent/execution/tanstack-execution-backend.js';
import type { ExecutionRequest } from '../src/agent/execution/execution-backend.port.js';
import { toolFixture, ToolScriptAdapter } from './mod-ai02-harness.js';

class CapturedAgent extends AbstractAgent {
  constructor(
    private events: Json[],
    threadId: string,
  ) {
    super({ threadId });
  }
  run(input: RunAgentInput) {
    // Use the production SSE encoder; raw internal chunks are not the wire.
    return transformHttpEventStream(
      runHttpRequest(async () => {
        const log = memoryStream({ runId: input.runId, offset: '-1' });
        await log.append(this.events as unknown as StreamChunk[]);
        await log.close();
        return resumeServerSentEventsResponse({ adapter: log });
      }),
    );
  }
  replaceEvents(events: Json[]) {
    this.events = events;
  }
}

class ReasoningToolAdapter extends ToolScriptAdapter {
  override async *chatStream(options: TextOptions<Record<string, never>>) {
    for await (const event of super.chatStream(options)) {
      yield event;
      if (event.type === EventType.TEXT_MESSAGE_START) {
        // Providers reuse the assistant id for internal thinking. The public
        // stream must give it a distinct role/id before a native SDK applies it.
        yield {
          type: EventType.REASONING_MESSAGE_START,
          messageId: event.messageId,
        } as StreamChunk;
        yield {
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: event.messageId,
          delta: 'Checking the proposed action.',
        } as StreamChunk;
        yield {
          type: EventType.REASONING_MESSAGE_END,
          messageId: event.messageId,
          signature: 'fixture-signed-thinking',
        } as StreamChunk;
      }
    }
  }
}

function fixture(write: boolean, reasoning = false) {
  const name = 'fixture_action';
  const calls = [{ id: 'call-1', name, args: { value: 'original' } }];
  const f = toolFixture(
    [
      {
        name,
        behavior: write ? SENSITIVE_BUILTIN : OBSERVING_BUILTIN,
        build: () =>
          tool({ inputSchema: z.object({ value: z.string() }), execute: async (args) => args }),
      },
    ],
    calls,
    {
      mode: write ? 'AUTO' : 'FULL',
      initialRunId: write ? 'audit-approval-run-0' : 'audit-tool-run-0',
    },
  );
  const Adapter = reasoning ? ReasoningToolAdapter : ToolScriptAdapter;
  const adapter = new Adapter(calls, f.resolved.toolSet, false);
  const request: ExecutionRequest = {
    model: { userId: 'owner', modelRef: 'fixture-model' },
    botId: 'owned-bot',
    threadId: f.threadId,
    runId: write ? 'audit-approval-run-0' : 'audit-tool-run-0',
    triggerMessageId: 'user-1',
    tools: f.resolved.toolSet,
    policy: f.policy,
    instructions: {
      identity: { name: 'Quill', role: 'Reviewer' },
      botPrompt: 'Check facts.',
      memory: '',
    },
  };
  const backend = new TanStackExecutionBackend({
    resolveModel: async () => ({
      adapter,
      modelId: 'fixture-model',
      connectionId: 'fixture',
      connectionName: 'Fixture',
      kind: 'custom',
      upstreamModelId: 'fixture',
      label: 'Fixture',
      contextWindow: 10000,
      capabilities: { tools: true, vision: false, reasoning: false },
    }),
    openPersistence: async (input) => {
      await f.persistence.stores.runs.createOrResume({
        runId: input.runId,
        threadId: input.threadId,
        startedAt: Date.now(),
      });
      return {
        persistence: f.persistence,
        reserve: async () => {},
        assertLive: async () => {},
        boundary: async (_next, operation) => operation(),
        progress: async () => {},
        authorizeResume: f.authorizeResume,
        budget: {
          steps: 0,
          workingMs: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            reportedCalls: 0,
            unreportedCalls: 0,
          },
        },
      };
    },
    loadAttachments: async () => new Map(),
    logger: { warn: () => {} },
  });
  async function produce(input = request) {
    const events: Json[] = [];
    const result = await backend.execute(input, {
      appendEvent: async (event) => {
        events.push(event);
      },
      checkpoint: async () => {},
      persistUsage: async () => {},
      status: () => {},
      releaseForApproval: async () => {},
    });
    return { events, result };
  }
  return { f, request, produce };
}

describe('audit: production execution events through independent AG-UI 1.0 verifier', () => {
  it('verifies a tool round produced by the production backend', async () => {
    const h = fixture(false);
    await h.f.persistence.stores.messages.saveThread(h.f.threadId, [
      { id: 'user-1', role: 'user', content: 'Use fixture_action.' },
    ]);
    const p = await h.produce();
    expect(p.result.status).toBe('completed');
    const agent = new CapturedAgent(p.events, h.f.threadId);
    await agent.runAgent({ runId: h.request.runId });
    expect(agent.messages.some((message) => message.role === 'tool')).toBe(true);
  });
  it('verifies a production approval and resumes with the AG-UI helper', async () => {
    const h = fixture(true, true);
    await h.f.persistence.stores.messages.saveThread(h.f.threadId, [
      { id: 'user-1', role: 'user', content: 'Use fixture_action.' },
    ]);
    const p = await h.produce();
    expect(p.result.status).toBe('interrupted');
    const agent = new CapturedAgent(p.events, h.f.threadId);
    await agent.runAgent({ runId: h.request.runId });
    expect(agent.pendingInterrupts).toHaveLength(1);
    expect(agent.messages.some((message) => message.role === 'reasoning')).toBe(true);
    expect(
      agent.messages
        .filter((message) => message.role === 'assistant')
        .map((message) => message.content),
    ).not.toContain('Checking the proposed action.');
    const resume = buildResumeArray(agent.pendingInterrupts, {
      [agent.pendingInterrupts[0]!.id]: {
        status: 'resolved',
        payload: { approved: true, editedArgs: { value: 'reviewed' } },
      },
    });
    const continuation = await h.produce({
      ...h.request,
      runId: 'audit-approval-run-1',
      parentRunId: h.request.runId,
      resume,
    });
    expect(continuation.result.status).toBe('completed');
    agent.replaceEvents(continuation.events);
    await agent.runAgent({ runId: 'audit-approval-run-1', resume });
    expect(agent.pendingInterrupts).toHaveLength(0);
  });
});
