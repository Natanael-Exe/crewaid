import { describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { MENU_LABELS_EN, applicationMenuTemplate } from '../src/applicationMenu.js';

/**
 * The application menu (CC-53).
 *
 * Asserted as a template rather than as a running menu: this is the one piece
 * of the app that no other test can see, and the request behind it ("when I
 * click File I should see New bot") is exactly a claim about what the template
 * contains and what pressing it does.
 */

function template(isMac: boolean) {
  const onNewBot = vi.fn();
  const onNewWindow = vi.fn();
  const items = applicationMenuTemplate({ isMac, labels: MENU_LABELS_EN, onNewBot, onNewWindow });
  return { items, onNewBot, onNewWindow };
}

function fileMenu(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const file = items.find((item) => item.label === 'File');
  if (file === undefined || !Array.isArray(file.submenu)) throw new Error('no File menu');
  return file.submenu;
}

describe('the File menu', () => {
  it('offers New Bot ahead of New Window, with the accelerator an operator would try', () => {
    const { items } = template(true);
    const file = fileMenu(items);
    const labels = file.map((item) => item.label ?? item.type);

    expect(labels.slice(0, 2)).toEqual(['New Bot', 'New Window']);
    expect(file[0]?.accelerator).toBe('CmdOrCtrl+N');
  });

  it('announces New Bot rather than doing it, because the action is the renderer’s', () => {
    // R1: creating a bot is a POST to the orchestrator, and every orchestrator
    // call lives in the renderer. The menu's job is to say which command was
    // chosen.
    const { items, onNewBot, onNewWindow } = template(true);
    const file = fileMenu(items);

    (file[0]?.click as () => void)();
    expect(onNewBot).toHaveBeenCalledTimes(1);
    expect(onNewWindow).not.toHaveBeenCalled();

    (file[1]?.click as () => void)();
    expect(onNewWindow).toHaveBeenCalledTimes(1);
  });

  it('keeps the app menu first on macOS and drops it elsewhere', () => {
    expect(template(true).items[0]?.role).toBe('appMenu');
    expect(template(false).items[0]?.role).not.toBe('appMenu');
  });

  it('closes a window on macOS and quits on the platforms that expect it', () => {
    // ⌘W closes what you are looking at; the app menu already carries Quit on
    // macOS, and Windows and Linux have no app menu to carry it.
    const mac = fileMenu(template(true).items);
    const other = fileMenu(template(false).items);

    expect(mac.at(-1)?.role).toBe('close');
    expect(other.at(-1)?.role).toBe('quit');
  });

  it('keeps the standard Edit, View and Window menus', () => {
    const roles = template(true).items.map((item) => item.role);
    expect(roles).toContain('editMenu');
    expect(roles).toContain('viewMenu');
    expect(roles).toContain('windowMenu');
  });
});
