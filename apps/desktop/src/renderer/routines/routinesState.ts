import type { CreateRoutineBody, Routine, UpdateRoutineBody } from '@crewaid/shared';
import { todayInTimezone } from './scheduleChoices';
import { t, currentLocale } from '../i18n/i18n';
import { monthName, weekdayName } from '../i18n/dates';

/**
 * The routine panel's decisions, as pure functions.
 *
 * Everything here is what a render test cannot reach through the markup —
 * the wording of a schedule, the badge for a last run, what a form sends —
 * so it lives where it can be tested without a DOM.
 */

/** One bot's routines, the operator's first, then the bot's own, each by name. */
export function routinesForBot(all: readonly Routine[], botId: string): Routine[] {
  return all
    .filter((routine) => routine.botId === botId)
    .sort(
      (a, b) =>
        (a.origin === b.origin ? 0 : a.origin === 'OPERATOR' ? -1 : 1) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
}

const isInt = (value: string) => /^\d+$/.test(value);
const clock = (hour: string, minute: string) =>
  `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;

/**
 * A cron in words, for the shapes people actually write; the cron itself
 * otherwise. Never a guess: anything not recognised exactly is shown as
 * written, because a wrong sentence about when something runs is worse than
 * an unfamiliar one.
 */
export function describeSchedule(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return cron;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  const every = /^\*\/(\d+)$/.exec(minute);
  if (every && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return every[1] === '1'
      ? t('routines.routinesState.everyMinute')
      : t('routines.schedule.everyMinutes', { n: every[1] ?? '' });
  }
  if (minute === '*' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return t('routines.routinesState.everyMinute');
  }
  if (isInt(minute) && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return minute === '0'
      ? t('routines.routinesState.hourly')
      : t('routines.schedule.hourlyAt', { minute: minute.padStart(2, '0') });
  }
  const everyHour = /^\*\/(\d+)$/.exec(hour);
  if (minute === '0' && everyHour && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return t('routines.schedule.everyHours', { n: everyHour[1] ?? '' });
  }
  if (!isInt(minute) || !isInt(hour)) return cron;
  const at = clock(hour, minute);

  if (dayOfMonth === '*' && month === '*') {
    if (dayOfWeek === '*') return t('routines.schedule.daily', { time: at });
    if (dayOfWeek === '1-5') return t('routines.schedule.weekdays', { time: at });
    if (dayOfWeek === '0,6' || dayOfWeek === '6,0')
      return t('routines.schedule.weekends', { time: at });
    if (/^[0-6](?:,[0-6])+$/.test(dayOfWeek)) {
      const days = [...new Set(dayOfWeek.split(',').map(Number))].sort((a, b) => a - b);
      const names = new Intl.ListFormat(currentLocale(), { type: 'unit', style: 'short' }).format(
        days.map((value) => weekdayName(value, 'short')),
      );
      return t('routines.schedule.weeklyOn', { days: names, time: at });
    }
    if (isInt(dayOfWeek)) {
      return t('routines.schedule.onDay', { day: weekdayName(Number(dayOfWeek)), time: at });
    }
    return cron;
  }
  if (isInt(dayOfMonth) && month === '*' && dayOfWeek === '*') {
    return t('routines.schedule.monthly', { day: dayOfMonth, time: at });
  }
  const everyMonth = /^\*\/(\d+)$/.exec(month);
  if (isInt(dayOfMonth) && everyMonth && dayOfWeek === '*') {
    return t('routines.schedule.everyMonths', {
      n: everyMonth[1] ?? '',
      day: dayOfMonth,
      time: at,
    });
  }
  if (isInt(dayOfMonth) && isInt(month) && dayOfWeek === '*') {
    const index = Number(month);
    if (index >= 1 && index <= 12) {
      return t('routines.schedule.yearly', { month: monthName(index), day: dayOfMonth, time: at });
    }
  }
  return cron;
}

/**
 * The schedule for the routine list: in words, or "Custom schedule" for a
 * cron this panel cannot put into words exactly — the cron itself stays one
 * hover away, never the headline.
 */
export function scheduleText(cron: string): string {
  const words = describeSchedule(cron);
  return words === cron ? t('routines.routinesState.customSchedule') : words;
}

/**
 * Whether a routine's last day has passed in its own zone (D-127). It stays
 * enabled on the server — ending is not disabling — but it will not run
 * again, and the server refuses to run it now.
 */
export function routineEnded(
  routine: Pick<Routine, 'endsOn' | 'timezone'>,
  now: Date = new Date(),
): boolean {
  if (routine.endsOn === null) return false;
  try {
    return routine.endsOn < todayInTimezone(routine.timezone, now);
  } catch {
    return false;
  }
}

export type RunTone = 'success' | 'danger' | 'accent' | 'default';

/** "3 min ago", "2 h ago" — coarse on purpose: this is a glance, not a log. */
export function relativeTime(then: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  if (seconds < 60) return t('routines.routinesState.justNow');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('routines.ago.minutes', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('routines.ago.hours', { n: hours });
  return t('routines.ago.days', { n: Math.round(hours / 24) });
}

/** The last-run badge: what happened, and when. */
export function lastRunView(
  routine: Pick<Routine, 'lastRunAt' | 'lastStatus'>,
  now: Date,
): { readonly label: string; readonly tone: RunTone } {
  if (routine.lastRunAt === null || routine.lastStatus === null) {
    return { label: t('routines.routinesState.neverRun'), tone: 'default' };
  }
  const when = relativeTime(new Date(routine.lastRunAt), now);
  switch (routine.lastStatus) {
    case 'RUNNING':
      return { label: t('routines.routinesState.running'), tone: 'accent' };
    case 'PENDING':
      return { label: t('routines.routinesState.queued'), tone: 'accent' };
    case 'SUCCEEDED':
      return { label: t('routines.run.succeeded', { when }), tone: 'success' };
    case 'FAILED':
      return { label: t('routines.run.failed', { when }), tone: 'danger' };
    case 'CANCELLED':
      return { label: t('routines.run.cancelled', { when }), tone: 'default' };
  }
}

/** Whether a routine's outcome is still arriving, so the panel keeps polling. */
export function isInFlight(routine: Pick<Routine, 'lastStatus'>): boolean {
  return routine.lastStatus === 'RUNNING' || routine.lastStatus === 'PENDING';
}

// ── The form ──────────────────────────────────────────────────────────────

export type RoutineDraft = {
  readonly name: string;
  readonly cron: string;
  readonly timezone: string;
  readonly endsOn: string | null;
  readonly prompt: string;
  /** D-133: the goal the routine works toward, if any. */
  readonly goalId: string | null;
};

/** The operator's own zone: a schedule they type is read on their clock. */
export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Port-au-Prince';
  } catch {
    return 'America/Port-au-Prince';
  }
}

export function emptyDraft(timezone: string = localTimezone()): RoutineDraft {
  // No schedule yet: the form opens on "Add schedule" rather than on a
  // repeat the operator did not choose.
  return { name: '', cron: '', timezone, endsOn: null, prompt: '', goalId: null };
}

export function draftFromRoutine(routine: Routine): RoutineDraft {
  return {
    name: routine.name,
    cron: routine.cron,
    timezone: routine.timezone,
    endsOn: routine.endsOn,
    prompt: routine.prompt ?? '',
    goalId: routine.goalId,
  };
}

/**
 * What stops Save, as a sentence — or null. The server checks the cron and
 * zone properly (D-120); this only catches what is plainly missing, so the
 * operator is not sent on a round trip to learn a field is empty.
 */
export function draftProblem(
  draft: RoutineDraft,
  runsSkill: boolean,
  /** The end date already saved: an ended routine can still be renamed or re-enabled. */
  savedEndsOn: string | null = null,
): string | null {
  if (draft.name.trim() === '') return t('routines.routinesState.giveTheRoutineAName');
  if (draft.cron.trim().split(/\s+/).length !== 5) {
    return t('routines.routinesState.chooseWhenTheRoutineShould');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: draft.timezone });
  } catch {
    return t('routines.routinesState.chooseATimezoneFromThe');
  }
  if (draft.endsOn !== null) {
    const date = new Date(`${draft.endsOn}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== draft.endsOn) {
      return t('routines.routinesState.chooseAValidEndDate');
    }
    if (draft.endsOn !== savedEndsOn && draft.endsOn < todayInTimezone(draft.timezone)) {
      return t('routines.routinesState.chooseAnEndDateThat');
    }
  }
  if (!runsSkill && draft.prompt.trim() === '')
    return t('routines.routinesState.sayWhatTheBotShould');
  return null;
}

export function createBodyOf(draft: RoutineDraft, botId: string): CreateRoutineBody {
  return {
    botId,
    name: draft.name.trim(),
    cron: draft.cron.trim(),
    timezone: draft.timezone.trim(),
    endsOn: draft.endsOn,
    prompt: draft.prompt.trim(),
    ...(draft.goalId !== null && { goalId: draft.goalId }),
  };
}

/**
 * Only what changed. A PATCH that re-sends every field would, for a skill
 * routine, send a `prompt` the server must refuse (§3: exactly one of prompt
 * or skillId), and for any routine turns "rename it" into "rewrite it".
 */
export function updateBodyOf(draft: RoutineDraft, routine: Routine): UpdateRoutineBody | null {
  const body: { -readonly [K in keyof UpdateRoutineBody]: UpdateRoutineBody[K] } = {};
  if (draft.name.trim() !== routine.name) body.name = draft.name.trim();
  if (draft.cron.trim() !== routine.cron) body.cron = draft.cron.trim();
  if (draft.timezone.trim() !== routine.timezone) body.timezone = draft.timezone.trim();
  if (draft.endsOn !== routine.endsOn) body.endsOn = draft.endsOn;
  if (draft.goalId !== routine.goalId) body.goalId = draft.goalId;
  if (routine.skillId === null && draft.prompt.trim() !== (routine.prompt ?? '')) {
    body.prompt = draft.prompt.trim();
  }
  return Object.keys(body).length === 0 ? null : body;
}
