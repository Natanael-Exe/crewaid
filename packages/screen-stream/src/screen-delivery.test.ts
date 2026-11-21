import { describe, expect, it } from 'vitest';

import {
  DeliveryLine,
  LATENCY_SAMPLE_MAX_BYTES,
  UNMEASURED_BUDGET_BYTES,
} from './screen-delivery.js';

const SMALL = 1_000;
const BIG = 200_000;

/** An update sent at `sentAt`, alone on the line or behind another. */
const update = (bytes: number, sentAt: number, lineWasIdle = true) => ({
  bytes,
  sentAt,
  lineWasIdle,
});

/** A line whose latency and rate are already known. */
function measured(latencyMs: number, bytesPerMs: number): DeliveryLine {
  const line = new DeliveryLine();
  line.delivered(update(SMALL, 0), latencyMs);
  const sentAt = 10_000;
  line.delivered(update(BIG, sentAt), sentAt + latencyMs + BIG / bytesPerMs);
  return line;
}

describe('DeliveryLine', () => {
  it('reads latency only from a small update that had the line to itself', () => {
    const line = new DeliveryLine();
    expect(line.delivered(update(SMALL, 0), 185)).toBeNull();
    expect(line.latencyMs).toBe(185);
    // Behind another update, a small one shows that one's transfer as well.
    expect(line.delivered(update(SMALL, 1_000, false), 1_900)).toBeNull();
    expect(line.latencyMs).toBe(185);
  });

  it('lets latency fall at once and rise slowly', () => {
    const line = new DeliveryLine();
    line.delivered(update(SMALL, 0), 185);
    line.delivered(update(SMALL, 1_000), 1_100);
    expect(line.latencyMs).toBe(100);
    line.delivered(update(LATENCY_SAMPLE_MAX_BYTES, 2_000), 2_300);
    expect(line.latencyMs).toBe(110);
  });

  it('judges a large update by its own transfer, without the latency', () => {
    // 185 ms of latency is no quality level's fault, and none would shorten it.
    const line = new DeliveryLine();
    line.delivered(update(SMALL, 0), 185);
    expect(line.delivered(update(BIG, 1_000), 1_000 + 185 + 200)).toBe(200);
  });

  it('does not count time spent behind the update before it', () => {
    const line = new DeliveryLine();
    line.delivered(update(SMALL, 0), 100);
    // Two 100 KB updates sent 10 ms apart: the second reaches the viewer
    // 100 ms after the first, which is its transfer, not the 290 ms since it
    // was sent.
    expect(line.delivered(update(100_000, 1_000), 1_200)).toBe(100);
    expect(line.delivered(update(100_000, 1_010, false), 1_300)).toBe(100);
  });

  it('admits small updates only until the line is measured', () => {
    const line = new DeliveryLine();
    expect(line.budgetBytes).toBe(UNMEASURED_BUDGET_BYTES);
    // Latency alone is not enough: the budget is latency times rate.
    line.delivered(update(SMALL, 0), 185);
    expect(line.budgetBytes).toBe(UNMEASURED_BUDGET_BYTES);
  });

  it('holds what a fast, distant line carries without queueing', () => {
    // 1,000 bytes/ms (8 Mbit/s) and 185 ms: several busy updates fit.
    expect(measured(185, 1_000).budgetBytes).toBe(185_000);
  });

  it('holds less than one busy update on a slow line', () => {
    // 1 Mbit/s and 700 ms of latency: the line pacing was introduced for.
    const line = measured(700, 125);
    expect(line.budgetBytes).toBe(87_500);
    expect(line.budgetBytes).toBeLessThan(BIG);
  });

  it('lets the rate fall fast and rise slowly', () => {
    const line = measured(100, 1_000);
    // A 200 bytes/ms sample halves the distance at once...
    line.delivered(update(BIG, 50_000), 50_000 + 100 + BIG / 200);
    expect(line.budgetBytes).toBe(60_000);
    // ...and a 2,000 bytes/ms one moves it a fifth of the way towards at most
    // double the estimate.
    line.delivered(update(BIG, 60_000), 60_000 + 100 + BIG / 2_000);
    expect(line.budgetBytes).toBe(72_000);
  });

  it('does not read updates confirmed in the same instant as an infinitely fast line', () => {
    // Pongs held up on the viewer's side arrive together. Read at face value,
    // the second update took no time, and a slow line would be sent three busy
    // updates at once: the queue pacing exists to prevent.
    const line = measured(185, 125);
    line.delivered(update(100_000, 20_000), 20_985);
    line.delivered(update(100_000, 20_010, false), 20_985);
    expect(line.budgetBytes).toBe(27_750);
    expect(line.budgetBytes).toBeLessThan(100_000);
  });
});
