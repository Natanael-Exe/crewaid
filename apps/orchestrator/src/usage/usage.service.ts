import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { UsageQuery, UsageResponse } from '@crewaid/shared';
import { catalogPriceForModel, usdForTokenCounters } from '../telemetry/ai-telemetry.js';
import { PrismaService } from '../prisma/prisma.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The resolution money is reported at: micro-dollars (6 dp). The
 * cheapest catalog rates are fractions of a micro-dollar per token (e.g.
 * glm-5.3-flash at $0.075/M → $0.000000075/token), so whole cents would
 * render almost every small day as $0.00, and a raw float sum would put
 * `0.30000000000000004` on the wire. Rounding happens ONCE per (bot, day)
 * bucket — never per turn — so displayed rows are the rounded totals of
 * unrounded sums, not sums of rounded parts.
 */
export const USD_MICRO_SCALE = 1_000_000;

export function roundToMicroUsd(usd: number): number {
  return Math.round(usd * USD_MICRO_SCALE) / USD_MICRO_SCALE;
}

/**
 * One (bot, day) bucket: the four D-009(3) counters summed over the day's
 * turns plus CC-12's money. The wire response projects the counters and the
 * cost; the cache counters are summed here in one place so CC-05's cap
 * arithmetic and CC-12's cost math reuse these totals instead of re-deriving
 * them from a second query.
 */
export type UsageDayBucket = {
  botId: string;
  /** UTC calendar date, `YYYY-MM-DD`. */
  day: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  /**
   * The day's estimated spend in USD, priced per turn from each
   * turn's own recorded billing model (see `costOfTurn`) and rounded to
   * micro-dollars once, at the end. `null` when ANY contributing turn's
   * spend cannot be priced — presenting the sum of the priceable turns as
   * the day's money would silently understate spend.
   */
  estimatedCostUsd: number | null;
};

/** The AgentTurn columns a usage query reads — and nothing else. */
export type TurnUsageRow = {
  botId: string;
  startedAt: Date;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  /**
   * The resolved `provider:model` billing key the turn recorded when
   * its model call settled. `null` for rows settled before the column
   * existed, or turns whose call never settled — unpriceable, never guessed
   * from the bot's current configuration.
   */
  modelId: string | null;
};

/** The UTC calendar day a timestamp falls in, as `YYYY-MM-DD`. */
export function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** UTC midnight of an ISO `YYYY-MM-DD` date. */
function utcMidnight(day: string): Date {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date));
}

/**
 * The half-open query window for `?from=&to=` — inclusive UTC calendar dates.
 * `from` after `to` is a client bug, not an empty range: answering 200 with
 * `rows: []` would silently look like "no spend" to a caller that swapped its
 * arguments, and the same pair feeds CC-05's cap — a wrong day there halts
 * the product. It 400s instead.
 */
export function utcWindowFor(query: UsageQuery): { start: Date; endExclusive: Date } {
  const start = utcMidnight(query.from);
  const endInclusive = utcMidnight(query.to);
  if (start.getTime() > endInclusive.getTime()) {
    throw new BadRequestException('`from` must be on or before `to`');
  }
  // Both ends are UTC midnights, so +24h is exact — no DST exists in UTC.
  return { start, endExclusive: new Date(endInclusive.getTime() + DAY_MS) };
}

/** The counters `costOfTurn` reads off a turn (the four D-009(3) columns). */
export type TurnCostCounters = Pick<
  TurnUsageRow,
  'modelId' | 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'cacheCreationTokens'
>;

/**
 * The USD cost of one turn's counters, or null when the spend cannot
 * be priced:
 *
 * - A turn that measured NO tokens (all four counters zero) is a real 0 —
 * nothing was spent, whatever the model. This also keeps legacy zero-usage
 * rows (settled before the billing column existed) a true $0 rather than
 * an unknown.
 * - A turn with measured tokens but no recorded billing identity is null:
 * the pre-CC-12 history has no model to price and the bot's CURRENT model
 * is not evidence of what ran (the composer's model picker PATCHes the bot
 * between sends). Never guessed.
 * - A recorded key with no catalog entry (an operator can configure any
 * registry-valid model) is null too — a real unknown price, never 0.
 * - Otherwise: the shared cost arithmetic — fresh input, cache reads, cache
 * writes and output at the catalog's rates (cache-aware per D-009(3), so
 * the math stays right once CC-11 populates the cache counters).
 *
 * Unrounded by design; the bucket rounds the day's total once.
 */
export function costOfTurn(turn: TurnCostCounters): number | null {
  const measured =
    turn.inputTokens + turn.outputTokens + turn.cachedInputTokens + turn.cacheCreationTokens;
  if (measured === 0) {
    return 0;
  }
  if (turn.modelId === null) {
    return null;
  }
  const price = catalogPriceForModel(turn.modelId);
  if (price === undefined) {
    return null;
  }
  return usdForTokenCounters(price, {
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    cachedInputTokens: turn.cachedInputTokens,
    cacheCreationTokens: turn.cacheCreationTokens,
  });
}

/**
 * Sums turns into (bot, day) buckets, keyed by the turn's UTC start day.
 *
 * Pure and separate from the query on purpose: the bucketing rules — UTC
 * days, absent day means zero, a turn counts in the day it STARTED — are
 * exactly what a fence test can pin without a database.
 *
 * Each turn is priced by its OWN recorded billing model and the raw
 * costs are summed per bucket; the sum rounds to micro-dollars once. A
 * single unpriceable turn poisons the bucket to null rather than letting the
 * rounded remainder read as the day's total.
 */
export function bucketTurnsByUtcDay(turns: readonly TurnUsageRow[]): UsageDayBucket[] {
  type BucketAccumulator = Omit<UsageDayBucket, 'estimatedCostUsd'> & {
    costSum: number;
    costUnknown: boolean;
  };
  const buckets = new Map<string, BucketAccumulator>();

  for (const turn of turns) {
    const day = utcDayKey(turn.startedAt);
    const key = `${turn.botId}\u0000${day}`;
    let existing = buckets.get(key);
    if (existing === undefined) {
      existing = {
        botId: turn.botId,
        day,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        costSum: 0,
        costUnknown: false,
      };
      buckets.set(key, existing);
    }
    existing.inputTokens += turn.inputTokens;
    existing.outputTokens += turn.outputTokens;
    existing.cachedInputTokens += turn.cachedInputTokens;
    existing.cacheCreationTokens += turn.cacheCreationTokens;

    const cost = costOfTurn(turn);
    if (cost === null) {
      existing.costUnknown = true;
    } else {
      existing.costSum += cost;
    }
  }

  return [...buckets.values()]
    .sort((a, b) =>
      a.botId === b.botId ? a.day.localeCompare(b.day) : a.botId.localeCompare(b.botId),
    )
    .map(({ costSum, costUnknown, ...bucket }) => ({
      ...bucket,
      estimatedCostUsd: costUnknown ? null : roundToMicroUsd(costSum),
    }));
}

/**
 * CC-04/CC-12 — the daily token-spend rollup behind `GET /usage?from=&to=`
 * (§7.1): the D-009(3) counters per (bot, day) plus the money they cost.
 *
 * The durable numbers are the counters and the billing identity the turn
 * runner settles onto each AgentTurn row; this service does not recompute
 * spend from telemetry events or logs. R7/D-010: the one query is scoped by
 * the caller's `userId` through the bot relation — a foreign user's turns
 * can never appear, and a bot with no turns contributes no rows (absence is
 * zero; the response never fabricates a zero row for a day nothing
 * happened).
 *
 * CC-12 money semantics: priced per turn from the model that turn recorded,
 * via the same catalog and arithmetic as the per-call telemetry estimate —
 * one cost table, one math. `estimatedCostUsd` is null when any of the day's
 * turns cannot be priced (no recorded model, or one without a catalog rate);
 * a day that measured no tokens is 0.
 */
@Injectable()
export class UsageService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async daily(userId: string, query: UsageQuery): Promise<UsageResponse> {
    const { start, endExclusive } = utcWindowFor(query);

    const turns = await this.prisma.agentTurn.findMany({
      where: {
        bot: { userId },
        startedAt: { gte: start, lt: endExclusive },
      },
      select: {
        botId: true,
        startedAt: true,
        inputTokens: true,
        outputTokens: true,
        cachedInputTokens: true,
        cacheCreationTokens: true,
        modelId: true,
      },
    });

    return {
      rows: bucketTurnsByUtcDay(turns).map(
        ({ botId, day, inputTokens, outputTokens, estimatedCostUsd }) => ({
          botId,
          day,
          inputTokens,
          outputTokens,
          estimatedCostUsd,
        }),
      ),
    };
  }
}
