/** Main-to-preload notification for native window chrome. */
export const WINDOW_FULLSCREEN_CHANNEL = 'crewaid:window:fullscreen';

/** Renderer-to-main appearance sync so OS menus and window chrome match Crewaid's theme. */
export const WINDOW_THEME_CHANNEL = 'crewaid:window:theme';

export type WindowThemeSource = 'light' | 'dark' | 'system';

/**
 * Window background tint matched to the dawn and night room wallpapers so
 * cold launch and live resize never flash a bright white frame in dark mode.
 */
export function windowBackgroundColor(dark: boolean): string {
  return dark ? '#0b1033' : '#f4f7fc';
}

export function isWindowThemeSource(value: unknown): value is WindowThemeSource {
  return value === 'light' || value === 'dark' || value === 'system';
}
