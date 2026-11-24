import { guardedIpc, type GuardedIpcOptions } from './tokenStore.js';
import {
  isWindowThemeSource,
  WINDOW_THEME_CHANNEL,
  type WindowThemeSource,
} from './windowPresentation.js';

/** Accept only Crewaid's three appearance modes through the trusted IPC fence. */
export function registerThemeIpc(
  options: GuardedIpcOptions & { readonly onTheme: (theme: WindowThemeSource) => void },
): void {
  guardedIpc(options)(
    WINDOW_THEME_CHANNEL,
    (value) => {
      if (!isWindowThemeSource(value)) return false;
      options.onTheme(value);
      return true;
    },
    { unauthorized: false, failed: false },
  );
}
