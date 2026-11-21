import { describe, expect, it } from 'vitest';
import {
  bucketTurnsByUtcDay,
  costOfTurn,
  roundToMicroUsd,
  type TurnUsageRow,
} from '../src/usage/usage.service.js';
import { catalogCostEstimate } from '../src/telemetry/ai-telemetry.js';

/**
 * CC-12 — the pure half of the cost report.
 *
 * `GET /usage` reports money beside the tokens, priced per turn from the
 * billing identity each turn recorded (the resolved `provider:model`) with
 * the same catalog and arithmetic as the per-call telemetry estimate. These
 * tests pin the arithmetic and the honesty rules without a database: unknown
 * or missing identity is a real null (never 0), a measured nothing is a real
 * 0 (whatever the model), a bucket containing unpriceable spend is null, and
 * rounding happens once per bucket at micro-dollar resolution.
 */

type TurnSeed = { botId: string; startedAt: string } & Partial<
  Omit<TurnUsageRow, 'botId' | 'startedAt'>
>;

function turn(seed: TurnSeed): TurnUsageRow {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    modelId: null,
    ...seed,
    startedAt: new Date(seed.startedAt),
  };
}

describe('CC-12 — per-turn cost from the recorded billing identity', () => {
  it('prices the counters cache-aware, by the same arithmetic as the telemetry estimate', () => {
    // Haiku rates: input $1/M, output $5/M, cache read $0.1/M, write $1.25/M.
    // The input total includes both cache subsets, so fresh input is 500k:
    // 0.5 + 0.04 + 0.125 + 5 = 5.665.
    const counters = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 400_000,
      cacheCreationTokens: 100_000,
    };

    const cost = costOfTurn({ modelId: 'anthropic:claude-haiku-4-5', ...counters });

    expect(cost).toBeCloseTo(5.665, 9);
    // The one-arithmetic fence: /usage and the per-call telemetry estimate
    // can never disagree about the same numbers (CC-12's whole point).
    expect(
      catalogCostEstimate('anthropic', 'claude-haiku-4-5', {
        inputTokens: counters.inputTokens,
        outputTokens: counters.outputTokens,
        totalTokens: counters.inputTokens + counters.outputTokens,
        cacheReadTokens: counters.cachedInputTokens,
        cacheWriteTokens: counters.cacheCreationTokens,
      }),
    ).toBeCloseTo(cost!, 12);
  });

  it('prices each turn by its own model, not one model for the whole bucket', () => {
    // Opus input $5/M on one turn, gpt-5-mini output $2/M on another. A
    // bucket priced from a single model would be wrong for the other turn —
    // which is exactly why the runner records the identity per turn (the
    // composer's model picker switches bots between sends).
    const [bucket] = bucketTurnsByUtcDay([
      turn({
        botId: 'bot-cost',
        startedAt: '2026-09-01T09:00:00Z',
        modelId: 'anthropic:claude-opus-4-5',
        inputTokens: 1_000_000,
      }),
      turn({
        botId: 'bot-cost',
        startedAt: '2026-09-01T10:00:00Z',
        modelId: 'openai:gpt-5-mini',
        outputTokens: 1_000_000,
      }),
    ]);

    expect(bucket!.estimatedCostUsd).toBe(7); // 5 + 2
  });

  it('keeps unknown and unrecorded models a real null, never a fabricated 0', () => {
    // No billing identity (rows settled before CC-12, or a call that never
    // settled) — the bot's current model is not evidence of what ran.
    expect(costOfTurn({ modelId: null, inputTokens: 10, outputTokens: 4 })).toBeNull();
    // A recorded key with no catalog entry (any registry-valid model is
    // configurable) is unknown too.
    expect(
      costOfTurn({ modelId: 'anthropic:claude-9-imaginary', inputTokens: 10, outputTokens: 4 }),
    ).toBeNull();
    // A malformed or alias value can never match a price row.
    expect(costOfTurn({ modelId: 'mock-model', inputTokens: 10, outputTokens: 4 })).toBeNull();
    expect(costOfTurn({ modelId: 'default', inputTokens: 10, outputTokens: 4 })).toBeNull();
  });

  it('treats a measured nothing as a real 0, whatever the model', () => {
    const zeros = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    };
    expect(costOfTurn({ modelId: null, ...zeros })).toBe(0);
    expect(costOfTurn({ modelId: 'anthropic:claude-9-imaginary', ...zeros })).toBe(0);
    expect(costOfTurn({ modelId: 'mock-provider:mock-model', ...zeros })).toBe(0);
  });
});

describe('CC-12 — money in the (bot, day) bucket', () => {
  it('sums priced turns and poisons the bucket to null when any turn is unpriceable', () => {
    const rows = bucketTurnsByUtcDay([
      turn({
        botId: 'bot-poison',
        startedAt: '2026-09-01T08:00:00Z',
        modelId: 'mock-provider:mock-model', // input $2/M
        inputTokens: 1_000_000,
      }),
      // Measured spend with no recorded model: the day's total cannot be
      // complete, so the bucket is null — a partial sum would read as the
      // day's money and silently understate it.
      turn({ botId: 'bot-poison', startedAt: '2026-09-01T09:00:00Z', inputTokens: 500_000 }),
    ]);

    expect(rows).toHaveLength(1);
    // The tokens still sum and report as measured.
    expect(rows[0]!.inputTokens).toBe(1_500_000);
    expect(rows[0]!.estimatedCostUsd).toBeNull();
  });

  it('lets a zero-usage legacy turn contribute a true 0 without poisoning the bucket', () => {
    const [bucket] = bucketTurnsByUtcDay([
      // A turn that measured nothing (settled zeros, no model) is a real $0,
      // not an unknown — so it must not null a day whose other turns price.
      turn({ botId: 'bot-zero', startedAt: '2026-09-01T08:00:00Z' }),
      turn({
        botId: 'bot-zero',
        startedAt: '2026-09-01T09:00:00Z',
        modelId: 'mock-provider:mock-model',
        inputTokens: 1_000_000,
      }),
    ]);

    expect(bucket!.estimatedCostUsd).toBe(2);
  });

  it('rounds the day total once at micro-dollar resolution, never per turn', () => {
    // Two turns of 3 qwen-flash input tokens each: 3 × $0.15/M = 4.5e-7 per
    // turn — below half a micro-dollar EACH, but 9e-7 together, which rounds
    // up. Per-turn rounding would drop both to 0 and lose the cents the day
    // actually accrued at this resolution.
    const [bucket] = bucketTurnsByUtcDay([
      turn({
        botId: 'bot-round',
        startedAt: '2026-09-01T08:00:00Z',
        modelId: 'openrouter:qwen/qwen3.8-flash',
        inputTokens: 3,
      }),
      turn({
        botId: 'bot-round',
        startedAt: '2026-09-01T09:00:00Z',
        modelId: 'openrouter:qwen/qwen3.8-flash',
        inputTokens: 3,
      }),
    ]);

    expect(bucket!.estimatedCostUsd).toBe(0.000001);
  });
});

describe('CC-12 — micro-dollar rounding semantics', () => {
  it('rounds to 6 decimal places, half away from zero at the boundary', () => {
    expect(roundToMicroUsd(0)).toBe(0);
    // Float noise from the rates must not reach the wire.
    expect(roundToMicroUsd(0.30000000000000004)).toBe(0.3);
    expect(roundToMicroUsd(5.765)).toBe(5.765);
    // Exactly half a micro-dollar rounds up.
    expect(roundToMicroUsd(0.0000005)).toBe(0.000001);
    // Anything below it rounds to a displayed 0 — "less than half a
    // micro-dollar", which is the resolution this wire reports at.
    expect(roundToMicroUsd(0.0000004)).toBe(0);
  });
});
