import { Injectable, Logger } from '@nestjs/common';
import { MODEL_ID_SEPARATOR } from '@crewaid/shared';
import { z } from 'zod';

export const AiTelemetryOutcomeSchema = z.enum(['success', 'error', 'interrupted']);
export type AiTelemetryOutcome = z.infer<typeof AiTelemetryOutcomeSchema>;

/**
 * Numeric usage only; raw provider usage is intentionally not part of this
 * contract. `undefined` means the provider did not report the count —
 * unknown is preserved as unknown, never coerced into a measured zero.
 */
export type AiTelemetryUsage = {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
  cacheReadTokens: number | undefined;
  cacheWriteTokens: number | undefined;
};

export type AiTelemetryUsageWithUnknown = AiTelemetryUsage & { usageUnknown: boolean };

/**
 * Privacy-safe, structured model-call telemetry. Prompts, outputs, headers,
 * credentials, provider metadata, and error messages are intentionally absent.
 * Nullable numeric fields mean "the provider did not report this count" —
 * a real zero is always reported as 0 with usageUnknown false.
 */
export const AiTelemetryEventSchema = z.object({
  schemaVersion: z.literal(1),
  event: z.literal('ai.model-call'),
  outcome: AiTelemetryOutcomeSchema,
  provider: z.string().min(1).max(128),
  model: z.string().min(1).max(256),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  cacheCreationTokens: z.number().int().nonnegative().nullable(),
  usageUnknown: z.boolean(),
  latencyMs: z.number().finite().nonnegative(),
  estimatedCostUsd: z.number().finite().nonnegative().nullable(),
  botId: z.string().min(1).max(128).optional(),
  conversationId: z.string().min(1).max(128).optional(),
  chainId: z.string().min(1).max(128).optional(),
  turnId: z.string().min(1).max(128).optional(),
  runId: z.string().min(1).max(128).optional(),
  errorCode: z
    .string()
    .regex(/^[A-Z0-9_]+$/)
    .optional(),
});
export type AiTelemetryEvent = z.infer<typeof AiTelemetryEventSchema>;

export type AiTelemetrySink = {
  record(event: AiTelemetryEvent): void | Promise<void>;
};

export type AiTelemetryCostResolver = (
  provider: string,
  model: string,
  usage: AiTelemetryUsage,
) => number | null;

export const AI_TELEMETRY = Symbol('AI_TELEMETRY');

/**
 * Projects a call's usage onto the closed event schema. Measured counts stay
 * non-negative integers; unreported or malformed counts become null so
 * unknown never masquerades as a measured zero.
 */
export function projectUsageForEvent(usage: AiTelemetryUsageWithUnknown): {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationTokens: number | null;
  usageUnknown: boolean;
} {
  const measured = (value: number | undefined): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  const inputTokens = measured(usage.inputTokens);
  const outputTokens = measured(usage.outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      usage.totalTokens !== undefined
        ? measured(usage.totalTokens)
        : inputTokens !== null && outputTokens !== null
          ? inputTokens + outputTokens
          : null,
    cachedInputTokens: measured(usage.cacheReadTokens),
    cacheCreationTokens: measured(usage.cacheWriteTokens),
    usageUnknown: usage.usageUnknown,
  };
}

/**
 * Wraps the cost resolver so pricing can never alter turn semantics. A
 * resolver failure is a telemetry gap (null), never a turn failure.
 */
export function safeCostEstimate(
  resolver: AiTelemetryCostResolver,
  provider: string,
  model: string,
  usage: AiTelemetryUsage,
): number | null {
  try {
    const cost = resolver(provider, model, usage);
    if (cost === null) return null;
    return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null;
  } catch {
    return null;
  }
}

/**
 * Deterministic per-1M-token USD prices for the supported catalog — CC-12's
 * cost table. Cached reads bill at a fraction of fresh input (D-009(3):
 * CC-11 prompt caching); cache creation bills at the write premium. Unknown
 * provider/model pairs resolve to null — a real unknown price, never 0.
 *
 * The `mock-provider` entries are test-harness models, priced so tests can
 * exercise the production DI path without any network calls.
 */
export type ModelPriceRates = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

const MODEL_PRICES_PER_MILLION_USD: Record<string, ModelPriceRates> = {
  'anthropic:claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'anthropic:claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'anthropic:claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'openai:gpt-5.1': { input: 1.25, output: 10, cacheRead: 0.125 },
  'openai:gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025 },
  'openrouter:moonshotai/kimi-k3': { input: 3, output: 15 },
  'openrouter:z-ai/glm-5.2': { input: 0.966, output: 3.036 },
  'openrouter:z-ai/glm-5.3': { input: 1.4, output: 4.4 },
  'openrouter:z-ai/glm-5.3-flash': { input: 0.15, output: 0.5 },
  'openrouter:x-ai/grok-4.5': { input: 2, output: 6 },
  'openrouter:x-ai/grok-4.6': { input: 2, output: 6 },
  'openrouter:deepseek/deepseek-v4-pro-0813': { input: 0.66, output: 1.98 },
  'openrouter:deepseek/deepseek-v4-flash-vision-exp': { input: 0.22, output: 0.66 },
  'openrouter:google/gemini-3.8-flash': { input: 0.75, output: 3.75 },
  'openrouter:qwen/qwen3.8-flash': { input: 0.15, output: 0.47 },
  // The included models that the rows above do not already price. Every
  // included model must have a row: it is the charge when OpenRouter reports
  // no cost for a call, and an included model with no price would be free.
  // From OpenRouter's /api/v1/models on 2026-10-02.
  'openrouter:anthropic/claude-haiku-4.5': { input: 1, output: 5 },
  'openrouter:openai/gpt-5-mini': { input: 0.25, output: 2 },
  // Test-harness models (production-DI-path tests only).
  'mock-provider:mock-model': { input: 2, output: 6 },
  'mock-provider:mock-model-id': { input: 2, output: 6 },
};

/**
 * The price table's key format — `provider:model`, the registry separator —
 * so the billing identity a turn records is literally the table key. One
 * format, defined in `@crewaid/shared`, used everywhere.
 */
export function modelKeyOf(provider: string, model: string): string {
  return `${provider}${MODEL_ID_SEPARATOR}${model}`;
}

/**
 * The catalog rates for a `provider:model` key, or `undefined` when the
 * model has no entry — a real unknown price, never a fabricated zero. The
 * ONE lookup shared by the per-call telemetry estimate and the /usage
 * cost report, so the two money numbers can never disagree.
 */
export function catalogPriceForModel(modelKey: string): ModelPriceRates | undefined {
  return MODEL_PRICES_PER_MILLION_USD[modelKey];
}

/**
 * The cost arithmetic: fresh input at the input rate, cache reads at the
 * read rate, cache writes at the write rate, output at the output rate. A
 * rate a row omits falls back to the input rate. Pure and UNROUNDED — the
 * callers decide where money rounds (the /usage wire rounds once per bucket;
 * the telemetry event keeps the raw estimate).
 *
 * Fresh input is the total input minus both cache subsets, because Anthropic's
 * adapter reports `total = noCache + cacheWrite + cacheRead` — subtracting only
 * cache reads would double-bill cache writes.
 */
export function usdForTokenCounters(
  price: ModelPriceRates,
  counters: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheCreationTokens: number;
  },
): number {
  const perMillion = (tokens: number, rate: number): number => (tokens / 1_000_000) * rate;
  const freshInput = Math.max(
    0,
    counters.inputTokens - counters.cachedInputTokens - counters.cacheCreationTokens,
  );
  return (
    perMillion(freshInput, price.input) +
    perMillion(counters.cachedInputTokens, price.cacheRead ?? price.input) +
    perMillion(counters.cacheCreationTokens, price.cacheWrite ?? price.input) +
    perMillion(counters.outputTokens, price.output)
  );
}

export function catalogCostEstimate(
  provider: string,
  model: string,
  usage: AiTelemetryUsage,
): number | null {
  const price = catalogPriceForModel(modelKeyOf(provider, model));
  if (price === undefined) {
    return null;
  }
  // No token counts reported (mid-stream failure/abort): pricing a
  // fabricated 0 would understate spend, so the cost is genuinely unknown.
  if (
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.totalTokens === undefined
  ) {
    return null;
  }
  return usdForTokenCounters(price, {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens: usage.cacheReadTokens ?? 0,
    cacheCreationTokens: usage.cacheWriteTokens ?? 0,
  });
}

/** The resolver wired by production DI (no injection overrides it). */
export const productionCostEstimate: AiTelemetryCostResolver = catalogCostEstimate;

/** Registry providers are tool-spaced ('anthropic.messages'); catalog keys are not. */
export function catalogProviderOf(provider: string): string {
  return provider.split('.')[0]!;
}

@Injectable()
export class AiTelemetryService implements AiTelemetrySink {
  private readonly logger = new Logger(AiTelemetryService.name);

  record(event: AiTelemetryEvent): void {
    // Parse the closed contract before logging. This sink never accepts an
    // arbitrary object, so credentials and raw auth material cannot leak via
    // accidental fields or provider error objects.
    const safe = AiTelemetryEventSchema.parse(event);
    this.logger.log(JSON.stringify(safe));
  }
}
