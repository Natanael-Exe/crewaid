import { describe, expect, it } from 'vitest';

import {
  breachedLimit,
  MAX_RECORDING_EVENTS,
  MAX_RECORDING_MS,
} from '../src/recordings/recording-limits.js';

/**
 * M3-BE-05 — §6/M3's hard limits: "20 minutes, 5000 events. Exceeding either
 * auto-stops and marks the recording `READY` with a warning."
 *
 * The predicate is pure so that both boundaries are fixtures rather than a
 * twenty-minute test, which is the same reason the coalescers take an arrival
 * time instead of reading a clock.
 */
describe('breachedLimit', () => {
  it('pins §6/M3 at twenty minutes and five thousand events', () => {
    // Restated here in the PRD's own units. If a future edit "rounds" either
    // number, the sentence it came from is one line above.
    expect(MAX_RECORDING_MS).toBe(20 * 60 * 1000);
    expect(MAX_RECORDING_EVENTS).toBe(5000);
  });

  it('lets an ordinary recording run', () => {
    expect(breachedLimit(0, 0)).toBeNull();
    expect(breachedLimit(9 * 60 * 1000, 120)).toBeNull();
  });

  it('admits the last event the trace may contain', () => {
    // 4999 stored events means the 5000th is still allowed in. Off by one here
    // is the difference between a ceiling and a ceiling minus one, and nothing
    // downstream would ever show it.
    expect(breachedLimit(0, MAX_RECORDING_EVENTS - 1)).toBeNull();
  });

  it('stops on the event that reaches the ceiling, not one past it', () => {
    expect(breachedLimit(0, MAX_RECORDING_EVENTS)).toBe('EVENT_LIMIT');
    expect(breachedLimit(0, MAX_RECORDING_EVENTS + 1)).toBe('EVENT_LIMIT');
  });

  it('admits the last millisecond the recording may span', () => {
    expect(breachedLimit(MAX_RECORDING_MS - 1, 0)).toBeNull();
  });

  it('stops on the millisecond the deadline is reached', () => {
    expect(breachedLimit(MAX_RECORDING_MS, 0)).toBe('TIME_LIMIT');
    expect(breachedLimit(MAX_RECORDING_MS + 60_000, 0)).toBe('TIME_LIMIT');
  });

  it('reports the event ceiling when both are reached at once', () => {
    // Deliberate, not incidental: the count describes the trace the user is
    // left holding, the clock only describes the session that produced it.
    expect(breachedLimit(MAX_RECORDING_MS, MAX_RECORDING_EVENTS)).toBe('EVENT_LIMIT');
  });
});
