/**
 * Preload bridge — the ONLY channel between the sandboxed renderer and the
 * main process. The renderer gets `window.crewaid`; it gets nothing else.
 *
 * Kept deliberately tiny: the token store, and the sign-in. The
 * WS client does NOT need IPC (the renderer speaks WSS to the orchestrator
 * directly), so this surface should stay small. Add capabilities here only
 * when the renderer genuinely cannot do them itself.
 *
 * ONE NAMESPACE, ON PURPOSE. Everything hangs off `window.crewaid`, and every
 * invoke channel is registered in the main process through `guardedIpc`.
 * `@better-auth/electron`'s own preload helper exposes seven bare globals —
 * `window.requestAuth`, `window.signOut`, `window.getUser` — over handlers
 * that never look at the sender. It is not used here for that reason; these
 * four channels reach the same library through the IPC fence that was already there.
 */
import { contextBridge, ipcRenderer } from 'electron';
import {
  WINDOW_FULLSCREEN_CHANNEL,
  WINDOW_THEME_CHANNEL,
  type WindowThemeSource,
} from './windowPresentation.js';
import { LOCALE_CHANNEL, NEW_BOT_CHANNEL } from './applicationMenu.js';
import { OPEN_EXTERNAL_CHANNEL, type OpenExternalResult } from './openExternal.js';
import type { AppInfoResult } from './edition';
import type { UpdateInstallResult, UpdateState, UpdateStateResult } from './updater';
import type { AuthStatus, SignInResult } from './signIn';
import type { TokenBag, TokenStoreReadResult, TokenStoreWriteResult } from './tokenStore';
import {
  LOCAL_CONNECTOR_PROMPT_CHANNEL,
  LOCAL_CONNECTOR_STATE_CHANNEL,
  type BuiltinLocalHarnessId,
  type LocalConnectorPromptEvent,
  type LocalConnectorPromptResponse,
  type LocalHarnessDetectionResult,
  type LocalHarnessProbeItem,
  type LocalPermissionOptionView,
  type ManagedConnectorActionErrorCode,
  type ManagedConnectorActionResult,
  type ManagedConnectorRuntimeState,
  type ManagedConnectorsListResult,
  type ManagedConnectorView,
  type PairLocalConnectorInput,
  type PickFolderResult,
  type UpdateLocalConnectorInput,
} from './localConnectorTypes.js';

export type { TokenBag, TokenStoreReadResult, TokenStoreWriteResult } from './tokenStore';
export type { AuthStatus, SignInResult, SignInUser } from './signIn';
export type { OpenExternalResult } from './openExternal';
export type { AppInfoResult } from './edition';
export type { InstallResult, UpdateInstallResult, UpdateState, UpdateStateResult } from './updater';
export type {
  BuiltinLocalHarnessId,
  LocalConnectorPromptEvent,
  LocalConnectorPromptResponse,
  LocalHarnessDetectionResult,
  LocalHarnessProbeItem,
  LocalPermissionOptionView,
  ManagedConnectorActionErrorCode,
  ManagedConnectorActionResult,
  ManagedConnectorRuntimeState,
  ManagedConnectorsListResult,
  ManagedConnectorView,
  PairLocalConnectorInput,
  PickFolderResult,
  UpdateLocalConnectorInput,
};

const AUTH_CHANGED_CHANNEL = 'crewaid:auth:changed';
const UPDATE_CHANGED_CHANNEL = 'crewaid:update:changed';

// Native macOS full screen is independent of document.fullscreenElement. Keep
// chrome layout in sync on entry, exit and reload without exposing window control.
let nativeFullscreen = false;
function applyWindowPresentation(): void {
  if (typeof document === 'undefined' || document.documentElement === null) return;
  document.documentElement.dataset['nativeTitlebar'] =
    process.platform === 'darwin' ? 'mac' : 'standard';
  document.documentElement.dataset['windowFullscreen'] = String(nativeFullscreen);
}
ipcRenderer.on(WINDOW_FULLSCREEN_CHANNEL, (_event: unknown, fullscreen: unknown) => {
  if (typeof fullscreen !== 'boolean') return;
  nativeFullscreen = fullscreen;
  applyWindowPresentation();
});
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', applyWindowPresentation, { once: true });
}

// Keep a menu request until the signed-in app mounts its listener.
let pendingNewBot = false;
const newBotListeners = new Set<() => void>();
ipcRenderer.on(NEW_BOT_CHANNEL, () => {
  if (newBotListeners.size === 0) pendingNewBot = true;
  else for (const listener of newBotListeners) listener();
});

const api = {
  app: {
    /** Which build this is: the renderer hides what its edition does not have. */
    info: (): Promise<AppInfoResult> => ipcRenderer.invoke('crewaid:app:info'),
    /** The language this window shows, so the menu bar reads in it too. */
    setLocale: (locale: string): Promise<boolean> => ipcRenderer.invoke(LOCALE_CHANNEL, locale),
    /** The appearance preference this window shows, so OS chrome and menus match. */
    setTheme: (theme: WindowThemeSource): Promise<boolean> =>
      ipcRenderer.invoke(WINDOW_THEME_CHANNEL, theme),
  },
  update: {
    /** Whether an update is downloading, ready, or (unsigned macOS) available. */
    state: (): Promise<UpdateStateResult> => ipcRenderer.invoke('crewaid:update:get'),
    /** Restart into the downloaded update, or open the download page. */
    install: (): Promise<UpdateInstallResult> => ipcRenderer.invoke('crewaid:update:install'),
    onChanged: (listener: (state: UpdateState) => void): (() => void) => {
      const handler = (_event: unknown, state: UpdateState): void => listener(state);
      ipcRenderer.on(UPDATE_CHANGED_CHANNEL, handler);
      return () => {
        ipcRenderer.off(UPDATE_CHANGED_CHANNEL, handler);
      };
    },
  },
  token: {
    get: (): Promise<TokenStoreReadResult> => ipcRenderer.invoke('crewaid:token:get'),
    set: (bag: TokenBag): Promise<TokenStoreWriteResult> =>
      ipcRenderer.invoke('crewaid:token:set', bag),
  },
  menu: {
    /**
     * The application menu's "New Bot", which the main process owns.
     *
     * A one-way message rather than an invoke: the menu item is a KEYBOARD
     * EQUIVALENT as much as a menu entry, and the action behind it is a
     * renderer concern — creating a bot is a POST to the orchestrator, and R1
     * keeps every orchestrator call in here. The main process announces which
     * command was chosen and nothing else. Returns its own unsubscribe, like
     * `onChanged`, because a component that mounts twice must not leave a
     * listener behind.
     */
    onNewBot: (listener: () => void): (() => void) => {
      newBotListeners.add(listener);
      if (pendingNewBot) {
        pendingNewBot = false;
        listener();
      }
      return () => {
        newBotListeners.delete(listener);
      };
    },
  },
  shell: {
    /**
     * Open a URL in the operating system's browser.
     *
     * The renderer holds an authorize URL it cannot open itself, and this is
     * the narrowest thing that lets it. The main process decides whether the
     * value is openable at all — see `openExternal.ts` for why that check
     * cannot live on this side of the boundary.
     */
    openExternal: (url: string): Promise<OpenExternalResult> =>
      ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),
  },
  auth: {
    /** Who the stored credentials belong to, asked of the orchestrator each time. */
    status: (): Promise<AuthStatus> => ipcRenderer.invoke('crewaid:auth:status'),
    /** Opens the system browser. The result says it opened, never who signed in. */
    start: (): Promise<SignInResult> => ipcRenderer.invoke('crewaid:auth:start'),
    /** The paste-the-code path, for when the OS will not hand back a custom scheme. */
    complete: (code: string): Promise<AuthStatus> =>
      ipcRenderer.invoke('crewaid:auth:complete', code),
    signOut: (): Promise<AuthStatus> => ipcRenderer.invoke('crewaid:auth:signOut'),
    /**
     * Sign-in finishes in the main process, long after the click that started
     * it — the browser round trip happens outside this app entirely — so the
     * result arrives as an event rather than as that call's return value.
     * Returns its own unsubscribe, because a component that mounts twice must
     * not leave a listener behind.
     */
    onChanged: (listener: (status: AuthStatus) => void): (() => void) => {
      const handler = (_event: unknown, status: AuthStatus): void => listener(status);
      ipcRenderer.on(AUTH_CHANGED_CHANNEL, handler);
      return () => {
        ipcRenderer.off(AUTH_CHANGED_CHANNEL, handler);
      };
    },
  },
  localConnector: {
    detectHarnesses: (refresh = false): Promise<LocalHarnessDetectionResult> =>
      ipcRenderer.invoke('crewaid:local-connector:detect-harnesses', refresh),
    pickFolder: (): Promise<PickFolderResult> =>
      ipcRenderer.invoke('crewaid:local-connector:pick-folder'),
    list: (): Promise<ManagedConnectorsListResult> =>
      ipcRenderer.invoke('crewaid:local-connector:list'),
    pair: (input: PairLocalConnectorInput): Promise<ManagedConnectorActionResult> =>
      ipcRenderer.invoke('crewaid:local-connector:pair', input),
    start: (connectorId: string): Promise<ManagedConnectorActionResult> =>
      ipcRenderer.invoke('crewaid:local-connector:start', connectorId),
    pause: (connectorId: string): Promise<ManagedConnectorActionResult> =>
      ipcRenderer.invoke('crewaid:local-connector:pause', connectorId),
    update: (input: UpdateLocalConnectorInput): Promise<ManagedConnectorActionResult> =>
      ipcRenderer.invoke('crewaid:local-connector:update', input),
    unpair: (connectorId: string): Promise<ManagedConnectorActionResult> =>
      ipcRenderer.invoke('crewaid:local-connector:unpair', connectorId),
    currentPrompt: (): Promise<LocalConnectorPromptEvent | null> =>
      ipcRenderer.invoke('crewaid:local-connector:current-prompt'),
    respondPrompt: (response: LocalConnectorPromptResponse): Promise<boolean> =>
      ipcRenderer.invoke('crewaid:local-connector:respond-prompt', response),
    onStateChanged: (listener: (connectors: readonly ManagedConnectorView[]) => void): (() => void) => {
      const handler = (_event: unknown, connectors: readonly ManagedConnectorView[]): void =>
        listener(connectors);
      ipcRenderer.on(LOCAL_CONNECTOR_STATE_CHANNEL, handler);
      return () => {
        ipcRenderer.off(LOCAL_CONNECTOR_STATE_CHANNEL, handler);
      };
    },
    onPrompt: (listener: (prompt: LocalConnectorPromptEvent | null) => void): (() => void) => {
      const handler = (_event: unknown, prompt: LocalConnectorPromptEvent | null): void =>
        listener(prompt);
      ipcRenderer.on(LOCAL_CONNECTOR_PROMPT_CHANNEL, handler);
      return () => {
        ipcRenderer.off(LOCAL_CONNECTOR_PROMPT_CHANNEL, handler);
      };
    },
  },
};

export type CrewaidBridge = typeof api;

contextBridge.exposeInMainWorld('crewaid', api);
