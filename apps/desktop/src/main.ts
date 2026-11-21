import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  safeStorage,
  session,
  shell,
  type WebContents,
} from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LOCALE,
  desktopAuthScheme,
  matchSupportedLocale,
  type Locale,
} from '@crewaid/shared';
import { WINDOW_FULLSCREEN_CHANNEL } from './windowPresentation.js';
import { NEW_BOT_CHANNEL, applicationMenuTemplate } from './applicationMenu.js';
import { menuLabels, registerLocaleIpc } from './menuLocale.js';
import { createAuthExchange } from './authExchange.js';
import { pinOrchestrator, readDesktopEdition, registerAppInfoIpc } from './edition.js';
import { realUpdater } from './autoUpdater.js';
import {
  UPDATE_CHANGED_CHANNEL,
  createUpdateController,
  downloadPageUrl,
  registerUpdateIpc,
  type UpdateController,
  type UpdateState,
} from './updater.js';
import {
  AUTH_CHANGED_CHANNEL,
  createSignInController,
  isDesktopAuthCallback,
  registerAuthIpc,
  type AuthStatus,
  type SignInController,
} from './signIn.js';
import { registerMediaPermissions } from './mediaPermission.js';
import { openableUrl, registerOpenExternalIpc } from './openExternal.js';
import { isRendererUrl, rendererEntryUrl } from './rendererLocation.js';
import { createTokenStore, isTrustedRendererSender, registerTokenIpc } from './tokenStore.js';

/**
 * `@crewaid/desktop` — Electron main process.
 *
 * ⚠️ PRD R1: this app contains ZERO orchestration logic. No agent loop, no
 * model calls, no Docker access, no database. It speaks HTTP and WebSocket
 * only, even in local development. The lint rule `crewaid/r1-electron-is-a-client`
 * enforces the import bans; if you are reaching for dockerode, @prisma/client,
 * or an AI SDK provider in here, you are in the wrong app.
 *
 * M1-FE-01 shell. M1-FE-06 (WS client) and the REST layer arrive later in M1;
 * both live in the renderer and speak to the orchestrator directly — the main
 * process only provides window management and the CC-07 token store.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Vite dev server URL when ELECTRON_START_URL is set (`pnpm --filter @crewaid/desktop dev`);
// otherwise load the built renderer from dist/renderer/index.html. A packaged
// build ignores the variable: the window it would redirect carries the preload.
const RENDERER_ENTRY = rendererEntryUrl({
  packaged: app.isPackaged,
  startUrl: process.env.ELECTRON_START_URL,
  indexPath: path.join(__dirname, 'renderer', 'index.html'),
});
const isRendererDocument = (url: unknown): boolean => isRendererUrl(url, RENDERER_ENTRY);

if (app.isPackaged && process.env.ELECTRON_START_URL) {
  console.warn('[crewaid] ELECTRON_START_URL is ignored by a packaged build.');
} else if (!app.isPackaged && !process.env.ELECTRON_START_URL) {
  console.warn(
    '[crewaid] ELECTRON_START_URL not set — loading the built renderer from dist/renderer/index.html. ' +
      'Use `pnpm --filter @crewaid/desktop dev` for live reload during M1.',
  );
}

/**
 * Which product this build is, read once. It decides the sign-in
 * scheme, whether the orchestrator address is compiled in, and what the
 * renderer offers to change.
 */
const PACKAGE_JSON: unknown = app.isPackaged
  ? JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'))
  : undefined;
const EDITION = readDesktopEdition({
  packaged: app.isPackaged,
  packageJson: PACKAGE_JSON,
  env: process.env,
});

/**
 * Whether this build may install its own updates. Squirrel.Mac refuses an
 * unsigned bundle, so a macOS build says it is signed (the release workflow
 * writes `crewaid.macSigned` when it signed it) or gets the download page.
 */
function canInstallUpdates(): boolean {
  if (process.platform !== 'darwin') return true;
  const block = (PACKAGE_JSON as { crewaid?: { macSigned?: unknown } } | undefined)?.crewaid;
  return block?.macSigned === true;
}
const SIGN_IN_SCHEME = desktopAuthScheme(EDITION.edition);

// `app.getPath('userData')` follows `productName` (Crewaid) in package.json,
// and the CC-07 credential bag lives there: changing that name signs every
// operator out, because the next launch looks in a new, empty directory.

// encrypted token storage and authenticated IPC

/**
 * The windows this app created to host the Crewaid renderer.
 *
 * A set rather than a `mainWindow` handle because the CC-07 IPC fence asks
 * "did this come from one of our windows", not "is this THE window". PRD M1
 * requires two windows against the same orchestrator to both receive
 * the same frames, and each window reads its own credentials over this IPC —
 * so a fence keyed on a single handle silently unauthenticates whichever
 * window was not created last, and it fails as a window that connects and then
 * receives nothing rather than as an error anyone can see.
 */
const rendererWindows = new Set<BrowserWindow>();

let signInController: SignInController | undefined;
let updateController: UpdateController | undefined;

function registerIpc(): void {
  const fileStore = createTokenStore({
    safeStorage,
    userDataPath: app.getPath('userData'),
  });
  // A hosted build talks to its own orchestrator and nothing else: every
  // reader below sees that address, and no writer can replace it.
  const store =
    EDITION.edition === 'cloud' ? pinOrchestrator(fileStore, EDITION.orchestratorUrl) : fileStore;
  // ONE trusted-sender predicate, shared by both registrations. V1-11's four
  // sign-in channels are behind the same fence as the two token channels, from
  // the same call site — not beside it with a copy of the rule.
  const isTrustedSender = (event: unknown): boolean =>
    isTrustedRendererSender(event, [...rendererWindows], isRendererDocument);

  registerTokenIpc({ ipcMain, store, isTrustedSender });

  signInController = createSignInController({
    edition: EDITION.edition,
    store,
    exchange: createAuthExchange(EDITION.edition),
    onChanged: broadcastAuthStatus,
  });
  registerAuthIpc({ ipcMain, controller: signInController, isTrustedSender });
  // M6-FE-02's one new capability, behind the SAME fence from the SAME call
  // site. An unfenced door beside a fenced one is the one that ends up
  // mattering, and `shell.openExternal` is the widest thing in this
  // app — the scheme check that bounds it lives in the main process, where
  // the capability is.
  registerOpenExternalIpc({ ipcMain, isTrustedSender, open: (url) => shell.openExternal(url) });
  registerAppInfoIpc({
    ipcMain,
    isTrustedSender,
    info: { edition: EDITION.edition, version: app.getVersion() },
  });
  registerLocaleIpc({
    ipcMain,
    isTrustedSender,
    onLocale: (locale) => {
      if (locale === menuLocale) return;
      menuLocale = locale;
      installApplicationMenu();
    },
  });

  // M9-FE-01. Registered in development too, so the renderer always gets an
  // answer ("idle"); only a packaged build has a feed to check.
  updateController = createUpdateController({
    updater: realUpdater((message) => console.log(`[crewaid:update] ${message}`)),
    canInstall: canInstallUpdates(),
    downloadPageUrl: downloadPageUrl(EDITION.edition, process.platform, process.arch),
    openExternal: (url) => shell.openExternal(url),
    onChanged: broadcastUpdateState,
    log: (message) => console.warn(`[crewaid:update] ${message}`),
  });
  registerUpdateIpc({ ipcMain, isTrustedSender, controller: updateController });
  if (app.isPackaged) updateController.start();
}

/** Every window, like the auth status: an update is a fact about the machine. */
function broadcastUpdateState(state: UpdateState): void {
  for (const window of rendererWindows) {
    if (!window.isDestroyed()) window.webContents.send(UPDATE_CHANGED_CHANNEL, state);
  }
}

/**
 * Tell every window this app created that the credentials changed.
 *
 * Every window, not the focused one: PRD M1 requires two windows against the
 * same orchestrator to both work, each reading its own credentials, and a
 * sign-in in one of them is a fact about the machine rather than about that
 * window. Sending to `getFocusedWebContents()` — which is what the library's
 * own bridge does — would leave the other window authenticated as nobody until
 * someone reloaded it.
 */
function broadcastAuthStatus(status: AuthStatus): void {
  for (const window of rendererWindows) {
    if (!window.isDestroyed()) window.webContents.send(AUTH_CHANGED_CHANNEL, status);
  }
}

// ── V1-11: the sign-in callback ────────────────────────────────────────────

/**
 * Take the deep link the browser bounced, or leave it alone.
 *
 * Validated twice on purpose and in this order: `isDesktopAuthCallback` is
 * ours, pure and narrower, and it runs first — so a URL that is not a sign-in
 * callback never reaches auth code at all. `handleCallback` then hands what
 * survives to the library, which spends it.
 */
function consumeDeepLink(url: unknown): void {
  if (!isDesktopAuthCallback(url, EDITION.edition) || signInController === undefined) return;
  focusRendererWindow();
  void signInController.handleCallback(url);
}

function focusRendererWindow(): void {
  const [window] = [...rendererWindows];
  if (window === undefined || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.focus();
}

/**
 * Tell the window the operator is looking at to open its New Bot dialog.
 *
 * The focused window rather than all of them, unlike `broadcastAuthStatus`: a
 * credential is a fact about the machine and every window needs it, while
 * opening a dialog is an action in one of them. Sending it to every window
 * would put the same modal in front of the operator once per open window.
 *
 * A window is CREATED if there is none — a menu item that does nothing when
 * the last window was closed is a menu item that looks broken, and on macOS
 * the app outlives its windows by design. The dialog is opened by the message
 * the new window receives once its renderer has loaded, which is why the
 * listener in the renderer is registered on mount rather than on demand.
 */
function promptNewBot(): void {
  const focused = BrowserWindow.getFocusedWindow();
  let target =
    focused !== null && rendererWindows.has(focused) && !focused.isDestroyed()
      ? focused
      : [...rendererWindows].find((window) => !window.isDestroyed());
  if (target === undefined) {
    target = createMainWindow();
  }
  if (target.isMinimized()) target.restore();
  target.focus();
  const contents = target.webContents;
  const send = (): void => {
    if (!contents.isDestroyed()) contents.send(NEW_BOT_CHANNEL);
  };
  if (contents.isLoadingMainFrame()) contents.once('did-finish-load', send);
  else send();
}

/**
 * Register this edition's scheme (`crewaid://` or `crewaid-selfhosted://`) and route what arrives on it.
 *
 * ── THE THREE WAYS A CALLBACK ARRIVES ───────────────────────────────────────
 *
 * macOS delivers it to the running app as `open-url`. Windows and Linux launch
 * the app AGAIN with the URL as an argument, so the single-instance lock is
 * load-bearing rather than hygiene: without it the second process would do the
 * exchange, write the credential, and exit, leaving the window the person is
 * looking at exactly as signed out as before. With it, the second process
 * hands its arguments to the first and quits.
 *
 * The third way is a cold start — the app was not running when the browser
 * bounced — which arrives as `process.argv`.
 *
 * ── AND WHY THE PASTE FALLBACK IS NOT OPTIONAL ──────────────────────────────
 *
 * `setAsDefaultProtocolClient` reports whether the OS took the registration,
 * and it will not always take it. Run as plain `electron .` on macOS, the
 * scheme goes to Electron's shared bundle ID, which every checkout's copy
 * claims (`pnpm dev` avoids that with its own copy: scripts/dev-electron.mjs);
 * a Linux desktop may have no handler for a custom scheme at all. That is why the sign-in page prints
 * the code and `crewaid:auth:complete` accepts it — the same code through a
 * different transport, refused or accepted by the same server-side check.
 */
function registerSignInProtocol(): void {
  const registered = process.defaultApp
    ? typeof process.argv[1] === 'string' &&
      app.setAsDefaultProtocolClient(SIGN_IN_SCHEME, process.execPath, [
        path.resolve(process.argv[1]),
      ])
    : app.setAsDefaultProtocolClient(SIGN_IN_SCHEME);

  if (!registered) {
    console.warn(
      `[crewaid] the OS did not register ${SIGN_IN_SCHEME}:// to this app — ` +
        'browser sign-in will need the code pasted into Settings.',
    );
  } else if (
    process.defaultApp &&
    process.platform === 'darwin' &&
    path.basename(path.resolve(process.execPath, '..', '..', '..')) !== 'Crewaid Dev.app'
  ) {
    // Registered, but to Electron's shared bundle ID: macOS may hand the
    // callback to any checkout's Electron.app instead of this window.
    console.warn(
      `[crewaid] ${SIGN_IN_SCHEME}:// went to stock Electron, which every checkout shares — ` +
        'run `pnpm --filter @crewaid/desktop start` (or `dev`) for browser sign-in to return here.',
    );
  }

  app.on('open-url', (event, url) => {
    event.preventDefault();
    consumeDeepLink(url);
  });
}

// Window

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 600,
    title: 'Crewaid',
    // Warm near-white per docs/design/UI-SPEC.md token sheet — avoids the
    // white flash before the renderer paints.
    backgroundColor: '#F7F6F4',
    show: false,
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 14, y: 28 },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const publishFullscreen = () => {
    win.webContents.send(WINDOW_FULLSCREEN_CHANNEL, win.isFullScreen());
  };
  win.on('enter-full-screen', publishFullscreen);
  win.on('leave-full-screen', publishFullscreen);
  win.webContents.on('did-finish-load', publishFullscreen);
  rendererWindows.add(win);
  win.once('closed', () => rendererWindows.delete(win));
  keepOnRenderer(win.webContents);

  win.once('ready-to-show', () => win.show());

  void win.loadURL(RENDERER_ENTRY);

  return win;
}

/**
 * A renderer window shows the renderer and nothing else.
 *
 * The preload rides with the window, so a navigation is how a page that is
 * not ours would reach `window.crewaid`. A link that leaves the app goes to
 * the system browser instead — through the same https-only check the
 * renderer's `openExternal` channel uses — and no page opens a window here.
 */
function keepOnRenderer(contents: WebContents): void {
  const stayHome = (event: { preventDefault(): void }, url: string): void => {
    if (isRendererDocument(url)) return;
    event.preventDefault();
    const external = openableUrl(url);
    if (external !== null) void shell.openExternal(external);
  };
  contents.on('will-navigate', stayHome);
  contents.on('will-redirect', stayHome);
  contents.setWindowOpenHandler(({ url }) => {
    const external = openableUrl(url);
    if (external !== null) void shell.openExternal(external);
    return { action: 'deny' };
  });
}

/**
 * The menu's language: the computer's until a window says which one it shows,
 * because no window has read the person's choice before the first one opens.
 */
let menuLocale: Locale | undefined;

function installApplicationMenu(): void {
  menuLocale ??= matchSupportedLocale(app.getPreferredSystemLanguages()) ?? DEFAULT_LOCALE;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      applicationMenuTemplate({
        isMac: process.platform === 'darwin',
        labels: menuLabels(menuLocale),
        onNewBot: promptNewBot,
        onNewWindow: () => {
          createMainWindow();
        },
      }),
    ),
  );
}

/**
 * A second launch is a delivery, not an instance.
 *
 * On Windows and Linux the OS answers a `crewaid://` link by starting this app
 * again with the URL appended to its arguments. Taken at face value that is a
 * second process writing a credential into the same file while the window the
 * person is actually looking at knows nothing about it. Holding the lock turns
 * that launch into a message: the newcomer quits, and its arguments arrive
 * here.
 *
 * Before `whenReady`, because there is no point building a window for a
 * process that is about to exit.
 */
if (app.requestSingleInstanceLock()) {
  app.on('second-instance', (_event, argv) => {
    focusRendererWindow();
    // The URL is appended, so it is the last argument — but only when the
    // launch was a deep link at all. Anything else fails the check and is
    // ignored rather than guessed at.
    consumeDeepLink(argv[argv.length - 1]);
  });

  void app.whenReady().then(() => {
    registerSignInProtocol();
    registerIpc();
    registerMediaPermissions({
      session: session.defaultSession,
      isRendererContents: (contents) =>
        [...rendererWindows].some(
          (win) =>
            !win.isDestroyed() &&
            win.webContents.id === contents.id &&
            isRendererDocument(win.webContents.getURL()),
        ),
    });
    installApplicationMenu();
    createMainWindow();

    // A cold start: the app was not running when the browser bounced, so the
    // callback is in this process's own arguments rather than in an event.
    consumeDeepLink(process.argv[process.argv.length - 1]);

    app.on('activate', () => {
      // macOS: re-create the window when the dock icon is clicked.
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });
} else {
  app.quit();
}

app.on('window-all-closed', () => {
  // Non-macOS convention: quit when all windows are closed.
  if (process.platform !== 'darwin') app.quit();
});
