import { z } from 'zod';

/**
 * The languages Crewaid speaks: the app's own text, and the language a
 * bot starts in.
 *
 * A code is in this list only when the desktop ships a complete catalog for
 * it, because the list is what the Language picker offers and a half-translated
 * app reads as broken. Portuguese and Spanish are written in Brazilian and
 * Latin American usage under their bare codes, so `Intl.DisplayNames` names
 * them "Portuguese" and "Spanish" rather than a region. Chinese needs its
 * script, since the two written forms are separate catalogs.
 */
export const SUPPORTED_LOCALES = [
  'af',
  'ar',
  'bn',
  'cs',
  'da',
  'de',
  'el',
  'en',
  'es',
  'fi',
  'fr',
  'ha',
  'he',
  'hi',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'mr',
  'nb',
  'nl',
  'pl',
  'pt',
  'ru',
  'sv',
  'sw',
  'ta',
  'te',
  'th',
  'tr',
  'uk',
  'ur',
  'vi',
  'zh-Hans',
  'zh-Hant',
] as const;

export const LocaleSchema = z.enum(SUPPORTED_LOCALES);
export type Locale = z.infer<typeof LocaleSchema>;

/** What the app falls back to when neither the person nor their computer names a language it has. */
export const DEFAULT_LOCALE: Locale = 'en';

const RTL_LOCALES: ReadonlySet<Locale> = new Set<Locale>(['ar', 'he', 'ur']);

/** Whether a language is written right to left, which flips the whole layout. */
export function isRtlLocale(locale: Locale): boolean {
  return RTL_LOCALES.has(locale);
}

function isLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * The first of a computer's preferred languages that Crewaid speaks, or null.
 *
 * A system reports tags like `fr-HT`, `zh-TW` or `no`, never the bare codes
 * above. The region is dropped, except where it decides the script: Taiwan,
 * Hong Kong and Macau read Traditional Chinese even when the tag does not say
 * `Hant`. Norwegian in any of its tags reads Bokmål, the only written form
 * the app has.
 */
export function matchSupportedLocale(tags: readonly string[]): Locale | null {
  for (const tag of tags) {
    let parsed: Intl.Locale;
    try {
      parsed = new Intl.Locale(tag);
    } catch {
      continue;
    }
    const language = parsed.language;
    if (language === 'zh') {
      const script = parsed.maximize().script;
      return script === 'Hant' ? 'zh-Hant' : 'zh-Hans';
    }
    if (language === 'no' || language === 'nn') return 'nb';
    if (isLocale(language)) return language;
  }
  return null;
}

/**
 * The language in effect: the person's choice, else what their computer
 * reported, else English. The desktop and the server both resolve through
 * this, so a bot and the app never disagree about which language is current.
 */
export function resolveLocale(
  choice: Locale | null | undefined,
  system: Locale | null | undefined,
): Locale {
  return choice ?? system ?? DEFAULT_LOCALE;
}

/**
 * Whether the runtime knows a timezone. `Intl` is the authority on both sides
 * of the wire, so a zone the desktop offers is one the server can schedule in.
 */
export function isKnownTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The timezone in effect: the person's choice, else what their computer
 * reported, else null. There is no invented default here — a caller that must
 * schedule something supplies its own, and a bot is told nothing rather than a
 * zone nobody chose.
 */
export function resolveTimezone(
  choice: string | null | undefined,
  system: string | null | undefined,
): string | null {
  return choice ?? system ?? null;
}
