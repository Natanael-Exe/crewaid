import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../src/prisma/prisma.service.js';
import { ClickCorrelatorService } from '../src/recordings/click-correlator.service.js';
import type { CorrelatorRow } from '../src/recordings/click-correlator.js';

/**
 * M4-BE-05 — the write half of the correlator.
 *
 * The judgement is `click-correlator.test.ts`; this is what the service does
 * with it: read the trace, ask, write BOTH sides of every pair in one
 * transaction — and never fail the recording when any of that cannot happen.
 */

function rows(): readonly CorrelatorRow[] {
  return [
    {
      id: 'press',
      tsOffsetMs: 0,
      layer: 'X11',
      type: 'pointer',
      payload: { x: 640, y: 400, buttonMask: 1 },
    },
    {
      id: 'release',
      tsOffsetMs: 60,
      layer: 'X11',
      type: 'pointer',
      payload: { x: 640, y: 400, buttonMask: 0 },
    },
    {
      id: 'click',
      tsOffsetMs: 90,
      layer: 'CDP',
      type: 'click',
      payload: { screenX: 640, screenY: 400, dpr: 1, button: 0 },
    },
  ];
}

function setup(trace: readonly CorrelatorRow[] = rows()) {
  const findMany = vi.fn(() => Promise.resolve(trace));
  const updateMany = vi.fn((_args: unknown) => Promise.resolve({ count: 1 }));
  const transaction = vi.fn((operations: Promise<unknown>[]) => Promise.all(operations));
  const prisma = {
    recordingEvent: { findMany, updateMany },
    $transaction: transaction,
  } as unknown as PrismaService;
  return {
    service: new ClickCorrelatorService(prisma),
    findMany,
    updateMany,
    transaction,
  };
}

describe('ClickCorrelatorService', () => {
  it('reads the trace in order and writes correlatedWithId on BOTH rows of a pair', async () => {
    const { service, findMany, updateMany, transaction } = setup();

    await expect(service.correlate('rec-1')).resolves.toBe(1);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { recordingId: 'rec-1' },
        orderBy: { tsOffsetMs: 'asc' },
      }),
    );
    // Each row names the other — one update per side, both in one transaction,
    // so a partial pass cannot leave a one-sided link.
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'press' },
      data: { correlatedWithId: 'click' },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'click' },
      data: { correlatedWithId: 'press' },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0]![0]).toHaveLength(2);
  });

  it('writes nothing when nothing provably pairs', async () => {
    const { service, updateMany, transaction } = setup([
      {
        id: 'press',
        tsOffsetMs: 0,
        layer: 'X11',
        type: 'pointer',
        payload: { x: 1, y: 1, buttonMask: 1 },
      },
      {
        id: 'click',
        tsOffsetMs: 30,
        layer: 'CDP',
        type: 'click',
        payload: { screenX: 900, screenY: 700, dpr: 1 },
      },
    ]);

    await expect(service.correlate('rec-1')).resolves.toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('is idempotent: a second pass writes the same values', async () => {
    const { service, updateMany } = setup();

    await service.correlate('rec-1');
    const firstPass = updateMany.mock.calls.map((call) => JSON.stringify(call[0]));
    await service.correlate('rec-1');
    expect(updateMany.mock.calls.map((call) => JSON.stringify(call[0]))).toEqual([
      ...firstPass,
      ...firstPass,
    ]);
  });

  it('never rejects — a failed read costs the correlation, never the recording', async () => {
    const findMany = vi.fn(() => Promise.reject(new Error('database is away')));
    const prisma = { recordingEvent: { findMany } } as unknown as PrismaService;
    const service = new ClickCorrelatorService(prisma);

    await expect(service.correlate('rec-1')).resolves.toBe(0);
  });

  it('never rejects — a failed write marks nothing and stays quiet to the caller', async () => {
    const findMany = vi.fn(() => Promise.resolve(rows()));
    const updateMany = vi.fn(() => Promise.resolve({ count: 1 }));
    const transaction = vi.fn(() => Promise.reject(new Error('write refused')));
    const prisma = {
      recordingEvent: { findMany, updateMany },
      $transaction: transaction,
    } as unknown as PrismaService;

    await expect(new ClickCorrelatorService(prisma).correlate('rec-1')).resolves.toBe(0);
  });
});
