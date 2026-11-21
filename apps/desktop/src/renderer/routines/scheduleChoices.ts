import { t, currentLocale } from '../i18n/i18n';
/**
 * The routine form's schedule, as choices a person makes — "every week on
 * Monday at 09:00" — and the exact five-field cron each one stands for.
 *
 * Every choice here maps to a cron that fires exactly when it says, and every
 * cron this file writes reads back as the choice that wrote it. A custom
 * interval is offered only where cron can space it evenly: every 7 minutes
 * would fire at:56 and then:00, four minutes apart, so the stepper skips
 * from 6 to 10 rather than accept it.
 */

export type Preset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly';
/**
 * `none`: a new routine before a repeat is picked. `current`: a cron this form
 * did not write (a bot's, or an older routine's) — kept as it is until the
 * operator picks a replacement, never rewritten into a near miss.
 */
export type ScheduleChoice = Preset | 'custom' | 'none' | 'current';
export type RepeatUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months';

export type ScheduleParts = {
  readonly choice: ScheduleChoice;
  readonly hour: number;
  readonly minute: number;
  /** 0 = Sunday, as cron counts them. */
  readonly weekdays: readonly number[];
  readonly monthDay: number;
  readonly frequency: number;
  readonly unit: RepeatUnit;
};

const PRESET_LABELS = {
  hourly: 'routines.preset.hourly',
  daily: 'routines.preset.daily',
  weekdays: 'routines.preset.weekdays',
  weekly: 'routines.preset.weekly',
  monthly: 'routines.preset.monthly',
} as const;

// Getters: the list is built at import, and a label read then would stay in
// that moment's language.
export const PRESETS: ReadonlyArray<{ readonly id: Preset; readonly label: string }> = (
  Object.keys(PRESET_LABELS) as Array<keyof typeof PRESET_LABELS>
).map((id) => ({
  id,
  get label() {
    return t(PRESET_LABELS[id]);
  },
}));

/** The intervals cron can space evenly, per unit — the only ones the stepper stops on. */
export const CUSTOM_STEPS: Readonly<Record<RepeatUnit, readonly number[]>> = {
  minutes: [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30],
  hours: [1, 2, 3, 4, 6, 8, 12],
  days: [1],
  weeks: [1],
  months: [1, 2, 3, 4, 6, 12],
};

export const DEFAULT_PARTS: ScheduleParts = {
  choice: 'none',
  hour: 9,
  minute: 0,
  weekdays: [1],
  monthDay: 1,
  frequency: 1,
  unit: 'days',
};

const INT = /^\d+$/;
const STEP = /^\*\/(\d+)$/;

function inRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** A cron as the choice that would write it, or `current` when none would. */
export function scheduleParts(cron: string): ScheduleParts {
  const trimmed = cron.trim();
  if (trimmed === '') return DEFAULT_PARTS;
  const current: ScheduleParts = { ...DEFAULT_PARTS, choice: 'current' };
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return current;
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const custom = (unit: RepeatUnit, frequency: number, extra: Partial<ScheduleParts> = {}) =>
    CUSTOM_STEPS[unit].includes(frequency)
      ? { ...DEFAULT_PARTS, choice: 'custom' as const, unit, frequency, ...extra }
      : current;

  if (hour === '*' && day === '*' && month === '*' && weekday === '*') {
    if (minute === '*') return custom('minutes', 1);
    const every = STEP.exec(minute);
    if (every) return custom('minutes', Number(every[1]));
    if (INT.test(minute) && inRange(Number(minute), 0, 59)) {
      return { ...DEFAULT_PARTS, choice: 'hourly', minute: Number(minute) };
    }
    return current;
  }
  const everyHour = STEP.exec(hour);
  if (minute === '0' && everyHour && day === '*' && month === '*' && weekday === '*') {
    return custom('hours', Number(everyHour[1]));
  }

  if (!INT.test(minute) || !INT.test(hour)) return current;
  const at = { hour: Number(hour), minute: Number(minute) };
  if (!inRange(at.hour, 0, 23) || !inRange(at.minute, 0, 59)) return current;

  if (day === '*' && month === '*') {
    if (weekday === '*') return { ...DEFAULT_PARTS, choice: 'daily', ...at };
    if (weekday === '1-5') return { ...DEFAULT_PARTS, choice: 'weekdays', ...at };
    if (/^[0-6](?:,[0-6])*$/.test(weekday)) {
      const weekdays = [...new Set(weekday.split(',').map(Number))].sort((a, b) => a - b);
      return { ...DEFAULT_PARTS, choice: 'weekly', ...at, weekdays };
    }
    return current;
  }
  if (INT.test(day) && inRange(Number(day), 1, 31) && weekday === '*') {
    const monthDay = Number(day);
    if (month === '*') return { ...DEFAULT_PARTS, choice: 'monthly', ...at, monthDay };
    const everyMonth = STEP.exec(month);
    if (everyMonth) return custom('months', Number(everyMonth[1]), { ...at, monthDay });
  }
  return current;
}

/** The cron a preset writes, keeping whatever time and days are already chosen. */
export function cronForPreset(choice: Preset, parts: ScheduleParts): string {
  const { hour, minute } = parts;
  switch (choice) {
    case 'hourly':
      return `${minute} * * * *`;
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekdays':
      return `${minute} ${hour} * * 1-5`;
    case 'weekly':
      return `${minute} ${hour} * * ${weekdaysOrMonday(parts.weekdays).join(',')}`;
    case 'monthly':
      return `${minute} ${hour} ${parts.monthDay} * *`;
  }
}

/** The cron a custom repeat writes, or null for an interval cron cannot space evenly. */
export function cronForCustom(parts: ScheduleParts): string | null {
  const n = parts.frequency;
  if (!CUSTOM_STEPS[parts.unit].includes(n)) return null;
  const { hour, minute } = parts;
  switch (parts.unit) {
    case 'minutes':
      return n === 1 ? '* * * * *' : `*/${n} * * * *`;
    case 'hours':
      return `0 ${n === 1 ? '*' : `*/${n}`} * * *`;
    case 'days':
      return `${minute} ${hour} * * *`;
    case 'weeks':
      return `${minute} ${hour} * * ${weekdaysOrMonday(parts.weekdays).join(',')}`;
    case 'months':
      return `${minute} ${hour} ${parts.monthDay} ${n === 1 ? '*' : `*/${n}`} *`;
  }
}

function weekdaysOrMonday(days: readonly number[]): readonly number[] {
  return days.length === 0 ? [1] : [...days].sort((a, b) => a - b);
}

/**
 * Where the stepper lands. It only ever stops on an interval cron can space
 * evenly: a step up from 6 minutes goes to 10, a step down to 6, and a typed
 * number goes to the nearest one.
 */
export function snapFrequency(unit: RepeatUnit, wanted: number, previous: number): number {
  const steps = CUSTOM_STEPS[unit];
  const first = steps[0] ?? 1;
  const last = steps[steps.length - 1] ?? 1;
  if (!Number.isFinite(wanted)) return previous;
  if (steps.includes(wanted)) return wanted;
  if (wanted === previous + 1) return steps.find((step) => step > previous) ?? last;
  if (wanted === previous - 1) return [...steps].reverse().find((step) => step < previous) ?? first;
  return steps.reduce((best, step) =>
    Math.abs(step - wanted) < Math.abs(best - wanted) ? step : best,
  );
}

/** The repeat, in words, for the dropdown's own label. */
export function choiceLabel(choice: ScheduleChoice): string {
  if (choice === 'custom' || choice === 'current')
    return t('routines.routineScheduleFields.custom');
  if (choice === 'none') return t('routines.routineScheduleFields.addSchedule');
  return (
    PRESETS.find((preset) => preset.id === choice)?.label ??
    t('routines.routineScheduleFields.custom')
  );
}

// Timezones

export type TimezoneChoice = {
  readonly id: string;
  /** "America/New York" — the id, readable. */
  readonly label: string;
  /** "GMT-4" at the moment of asking; it moves with daylight saving. */
  readonly offset: string;
};

/** Every zone this runtime knows, plus UTC and a saved alias, each with its offset now. */
export function timezoneChoices(selected: string, now: Date = new Date()): TimezoneChoice[] {
  const ids = new Set(['UTC', ...Intl.supportedValuesOf('timeZone')]);
  if (isTimezone(selected)) ids.add(selected);
  return [...ids]
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({ id, label: id.replaceAll('_', ' '), offset: offsetIn(id, now) }));
}

function isTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone.trim() !== '';
  } catch {
    return false;
  }
}

function offsetIn(zone: string, now: Date): string {
  try {
    const parts = new Intl.DateTimeFormat(currentLocale(), {
      timeZone: zone,
      timeZoneName: 'shortOffset',
    }).formatToParts(now);
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

// Dates in a routine's own zone

/** `YYYY-MM-DD` as it is right now in `timezone` — where an end date is read. */
export function todayInTimezone(timezone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((value) => value.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function addDays(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

/** The date "Ends" starts on: tomorrow, so picking "Ends" never saves a routine that has ended. */
export function defaultEndDate(timezone: string, now: Date = new Date()): string {
  return addDays(todayInTimezone(timezone, now), 1);
}

/** "Sep 23, 2026" for a `YYYY-MM-DD` — read as a calendar day, not an instant. */
export function formatDay(date: string): string {
  return new Date(`${date}T12:00:00.000Z`).toLocaleDateString(currentLocale(), {
    timeZone: 'UTC',
    dateStyle: 'medium',
  });
}
