import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { UsageRowSchema } from '@crewaid/shared';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import {
  bucketTurnsByUtcDay,
  UsageService,
  utcDayKey,
  utcWindowFor,
  type TurnUsageRow,
} from '../src/usage/usage.service.js';

/**
 * CC-04 — the pure half of the daily rollup.
 *
 * The bucketing rules and the window semantics live here, without a database:
 * UTC defines the day, `?from=&to=` are inclusive calendar dates, a turn
 * counts in the day it STARTED, and a (bot, day) nothing happened on produces
 * no row. The integration suite proves the same rules end to end through
 * `GET /usage`; this file pins the arithmetic and the edges (midnight,
 * month/year rollover, from-after-to) exactly, where a regression is a diff
 * rather than a debugging session.
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

describe('CC-04 — UTC day bucketing', () => {
  it('keys a turn by its UTC start day, never the local day', () => {
    expect(utcDayKey(new Date('2026-09-02T00:00:00.000Z'))).toBe('2026-09-02');
    expect(utcDayKey(new Date('2026-09-01T23:59:59.999Z'))).toBe('2026-09-01');
    // 21:00 in UTC-4 is already tomorrow in UTC — the day CC-05's cap must
    // budget by, and the one reason the boundary is defined once, here.
    expect(utcDayKey(new Date('2026-09-01T21:00:00.000-04:00'))).toBe('2026-09-02');
  });

  it('splits turns by bot and sums the four counters per (bot, day)', () => {
    const rows = bucketTurnsByUtcDay([
      turn({
        botId: 'bot-a',
        startedAt: '2026-09-01T08:00:00Z',
        inputTokens: 10,
        outputTokens: 4,
        cachedInputTokens: 2,
        cacheCreationTokens: 1,
      }),
      turn({
        botId: 'bot-a',
        startedAt: '2026-09-01T22:00:00Z',
        inputTokens: 5,
        outputTokens: 3,
      }),
      turn({ botId: 'bot-a', startedAt: '2026-09-02T00:00:00Z', inputTokens: 7, outputTokens: 2 }),
      turn({ botId: 'bot-b', startedAt: '2026-09-01T09:00:00Z', inputTokens: 1, outputTokens: 1 }),
    ]);

    expect(rows).toEqual([
      {
        botId: 'bot-a',
        day: '2026-09-01',
        inputTokens: 15,
        outputTokens: 7,
        cachedInputTokens: 2,
        cacheCreationTokens: 1,
        // No billing identity recorded on these seeds (CC-12): spend is
        // measured but unpriceable — null, not a fabricated 0.
        estimatedCostUsd: null,
      },
      {
        botId: 'bot-a',
        day: '2026-09-02',
        inputTokens: 7,
        outputTokens: 2,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: null,
      },
      {
        botId: 'bot-b',
        day: '2026-09-01',
        inputTokens: 1,
        outputTokens: 1,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: null,
      },
    ]);
  });

  it('keeps adjacent days apart at the midnight boundary', () => {
    const rows = bucketTurnsByUtcDay([
      turn({ botId: 'bot-a', startedAt: '2026-09-01T23:59:59.999Z', inputTokens: 3 }),
      turn({ botId: 'bot-a', startedAt: '2026-09-02T00:00:00.000Z', inputTokens: 4 }),
    ]);

    expect(rows.map((row) => [row.day, row.inputTokens])).toEqual([
      ['2026-09-01', 3],
      ['2026-09-02', 4],
    ]);
  });

  it('produces no bucket when there are no turns (absence is zero)', () => {
    expect(bucketTurnsByUtcDay([])).toEqual([]);
  });
});

describe('CC-04 — the ?from=&to= window', () => {
  it('includes both dates as UTC calendar days', () => {
    const { start, endExclusive } = utcWindowFor({ from: '2026-09-01', to: '2026-09-02' });

    expect(start.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(endExclusive.toISOString()).toBe('2026-09-03T00:00:00.000Z');
  });

  it('treats a single date as a full 24h UTC day', () => {
    const { start, endExclusive } = utcWindowFor({ from: '2026-09-01', to: '2026-09-01' });

    expect(start.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(endExclusive.toISOString()).toBe('2026-09-02T00:00:00.000Z');
    expect(endExclusive.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('rolls over month and year boundaries exactly', () => {
    expect(utcWindowFor({ from: '2026-08-31', to: '2026-09-01' }).endExclusive.toISOString()).toBe(
      '2026-09-02T00:00:00.000Z',
    );
    expect(utcWindowFor({ from: '2026-12-31', to: '2026-12-31' }).endExclusive.toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('rejects an inverted range as a client bug instead of an empty answer', () => {
    // 200 with rows: [] would read as "no spend" to a caller that swapped its
    // arguments — and the same pair feeds CC-05's cap, so it must 400.
    expect(() => utcWindowFor({ from: '2026-09-02', to: '2026-09-01' })).toThrow(
      BadRequestException,
    );
  });
});

describe('CC-04 — wire projection', () => {
  it('projects buckets onto rows the shared schema accepts', () => {
    const [bucket] = bucketTurnsByUtcDay([
      turn({
        botId: 'clx1a2b3c4d5e6f7g8h9i0j1',
        startedAt: '2026-09-01T10:00:00Z',
        inputTokens: 10,
        outputTokens: 4,
        cachedInputTokens: 2,
        cacheCreationTokens: 1,
      }),
    ]);

    // The service projects the four durable counters onto the two token
    // fields the §4.1 contract carries, plus CC-12's money; the row must be
    // exactly what the wire schema says it is.
    const row = {
      botId: bucket!.botId,
      day: bucket!.day,
      inputTokens: bucket!.inputTokens,
      outputTokens: bucket!.outputTokens,
      estimatedCostUsd: bucket!.estimatedCostUsd,
    };
    expect(UsageRowSchema.safeParse(row).success).toBe(true);
    expect(row.day).toBe('2026-09-01');
  });

  it('merges AgentTurn and CodingRun rows in UsageService.daily, pricing each by its own modelId', async () => {
    const turnFindMany = vi.fn().mockResolvedValue([
      {
        botId: 'clx1a2b3c4d5e6f7g8h9i0j1',
        startedAt: new Date('2026-09-01T10:00:00.000Z'),
        inputTokens: 500_000,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        modelId: 'mock-provider:mock-model',
      },
    ]);
    const codingRunFindMany = vi.fn().mockResolvedValue([
      {
        botId: 'clx1a2b3c4d5e6f7g8h9i0j1',
        startedAt: new Date('2026-09-01T10:05:00.000Z'),
        inputTokens: 0,
        outputTokens: 500_000,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        modelId: 'mock-provider:mock-model',
      },
    ]);

    const service = new UsageService({
      agentTurn: { findMany: turnFindMany },
      codingRun: { findMany: codingRunFindMany },
    } as unknown as PrismaService);

    const response = await service.daily('user-1', { from: '2026-09-01', to: '2026-09-01' });
    // mock-provider:mock-model is $2/M input + $6/M output -> 0.5M * 2 + 0.5M * 6 = $4.
    expect(response.rows).toEqual([
      {
        botId: 'clx1a2b3c4d5e6f7g8h9i0j1',
        day: '2026-09-01',
        inputTokens: 500_000,
        outputTokens: 500_000,
        estimatedCostUsd: 4,
      },
    ]);
    expect(codingRunFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user-1' }),
      }),
    );
  });
});
