import electronUpdater from 'electron-updater';
import type { UpdaterPort } from './updater.js';

/**
 * ⚠️ The only file that imports `electron-updater`.
 *
 * It requires a real Electron main process, so the decisions live in
 * `updater.ts` behind `UpdaterPort` and are tested there with a fake; this
 * file only adapts the library's singleton to that port — the same split as
 * `authExchange.ts` and `signIn.ts`. CommonJS, hence the default import.
 */
export function realUpdater(log: (message: string) => void): UpdaterPort {
  const { autoUpdater } = electronUpdater;
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => undefined };
  return {
    get autoDownload() {
      return autoUpdater.autoDownload;
    },
    set autoDownload(value) {
      autoUpdater.autoDownload = value;
    },
    get autoInstallOnAppQuit() {
      return autoUpdater.autoInstallOnAppQuit;
    },
    set autoInstallOnAppQuit(value) {
      autoUpdater.autoInstallOnAppQuit = value;
    },
    // Each event wired by name: the library types its listeners per event,
    // and the port takes one payload, so nothing is cast across the seam.
    on: (event, listener) => {
      switch (event) {
        case 'update-available':
          autoUpdater.on('update-available', (info) => listener(info));
          return;
        case 'update-not-available':
          autoUpdater.on('update-not-available', (info) => listener(info));
          return;
        case 'download-progress':
          autoUpdater.on('download-progress', (progress) => listener(progress));
          return;
        case 'update-downloaded':
          autoUpdater.on('update-downloaded', (info) => listener(info));
          return;
        case 'error':
          autoUpdater.on('error', (error) => listener(error));
          return;
      }
    },
    checkForUpdates: () => autoUpdater.checkForUpdates(),
    quitAndInstall: (isSilent, isForceRunAfter) =>
      autoUpdater.quitAndInstall(isSilent, isForceRunAfter),
  };
}
