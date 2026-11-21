import { describe, expect, it } from 'vitest';

import {
  RoutineScheduleError,
  nextFirings,
  parseRoutineSchedule,
  routineEndDate,
} from '../src/routines/routine-schedule.js';
import {
  UNCONFIGURED_SCHEDULER,
  describeRoutineConfig,
  type RoutineScheduler,
  type ScheduledRoutine,
} from '../src/routines/routine.queue.js';
import { reconcileSchedules } from '../src/routines/routine-schedule.reconciler.js';
import { runStatusOfTurn } from '../src/routines/routine-runner.service.js';

/**
 * M8-BE-01 — a routine's cron and timezone, and what the scheduler is told.
 *
 * The expansion cases here are the ones BE-01 has to get right to be usable
 * at all; the exhaustive spring-forward/fall-back fixtures are M8-QA-01's.
 */

const NY = 'America/New_York';

describe('routineEndDate', () => {
  it('ends after the selected local day, including a daylight-saving change', () => {
    expect(routineEndDate('2026-03-08', NY).toISOString()).toBe('2026-03-09T03:59:59.999Z');
    expect(routineEndDate('2026-11-01', NY).toISOString()).toBe('2026-11-02T04:59:59.999Z');
    expect(routineEndDate('2026-09-22', 'Asia/Tokyo').toISOString()).toBe(
      '2026-09-22T14:59:59.999Z',
    );
  });

  it('rejects a calendar date that does not exist', () => {
    expect(() => routineEndDate('2026-02-30', NY)).toThrow(RoutineScheduleError);
  });
});

describe('parseRoutineSchedule', () => {
  it('accepts a 5-field cron in an IANA zone and normalises its whitespace', () => {
    expect(parseRoutineSchedule('  */5   *  * * * ', NY)).toEqual({
      pattern: '*/5 * * * *',
      tz: NY,
    });
  });

  it('refuses a six-field cron, which the parser would read as every SECOND', () => {
    // `cron-parser` accepts this; handed to the scheduler it would start a
    // model turn every second. The field count is the guard.
    expect(() => parseRoutineSchedule('* * * * * *', NY)).toThrow(RoutineScheduleError);
    expect(() => parseRoutineSchedule('* * * * * *', NY)).toThrow(/exactly 5 fields/);
  });

  it('refuses fewer than five fields and an empty string', () => {
    expect(() => parseRoutineSchedule('* * * *', NY)).toThrow(/exactly 5 fields/);
    expect(() => parseRoutineSchedule('', NY)).toThrow(/exactly 5 fields/);
  });

  it('refuses an out-of-range field, naming the expression', () => {
    expect(() => parseRoutineSchedule('61 * * * *', NY)).toThrow(/"61 \* \* \* \*" is not valid/);
  });

  it('refuses an unknown zone by name, rather than failing later on the first firing', () => {
    expect(() => parseRoutineSchedule('* * * * *', 'Mars/Olympus')).toThrow(
      /timezone must be an IANA zone.*"Mars\/Olympus"/,
    );
    expect(() => parseRoutineSchedule('* * * * *', '')).toThrow(/timezone/);
  });

  it('accepts the §3 default zone', () => {
    expect(parseRoutineSchedule('0 9 * * 1-5', 'America/Port-au-Prince').tz).toBe(
      'America/Port-au-Prince',
    );
  });
});

describe('nextFirings — wall-clock time in the routine’s zone', () => {
  it('fires */5 on the five-minute marks', () => {
    const firings = nextFirings(
      parseRoutineSchedule('*/5 * * * *', NY),
      new Date('2026-06-01T13:02:00Z'),
      3,
    );
    expect(firings.map((d) => d.toISOString())).toEqual([
      '2026-06-01T13:05:00.000Z',
      '2026-06-01T13:10:00.000Z',
      '2026-06-01T13:15:00.000Z',
    ]);
  });

  it('reads the hour in the zone, not in UTC', () => {
    // 09:00 in New York is 13:00Z in summer (EDT) and 14:00Z in winter (EST).
    const schedule = parseRoutineSchedule('0 9 * * *', NY);
    expect(nextFirings(schedule, new Date('2026-07-01T00:00:00Z'), 1)[0]?.toISOString()).toBe(
      '2026-07-01T13:00:00.000Z',
    );
    expect(nextFirings(schedule, new Date('2026-12-01T00:00:00Z'), 1)[0]?.toISOString()).toBe(
      '2026-12-01T14:00:00.000Z',
    );
  });

  it('keeps 09:00 at 09:00 across the spring-forward boundary', () => {
    const firings = nextFirings(
      parseRoutineSchedule('0 9 * * *', NY),
      new Date('2026-03-07T00:00:00Z'),
      3,
    );
    // Mar 7 is EST (-5), Mar 8 and 9 are EDT (-4).
    expect(firings.map((d) => d.toISOString())).toEqual([
      '2026-03-07T14:00:00.000Z',
      '2026-03-08T13:00:00.000Z',
      '2026-03-09T13:00:00.000Z',
    ]);
  });

  it('fires a time that happens twice on the fall-back day exactly once', () => {
    const firings = nextFirings(
      parseRoutineSchedule('30 1 * * *', NY),
      new Date('2026-10-31T12:00:00Z'),
      2,
    );
    expect(firings.map((d) => d.toISOString())).toEqual([
      '2026-11-01T05:30:00.000Z', // 01:30 EDT, the first occurrence
      '2026-11-02T06:30:00.000Z', // 01:30 EST the next day
    ]);
  });
});

describe('runStatusOfTurn', () => {
  it('maps every turn status onto the routine vocabulary', () => {
    expect(runStatusOfTurn(null)).toBe('PENDING');
    expect(runStatusOfTurn('running')).toBe('RUNNING');
    expect(runStatusOfTurn('interrupted')).toBe('RUNNING');
    expect(runStatusOfTurn('completed')).toBe('SUCCEEDED');
    expect(runStatusOfTurn('aborted')).toBe('CANCELLED');
    expect(runStatusOfTurn('failed')).toBe('FAILED');
  });
});

describe('ROUTINE_WORKER / REDIS_URL', () => {
  it('reports both halves together, consuming by default', () => {
    expect(describeRoutineConfig({})).toEqual({ redisUrl: null, workerEnabled: true });
    expect(describeRoutineConfig({ REDIS_URL: 'redis://h:1', ROUTINE_WORKER: 'false' })).toEqual({
      redisUrl: 'redis://h:1',
      workerEnabled: false,
    });
  });

  it('names its own variable when the value is malformed', () => {
    expect(() => describeRoutineConfig({ ROUTINE_WORKER: 'no' })).toThrow(/ROUTINE_WORKER/);
  });
});

describe('the scheduler a deployment without Redis gets', () => {
  const routine = { id: 'r1', cron: '*/5 * * * *', timezone: NY };

  it('refuses to schedule, naming the missing variable and the file', async () => {
    await expect(UNCONFIGURED_SCHEDULER.schedule(routine)).rejects.toThrow(
      /REDIS_URL is not set.*\.env\.example/,
    );
  });

  it('reports a bad schedule as a bad schedule, not as missing Redis', async () => {
    await expect(UNCONFIGURED_SCHEDULER.schedule({ ...routine, cron: '* * *' })).rejects.toThrow(
      RoutineScheduleError,
    );
  });

  it('still lets a routine be unscheduled, so it stays deletable', async () => {
    await expect(UNCONFIGURED_SCHEDULER.unschedule('r1')).resolves.toBeUndefined();
    await expect(UNCONFIGURED_SCHEDULER.scheduled()).resolves.toEqual([]);
  });
});

describe('reconcileSchedules', () => {
  function recorder(): RoutineScheduler & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      schedule: (r) => {
        calls.push(`schedule:${r.id}`);
        return Promise.resolve();
      },
      unschedule: (id) => {
        calls.push(`unschedule:${id}`);
        return Promise.resolve();
      },
      scheduled: () => Promise.resolve([]),
      runNow: () => Promise.resolve(),
    };
  }

  const inRedis = (routineId: string, pattern: string, tz = NY): ScheduledRoutine => ({
    routineId,
    pattern,
    tz,
  });

  it('leaves a schedule Redis already holds untouched', async () => {
    // The restart case: touching it could disturb an overdue firing.
    const scheduler = recorder();
    const report = await reconcileSchedules(
      [{ id: 'a', cron: '*/5 * * * *', timezone: NY }],
      [inRedis('a', '*/5 * * * *')],
      scheduler,
    );
    expect(scheduler.calls).toEqual([]);
    expect(report).toEqual({ scheduled: [], unscheduled: [], invalid: [] });
  });

  it('schedules a row Redis lacks, and rewrites one whose pattern or zone differs', async () => {
    const scheduler = recorder();
    const report = await reconcileSchedules(
      [
        { id: 'missing', cron: '0 9 * * *', timezone: NY },
        { id: 'pattern', cron: '0 10 * * *', timezone: NY },
        { id: 'zone', cron: '0 9 * * *', timezone: 'Europe/Paris' },
      ],
      [inRedis('pattern', '0 9 * * *'), inRedis('zone', '0 9 * * *')],
      scheduler,
    );
    expect(report.scheduled).toEqual(['missing', 'pattern', 'zone']);
    expect(scheduler.calls).toEqual(['schedule:missing', 'schedule:pattern', 'schedule:zone']);
  });

  it('compares the normalised pattern, so spacing alone is not a change', async () => {
    const scheduler = recorder();
    await reconcileSchedules(
      [{ id: 'a', cron: '*/5  *  * * *', timezone: NY }],
      [inRedis('a', '*/5 * * * *')],
      scheduler,
    );
    expect(scheduler.calls).toEqual([]);
  });

  it('removes a schedule whose row is gone or disabled', async () => {
    // Disabled rows are not passed in — the caller reads only enabled ones —
    // so both cases look the same from here: a scheduler with no wanted row.
    const scheduler = recorder();
    const report = await reconcileSchedules([], [inRedis('orphan', '* * * * *')], scheduler);
    expect(report.unscheduled).toEqual(['orphan']);
    expect(scheduler.calls).toEqual(['unschedule:orphan']);
  });

  it('removes a schedule after its end date and updates a changed end date', async () => {
    const scheduler = recorder();
    const past = '2020-01-01';
    const future = '2099-01-01';
    const endDate = routineEndDate(future, NY).getTime();
    const report = await reconcileSchedules(
      [
        { id: 'ended', cron: '0 9 * * *', timezone: NY, endsOn: past },
        { id: 'extended', cron: '0 9 * * *', timezone: NY, endsOn: future },
      ],
      [
        { ...inRedis('ended', '0 9 * * *'), endDate: routineEndDate(past, NY).getTime() },
        inRedis('extended', '0 9 * * *'),
      ],
      scheduler,
    );
    expect(report.unscheduled).toEqual(['ended']);
    expect(report.scheduled).toEqual(['extended']);
    expect(endDate).toBeGreaterThan(Date.now());
  });

  it('does not schedule an invalid row, and removes the old schedule it had', async () => {
    const scheduler = recorder();
    const report = await reconcileSchedules(
      [{ id: 'bad', cron: '* * * * * *', timezone: NY }],
      [inRedis('bad', '* * * * *')],
      scheduler,
    );
    expect(report).toEqual({ scheduled: [], unscheduled: ['bad'], invalid: ['bad'] });
  });
});
