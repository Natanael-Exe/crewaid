import { useSyncExternalStore } from 'react';
import {
  DEFAULT_LOCALE,
  LocaleSchema,
  matchSupportedLocale,
  resolveLocale,
  type Locale,
} from '@crewaid/shared';
import { activateLocale } from './i18n';

/**
 * The language the person chose, null for "Follow system".
 *
 * The account holds the choice (`UserSettings.language`), because bots read
 * it too. This is the window's copy of it, kept in local storage so the app
 * opens in the right language before `/settings` answers — and on the
 * sign-in screen, where nothing can answer.
 */
const KEY = 'crewaid.appearance.language';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readLanguageChoice(store: StorageLike | null): Locale | null {
  try {
    const parsed = LocaleSchema.safeParse(store?.getItem(KEY));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The language this computer asks for, among the ones Crewaid speaks. */
export function deviceLocale(
  languages: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages,
): Locale {
  return matchSupportedLocale(languages) ?? DEFAULT_LOCALE;
}

const listeners = new Set<() => void>();
let current: Locale | null | undefined;

/** The choice as this window holds it. */
export function currentLanguageChoice(): Locale | null {
  if (current === undefined) current = readLanguageChoice(storage());
  return current;
}

/** Remember the choice and switch the window to it. Resolves once the catalog is in. */
export function setLanguageChoice(choice: Locale | null): Promise<void> {
  current = choice;
  try {
    if (choice === null) storage()?.removeItem(KEY);
    else storage()?.setItem(KEY, choice);
  } catch {
    // Kept for this session even when it cannot be kept for the next.
  }
  for (const listener of listeners) listener();
  return activateLocale(resolveLocale(choice, deviceLocale()));
}

/** Before the first render, so the first frame is already in the right language. */
export function initializeLocale(): Promise<void> {
  return activateLocale(resolveLocale(currentLanguageChoice(), deviceLocale()));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLanguageChoice(): Locale | null {
  return useSyncExternalStore(subscribe, currentLanguageChoice, () => null);
}
