import { MAX_QUALITY } from './rfb-protocol.js';

/**
 * Picks a screen stream's JPEG quality from how long its updates take to
 * reach the slowest viewer.
 *
 * A busy full-quality update takes seconds to cross a slow line; a lower
 * quality makes it several times smaller. The same trade most remote-desktop
 * products make: a softer picture that moves beats a sharp one that lags.
 *
 * Only the part of the delivery time that quality can change is judged: each
 * update's own transfer, net of the line's latency and of waiting behind the
 * update before it (`DeliveryLine`). A 700 ms line with fast frames is not
 * degraded for its latency, which no quality level would shorten.
 *
 * Steps down quickly and back up slowly: a lagging screen is worse than a soft
 * one, and each change is visible. Never above what the viewers asked for.
 */
export class AdaptiveQuality {
  #cap = MAX_QUALITY;
  #transferMs: number | null = null;
  #fastStreak = 0;
  #lastChangeAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly now: () => number = Date.now) {}

  /** The highest quality the line carries well; the stream uses the lower of this and the request. */
  get cap(): number {
    return this.#cap;
  }

  /**
   * Record one delivered update and how long its own bytes took on the line.
   * Returns the new cap and its direction when the quality should change,
   * otherwise null.
   */
  record(
    bytes: number,
    transferMs: number,
    requested: number,
  ): { cap: number; direction: 'down' | 'up' } | null {
    if (bytes < ADAPTIVE_JUDGED_UPDATE_BYTES) return null;

    const transfer = Math.max(0, transferMs);
    this.#transferMs =
      this.#transferMs === null ? transfer : this.#transferMs * 0.7 + transfer * 0.3;
    this.#fastStreak = transfer < ADAPTIVE_FAST_MS ? this.#fastStreak + 1 : 0;
    const current = Math.min(this.#cap, requested);
    const sinceChange = this.now() - this.#lastChangeAt;

    if (
      this.#transferMs > ADAPTIVE_SLOW_MS &&
      current > ADAPTIVE_MIN_QUALITY &&
      sinceChange >= ADAPTIVE_DOWN_COOLDOWN_MS
    ) {
      const step = this.#transferMs > ADAPTIVE_VERY_SLOW_MS ? 2 : 1;
      return this.#change(Math.max(ADAPTIVE_MIN_QUALITY, current - step), 'down');
    }
    if (
      this.#fastStreak >= ADAPTIVE_FAST_STREAK &&
      current < requested &&
      sinceChange >= ADAPTIVE_UP_COOLDOWN_MS
    ) {
      return this.#change(current + 1, 'up');
    }
    return null;
  }

  #change(cap: number, direction: 'down' | 'up'): { cap: number; direction: 'down' | 'up' } {
    this.#cap = cap;
    this.#lastChangeAt = this.now();
    // Measure the new quality afresh rather than judging it by the old one.
    this.#transferMs = null;
    this.#fastStreak = 0;
    return { cap, direction };
  }
}

/** An update this large is judged: its size is quality-dependent. */
export const ADAPTIVE_JUDGED_UPDATE_BYTES = 16 * 1024;
/** Average transfer time above which the quality steps down. */
export const ADAPTIVE_SLOW_MS = 350;
/** ...by two levels at once above this. */
export const ADAPTIVE_VERY_SLOW_MS = 1_000;
/** Transfer time below which an update counts towards stepping back up. */
export const ADAPTIVE_FAST_MS = 100;
/** Consecutive fast updates before a step up. */
export const ADAPTIVE_FAST_STREAK = 8;
export const ADAPTIVE_DOWN_COOLDOWN_MS = 3_000;
export const ADAPTIVE_UP_COOLDOWN_MS = 10_000;
/** Below this the picture stops being readable, whatever the line. */
export const ADAPTIVE_MIN_QUALITY = 2;
