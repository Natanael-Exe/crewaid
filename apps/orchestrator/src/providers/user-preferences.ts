import {
  isKnownTimezone,
  LocaleSchema,
  resolveTimezone,
  type Locale,
  type UserSettings as WireUserSettings,
} from '@crewaid/shared';

/**
 * The columns of `UserSettings` that say who a bot is working for.
 * Selected through an existing query's relation wherever possible, so a turn
 * or a routine learns the person's language and zone without a query of its
 * own.
 */
export const USER_PREFERENCES_SELECT = {
  language: true,
  timezone: true,
  systemLanguage: true,
  systemTimezone: true,
} as const;

export type UserPreferencesRow = {
  readonly language: string | null;
  readonly timezone: string | null;
  readonly systemLanguage: string | null;
  readonly systemTimezone: string | null;
};

/**
 * What the server knows about the person, or null where it knows nothing.
 *
 * Unlike the desktop, nothing here falls back to English or to a default
 * zone: a bot told "the user is in America/Port-au-Prince" because nobody
 * reported anything is told something false, and the house style already
 * matches whatever language the person writes in.
 */
export type UserPreferences = {
  readonly language: Locale | null;
  readonly timezone: string | null;
};

function locale(value: string | null): Locale | null {
  const parsed = LocaleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function zone(value: string | null): string | null {
  return value !== null && isKnownTimezone(value) ? value : null;
}

export function userPreferences(row: UserPreferencesRow | null | undefined): UserPreferences {
  if (row === null || row === undefined) return { language: null, timezone: null };
  return {
    language: locale(row.language) ?? locale(row.systemLanguage),
    timezone: resolveTimezone(zone(row.timezone), zone(row.systemTimezone)),
  };
}

/**
 * The language text the server writes for the person is written in —
 * the choice, then what the window asking says it shows, then what a computer
 * last reported. Null where nothing is known; the copy then reads English.
 * The window comes before the report because it is the newer of the two:
 * a new account is greeted before its first report lands.
 */
export function writingLanguage(
  row: UserPreferencesRow | null | undefined,
  windowLanguage?: Locale,
): Locale | null {
  return locale(row?.language ?? null) ?? windowLanguage ?? locale(row?.systemLanguage ?? null);
}

/**
 * A language's English name, for text a model reads. English because every
 * instruction around it is English; the model writes the language, it does
 * not need it named in itself.
 */
export function languageName(language: Locale): string {
  return new Intl.DisplayNames(['en'], { type: 'language' }).of(language) ?? language;
}

/**
 * A stored row as the wire reads it. A value that no longer parses — a
 * locale this build dropped, a zone the runtime stopped knowing — reads as
 * unset rather than failing the whole response.
 */
export function settingsToWire(
  row: UserPreferencesRow & {
    readonly userId: string;
    readonly defaultModelId: string | null;
    readonly codingModelId: string | null;
    readonly updatedAt: Date;
  },
): WireUserSettings {
  return {
    userId: row.userId,
    defaultModelId: row.defaultModelId,
    codingModelId: row.codingModelId,
    language: locale(row.language),
    timezone: zone(row.timezone),
    systemLanguage: locale(row.systemLanguage),
    systemTimezone: zone(row.systemTimezone),
    updatedAt: row.updatedAt,
  };
}
