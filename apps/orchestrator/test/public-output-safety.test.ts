import { describe, expect, it } from 'vitest';
import {
  EventType,
  type ModelMessage,
  type StreamChunk,
  type TextOptions,
} from '@tanstack/ai';
import { BaseTextAdapter } from '@tanstack/ai/adapters';
import type { Json } from '@crewaid/shared';
import { TanStackExecutionBackend } from '../src/agent/execution/tanstack-execution-backend.js';
import type { ExecutionRequest } from '../src/agent/execution/execution-backend.port.js';
import { fromTranscriptRow, fromTranscriptRowForOperator } from '../src/agent/persistence/transcript.js';
import { toolFixture } from './mod-ai02-harness.js';

class ScriptedStreamAdapter extends BaseTextAdapter<string> {
  readonly kind = 'text' as const;
  readonly name = 'scripted-stream';
  constructor(private readonly chunks: readonly StreamChunk[]) {
    super({}, 'scripted-model');
  }
  async *chatStream(_options: TextOptions<Record<string, never>>) {
    for (const chunk of this.chunks) yield chunk;
  }
  async structuredOutput(): Promise<{ data: unknown; rawText: string }> {
    return { data: {}, rawText: '{}' };
  }
}

describe('Phase 0 — server-side public output protection', () => {
  it('excludes provider reasoning from operator hydration while preserving it for model execution', () => {
    const botId = 'clx1a2b3c4d5e6f7g8h9i0j1';
    const row = {
      id: 'msg-1',
      author: 'BOT' as const,
      fromBotId: botId,
      runId: 'run-1',
      content: '<think>internal draft</think>\n\nFinal decision ready.',
      parts: {
        role: 'assistant',
        content: '<think>internal draft</think>\n\nFinal decision ready.',
        thinking: [{ content: 'Private chain of thought', signature: 'sig-1' }],
      },
      createdAt: new Date('2026-11-25T11:36:00.000Z'),
      sequence: 1,
      stopReason: null,
      taskId: null,
      routineId: null,
      chainId: null,
      hopCount: 0,
      startsTopic: false,
    };

    const forModel = fromTranscriptRow(row, botId);
    expect(forModel.ok).toBe(true);
    if (forModel.ok) {
      expect(forModel.value?.thinking).toEqual([
        { content: 'Private chain of thought', signature: 'sig-1' },
      ]);
    }

    const forOperator = fromTranscriptRowForOperator(row, botId, []);
    expect(forOperator.ok).toBe(true);
    if (forOperator.ok) {
      expect(forOperator.value.thinking).toBeUndefined();
      expect(forOperator.value.content).toBe('Final decision ready.');
    }
  });

  it('suppresses legacy Gideon meltdown rows on operator read without rewriting storage', () => {
    const botId = 'clx1a2b3c4d5e6f7g8h9i0j1';
    const meltdown =
      'tuple shaped wrong\n\n' +
      Array.from({ length: 40 }, () => 'Produce. Write. Emit. Go. Now. Ok.').join(' ');
    const row = {
      id: 'msg-gideon-1136',
      author: 'BOT' as const,
      fromBotId: botId,
      runId: 'run-legacy',
      content: meltdown,
      parts: { role: 'assistant', content: meltdown },
      createdAt: new Date('2026-11-25T11:36:00.000Z'),
      sequence: 2,
      stopReason: null,
      taskId: null,
      routineId: null,
      chainId: null,
      hopCount: 0,
      startsTopic: false,
    };

    const forOperator = fromTranscriptRowForOperator(row, botId, []);
    expect(forOperator.ok).toBe(true);
    if (forOperator.ok) {
      expect(forOperator.value.content).toBe('');
    }
  });

  it('aborts a runaway repetition stream, withdraws the corrupt message, and emits one retryable error', async () => {
    const f = toolFixture([], [], { mode: 'FULL', initialRunId: 'run-loop-1' });
    await f.persistence.stores.messages.saveThread(f.threadId, [
      { id: 'user-1', role: 'user', content: 'Wrap up.' },
    ]);

    const messageId = 'asst-loop-1';
    const loopDeltas = Array.from({ length: 30 }, () => 'Produce. Write. Emit. Go. Now. Ok. ');
    const chunks: StreamChunk[] = [
      { type: EventType.RUN_STARTED, runId: 'run-loop-1', threadId: f.threadId, timestamp: 1 },
      { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant', timestamp: 2 },
      ...loopDeltas.map(
        (delta, idx): StreamChunk => ({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta,
          timestamp: 3 + idx,
        }),
      ),
      { type: EventType.TEXT_MESSAGE_END, messageId, timestamp: 100 },
      {
        type: EventType.RUN_FINISHED,
        runId: 'run-loop-1',
        threadId: f.threadId,
        timestamp: 101,
        finishReason: 'stop',
      },
    ];

    const withdrawn: string[] = [];
    const adapter = new ScriptedStreamAdapter(chunks);
    const backend = new TanStackExecutionBackend({
      resolveModel: async () => ({
        adapter,
        modelId: 'scripted-model',
        connectionId: 'fixture',
        connectionName: 'Fixture',
        kind: 'custom',
        upstreamModelId: 'scripted',
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
          withdraw: async (_tid, id) => {
            withdrawn.push(id);
          },
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

    const request: ExecutionRequest = {
      model: { userId: 'owner', modelRef: 'scripted-model' },
      botId: 'owned-bot',
      threadId: f.threadId,
      runId: 'run-loop-1',
      triggerMessageId: 'user-1',
      tools: f.resolved.toolSet,
      policy: f.policy,
      instructions: {
        identity: { name: 'Gideon', role: 'PM' },
        botPrompt: '',
        memory: '',
      },
    };

    const events: Json[] = [];
    const outcome = await backend.execute(request, {
      appendEvent: async (event) => {
        events.push(event);
      },
      checkpoint: async () => {},
      persistUsage: async () => {},
      status: () => {},
      releaseForApproval: async () => {},
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('PROVIDER_UNAVAILABLE');
    expect(withdrawn).toContain(messageId);
    const errorEvents = events.filter(
      (event) => typeof event === 'object' && event !== null && (event as { type?: string }).type === EventType.RUN_ERROR,
    );
    expect(errorEvents).toHaveLength(1);
    const saved = (await f.persistence.stores.messages.loadThread(f.threadId)) as ModelMessage[];
    expect(saved.some((msg) => msg.id === messageId)).toBe(false);
  });
});
