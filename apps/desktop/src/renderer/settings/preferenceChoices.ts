import type { Locale } from '@crewaid/shared';
import { t } from '../i18n/i18n';
import type { SearchSelectItem } from './SearchSelect';

/** The list ids that stand for "no choice": the person follows their computer. */
export const FOLLOW_SYSTEM = 'system';
export const AUTO_DETECT = 'auto';

function capitalized(text: string, locale: string): string {
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}

/** A language's name in another language, e.g. ('fr', 'en') → "French", ('fr', 'fr') → "Français". */
export function languageName(code: Locale, inLocale: string): string {
  try {
    const name = new Intl.DisplayNames([inLocale], { type: 'language' }).of(code);
    return name === undefined ? code : capitalized(name, inLocale);
  } catch {
    return code;
  }
}

/**
 * The Language list: "Follow system", then every language with its own name
 * first — the name a person looking for their language recognises — and its
 * name in the app's current language beside it, sorted by that second name.
 */
export function languageItems(available: readonly Locale[], uiLocale: Locale): SearchSelectItem[] {
  const collator = new Intl.Collator(uiLocale);
  const languages = available
    .map((code) => ({
      id: code,
      label: languageName(code, code),
      detail: languageName(code, uiLocale),
      keywords: `${languageName(code, 'en')} ${code}`,
    }))
    .sort((a, b) => collator.compare(a.detail, b.detail));
  return [{ id: FOLLOW_SYSTEM, label: t('settings.language.followSystem') }, ...languages];
}

/** "America/Port-au-Prince" reads "America/Port-au-Prince"; "America/New_York" reads "America/New York". */
export function zoneLabel(zone: string): string {
  return zone.replaceAll('_', ' ');
}

/**
 * The Timezone list: "Auto-detect" naming this computer's zone, then every
 * zone the runtime knows plus UTC, each with its time now — the quickest way
 * to tell two cities apart is what the clock says there. A saved zone the
 * runtime lists under another name is kept, so the row can still show it.
 */
export function timezoneItems(
  uiLocale: Locale,
  detected: string,
  selected: string | null,
  now: Date = new Date(),
): SearchSelectItem[] {
  const zones = new Set(['UTC', ...Intl.supportedValuesOf('timeZone')]);
  if (selected !== null) zones.add(selected);
  const time = (zone: string): string => {
    try {
      return new Intl.DateTimeFormat(uiLocale, {
        timeZone: zone,
        hour: 'numeric',
        minute: '2-digit',
      }).format(now);
    } catch {
      return '';
    }
  };
  return [
    {
      id: AUTO_DETECT,
      label: t('settings.timezone.autoDetect', { zone: zoneLabel(detected) }),
      detail: time(detected),
      keywords: detected,
    },
    ...[...zones]
      .sort((a, b) => a.localeCompare(b, 'en'))
      .map((zone) => ({ id: zone, label: zoneLabel(zone), detail: time(zone), keywords: zone })),
  ];
}
