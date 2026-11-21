import { describe, expect, it } from 'vitest';

import { describeSchedule } from '../src/renderer/routines/routinesState';
import {
  CUSTOM_STEPS,
  DEFAULT_PARTS,
  PRESETS,
  addDays,
  cronForCustom,
  cronForPreset,
  defaultEndDate,
  formatDay,
  scheduleParts,
  snapFrequency,
  timezoneChoices,
  todayInTimezone,
  type RepeatUnit,
} from '../src/renderer/routines/scheduleChoices';

const at = { ...DEFAULT_PARTS, hour: 14, minute: 30, weekdays: [2, 4], monthDay: 15 };

describe('routine schedule choices', () => {
  it('opens a new routine on "Add schedule", not on a repeat nobody chose', () => {
    expect(scheduleParts('').choice).toBe('none');
  });

  it('reads every preset back as the preset that wrote it', () => {
    for (const { id } of PRESETS) {
      const cron = cronForPreset(id, at);
      const parts = scheduleParts(cron);
      expect(parts.choice, cron).toBe(id);
      expect(cronForPreset(id, parts), cron).toBe(cron);
    }
    expect(cronForPreset('weekly', at)).toBe('30 14 * * 2,4');
    expect(cronForPreset('monthly', at)).toBe('30 14 15 * *');
    expect(cronForPreset('hourly', at)).toBe('30 * * * *');
  });

  it('reads every custom repeat back as an equivalent choice, never as "current"', () => {
    for (const unit of Object.keys(CUSTOM_STEPS) as RepeatUnit[]) {
      for (const frequency of CUSTOM_STEPS[unit]) {
        const cron = cronForCustom({ ...at, choice: 'custom', unit, frequency });
        expect(cron, `${frequency} ${unit}`).not.toBeNull();
        const parts = scheduleParts(cron!);
        expect(parts.choice, cron!).not.toBe('current');
        // The words the list shows are words, not the cron.
        expect(describeSchedule(cron!), cron!).not.toBe(cron);
        // And editing it again writes the same schedule.
        const again =
          parts.choice === 'custom'
            ? cronForCustom(parts)
            : parts.choice === 'none' || parts.choice === 'current'
              ? null
              : cronForPreset(parts.choice, parts);
        expect(again, cron!).toBe(cron);
      }
    }
    expect(scheduleParts('* * * * *')).toMatchObject({ choice: 'custom', unit: 'minutes' });
    expect(scheduleParts('0 9 1 */12 *')).toMatchObject({
      choice: 'custom',
      unit: 'months',
      frequency: 12,
    });
  });

  it('keeps a schedule it cannot show exactly as it is', () => {
    expect(scheduleParts('0 9-17/2 * * 1-5').choice).toBe('current');
    // Unevenly spaced: :56 then :00 is four minutes, not seven.
    expect(scheduleParts('*/7 * * * *').choice).toBe('current');
    expect(scheduleParts('0 9 * * 1-5 *').choice).toBe('current');
  });

  it('refuses an interval cron cannot space evenly', () => {
    expect(cronForCustom({ ...at, unit: 'minutes', frequency: 7 })).toBeNull();
    expect(cronForCustom({ ...at, unit: 'days', frequency: 2 })).toBeNull();
    expect(cronForCustom({ ...at, unit: 'weeks', frequency: 2 })).toBeNull();
  });

  it('steps the frequency only onto intervals that are allowed', () => {
    expect(snapFrequency('minutes', 7, 6)).toBe(10);
    expect(snapFrequency('minutes', 9, 10)).toBe(6);
    expect(snapFrequency('minutes', 7, 30)).toBe(6);
    expect(snapFrequency('hours', 5, 4)).toBe(6);
    expect(snapFrequency('months', 13, 12)).toBe(12);
    expect(snapFrequency('days', 2, 1)).toBe(1);
    expect(snapFrequency('minutes', Number.NaN, 5)).toBe(5);
  });
});

describe('timezone list', () => {
  const NOW = new Date('2026-09-22T15:00:00.000Z');

  it('lists every runtime zone and UTC, readable, each with its offset now', () => {
    const zones = timezoneChoices('America/New_York', NOW);
    const ids = zones.map((zone) => zone.id);
    expect(ids).toContain('UTC');
    for (const zone of Intl.supportedValuesOf('timeZone')) expect(ids).toContain(zone);
    expect(zones.find((zone) => zone.id === 'America/New_York')).toEqual({
      id: 'America/New_York',
      label: 'America/New York',
      offset: 'GMT-4',
    });
  });

  it('keeps a saved alias the runtime does not list, and drops a zone that does not exist', () => {
    expect(timezoneChoices('US/Eastern', NOW).map((zone) => zone.id)).toContain('US/Eastern');
    expect(timezoneChoices('Mars/Olympus', NOW).map((zone) => zone.id)).not.toContain(
      'Mars/Olympus',
    );
  });
});

describe('dates in the routine’s own zone', () => {
  // 02:00 UTC on the 23rd is still the 22nd in New York.
  const NOW = new Date('2026-09-23T02:00:00.000Z');

  it('reads today, and the default end date, in that zone', () => {
    expect(todayInTimezone('America/New_York', NOW)).toBe('2026-09-22');
    expect(todayInTimezone('Asia/Tokyo', NOW)).toBe('2026-09-23');
    expect(defaultEndDate('America/New_York', NOW)).toBe('2026-09-23');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('shows a calendar day as that day everywhere', () => {
    expect(formatDay('2026-09-23')).toBe('Sep 23, 2026');
  });
});
