import { describe, expect, it, vi } from 'vitest';
import {
  isWindowThemeSource,
  WINDOW_THEME_CHANNEL,
  windowBackgroundColor,
} from '../src/windowPresentation';
import { registerThemeIpc } from '../src/windowThemeIpc';

/**
 * The renderer tells the main process which appearance it shows, so native
 * menus, scrollbars and the window's own backdrop never flash the opposite
 * scheme. It is a renderer-to-main channel, so it goes through the same
 * trusted-sender fence as every other one and accepts only the three modes.
 */

type Handler = (event: unknown, value: unknown) => Promise<unknown>;

function register(onTheme: (theme: string) => void, trusted = true) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    }),
  };
  registerThemeIpc({ ipcMain, isTrustedSender: () => trusted, onTheme });
  const handler = handlers.get(WINDOW_THEME_CHANNEL);
  if (handler === undefined) throw new Error('theme channel was not registered');
  return handler;
}

describe('window theme IPC', () => {
  it('applies each of the three appearance modes', async () => {
    const onTheme = vi.fn();
    const handle = register(onTheme);
    for (const mode of ['light', 'dark', 'system']) {
      await expect(handle({}, mode)).resolves.toBe(true);
    }
    expect(onTheme.mock.calls.map(([mode]) => mode)).toEqual(['light', 'dark', 'system']);
  });

  it('refuses anything that is not one of the modes, without touching the window', async () => {
    const onTheme = vi.fn();
    const handle = register(onTheme);
    for (const value of ['Dark', '', null, undefined, 1, { theme: 'dark' }]) {
      await expect(handle({}, value)).resolves.toBe(false);
    }
    expect(onTheme).not.toHaveBeenCalled();
  });

  it('answers an untrusted sender with false and changes nothing', async () => {
    const onTheme = vi.fn();
    const handle = register(onTheme, false);
    await expect(handle({}, 'dark')).resolves.toBe(false);
    expect(onTheme).not.toHaveBeenCalled();
  });

  it('narrows only the three modes', () => {
    expect(isWindowThemeSource('light')).toBe(true);
    expect(isWindowThemeSource('dark')).toBe(true);
    expect(isWindowThemeSource('system')).toBe(true);
    expect(isWindowThemeSource('crewaid-dark')).toBe(false);
    expect(isWindowThemeSource(undefined)).toBe(false);
  });

  it('paints a dark window backdrop in dark mode so launch and resize do not flash white', () => {
    expect(windowBackgroundColor(true)).not.toBe(windowBackgroundColor(false));
    expect(windowBackgroundColor(true)).toMatch(/^#[0-9a-f]{6}$/i);
    expect(windowBackgroundColor(false)).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
