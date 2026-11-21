import { LocaleSchema, type Locale } from '@crewaid/shared';
import { LOCALE_CHANNEL, MENU_LABELS_EN, type MenuLabels } from './applicationMenu.js';
import { MENU_TRANSLATIONS } from './menuTranslations.js';
import { guardedIpc, type GuardedIpcOptions } from './tokenStore.js';

/** The menu's words in `locale`, or in English when that language has not shipped. */
export function menuLabels(locale: Locale): MenuLabels {
  return MENU_TRANSLATIONS[locale] ?? MENU_LABELS_EN;
}

/**
 * A window says which language it shows, and the menu follows. Only a
 * language Crewaid offers is accepted; anything else changes nothing.
 */
export function registerLocaleIpc(
  options: GuardedIpcOptions & { readonly onLocale: (locale: Locale) => void },
): void {
  guardedIpc(options)(
    LOCALE_CHANNEL,
    (value) => {
      const parsed = LocaleSchema.safeParse(value);
      if (!parsed.success) return false;
      options.onLocale(parsed.data);
      return true;
    },
    { unauthorized: false, failed: false },
  );
}
