import type { MenuItemConstructorOptions } from 'electron';

/**
 * The application menu, and the one channel it needs to reach the renderer.
 *
 * Why the menu is in the main process and the action is not
 *
 * macOS puts the menu bar at the top of the screen, outside every window, so a
 * menu is a main-process object whether or not the app draws its own: without
 * one, Electron installs a default that offers Electron's own items under the
 * product's name. The ACTION behind "New bot" is not a main-process thing at
 * all — creating a bot is a POST to the orchestrator, and R1 keeps every
 * orchestrator call in the renderer. So the menu item is a message: the main
 * process says which command was chosen, and the window that is already
 * holding the app's state does the work.
 *
 * That split is also why the accelerator lives here rather than in the
 * renderer's key handler: an accelerator the menu owns is drawn next to the
 * item and shows the operator what to press, and a menu that lists it while
 * the key does nothing is worse than no entry.
 */
export const NEW_BOT_CHANNEL = 'crewaid:menu:new-bot';

/**
 * The window's language, so the menu reads in it too. Here rather than
 * in `menuLocale.ts` because the preload imports this file, and that one
 * brings the locale contract with it.
 */
export const LOCALE_CHANNEL = 'crewaid:locale:set';

/** The menu's own words. Edit, View and Window are Electron's roles, named by the OS. */
export type MenuLabels = {
  readonly file: string;
  readonly newBot: string;
  readonly newWindow: string;
};

export const MENU_LABELS_EN: MenuLabels = {
  file: 'File',
  newBot: 'New Bot',
  newWindow: 'New Window',
};

export interface ApplicationMenuPorts {
  /** macOS gets the app menu (About, Services, Hide, Quit) as the first entry. */
  readonly isMac: boolean;
  readonly labels: MenuLabels;
  readonly onNewBot: () => void;
  readonly onNewWindow: () => void;
}

/**
 * The template, as a pure function of the two actions it can take.
 *
 * Pure so the accelerator, the order and the platform difference can be
 * asserted without an Electron process: a menu is the one piece of an app that
 * is invisible to every other test, and the ZCode-shaped comparison this was
 * asked for ("when I click File I should see New bot") is exactly a claim about
 * what a template contains.
 */
export function applicationMenuTemplate(ports: ApplicationMenuPorts): MenuItemConstructorOptions[] {
  return [
    ...(ports.isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: ports.labels.file,
      submenu: [
        {
          id: 'crewaid.new-bot',
          label: ports.labels.newBot,
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            ports.onNewBot();
          },
        },
        {
          id: 'crewaid.new-window',
          label: ports.labels.newWindow,
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            ports.onNewWindow();
          },
        },
        { type: 'separator' },
        // A window, not the app, on macOS: the platform's own convention is
        // that ⌘W closes what you are looking at and the app stays running —
        // and the app menu already carries Quit.
        ports.isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
}
