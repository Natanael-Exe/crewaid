import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EventType,
  fromSpecTokenUsage,
  type AdapterYieldChunk,
  type AnyTextAdapter,
  type TokenUsage,
} from '@tanstack/ai';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  ModelAllowanceExhaustedError,
  type IncludedModels,
} from '../../models/included-models.port.js';
import {
  catalogPriceForModel,
  modelKeyOf,
  usdForTokenCounters,
} from '../../telemetry/ai-telemetry.js';
import type { BillingConfig } from './billing.config.js';
import { BillingService } from './billing.service.js';
import { BILLING_CONFIG } from './billing.tokens.js';
import { TurnEventBus } from '../../agent/turn-event.bus.js';
import { buildTextAdapter } from '../../models/tanstack/text-adapter.js';
import { isSpecUsage, normalizeUsage } from '../../models/tanstack/usage.js';
import { crossedLevel } from './usage-notice.js';
import {
  DEFAULT_INCLUDED_MODEL,
  INCLUDED_CONNECTION_NAME,
  INCLUDED_MODEL_LIST,
} from './included-models.js';

/**
 * The models a hosted plan includes.
 *
 * Each account gets a `crewaid` connection holding the included models, made
 * the first time anything lists models for it. A call to one goes out on
 * Crewaid's OpenRouter key and is charged to the account's allowance at the
 * cost OpenRouter reports for it.
 *
 * The meter is around the model, not in the turn
 *
 * Middleware on the language model itself, so every call is charged whoever
 * makes it: a turn, but also memory distillation and skill compilation, which
 * call the model directly and never create a turn. Metering in the turn loop
 * would leave those free — and they run on their own schedule.
 *
 * Refused before a call, charged after it
 *
 * Each call checks the allowance first and is charged when it finishes, so
 * the call that crosses the line completes and the next one is refused. The
 * overrun is at most one call; refusing mid-stream would cut a reply off
 * half-written and still owe OpenRouter for it.
 */
@Injectable()
export class IncludedModelsService implements IncludedModels {
  private readonly logger = new Logger(IncludedModelsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
  ) {}

  async ensureFor(userId: string): Promise<void> {
    const existing = await this.prisma.providerConnection.findFirst({
      where: { userId, kind: 'CREWAID' },
      select: { models: { select: { upstreamModelId: true } } },
    });
    const have = new Set(existing?.models.map((model) => model.upstreamModelId) ?? []);
    if (existing !== null && INCLUDED_MODEL_LIST.every((m) => have.has(m.upstreamModelId))) return;

    // Two model lists rendering at once would otherwise both create the
    // connection, or both add the same model. One lock per account.
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`crewaid-included:${userId}`}))`;
      await this.provision(tx, userId);
    });
  }

  async textAdapter(userId: string, upstreamModelId: string): Promise<AnyTextAdapter> {
    await this.assertAllowance(userId);
    return this.meterAdapter(userId, upstreamModelId, this.upstreamText(upstreamModelId));
  }

  /**
   * The model as OpenRouter serves it on Crewaid's key, before the meter. Its
   * own method so the tests can put a scripted adapter here and exercise the
   * meter around it.
   */
  upstreamText(upstreamModelId: string): AnyTextAdapter {
    const key = this.config.openrouterKey;
    if (key === null) {
      throw new Error('included models need CREWAID_OPENROUTER_API_KEY');
    }
    return buildTextAdapter({
      kind: 'openrouter',
      apiKey: key,
      endpoint: null,
      upstreamModelId,
    }).adapter;
  }

  /**
   * A read-only look before a turn starts, so a spent allowance is refused at
   * resolution rather than at the first step. The binding check is the
   * reservation each call makes.
   */
  private async assertAllowance(userId: string): Promise<void> {
    const entitlement = await this.billing.entitlementFor(userId);
    if (entitlement.period === null) throw new ModelAllowanceExhaustedError();
    const allowance = entitlement.modelAllowanceMicroUsd;
    if (allowance === null) return;
    const used = await this.billing.modelMicroUsdUsed(userId, entitlement.period.start);
    if (used >= allowance) throw new ModelAllowanceExhaustedError();
  }

  /**
   * The allowance meter: each model call the engine
   * makes through the adapter reserves first and settles once, before its
   * `RUN_FINISHED` reaches the engine, so the next step is admitted after this
   * one's charge. A consumer that stops early (abort, cancel) and a stream that
   * fails part-way settle at an estimate of what was used; a call that failed
   * before producing anything settles at zero; one whose usage never came back
   * keeps its whole reservation. Every other adapter property is the
   * upstream's own.
   */
  private meterAdapter(
    userId: string,
    upstreamModelId: string,
    upstream: AnyTextAdapter,
  ): AnyTextAdapter {
    const reserve = (options: { systemPrompts?: unknown; messages?: unknown }) =>
      this.reserve(userId, upstreamModelId, {
        prompt: [options.systemPrompts ?? null, options.messages ?? null],
      });
    const settle = (hold: Hold, cost: number) => this.settle(userId, hold, cost);
    const charged = (hold: Hold, usage: FinishUsage) => {
      const library = usage !== undefined && isSpecUsage(usage) ? fromSpecTokenUsage(usage) : usage;
      return library === undefined ? hold.reserved : tanstackCostMicroUsd(upstreamModelId, library);
    };
    const metered = (
      options: { systemPrompts?: unknown; messages?: unknown },
      source: () => AsyncIterable<AdapterYieldChunk>,
    ): AsyncIterable<AdapterYieldChunk> => ({
      async *[Symbol.asyncIterator]() {
        const hold = await reserve(options);
        let settled = false;
        let produced = 0;
        const settleOnce = async (cost: number) => {
          if (settled) return;
          settled = true;
          await settle(hold, cost);
        };
        const partial = () =>
          hold.promptEstimate +
          estimateMicroUsd(upstreamModelId, 0, Math.ceil(produced / CHARS_PER_TOKEN));
        try {
          for await (const chunk of source()) {
            produced += deltaLength(chunk);
            if (chunk.type === EventType.RUN_FINISHED) await settleOnce(charged(hold, chunk.usage));
            else if (chunk.type === EventType.RUN_ERROR) await settleOnce(partial());
            yield chunk;
          }
        } catch (error: unknown) {
          await settleOnce(produced === 0 ? 0 : partial());
          throw error;
        } finally {
          // The consumer stopped early, or the stream ended without finishing.
          await settleOnce(partial());
        }
      },
    });
    return new Proxy(upstream, {
      get(target, property) {
        if (property === 'chatStream')
          return (options: Parameters<AnyTextAdapter['chatStream']>[0]) =>
            metered(options, () => target.chatStream(options));
        if (property === 'structuredOutputStream') {
          const stream = target.structuredOutputStream;
          if (stream === undefined) return undefined;
          return (options: Parameters<AnyTextAdapter['structuredOutput']>[0]) =>
            metered(options.chatOptions, () => stream.call(target, options));
        }
        if (property === 'structuredOutput')
          return async (options: Parameters<AnyTextAdapter['structuredOutput']>[0]) => {
            const hold = await reserve(options.chatOptions);
            let result: Awaited<ReturnType<AnyTextAdapter['structuredOutput']>>;
            try {
              result = await target.structuredOutput(options);
            } catch (error: unknown) {
              const aborted = options.chatOptions.abortController?.signal.aborted === true;
              await settle(hold, aborted ? hold.promptEstimate : 0);
              throw error;
            }
            await settle(hold, charged(hold, result.usage));
            return result;
          };
        const value: unknown = Reflect.get(target, property, target);
        return value;
      },
    });
  }

  /** Reserve one call's estimate, or refuse it: no plan, or the allowance is spent. */
  private async reserve(
    userId: string,
    upstreamModelId: string,
    params: { readonly prompt: unknown; readonly maxOutputTokens?: number | undefined },
  ): Promise<Hold> {
    const entitlement = await this.billing.entitlementFor(userId);
    if (entitlement.period === null) throw new ModelAllowanceExhaustedError();
    const promptTokens = Math.ceil(JSON.stringify(params.prompt).length / CHARS_PER_TOKEN);
    const promptEstimate = estimateMicroUsd(upstreamModelId, promptTokens, 0);
    const outputTokens = params.maxOutputTokens ?? RESERVED_OUTPUT_TOKENS;
    const reserved = promptEstimate + estimateMicroUsd(upstreamModelId, 0, outputTokens);
    const chargeId = await this.billing.reserveModelCharge(
      userId,
      entitlement.period,
      entitlement.modelAllowanceMicroUsd,
      upstreamModelId,
      reserved,
    );
    if (chargeId === null) throw new ModelAllowanceExhaustedError();
    return {
      chargeId,
      promptEstimate,
      reserved,
      allowance: entitlement.modelAllowanceMicroUsd,
      resetsAt: entitlement.period.end.toISOString(),
    };
  }

  /**
   * Settle a reservation to `cost`, retrying a failed write. Never throws: the
   * reply has been delivered by now, and a settle that cannot be written
   * leaves the reservation counted — charged at the estimate, not lost.
   */
  private async settle(userId: string, hold: Hold, cost: number): Promise<void> {
    for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt += 1) {
      try {
        const totals = await this.billing.settleModelCharge(userId, hold.chargeId, cost);
        if (totals === null) return;
        const level = crossedLevel(totals.before, totals.after, hold.allowance);
        if (level !== null) {
          this.events.emitUsageNotice(userId, { kind: 'model', level, resetsAt: hold.resetsAt });
        }
        return;
      } catch (error: unknown) {
        if (attempt === SETTLE_ATTEMPTS) {
          this.logger.error(
            `included model charge ${hold.chargeId} not settled; its reservation stands: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100 * 4 ** (attempt - 1)));
      }
    }
  }

  /** The connection, the models it is missing, and a default if the account has nothing else. */
  private async provision(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    const found = await tx.providerConnection.findFirst({
      where: { userId, kind: 'CREWAID' },
      select: { id: true, models: { select: { upstreamModelId: true } } },
    });
    const connection =
      found ??
      (await tx.providerConnection.create({
        data: { userId, kind: 'CREWAID', name: INCLUDED_CONNECTION_NAME, state: 'ACTIVE' },
        select: { id: true, models: { select: { upstreamModelId: true } } },
      }));
    const have = new Set(connection.models.map((model) => model.upstreamModelId));
    const missing = INCLUDED_MODEL_LIST.filter((model) => !have.has(model.upstreamModelId));
    if (missing.length > 0) {
      await tx.providerModel.createMany({
        data: missing.map((model) => ({
          connectionId: connection.id,
          upstreamModelId: model.upstreamModelId,
          label: model.label,
          contextWindow: model.contextWindow,
          supportsTools: model.tools,
          supportsVision: model.vision,
          supportsReasoning: model.reasoning,
        })),
      });
    }
    if (found !== null) return;

    // A new account's bots carry the `default` alias, so they need a default
    // to run at all. Set only when this is the account's first way to answer:
    // a default someone chose, or a connection of their own, is theirs.
    const settings = await tx.userSettings.findFirst({
      where: { userId },
      select: { defaultModelId: true },
    });
    const ownActive = await tx.providerConnection.count({
      where: { userId, kind: { not: 'CREWAID' }, state: 'ACTIVE' },
    });
    if ((settings?.defaultModelId ?? null) !== null || ownActive > 0) return;
    const model = await tx.providerModel.findFirst({
      where: { connection: { id: connection.id, userId }, upstreamModelId: DEFAULT_INCLUDED_MODEL },
      select: { id: true },
    });
    if (model === null) return;
    await tx.userSettings.upsert({
      where: { userId },
      create: { userId, defaultModelId: model.id },
      update: { defaultModelId: model.id },
    });
  }
}

/** A reserved call: its charge row, and what settling needs to know. */
type Hold = {
  readonly chargeId: string;
  /** The prompt's estimated cost: what an aborted call is charged at least. */
  readonly promptEstimate: number;
  /** The whole reservation: what a call whose usage never came back is charged. */
  readonly reserved: number;
  readonly allowance: number | null;
  readonly resetsAt: string;
};

/** A rough count, for estimates only; an exact one comes back with `finish`. */
const CHARS_PER_TOKEN = 4;
/** Output reserved for a call that names no limit; settled to the real figure. */
const RESERVED_OUTPUT_TOKENS = 4096;
const SETTLE_ATTEMPTS = 3;

type CallUsage = {
  readonly inputTokens: {
    readonly total?: number | undefined;
    readonly cacheRead?: number | undefined;
    readonly cacheWrite?: number | undefined;
  };
  readonly outputTokens: { readonly total?: number | undefined };
};

/**
 * What one call cost, in micro-dollars: OpenRouter's own figure when it sends
 * one, and the price table's estimate from the call's tokens otherwise.
 * Exported for the unit tests.
 */
export function costMicroUsd(upstreamModelId: string, usage: CallUsage, metadata: unknown): number {
  const reported = reportedCostUsd(metadata);
  if (reported !== null) return Math.ceil(reported * 1_000_000);
  const price = catalogPriceForModel(modelKeyOf('openrouter', upstreamModelId));
  if (price === undefined) return 0;
  const usd = usdForTokenCounters(price, {
    inputTokens: usage.inputTokens.total ?? 0,
    outputTokens: usage.outputTokens.total ?? 0,
    cachedInputTokens: usage.inputTokens.cacheRead ?? 0,
    cacheCreationTokens: usage.inputTokens.cacheWrite ?? 0,
  });
  return Math.ceil(usd * 1_000_000);
}

/** The price table's figure for a token count, in micro-dollars. Exported for the unit tests. */
export function estimateMicroUsd(
  upstreamModelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  return costMicroUsd(
    upstreamModelId,
    { inputTokens: { total: inputTokens }, outputTokens: { total: outputTokens } },
    undefined,
  );
}

/** `providerMetadata.openrouter.usage.cost`, in dollars, when it is a real number. */
function reportedCostUsd(metadata: unknown): number | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const openrouter = (metadata as { openrouter?: unknown }).openrouter;
  if (typeof openrouter !== 'object' || openrouter === null) return null;
  const usage = (openrouter as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return null;
  const cost = (usage as { cost?: unknown }).cost;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null;
}

/** A TanStack call's cost: OpenRouter's reported figure, else the price table's. */
export function tanstackCostMicroUsd(upstreamModelId: string, usage: TokenUsage): number {
  const reported = usage.cost;
  if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0)
    return Math.ceil(reported * 1_000_000);
  const counters = normalizeUsage('openrouter', usage);
  return costMicroUsd(
    upstreamModelId,
    {
      inputTokens: {
        total: counters?.inputTokens,
        cacheRead: counters?.cachedInputTokens,
        cacheWrite: counters?.cacheCreationTokens,
      },
      outputTokens: { total: counters?.outputTokens },
    },
    undefined,
  );
}

/** What a finished call reports: the library's usage, or the AG-UI spec's array of it. */
type FinishUsage = TokenUsage | Parameters<typeof fromSpecTokenUsage>[0] | undefined;

/** Characters a chunk streamed, for the estimate a call that never finishes is charged. */
function deltaLength(chunk: AdapterYieldChunk): number {
  return 'delta' in chunk && typeof chunk.delta === 'string' ? chunk.delta.length : 0;
}
