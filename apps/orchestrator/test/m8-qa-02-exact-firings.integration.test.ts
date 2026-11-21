import { afterEach, describe, expect, it } from 'vitest';

import { nextFirings, parseRoutineSchedule } from '../src/routines/routine-schedule.js';
import { SchedulerHarness } from './m8-scheduler-harness.js';

/**
 * M8-QA-02 — "create a routine, advance fake timers, assert exactly N
 * executions" — and M8-BE-06's DST criterion, checked against the scheduler
 * in Redis rather than a model of it.
 *
 * A real BullMQ job scheduler and worker on a real Redis; only the clock is
 * fake (see `m8-scheduler-harness.ts`). Firings are identified by the slot in
 * their job id, so "exactly N" means N distinct slots, each the one expected.
 */

const REDIS_URL = process.env['REDIS_URL'];
const NY = 'America/New_York';

describe.skipIf(REDIS_URL === undefined || REDIS_URL === '')(
  'exact firings under a fake clock (real redis)',
  () => {
    let h: SchedulerHarness | undefined;
    afterEach(async () => {
      await h?.close();
      h = undefined;
    });

    /** Run the clock through `expected`, one slot at a time. */
    async function tickThrough(harness: SchedulerHarness, expected: number[]): Promise<void> {
      for (const [index, slot] of expected.entries()) {
        await harness.advanceTo(slot);
        await harness.waitForFirings(index + 1);
      }
    }

    it('*/5 fires exactly twelve times over an hour, on the expected slots', async () => {
      const start = new Date('2026-06-01T13:02:00Z');
      h = new SchedulerHarness(REDIS_URL!, start);
      await h.scheduler.schedule({ id: 'hourly-check', cron: '*/5 * * * *', timezone: NY });
      h.startWorker();

      const expected = nextFirings(parseRoutineSchedule('*/5 * * * *', NY), start, 12).map((d) =>
        d.getTime(),
      );
      await tickThrough(h, expected);
      // Up to — but not onto — the next slot: nothing more may fire.
      await h.advanceTo(expected.at(-1)! + 5 * 60_000 - 1);
      await h.settle();

      expect(h.firedSlots()).toEqual(expected);
      expect(new Date(expected[0]!).toISOString()).toBe('2026-06-01T13:05:00.000Z');
      expect(new Date(expected.at(-1)!).toISOString()).toBe('2026-06-01T14:00:00.000Z');
    }, 30_000);

    it('does not fire before its slot, however often the worker looks', async () => {
      h = new SchedulerHarness(REDIS_URL!, new Date('2026-06-01T13:02:00Z'));
      await h.scheduler.schedule({ id: 'early', cron: '*/5 * * * *', timezone: NY });
      h.startWorker();

      await h.advanceTo(Date.parse('2026-06-01T13:04:59.000Z'));
      await h.settle();
      expect(h.fired).toHaveLength(0);

      await h.advanceTo(Date.parse('2026-06-01T13:05:00.000Z'));
      await h.waitForFirings(1);
      expect(h.fired).toHaveLength(1);
    }, 30_000);

    it('M8-BE-06: */5 in New York through spring-forward, in Redis — no 02:xx, no gap', async () => {
      // 01:40 EST on 2026-03-08; clocks jump from 02:00 EST to 03:00 EDT.
      const start = new Date('2026-03-08T06:40:00Z');
      h = new SchedulerHarness(REDIS_URL!, start);
      await h.scheduler.schedule({ id: 'spring', cron: '*/5 * * * *', timezone: NY });
      h.startWorker();

      const expected = nextFirings(parseRoutineSchedule('*/5 * * * *', NY), start, 8).map((d) =>
        d.getTime(),
      );
      await tickThrough(h, expected);
      await h.settle();

      expect(h.firedSlots()).toEqual(expected);
      // 01:45, 01:50, 01:55 EST, then straight to 03:00 EDT: five real
      // minutes apart throughout.
      expect(expected.map((ms) => new Date(ms).toISOString())).toEqual([
        '2026-03-08T06:45:00.000Z',
        '2026-03-08T06:50:00.000Z',
        '2026-03-08T06:55:00.000Z',
        '2026-03-08T07:00:00.000Z',
        '2026-03-08T07:05:00.000Z',
        '2026-03-08T07:10:00.000Z',
        '2026-03-08T07:15:00.000Z',
        '2026-03-08T07:20:00.000Z',
      ]);
    }, 30_000);

    it('M8-BE-06: a 09:00 routine fires at 09:00 New York time on both sides of fall-back', async () => {
      const start = new Date('2026-10-30T14:00:00Z'); // 10:00 EDT, after that day's run
      h = new SchedulerHarness(REDIS_URL!, start);
      await h.scheduler.schedule({ id: 'morning', cron: '0 9 * * *', timezone: NY });
      h.startWorker();

      const expected = [
        Date.parse('2026-10-31T13:00:00Z'), // 09:00 EDT
        Date.parse('2026-11-01T14:00:00Z'), // 09:00 EST — the clocks went back overnight
        Date.parse('2026-11-02T14:00:00Z'),
      ];
      await tickThrough(h, expected);
      await h.settle();

      expect(h.firedSlots()).toEqual(expected);
    }, 30_000);

    it('fires each of two routines on its own schedule, with no cross-talk', async () => {
      const start = new Date('2026-06-01T13:00:30Z');
      h = new SchedulerHarness(REDIS_URL!, start);
      await h.scheduler.schedule({ id: 'every-five', cron: '*/5 * * * *', timezone: NY });
      await h.scheduler.schedule({ id: 'every-ten', cron: '*/10 * * * *', timezone: NY });
      h.startWorker();

      // 13:05, 13:10 (both), 13:15, 13:20 (both), 13:25, 13:30 (both).
      let seen = 0;
      for (const minute of [5, 10, 15, 20, 25, 30]) {
        seen += minute % 10 === 0 ? 2 : 1;
        await h.advanceTo(Date.parse(`2026-06-01T13:${String(minute).padStart(2, '0')}:00Z`));
        await h.waitForFirings(seen);
      }
      await h.settle();

      const count = (id: string) => h!.fired.filter((f) => f.routineId === id).length;
      expect(count('every-five')).toBe(6);
      expect(count('every-ten')).toBe(3);
    }, 30_000);
  },
);
