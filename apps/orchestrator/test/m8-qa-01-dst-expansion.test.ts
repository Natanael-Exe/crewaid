import { describe, expect, it } from 'vitest';
import { defaultRepeatStrategy } from 'bullmq';

import { nextFirings, parseRoutineSchedule } from '../src/routines/routine-schedule.js';

/**
 * M8-BE-06 / M8-QA-01 — cron + timezone expansion across DST.
 *
 * §6/M8: "fires at correct wall-clock times in its timezone, including
 * across a DST boundary. Test with `America/New_York` — the default timezone
 * has no DST and will not exercise this."
 *
 * 2026's New York boundaries: clocks spring forward at 02:00 EST on Sunday
 * 8 March (to 03:00 EDT — 02:xx does not exist), and fall back at 02:00 EDT
 * on Sunday 1 November (to 01:00 EST — 01:xx happens twice).
 *
 * Two kinds of claim, kept apart:
 * - EQUIVALENCE: what `nextFirings` says is exactly what BullMQ's own
 *   `defaultRepeatStrategy` computes when it chains one firing to the next
 *   — the function the scheduler in Redis actually runs (D-119). Without
 *   this, every wall-clock assertion below would be about a model of the
 *   scheduler rather than the scheduler.
 * - WALL CLOCK: what those firings are, read back in New York's own time.
 */

const NY = 'America/New_York';

/** A firing as New York's clock shows it: `YYYY-MM-DD HH:mm` and its offset. */
function wallClock(ms: number): { local: string; hour: number; minute: number; day: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: NY,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  const day = `${parts['year']}-${parts['month']}-${parts['day']}`;
  return {
    local: `${day} ${parts['hour']}:${parts['minute']}`,
    hour: Number(parts['hour']),
    minute: Number(parts['minute']),
    day,
  };
}

/** Chain BullMQ's strategy the way the scheduler does: each firing from the last. */
function bullmqChain(pattern: string, tz: string, after: Date, count: number): number[] {
  const out: number[] = [];
  let millis = after.getTime();
  for (let i = 0; i < count; i += 1) {
    const next = defaultRepeatStrategy(millis, { pattern, tz });
    if (next === undefined) throw new Error('strategy returned no next firing');
    out.push(next);
    millis = next;
  }
  return out;
}

/** Every firing strictly inside [from, to). */
function firingsBetween(pattern: string, from: string, to: string): number[] {
  const schedule = parseRoutineSchedule(pattern, NY);
  const end = Date.parse(to);
  const out: number[] = [];
  let after = new Date(Date.parse(from) - 1);
  for (;;) {
    const [next] = nextFirings(schedule, after, 1);
    if (next === undefined || next.getTime() >= end) return out;
    out.push(next.getTime());
    after = next;
  }
}

const gaps = (firings: number[]) => firings.slice(1).map((ms, i) => ms - firings[i]!);

describe('equivalence with the scheduler BullMQ runs', () => {
  const cases: Array<[string, string]> = [
    ['*/5 * * * *', '2026-03-08T05:00:00Z'], // across spring-forward
    ['*/5 * * * *', '2026-11-01T04:00:00Z'], // across fall-back
    ['0 9 * * *', '2026-03-01T00:00:00Z'],
    ['30 2 * * *', '2026-03-05T00:00:00Z'],
    ['30 1 * * *', '2026-10-28T00:00:00Z'],
    ['0 * * * *', '2026-10-31T12:00:00Z'],
    ['15 8 * * 1-5', '2026-02-20T00:00:00Z'],
  ];

  it.each(cases)('%s from %s: the same firings, in the same order', (pattern, from) => {
    const ours = nextFirings(parseRoutineSchedule(pattern, NY), new Date(from), 400).map((d) =>
      d.getTime(),
    );
    expect(ours).toEqual(bullmqChain(pattern, NY, new Date(from), 400));
  });
});

describe('*/5 across the spring-forward day (2026-03-08, 23 hours long)', () => {
  // New York's local day: 05:00Z (00:00 EST) to 04:00Z next day (00:00 EDT).
  const firings = firingsBetween('*/5 * * * *', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z');

  it('fires 12 times for each of the 23 hours the day has — 276, not 288', () => {
    expect(firings).toHaveLength(23 * 12);
  });

  it('keeps exactly five real minutes between firings, straight through the jump', () => {
    expect(new Set(gaps(firings))).toEqual(new Set([5 * 60_000]));
  });

  it('lands on the five-minute marks of the wall clock, and never in 02:xx', () => {
    const clocks = firings.map(wallClock);
    expect(clocks.every((c) => c.minute % 5 === 0)).toBe(true);
    expect(clocks.some((c) => c.hour === 2)).toBe(false);
    // The two firings either side of the jump: 01:55 EST, then 03:00 EDT.
    const before = clocks.findIndex((c) => c.local === '2026-03-08 01:55');
    expect(clocks[before + 1]?.local).toBe('2026-03-08 03:00');
  });
});

describe('*/5 across the fall-back day (2026-11-01, 25 hours long)', () => {
  // 04:00Z (00:00 EDT) to 05:00Z next day (00:00 EST).
  const firings = firingsBetween('*/5 * * * *', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z');

  it('fires 12 times for each of the 25 hours the day has — 300, not 288', () => {
    expect(firings).toHaveLength(25 * 12);
  });

  it('keeps exactly five real minutes between firings, straight through the repeat', () => {
    expect(new Set(gaps(firings))).toEqual(new Set([5 * 60_000]));
  });

  it('runs the repeated hour twice: 01:00–01:55 appears 24 times, at distinct instants', () => {
    const inRepeatedHour = firings.filter((ms) => wallClock(ms).hour === 1);
    expect(inRepeatedHour).toHaveLength(24);
    expect(new Set(inRepeatedHour).size).toBe(24);
    // The first pass is EDT (05:xxZ), the second EST (06:xxZ).
    expect(new Date(inRepeatedHour[0]!).toISOString()).toBe('2026-11-01T05:00:00.000Z');
    expect(new Date(inRepeatedHour[12]!).toISOString()).toBe('2026-11-01T06:00:00.000Z');
  });
});

describe('fixed wall-clock times across both boundaries', () => {
  it('09:00 stays 09:00 in New York on every day of March and November', () => {
    const march = firingsBetween('0 9 * * *', '2026-03-01T05:00:00Z', '2026-04-01T04:00:00Z');
    const november = firingsBetween('0 9 * * *', '2026-11-01T04:00:00Z', '2026-12-01T05:00:00Z');
    expect(march).toHaveLength(31);
    expect(november).toHaveLength(30);
    expect([...march, ...november].every((ms) => wallClock(ms).hour === 9)).toBe(true);
    expect([...march, ...november].every((ms) => wallClock(ms).minute === 0)).toBe(true);
  });

  it('a time that does not exist (02:30 on spring-forward day) fires once, at 03:30', () => {
    const firings = firingsBetween('30 2 * * *', '2026-03-07T05:00:00Z', '2026-03-10T04:00:00Z');
    expect(firings.map((ms) => wallClock(ms).local)).toEqual([
      '2026-03-07 02:30',
      '2026-03-08 03:30',
      '2026-03-09 02:30',
    ]);
  });

  it('a time that happens twice (01:30 on fall-back day) fires once, the first time', () => {
    const firings = firingsBetween('30 1 * * *', '2026-10-31T04:00:00Z', '2026-11-03T05:00:00Z');
    expect(firings.map((ms) => new Date(ms).toISOString())).toEqual([
      '2026-10-31T05:30:00.000Z', // 01:30 EDT
      '2026-11-01T05:30:00.000Z', // 01:30 EDT — the first of the two
      '2026-11-02T06:30:00.000Z', // 01:30 EST
    ]);
  });

  it('an hourly routine fires 23 times on spring-forward day and 25 on fall-back day', () => {
    expect(
      firingsBetween('0 * * * *', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z'),
    ).toHaveLength(23);
    expect(
      firingsBetween('0 * * * *', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z'),
    ).toHaveLength(25);
  });

  it('a weekday routine skips the weekend in local time, not UTC', () => {
    // 20:30 on a Friday in New York is already Saturday in UTC.
    const firings = firingsBetween('30 20 * * 1-5', '2026-03-06T05:00:00Z', '2026-03-10T04:00:00Z');
    expect(firings.map((ms) => wallClock(ms).day)).toEqual(['2026-03-06', '2026-03-09']);
  });
});
