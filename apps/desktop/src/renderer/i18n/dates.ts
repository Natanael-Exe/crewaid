import { currentLocale } from './i18n';

/**
 * Weekday and month names in the app's language, from the runtime's
 * own calendar data rather than a list per language. 0 is Sunday, as cron
 * counts; months are 1-based, as cron writes them.
 */
const SUNDAY = Date.UTC(2023, 0, 1);

export function weekdayName(day: number, width: 'long' | 'short' = 'long'): string {
  return new Intl.DateTimeFormat(currentLocale(), { weekday: width, timeZone: 'UTC' }).format(
    new Date(SUNDAY + (day % 7) * 86_400_000),
  );
}

export function monthName(month: number, width: 'long' | 'short' = 'short'): string {
  return new Intl.DateTimeFormat(currentLocale(), { month: width, timeZone: 'UTC' }).format(
    new Date(Date.UTC(2023, month - 1, 15)),
  );
}

/** The two letters on a weekday toggle; the short name where two letters say nothing. */
export function weekdayInitials(day: number): string {
  return currentLocale() === 'en' ? weekdayName(day).slice(0, 2) : weekdayName(day, 'short');
}
