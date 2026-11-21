import { useLayoutEffect, useSyncExternalStore } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export const THEME_PREFERENCE_KEY = 'crewaid.appearance.theme';
const listeners = new Set<() => void>();
let current: ThemePreference | null = null;

export function parseThemePreference(value: unknown): ThemePreference {
  return value === 'dark' || value === 'light' ? value : 'system';
}

function snapshot(): ThemePreference {
  if (current !== null) return current;
  try {
    current = parseThemePreference(window.localStorage.getItem(THEME_PREFERENCE_KEY));
  } catch {
    current = 'system';
  }
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setThemePreference(preference: ThemePreference): void {
  current = preference;
  try {
    window.localStorage.setItem(THEME_PREFERENCE_KEY, preference);
  } catch {
    /* Session preference still works without storage. */
  }
  for (const listener of listeners) listener();
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, snapshot, () => 'system');
}

export function applyTheme(preference: ThemePreference, systemDark: boolean): void {
  const dark = preference === 'dark' || (preference === 'system' && systemDark);
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.classList.toggle('light', !dark);
  root.dataset['theme'] = dark ? 'crewaid-dark' : 'crewaid';
}

/** Apply before React paints so stored dark mode never opens on a light frame. */
export function initializeTheme(): void {
  applyTheme(snapshot(), window.matchMedia('(prefers-color-scheme: dark)').matches);
}

export function useAppTheme(): void {
  const preference = useThemePreference();
  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyTheme(preference, media.matches);
    update();
    media.addEventListener('change', update);
    const storageChanged = (event: StorageEvent) => {
      if (event.key === THEME_PREFERENCE_KEY) {
        current = parseThemePreference(event.newValue);
        for (const listener of listeners) listener();
      }
    };
    window.addEventListener('storage', storageChanged);
    return () => {
      media.removeEventListener('change', update);
      window.removeEventListener('storage', storageChanged);
    };
  }, [preference]);
}
