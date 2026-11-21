import { describe, expect, it, vi } from 'vitest';
import { EventType } from '@tanstack/ai';
import { JsonSchema, type Json } from '@crewaid/shared';
import { z } from 'zod';
import { AiTelemetryEventSchema, type AiTelemetryEvent } from '../src/telemetry/ai-telemetry.js';
import { tool } from '../src/agent/tool-contract.js';
import {
  OBSERVING_BUILTIN,
  SENSITIVE_BUILTIN,
  type RegisteredTool,
} from '../src/agent/tool-registry.js';
import {
  TanStackExecutionBackend,
  type TanStackExecutionPersistence,
} from '../src/agent/execution/tanstack-execution-backend.js';
import type {
  ExecutionPorts,
  ExecutionRequest,
  ExecutionCheckpoint,
} from '../src/agent/execution/execution-backend.port.js';
import { executionSystemPrompts } from '../src/agent/execution/provider-context.js';
import { agentInstructions } from '../src/agent/agent-instructions.js';
import { toolFixture, ToolScriptAdapter } from './mod-ai02-harness.js';

const emptyUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  reportedCalls: 0,
  unreportedCalls: 0,
};
function fixture(mode: 'AUTO' | 'FULL' = 'FULL', write = false) {
  const effect = vi.fn((args: unknown) => args);
  const definition = tool({
    inputSchema: z.object({ value: z.string().default('default') }),
    execute: effect,
  });
  const entry: RegisteredTool = {
    name: 'fixture_action',
    behavior: write ? SENSITIVE_BUILTIN : OBSERVING_BUILTIN,
    build: () => definition,
  };
  const calls = [{ id: 'call-1', name: entry.name, args: {} as Json }];
  const f = toolFixture([entry], calls, { mode });
  const adapter = new ToolScriptAdapter(calls, f.resolved.toolSet, false);
  const request: ExecutionRequest = {
    model: { userId: 'owner', modelRef: 'fixture-model' },
    botId: 'owned-bot',
    threadId: f.threadId,
    runId: 'run-0',
    triggerMessageId: 'user-1',
    tools: f.resolved.toolSet,
    observationTools: ['fixture_action'],
    policy: f.policy,
    instructions: {
      identity: { name: 'Quill', role: 'Reviewer' },
      botPrompt: 'Check facts.',
      memory: 'Use English.',
    },
  };
  const events: Json[] = [];
  const steps: ExecutionCheckpoint[] = [];
  const ports: ExecutionPorts = {
    appendEvent: async (event) => {
      events.push(event);
    },
    checkpoint: async (step) => {
      steps.push(step);
    },
    persistUsage: vi.fn(async () => undefined),
    status: vi.fn(),
    releaseForApproval: vi.fn(async () => undefined),
  };
  const reserve = vi.fn(async () => undefined);
  const assertLive = vi.fn(async () => undefined);
  const boundary = vi.fn();
  const openPersistence = vi.fn(
    async (input: ExecutionRequest): Promise<TanStackExecutionPersistence> => {
      // Explicit fixture admission. Production has already claimed its durable run.
      await f.persistence.stores.runs.createOrResume({
        runId: input.runId,
        threadId: input.threadId,
        startedAt: Date.now(),
      });
      return {
        persistence: f.persistence,
        reserve,
        assertLive,
        boundary: async (next, operation) => {
          boundary(next);
          return operation();
        },
        progress: async () => undefined,
        authorizeResume: f.authorizeResume,
        budget: { steps: 0, workingMs: 0, usage: emptyUsage },
      };
    },
  );
  const resolveModel = vi.fn(async () => ({
    adapter,
    modelId: 'fixture-model',
    connectionId: 'connection',
    connectionName: 'Owned',
    kind: 'custom' as const,
    upstreamModelId: 'fixture',
    label: 'Fixture',
    contextWindow: 10000,
    capabilities: { tools: true, vision: true, reasoning: false },
  }));
  const loadAttachments = vi.fn(async () => new Map());
  const logger = { warn: vi.fn() };
  const telemetry: AiTelemetryEvent[] = [];
  const backend = new TanStackExecutionBackend({
    resolveModel,
    openPersistence,
    loadAttachments,
    logger,
    telemetry: { record: (event) => void telemetry.push(event) },
  });
  async function start(
    extra: Partial<ExecutionRequest> = {},
    overrides: Partial<ExecutionPorts> = {},
  ) {
    await f.persistence.stores.messages.saveThread(f.threadId, [
      { id: 'user-1', role: 'user', content: 'Use fixture_action once and then answer.' },
    ]);
    return backend.execute({ ...request, ...extra }, { ...ports, ...overrides });
  }
  return {
    f,
    adapter,
    request,
    telemetry,
    events,
    steps,
    ports,
    backend,
    start,
    reserve,
    assertLive,
    resolveModel,
    openPersistence,
    boundary,
    loadAttachments,
    effect,
    logger,
  };
}
function types(events: Json[]) {
  return events.map((event) => z.object({ type: z.string() }).parse(event).type);
}

describe('D-176 canonical TanStack execution backend (real library, controlled model)', () => {
  it('loads admitted server history once, uses native events and checkpoints before the second model call', async () => {
    const h = fixture();
    let checkpointDone = false;
    const stream = h.adapter.chatStream.bind(h.adapter);
    h.adapter.chatStream = (options) => {
      if (options.messages.at(-1)?.role === 'tool') expect(checkpointDone).toBe(true);
      return stream(options);
    };
    const result = await h.start(
      {},
      {
        checkpoint: async (step) => {
          h.steps.push(step);
          checkpointDone = true;
        },
      },
    );
    expect(result.status).toBe('completed');
    expect(result.finishReason).toBe('stop');
    expect(h.effect).toHaveBeenCalledExactlyOnceWith(
      { value: 'default' },
      expect.objectContaining({ toolCallId: 'call-1' }),
    );
    expect(h.adapter.observed[0]).toHaveLength(1);
    expect(types(h.events).filter((type) => type === EventType.RUN_STARTED)).toHaveLength(1);
    expect(types(h.events).filter((type) => type === EventType.RUN_FINISHED)).toHaveLength(1);
    expect(h.steps.map((step) => step.stepIndex)).toEqual([0, 1]);
    expect(h.reserve.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(await h.f.persistence.stores.messages.loadThread(h.f.threadId)).toHaveLength(4);
    expect(h.ports.persistUsage).toHaveBeenCalledTimes(1);
    expect(result.usage.reportedCalls).toBe(1);
    expect(result.usage.unreportedCalls).toBe(1);
    expect(h.adapter.prompts[0]).toEqual([agentInstructions(h.request.instructions)]);
  });
  it('gives a stalled model one closing call with no executable tools or approval', async () => {
    const h = fixture();
    h.effect.mockImplementation(() => 'unchanged');
    const observed: Array<{ messages: unknown; tools: unknown }> = [];
    h.adapter.chatStream = (options) => {
      observed.push({ messages: structuredClone(options.messages), tools: options.tools });
      // Ignore the notice deliberately: a stop must hold even when the model
      // tries another tool call on its closing step.
      const scripted = new ToolScriptAdapter(
        [{ id: `repeat-${observed.length}`, name: 'fixture_action', args: {} }],
        h.request.tools,
        false,
      );
      return scripted.chatStream({ ...options, messages: [{ role: 'user', content: 'repeat' }] });
    };
    const result = await h.start({ maxSteps: 20 });
    expect(result).toMatchObject({
      status: 'completed',
      stall: { repeats: 5, tool: 'fixture_action' },
    });
    expect(observed).toHaveLength(6);
    expect(observed.at(-1)?.tools).toEqual([]);
    expect(h.effect).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(observed[3]?.messages)).toContain('Change approach');
    expect(JSON.stringify(observed[5]?.messages)).toContain('final answer');
    expect(
      JSON.stringify(await h.f.persistence.stores.messages.loadThread(h.f.threadId)),
    ).not.toContain('[SYSTEM NOTICE]');
  });

  it('sends the wrap-up notice once at 80 percent without storing it', async () => {
    const h = fixture();
    const observed: unknown[] = [];
    h.effect.mockImplementation(() => `result-${observed.length}`);
    const natural = h.adapter.chatStream.bind(h.adapter);
    h.adapter.chatStream = (options) => {
      observed.push(structuredClone(options.messages));
      if (observed.length === 5)
        return natural({
          ...options,
          messages: [{ role: 'tool', toolCallId: 'finished', content: 'done' }],
        });
      return new ToolScriptAdapter(
        [{ id: `step-${observed.length}`, name: 'fixture_action', args: {} }],
        h.request.tools,
        false,
      ).chatStream({ ...options, messages: [{ role: 'user', content: 'work' }] });
    };
    const result = await h.start({ maxSteps: 5 });
    expect(result.status).toBe('completed');
    expect(observed).toHaveLength(5);
    expect(JSON.stringify(observed.slice(0, 4))).not.toContain('Wrap up now');
    expect(JSON.stringify(observed[4])).toContain('4 of this turn');
    expect(
      JSON.stringify(await h.f.persistence.stores.messages.loadThread(h.f.threadId)),
    ).not.toContain('[SYSTEM NOTICE]');
  });

  it('records one privacy-safe model-call event per model call', async () => {
    const h = fixture();
    await h.start();
    // The tool call and the answer: two model calls, two records.
    expect(h.telemetry).toHaveLength(2);
    for (const event of h.telemetry) {
      // The closed schema admits identifiers and counts only: no prompt, output or tool text.
      expect(AiTelemetryEventSchema.strict().parse(event)).toMatchObject({
        event: 'ai.model-call',
        outcome: 'success',
        provider: 'custom',
        model: 'fixture',
        runId: h.request.runId,
      });
    }
    expect(JSON.stringify(h.telemetry)).not.toContain('fixture_action');
  });

  it('refuses another model call after a checkpoint failure and never emits successful finish', async () => {
    const h = fixture();
    const result = await h.start(
      {},
      {
        checkpoint: async () => {
          throw new Error('checkpoint offline');
        },
      },
    );
    expect(result.status).toBe('failed');
    expect(h.adapter.observed).toHaveLength(1);
    expect(types(h.events)).not.toContain(EventType.RUN_FINISHED);
    expect(types(h.events).at(-1)).toBe(EventType.RUN_ERROR);
  });
  it('does not swallow an event-log append failure', async () => {
    const h = fixture();
    await expect(
      h.start(
        {},
        {
          appendEvent: async () => {
            throw new Error('log offline');
          },
        },
      ),
    ).rejects.toThrow('log offline');
    expect(h.effect).not.toHaveBeenCalled();
  });
  it('a final checkpoint failure cannot commit a completed run in the library store', async () => {
    const h = fixture();
    const result = await h.start(
      {},
      {
        checkpoint: async (step) => {
          if (step.stepIndex === 1) throw new Error('final checkpoint offline');
        },
      },
    );
    expect(result.status).toBe('failed');
    expect((await h.f.persistence.stores.runs.get(h.request.runId))?.status).toBe('failed');
    expect(types(h.events)).not.toContain(EventType.RUN_FINISHED);
  });
  it('an observational usage write failure is safely logged and does not change completion', async () => {
    const h = fixture();
    const result = await h.start(
      {},
      {
        persistUsage: async () => {
          throw new Error('provider-secret-do-not-log');
        },
      },
    );
    expect(result.status).toBe('completed');
    expect(types(h.events).at(-1)).toBe(EventType.RUN_FINISHED);
    expect(h.logger.warn).toHaveBeenCalledExactlyOnceWith('turn.usage.persist.failed', {
      runId: h.request.runId,
      botId: h.request.botId,
      errorName: 'Error',
    });
    expect(JSON.stringify(h.logger.warn.mock.calls)).not.toContain('provider-secret');
  });
  it('the final transcript save must succeed before the outer terminal event', async () => {
    const h = fixture();
    const save = h.f.persistence.stores.messages.saveThread.bind(h.f.persistence.stores.messages);
    h.f.persistence.stores.messages.saveThread = async (threadId, messages) => {
      if (messages.at(-1)?.role === 'assistant') throw new Error('final transcript offline');
      return save(threadId, messages);
    };
    await expect(h.start()).rejects.toThrow('final transcript offline');
    expect(types(h.events)).not.toContain(EventType.RUN_ERROR);
    expect(types(h.events)).not.toContain(EventType.RUN_FINISHED);
  });
  it('waits for the closing transaction before publishing a terminal', async () => {
    const h = fixture();
    const open = h.openPersistence.getMockImplementation()!;
    let entered!: () => void;
    let commit!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const committed = new Promise<void>((resolve) => {
      commit = resolve;
    });
    h.openPersistence.mockImplementation(async (input) => ({
      ...(await open(input)),
      boundary: async (next, operation) => {
        const result = await operation();
        if (next === 'completed') {
          entered();
          await committed;
        }
        return result;
      },
    }));
    const result = h.start();
    await ready;
    expect(types(h.events)).not.toContain(EventType.RUN_FINISHED);
    commit();
    expect((await result).status).toBe('completed');
    expect(types(h.events).at(-1)).toBe(EventType.RUN_FINISHED);
  });
  it('a rejected completion boundary remains failed despite isolated terminal hooks', async () => {
    const h = fixture();
    const open = h.openPersistence.getMockImplementation()!;
    h.openPersistence.mockImplementation(async (input) => ({
      ...(await open(input)),
      boundary: async (next, operation) => {
        if (next === 'completed') throw new Error('vendor-secret boundary failure');
        return operation();
      },
    }));
    const result = await h.start();
    expect(result.status).toBe('failed');
    expect((await h.f.persistence.stores.runs.get(h.request.runId))?.status).toBe('failed');
    expect(types(h.events)).not.toContain(EventType.RUN_FINISHED);
    expect(JSON.stringify(h.events)).not.toContain('vendor-secret');
  });
  it('closes an admitted run when model resolution fails before chat starts', async () => {
    const h = fixture();
    h.resolveModel.mockRejectedValue(new Error('invalid api key: secret'));
    const result = await h.start();
    expect(result.status).toBe('failed');
    expect((await h.f.persistence.stores.runs.get(h.request.runId))?.status).toBe('failed');
    expect(h.adapter.observed).toHaveLength(0);
    expect(h.effect).not.toHaveBeenCalled();
    expect(JSON.stringify(h.events)).not.toContain('secret');
  });
  it('does not publish a terminal event when both completion and failure settlement cannot commit', async () => {
    const h = fixture();
    const open = h.openPersistence.getMockImplementation()!;
    h.openPersistence.mockImplementation(async (input) => ({
      ...(await open(input)),
      boundary: async () => {
        throw new Error('closing database unavailable');
      },
    }));
    await expect(h.start()).rejects.toThrow('closing database unavailable');
    expect(types(h.events)).not.toContain(EventType.RUN_ERROR);
    expect(types(h.events)).not.toContain(EventType.RUN_FINISHED);
  });
  it('typed review parks without dispatch and releases the computer before notifying completion', async () => {
    const h = fixture('AUTO', true);
    const result = await h.start();
    expect(result.status).toBe('interrupted');
    expect(h.effect).not.toHaveBeenCalled();
    expect(h.ports.releaseForApproval).toHaveBeenCalledTimes(1);
    const terminal = z
      .object({ outcome: z.object({ type: z.literal('interrupt') }) })
      .parse(h.events.at(-1));
    expect(terminal.outcome.type).toBe('interrupt');
    expect(await h.f.persistence.stores.interrupts.listPending(h.f.threadId)).toHaveLength(1);
  });
  it.each([true, false])(
    'continues an owned %s answer, preserving the original call identity',
    async (approved) => {
      const h = fixture('AUTO', true);
      await h.start();
      const pending = await h.f.persistence.stores.interrupts.listPending(h.f.threadId);
      const result = await h.backend.execute(
        {
          ...h.request,
          runId: 'run-1',
          parentRunId: 'run-0',
          resume: pending.map((record) => ({
            interruptId: record.interruptId,
            status: 'resolved',
            payload: { approved, ...(approved ? { editedArgs: { value: 'reviewed' } } : {}) },
          })),
        },
        h.ports,
      );
      expect(result.status).toBe('completed');
      expect(h.effect).toHaveBeenCalledTimes(approved ? 1 : 0);
      if (approved)
        expect(h.effect).toHaveBeenCalledWith(
          { value: 'reviewed' },
          expect.objectContaining({ toolCallId: 'call-1' }),
        );
      expect(await h.f.persistence.stores.interrupts.listPending(h.f.threadId)).toHaveLength(0);
    },
  );
  it('honors a step ceiling and retains the provider finish reason', async () => {
    const h = fixture();
    const result = await h.start({ maxSteps: 1 });
    expect(result.status).toBe('completed');
    expect(result.finishReason).toBe('tool_calls');
    expect(result.stoppedBy).toEqual({ kind: 'steps', limit: 1, observed: 1 });
    expect(h.adapter.observed).toHaveLength(1);
  });
  it('resume budgets come from server composition and cannot start fresh', async () => {
    const h = fixture();
    const open = h.openPersistence.getMockImplementation()!;
    h.openPersistence.mockImplementation(async () => ({
      ...(await open(h.request)),
      budget: { steps: 3, workingMs: 600, usage: { ...emptyUsage, inputTokens: 100 } },
    }));
    const result = await h.start({ maxSteps: 3 });
    expect(h.adapter.observed).toHaveLength(0);
    expect(result.stoppedBy).toEqual({ kind: 'steps', limit: 3, observed: 3 });
    expect(result.workingMs).toBeGreaterThanOrEqual(600);
    expect((await h.f.persistence.stores.runs.get(h.request.runId))?.status).toBe('completed');
    expect(h.boundary).toHaveBeenCalledExactlyOnceWith('completed');
  });
  it('an already-cancelled request never resolves a provider or opens persistence', async () => {
    const h = fixture();
    const controller = new AbortController();
    controller.abort();
    const result = await h.start({}, { signal: controller.signal });
    expect(result.status).toBe('aborted');
    expect(h.resolveModel).not.toHaveBeenCalled();
    expect(h.openPersistence).not.toHaveBeenCalled();
    expect(JsonSchema.parse(h.events.at(-1))).toMatchObject({
      type: EventType.RUN_ERROR,
      code: 'RUN_CANCELLED',
    });
  });
  it.each(['error', 'cancel'] as const)(
    'retains unfinished text on %s without any full-history streaming save',
    async (ending) => {
      const h = fixture();
      const controller = new AbortController();
      const store = h.f.persistence.stores.messages;
      const saved = vi.spyOn(store, 'saveThread');
      h.adapter.chatStream = async function* () {
        yield { type: EventType.TEXT_MESSAGE_START, messageId: 'partial', role: 'assistant' };
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: 'partial',
          delta: 'Still writing',
        };
        // Only the initial history admission has saved so far, not a token snapshot.
        expect(
          saved.mock.calls.some(([, messages]) =>
            messages.some((message) => message.id === 'partial'),
          ),
        ).toBe(false);
        if (ending === 'cancel') controller.abort();
        else throw new Error('provider unavailable');
      };
      const result = await h.start({}, { signal: controller.signal });
      expect(result.status).toBe(ending === 'cancel' ? 'aborted' : 'failed');
      const history = await store.loadThread(h.f.threadId);
      expect(history.find((message) => message.id === 'partial')?.content).toBe('Still writing');
      expect(
        saved.mock.calls.filter(([, messages]) =>
          messages.some((message) => message.id === 'partial'),
        ),
      ).toHaveLength(1);
    },
  );

  it('checkpoints only the dirty reply during a long stream, after its first visible delta', async () => {
    const h = fixture();
    const saved = vi.spyOn(h.f.persistence.stores.messages, 'saveThread');
    let time = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => time);
    try {
      h.adapter.chatStream = async function* (options) {
        yield { type: EventType.TEXT_MESSAGE_START, messageId: 'dirty', role: 'assistant' };
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'dirty', delta: 'A long ' };
        expect(saved.mock.calls.some(([, rows]) => rows.some((row) => row.id === 'dirty'))).toBe(
          false,
        );
        time += 1_001;
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'dirty', delta: 'reply' };
        expect(saved.mock.calls.at(-1)?.[1]).toEqual([
          expect.objectContaining({ id: 'dirty', role: 'assistant', content: 'A long reply' }),
        ]);
        yield { type: EventType.TEXT_MESSAGE_END, messageId: 'dirty' };
        yield {
          type: EventType.RUN_FINISHED,
          threadId: options.threadId!,
          runId: options.runId!,
          finishReason: 'stop',
        };
      };
      expect((await h.start()).status).toBe('completed');
    } finally {
      clock.mockRestore();
    }
  });

  it('cancels the actual provider signal and removes the caller listener', async () => {
    const h = fixture();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    let received: AbortSignal | undefined;
    h.adapter.chatStream = async function* (options) {
      received = options.request?.signal ?? undefined;
      controller.abort();
      if (received?.aborted !== true) throw new Error('provider did not receive cancel');
      yield { type: EventType.RUN_STARTED, runId: options.runId!, threadId: options.threadId! };
    };
    const result = await h.start({}, { signal: controller.signal });
    expect(received?.aborted).toBe(true);
    expect(result.status).toBe('aborted');
    expect(h.effect).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(h.events.at(-1)).toMatchObject({ code: 'RUN_CANCELLED' });
  });
  it('normalizes vendor RUN_ERROR text before any event reaches storage', async () => {
    const h = fixture();
    h.adapter.chatStream = async function* (options) {
      yield { type: EventType.RUN_STARTED, runId: options.runId!, threadId: options.threadId! };
      yield {
        type: EventType.RUN_ERROR,
        message: '401 Incorrect API key provided: sk-live1234567890abcdef. Check your key.',
        code: '401',
      };
    };
    const result = await h.start();
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('AUTH_FAILED');
    // D-228: the vendor's words reach an event only as the cleaned, attributed
    // explanation — never as the run's message, and never with a key in them.
    const terminal = h.events.at(-1);
    expect(terminal).toMatchObject({ type: EventType.RUN_ERROR, code: 'AUTH_FAILED' });
    expect(terminal).toMatchObject({ message: expect.not.stringContaining('Incorrect API key') });
    expect(terminal).toMatchObject({
      metadata: {
        crewaid: {
          explanation: {
            source: 'Owned',
            text: 'Incorrect API key provided: [hidden]. Check your key.',
          },
        },
      },
    });
    expect(JSON.stringify(h.events)).not.toContain('sk-live1234567890abcdef');
    // The run row keeps only `{ code, message }`.
    expect(result.error).toEqual({ code: 'AUTH_FAILED', message: expect.any(String) });
  });
  it('quotes nothing from the provider of an included model (D-228)', async () => {
    const h = fixture();
    const owned = await h.resolveModel();
    h.resolveModel.mockResolvedValue({ ...owned, included: true });
    h.adapter.chatStream = async function* (options) {
      yield { type: EventType.RUN_STARTED, runId: options.runId!, threadId: options.threadId! };
      yield {
        type: EventType.RUN_ERROR,
        message: '402 This platform account has run out of credits for today.',
        code: '402',
      };
    };
    await h.start();
    expect(h.events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: 'QUOTA_EXCEEDED' });
    expect(JSON.stringify(h.events)).not.toContain('platform account');
  });
  it('uses the existing stable instruction prefix for Anthropic cache metadata', () => {
    const h = fixture();
    expect(executionSystemPrompts(h.request, 'anthropic')).toEqual([
      {
        content: agentInstructions({
          identity: h.request.instructions.identity!,
          botPrompt: h.request.instructions.botPrompt!,
        }),
        metadata: { cache_control: { type: 'ephemeral' } },
      },
      'Use English.',
    ]);
  });
  it('claimed images are provider-only while canonical user content stays unchanged', async () => {
    const h = fixture();
    h.loadAttachments.mockResolvedValue(
      new Map([
        [
          'user-1',
          [{ filename: 'screen.png', mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) }],
        ],
      ]),
    );
    expect((await h.start()).status).toBe('completed');
    expect(h.adapter.observed[0]?.[0]?.content).toEqual([
      { type: 'text', content: 'Use fixture_action once and then answer.' },
      { type: 'image', source: { type: 'data', mimeType: 'image/png', value: 'AQID' } },
    ]);
    expect((await h.f.persistence.stores.messages.loadThread(h.f.threadId))[0]?.content).toBe(
      'Use fixture_action once and then answer.',
    );
  });
});
