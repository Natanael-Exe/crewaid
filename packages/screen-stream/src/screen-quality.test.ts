import { describe, expect, it } from 'vitest';

import {
  ADAPTIVE_DOWN_COOLDOWN_MS,
  ADAPTIVE_FAST_STREAK,
  ADAPTIVE_MIN_QUALITY,
  ADAPTIVE_UP_COOLDOWN_MS,
  AdaptiveQuality,
} from './screen-quality.js';

const SMALL = 1_000;
const BIG = 200_000;

function controller(): { q: AdaptiveQuality; advance: (ms: number) => void } {
  let now = 1_000_000;
  const q = new AdaptiveQuality(() => now);
  return { q, advance: (ms) => (now += ms) };
}

describe('AdaptiveQuality', () => {
  it('steps down when big updates take long to transfer, by two levels when very long', () => {
    const { q, advance } = controller();
    expect(q.record(BIG, 500, 9)).toEqual({ cap: 8, direction: 'down' });
    advance(ADAPTIVE_DOWN_COOLDOWN_MS);
    expect(q.record(BIG, 1_500, 9)).toEqual({ cap: 6, direction: 'down' });
  });

  it('does not degrade a line whose frames transfer quickly', () => {
    // Latency is the line's (`DeliveryLine` takes it out): no quality level
    // would shorten it.
    const { q, advance } = controller();
    for (let i = 0; i < 20; i++) {
      expect(q.record(BIG, 60, 9)).toBeNull();
      advance(1_000);
    }
    expect(q.cap).toBe(9);
  });

  it('waits out the cool-down between steps down', () => {
    const { q, advance } = controller();
    expect(q.record(BIG, 600, 9)?.cap).toBe(8);
    expect(q.record(BIG, 600, 9)).toBeNull();
    advance(ADAPTIVE_DOWN_COOLDOWN_MS - 1);
    expect(q.record(BIG, 600, 9)).toBeNull();
    advance(1);
    expect(q.record(BIG, 600, 9)?.cap).toBe(7);
  });

  it('never goes below the readable floor', () => {
    const { q, advance } = controller();
    for (let i = 0; i < 20; i++) {
      q.record(BIG, 4_900, 9);
      advance(ADAPTIVE_DOWN_COOLDOWN_MS);
    }
    expect(q.cap).toBe(ADAPTIVE_MIN_QUALITY);
  });

  it('steps back up after a run of fast updates, one level per cool-down, never above the request', () => {
    const { q, advance } = controller();
    q.record(BIG, 1_400, 9); // 9 -> 7
    expect(q.cap).toBe(7);
    advance(ADAPTIVE_UP_COOLDOWN_MS);
    for (let i = 0; i < ADAPTIVE_FAST_STREAK - 1; i++) expect(q.record(BIG, 50, 9)).toBeNull();
    expect(q.record(BIG, 50, 9)).toEqual({ cap: 8, direction: 'up' });
    // Not again before the cool-down, however fast.
    for (let i = 0; i < ADAPTIVE_FAST_STREAK; i++) expect(q.record(BIG, 50, 9)).toBeNull();

    // A thumbnail asked for 3: already above it, so nothing to raise.
    advance(ADAPTIVE_UP_COOLDOWN_MS);
    for (let i = 0; i < ADAPTIVE_FAST_STREAK * 2; i++) expect(q.record(BIG, 50, 3)).toBeNull();
  });

  it('judges neither small nor mid-sized updates', () => {
    const { q } = controller();
    expect(q.record(SMALL, 9_000, 9)).toBeNull();
    expect(q.record(10_000, 9_000, 9)).toBeNull();
    expect(q.cap).toBe(9);
  });
});
