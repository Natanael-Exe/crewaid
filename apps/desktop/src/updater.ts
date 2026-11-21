import type { Edition } from '@crewaid/shared';
import { guardedIpc } from './tokenStore.js';
import type { TokenIpcMainLike } from './tokenStore.js';

/**
 * In-app updates.
 *
 * The app reads its edition's feed on downloads.crewaid.io — the URL is baked
 * into `app-update.yml` by electron-builder's `publish` config — downloads a
 * newer version in the background, and offers a restart once it is on disk.
 * Nothing restarts by itself: the person chooses the moment, from the button
 * in the sidebar, and an update left alone installs when they next quit.
 *
 * An unsigned macOS build cannot install its own update: Squirrel.Mac refuses
 * a bundle without a valid signature. There the same button opens the
 * download page instead of downloading something that cannot be installed.
 * When the release workflow signs a build, `crewaid.macSigned` in its
 * package.json says so and the normal path applies.
 *
 * The decisions are here; `autoUpdater.ts` is the only file that imports
 * electron-updater, which needs a real Electron process.
 */

/** What the renderer is told. Failures are logged, never shown: a failed check is not news. */
export type UpdateState =
  | { readonly status: 'idle' }
  | { readonly status: 'downloading'; readonly version: string; readonly percent: number }
  /** Downloaded; a restart installs it. */
  | { readonly status: 'ready'; readonly version: string }
  /** Newer, but this build cannot install it (unsigned macOS): offer the download page. */
  | { readonly status: 'available'; readonly version: string };

/**
 * The slice of electron-updater's `autoUpdater` this file uses, so the
 * decisions below can be driven by a fake. `autoUpdater.ts` provides the real one.
 */
export type UpdaterEvent =
  'update-available' | 'update-not-available' | 'download-progress' | 'update-downloaded' | 'error';

export type UpdaterPort = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  readonly on: (event: UpdaterEvent, listener: (payload: unknown) => void) => void;
  readonly checkForUpdates: () => Promise<unknown>;
  readonly quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
};

export type UpdateControllerOptions = {
  readonly updater: UpdaterPort;
  /** Whether this build can install an update it downloads; false on unsigned macOS. */
  readonly canInstall: boolean;
  /** Where `available` sends the person: the edition's stable download link. */
  readonly downloadPageUrl: string;
  readonly openExternal: (url: string) => Promise<unknown>;
  readonly onChanged?: (state: UpdateState) => void;
  readonly log?: (message: string) => void;
  readonly setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  readonly setIntervalFn?: (callback: () => void, ms: number) => unknown;
};

export type UpdateController = {
  readonly state: () => UpdateState;
  /** Begin checking: once shortly after launch, then every few hours. */
  readonly start: () => void;
  readonly check: () => Promise<void>;
  /** Restart into a downloaded update, or open the download page. What it did, or why not. */
  readonly install: () => Promise<InstallResult>;
};

export type InstallResult =
  | { readonly status: 'restarting' }
  | { readonly status: 'opened' }
  | { readonly status: 'nothing' };

/** After launch, so the first check does not compete with the app starting up. */
export const FIRST_CHECK_DELAY_MS = 10_000;
/** A release a day at most; four hours finds it the same day without polling the CDN for nothing. */
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Each macOS chip has its own installer, so the page is chosen by architecture as well. */
export function downloadPageUrl(
  edition: Edition,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): string {
  const installer =
    platform === 'darwin'
      ? arch === 'arm64'
        ? 'mac-arm64'
        : 'mac-intel'
      : platform === 'linux'
        ? 'linux'
        : 'windows';
  return `https://downloads.crewaid.io/desktop/${edition}/${installer}`;
}

function versionOf(info: unknown): string | null {
  if (typeof info !== 'object' || info === null) return null;
  const version = (info as { version?: unknown }).version;
  return typeof version === 'string' && version !== '' ? version : null;
}

export function createUpdateController(options: UpdateControllerOptions): UpdateController {
  const { updater } = options;
  const log = options.log ?? (() => undefined);
  let state: UpdateState = { status: 'idle' };
  let checking = false;

  function set(next: UpdateState): void {
    state = next;
    options.onChanged?.(next);
  }

  // Downloading is pointless where installing is impossible; the person gets
  // the download page instead. Where it is possible, an update nobody acted on
  // still installs at the next quit rather than waiting forever.
  updater.autoDownload = options.canInstall;
  updater.autoInstallOnAppQuit = options.canInstall;

  updater.on('update-available', (info: unknown) => {
    const version = versionOf(info);
    if (version === null) return;
    if (!options.canInstall) set({ status: 'available', version });
    else if (state.status !== 'ready') set({ status: 'downloading', version, percent: 0 });
  });
  updater.on('download-progress', (progress: unknown) => {
    if (state.status !== 'downloading') return;
    const percent = (progress as { percent?: unknown } | null)?.percent;
    if (typeof percent === 'number') set({ ...state, percent: Math.round(percent) });
  });
  updater.on('update-downloaded', (info: unknown) => {
    const version = versionOf(info) ?? (state.status === 'downloading' ? state.version : null);
    if (version !== null) set({ status: 'ready', version });
  });
  updater.on('update-not-available', () => {
    // A downloaded update stays offered: "nothing newer than what is waiting"
    // does not take back the restart.
    if (state.status !== 'ready') set({ status: 'idle' });
  });
  updater.on('error', (error: unknown) => {
    log(`update check failed: ${error instanceof Error ? error.message : String(error)}`);
    // A download that failed is not on offer any more; a finished one still is.
    if (state.status === 'downloading') set({ status: 'idle' });
  });

  async function check(): Promise<void> {
    if (checking) return;
    checking = true;
    try {
      await updater.checkForUpdates();
    } catch (error) {
      log(`update check failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      checking = false;
    }
  }

  return {
    state: () => state,
    check,
    start: () => {
      const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
      const setIntervalFn = options.setIntervalFn ?? setInterval;
      setTimeoutFn(() => void check(), FIRST_CHECK_DELAY_MS);
      setIntervalFn(() => void check(), CHECK_INTERVAL_MS);
    },
    install: async () => {
      if (state.status === 'ready') {
        // Silent, and relaunched afterwards: the person already chose to
        // update by pressing the button, so the installer asks nothing again.
        updater.quitAndInstall(true, true);
        return { status: 'restarting' };
      }
      if (state.status === 'available') {
        await options.openExternal(options.downloadPageUrl);
        return { status: 'opened' };
      }
      return { status: 'nothing' };
    },
  };
}

/** Main → renderer, one way: the state changed. */
export const UPDATE_CHANGED_CHANNEL = 'crewaid:update:changed';

const UPDATE_REFUSED = { status: 'error', code: 'UNAUTHORIZED' } as const;
const UPDATE_FAILED = { status: 'error', code: 'IPC_ERROR' } as const;

export type UpdateStateResult = UpdateState | typeof UPDATE_REFUSED | typeof UPDATE_FAILED;
export type UpdateInstallResult = InstallResult | typeof UPDATE_REFUSED | typeof UPDATE_FAILED;

/** Behind the one trusted-sender fence, from the same call site as every other channel. */
export function registerUpdateIpc(options: {
  readonly ipcMain: TokenIpcMainLike;
  readonly isTrustedSender: (event: unknown) => boolean;
  readonly controller: UpdateController;
}): void {
  const register = guardedIpc(options);
  const fallbacks = { unauthorized: UPDATE_REFUSED, failed: UPDATE_FAILED };
  register<UpdateStateResult>('crewaid:update:get', () => options.controller.state(), fallbacks);
  register<UpdateInstallResult>(
    'crewaid:update:install',
    () => options.controller.install(),
    fallbacks,
  );
}
