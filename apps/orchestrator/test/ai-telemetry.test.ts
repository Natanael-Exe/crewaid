import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from './model-resolution-fake.js';
import type { ScriptPart as LanguageModelV4StreamPart } from './model-resolution-fake.js';
import { executionTurn } from './execution-turn-fake.js';
import {
  AiTelemetryEventSchema,
  catalogCostEstimate,
  catalogPriceForModel,
  catalogProviderOf,
  modelKeyOf,
  productionCostEstimate,
  projectUsageForEvent,
  safeCostEstimate,
  usdForTokenCounters,
  type AiTelemetryCostResolver as CostResolver,
  type AiTelemetryEvent,
  type AiTelemetrySink,
} from '../src/telemetry/ai-telemetry.js';

const baseUsage = {
  // The SDK's total counts both cache subsets: 7 fresh + 2 read + 1 written.
  inputTokens: { total: 10, noCache: 7, cacheRead: 2, cacheWrite: 1 },
  outputTokens: { total: 4, text: 4, reasoning: 0 },
};

function textChunks(
  text = 'hello',
  usage = baseUsage,
  chunkDelayInMs = 0,
): LanguageModelV4StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: text },
    { type: 'text-end', id: 'text-1' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
    },
  ];
}

function modelFromChunks(chunks: LanguageModelV4StreamPart[], chunkDelayInMs = 0) {
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'mock-model',
    doStream: async () => ({
      stream: simulateReadableStream({ chunks, initialDelayInMs: 1, chunkDelayInMs }),
    }),
  });
}

/**
 * One run through the TanStack execution backend. The correlation envelope is
 * the run's own: its bot, its thread and its run id.
 */
function runWith(options: {
  model: MockLanguageModelV4;
  telemetry?: AiTelemetrySink;
  costResolver?: CostResolver;
  signal?: AbortSignal;
}) {
  return executionTurn({
    model: options.model,
    ...(options.telemetry !== undefined && { telemetry: options.telemetry }),
    ...(options.costResolver !== undefined && { costResolver: options.costResolver }),
    ...(options.signal !== undefined && { signal: options.signal }),
  }).execute();
}

describe('CC-03 model-call telemetry contract', () => {
  it('emits one privacy-safe record per model call with the five-field correlation envelope', async () => {
    const events: AiTelemetryEvent[] = [];

    await runWith({
      model: modelFromChunks(textChunks()),
      telemetry: { record: (event) => events.push(event) },
    });

    expect(events).toHaveLength(1);
    const parsed = AiTelemetryEventSchema.parse(events[0]);
    expect(parsed).toMatchObject({
      event: 'ai.model-call',
      outcome: 'success',
      // The resolved connection's kind and upstream model, not the script's.
      provider: 'openai',
      model: 'fake-model',
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      cachedInputTokens: 2,
      cacheCreationTokens: 1,
      usageUnknown: false,
      botId: 'bot_under_test',
      conversationId: 'thread_under_test',
      runId: 'run-0',
    });
    expect(parsed.latencyMs).toBeGreaterThanOrEqual(0);
    expect(parsed).not.toHaveProperty('prompt');
    expect(parsed).not.toHaveProperty('output');
    expect(parsed).not.toHaveProperty('error');
    expect(JSON.stringify(parsed)).not.toContain('private');
  });

  it('preserves unknown usage as nulls (never zeros) on a mid-step error', async () => {
    const events: AiTelemetryEvent[] = [];
    const model = new MockLanguageModelV4({
      provider: 'mock-provider',
      modelId: 'mock-error-model',
      doStream: async () => {
        throw new Error('provider response contains a secret token');
      },
    });

    const output = await runWith({ model, telemetry: { record: (event) => events.push(event) } });
    expect(output.status).toBe('failed');

    expect(events).toHaveLength(1);
    const parsed = AiTelemetryEventSchema.parse(events[0]);
    expect(parsed).toMatchObject({
      event: 'ai.model-call',
      outcome: 'error',
      provider: 'openai',
      model: 'fake-model',
      usageUnknown: true,
      estimatedCostUsd: null,
    });
    expect(parsed.inputTokens).toBeNull();
    expect(parsed.outputTokens).toBeNull();
    expect(parsed.totalTokens).toBeNull();
    expect(parsed.cachedInputTokens).toBeNull();
    expect(parsed.cacheCreationTokens).toBeNull();
    expect(parsed).not.toHaveProperty('error');
    expect(JSON.stringify(parsed)).not.toContain('secret');
  });

  it('records an interrupted outcome when the run is cancelled mid-call, with unknown usage', async () => {
    const events: AiTelemetryEvent[] = [];
    const controller = new AbortController();
    const abort = vi.spyOn(controller, 'abort');
    // Many 10ms-spaced deltas: the 5ms abort fires while the stream is
    // mid-flight, exercising the SDK's onAbort dispatch.
    const deltas: LanguageModelV4StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'text-1' },
      ...Array.from({ length: 12 }, (_, index) => ({
        type: 'text-delta' as const,
        id: 'text-1',
        delta: ` chunk-${index}`,
      })),
      { type: 'text-end', id: 'text-1' },
      {
        type: 'finish',
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: baseUsage,
      },
    ];
    const running = runWith({
      model: modelFromChunks(deltas, 10),
      telemetry: { record: (event) => events.push(event) },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 5);

    expect((await running).status).toBe('aborted');

    expect(abort).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);
    const parsed = AiTelemetryEventSchema.parse(events[0]);
    expect(parsed).toMatchObject({
      event: 'ai.model-call',
      outcome: 'interrupted',
      provider: 'openai',
      model: 'fake-model',
      usageUnknown: true,
      estimatedCostUsd: null,
    });
    expect(parsed.inputTokens).toBeNull();
  });

  it('contains a throwing cost resolver without changing the turn outcome', async () => {
    const events: AiTelemetryEvent[] = [];

    const output = await runWith({
      model: modelFromChunks(textChunks()),
      telemetry: { record: (event) => events.push(event) },
      costResolver: () => {
        throw new Error('pricing table exploded');
      },
    });

    expect(output.status).toBe('completed');
    expect(output.finishReason).toBe('stop');
    expect(events).toHaveLength(1);
    expect(events[0]!.estimatedCostUsd).toBeNull();
  });

  it('contains a throwing telemetry sink without changing the turn outcome', async () => {
    const output = await runWith({
      model: modelFromChunks(textChunks()),
      telemetry: {
        record: async () => {
          throw new Error('sink down');
        },
      },
    });

    expect(output.status).toBe('completed');
    expect(output.finishReason).toBe('stop');
  });

  it('prices the production DI path with cache semantics and null for unknown models', () => {
    // Production DI: no resolver injected — the catalog prices known models,
    // and the AI SDK test harness models are priced deterministically.
    const known = productionCostEstimate('anthropic', 'claude-haiku-4-5', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
      cacheReadTokens: 400_000,
      cacheWriteTokens: 100_000,
    });
    // The 1M input total INCLUDES the 400k read and the 100k written, so
    // fresh input is 500k: 500k @ $1/M + cacheRead 400k @ $0.1/M + cacheWrite
    // 100k @ $1.25/M + output 1M @ $5/M = 0.5 + 0.04 + 0.125 + 5. Pricing the
    // write as fresh input as well would make it 5.765.
    expect(known).toBeCloseTo(5.665, 6);
    // Unknown models are a real null, never 0.
    expect(
      productionCostEstimate('unknown-provider', 'unknown-model', {
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      }),
    ).toBeNull();
    // A throwing resolver is contained at the boundary: null, never a throw.
    expect(
      safeCostEstimate(
        () => {
          throw new Error('pricing exploded');
        },
        'anthropic',
        'claude-haiku-4-5',
        {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
      ),
    ).toBeNull();
    // Raw catalog resolver and provider-name normalization are coherent.
    expect(
      catalogCostEstimate('mock-provider', 'mock-model', {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      }),
    ).toBeGreaterThan(0);
    expect(catalogProviderOf('anthropic.messages')).toBe('anthropic');
  });

  it('exposes the CC-12 price accessors the /usage cost report shares', () => {
    // The one table, one key format, one arithmetic: /usage imports exactly
    // these, so the endpoint and the telemetry estimate cannot drift.
    expect(catalogPriceForModel('anthropic:claude-haiku-4-5')).toEqual({
      input: 1,
      output: 5,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    });
    expect(catalogPriceForModel('anthropic:claude-9-imaginary')).toBeUndefined();
    expect(modelKeyOf('anthropic', 'claude-haiku-4-5')).toBe('anthropic:claude-haiku-4-5');

    // The counters form and the usage form are the same numbers down the
    // same arithmetic (module rounding).
    const counters = {
      inputTokens: 10,
      outputTokens: 4,
      cachedInputTokens: 2,
      cacheCreationTokens: 1,
    };
    const viaCounters = usdForTokenCounters(
      catalogPriceForModel('mock-provider:mock-model')!,
      counters,
    );
    expect(viaCounters).toBeCloseTo(
      catalogCostEstimate('mock-provider', 'mock-model', {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      })!,
      12,
    );
    // 10 input tokens at $2/M with $2 fallbacks for the cache columns plus
    // 4 output tokens at $6/M: fresh 7@2 + reads 2@2 + writes 1@2 + out 4@6
    // = 44e-6, the same number the per-call telemetry event reports.
    expect(viaCounters).toBeCloseTo(0.000044, 12);
  });

  it('keeps unknown usage distinguishable from measured zero', () => {
    // The usage shape the run backend projects: absent counters, said so.
    const unknown = {
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      usageUnknown: true,
    };
    expect(projectUsageForEvent(unknown)).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cachedInputTokens: null,
      cacheCreationTokens: null,
      usageUnknown: true,
    });
    const measuredZero = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usageUnknown: false,
    };
    const projectedZero = projectUsageForEvent(measuredZero);
    expect(projectedZero.usageUnknown).toBe(false);
    expect(projectedZero.inputTokens).toBe(0);
    expect(projectedZero.outputTokens).toBe(0);
    expect(projectedZero.totalTokens).toBe(0);
    expect(projectedZero).not.toEqual(projectUsageForEvent(unknown));
  });
});
