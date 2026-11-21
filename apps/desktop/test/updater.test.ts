import { describe, expect, it, vi } from 'vitest';
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  createUpdateController,
  downloadPageUrl,
  registerUpdateIpc,
  type UpdateState,
  type UpdaterEvent,
  type UpdaterPort,
} from '../src/updater';

/**
 * M9-FE-01 — what the app offers as an update arrives, driven through a fake
 * of the one electron-updater surface `updater.ts` uses.
 */

function fakeUpdater() {
  const listeners = new Map<UpdaterEvent, (payload: unknown) => void>();
  const port: UpdaterPort & { installs: Array<[boolean?, boolean?]>; checks: number } = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    installs: [],
    checks: 0,
    on: (event, listener) => {
      listeners.set(event, listener);
    },
    checkForUpdates: () => {
      port.checks += 1;
      return Promise.resolve(null);
    },
    quitAndInstall: (isSilent, isForceRunAfter) => {
      port.installs.push([isSilent, isForceRunAfter]);
    },
  };
  const emit = (event: UpdaterEvent, payload?: unknown) => listeners.get(event)?.(payload);
  return { port, emit };
}

function controller(canInstall: boolean) {
  const { port, emit } = fakeUpdater();
  const changes: UpdateState[] = [];
  const opened: string[] = [];
  const instance = createUpdateController({
    updater: port,
    canInstall,
    downloadPageUrl: 'https://downloads.crewaid.io/desktop/cloud/mac-arm64',
    openExternal: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
    onChanged: (state) => changes.push(state),
  });
  return { instance, port, emit, changes, opened };
}

describe('the update controller where the build can install updates', () => {
  it('downloads in the background and offers a restart only once the update is on disk', async () => {
    const { instance, port, emit } = controller(true);
    expect(port.autoDownload).toBe(true);
    expect(port.autoInstallOnAppQuit).toBe(true);

    emit('update-available', { version: '0.0.4' });
    expect(instance.state()).toEqual({ status: 'downloading', version: '0.0.4', percent: 0 });
    emit('download-progress', { percent: 41.6 });
    expect(instance.state()).toEqual({ status: 'downloading', version: '0.0.4', percent: 42 });
    // Nothing to press while downloading.
    await expect(instance.install()).resolves.toEqual({ status: 'nothing' });

    emit('update-downloaded', { version: '0.0.4' });
    expect(instance.state()).toEqual({ status: 'ready', version: '0.0.4' });
    await expect(instance.install()).resolves.toEqual({ status: 'restarting' });
    // Silent and relaunched: the person already chose by pressing the button.
    expect(port.installs).toEqual([[true, true]]);
  });

  it('keeps a downloaded update on offer when a later check finds nothing newer or fails', () => {
    const { instance, emit } = controller(true);
    emit('update-available', { version: '0.0.4' });
    emit('update-downloaded', { version: '0.0.4' });
    emit('update-not-available', { version: '0.0.4' });
    expect(instance.state()).toEqual({ status: 'ready', version: '0.0.4' });
    emit('error', new Error('offline'));
    expect(instance.state()).toEqual({ status: 'ready', version: '0.0.4' });
  });

  it('drops a download that failed rather than leaving it half-offered', () => {
    const { instance, emit } = controller(true);
    emit('update-available', { version: '0.0.4' });
    emit('error', new Error('connection reset'));
    expect(instance.state()).toEqual({ status: 'idle' });
  });
});

describe('the update controller on an unsigned macOS build', () => {
  it('downloads nothing it could not install, and sends the person to the download page', async () => {
    const { instance, port, emit, opened } = controller(false);
    expect(port.autoDownload).toBe(false);
    expect(port.autoInstallOnAppQuit).toBe(false);

    emit('update-available', { version: '0.0.4' });
    expect(instance.state()).toEqual({ status: 'available', version: '0.0.4' });
    await expect(instance.install()).resolves.toEqual({ status: 'opened' });
    expect(opened).toEqual(['https://downloads.crewaid.io/desktop/cloud/mac-arm64']);
    expect(port.installs).toEqual([]);
  });
});

describe('when it checks', () => {
  it('checks shortly after launch and then every few hours, never two at once', async () => {
    const { port } = fakeUpdater();
    const timeouts: Array<[() => void, number]> = [];
    const intervals: Array<[() => void, number]> = [];
    let release: () => void = () => undefined;
    port.checkForUpdates = () => {
      port.checks += 1;
      return new Promise((resolve) => {
        release = () => resolve(null);
      });
    };
    const instance = createUpdateController({
      updater: port,
      canInstall: true,
      downloadPageUrl: 'x',
      openExternal: () => Promise.resolve(),
      setTimeoutFn: (callback, ms) => timeouts.push([callback, ms]),
      setIntervalFn: (callback, ms) => intervals.push([callback, ms]),
    });
    instance.start();
    expect(timeouts.map(([, ms]) => ms)).toEqual([FIRST_CHECK_DELAY_MS]);
    expect(intervals.map(([, ms]) => ms)).toEqual([CHECK_INTERVAL_MS]);

    timeouts[0]![0]();
    intervals[0]![0](); // fires while the first check is still out
    expect(port.checks).toBe(1);
    release();
    await Promise.resolve();
    await Promise.resolve();
    intervals[0]![0]();
    expect(port.checks).toBe(2);
  });

  it('swallows a failed check: the next one simply tries again', async () => {
    const { port } = fakeUpdater();
    port.checkForUpdates = () => Promise.reject(new Error('DNS'));
    const log = vi.fn();
    const instance = createUpdateController({
      updater: port,
      canInstall: true,
      downloadPageUrl: 'x',
      openExternal: () => Promise.resolve(),
      log,
    });
    await expect(instance.check()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('update check failed: DNS');
    expect(instance.state()).toEqual({ status: 'idle' });
  });
});

describe('the download page', () => {
  it('is the edition’s stable link for the platform and chip', () => {
    expect(downloadPageUrl('cloud', 'darwin', 'arm64')).toBe(
      'https://downloads.crewaid.io/desktop/cloud/mac-arm64',
    );
    expect(downloadPageUrl('cloud', 'darwin', 'x64')).toBe(
      'https://downloads.crewaid.io/desktop/cloud/mac-intel',
    );
    expect(downloadPageUrl('selfhosted', 'win32', 'x64')).toBe(
      'https://downloads.crewaid.io/desktop/selfhosted/windows',
    );
    expect(downloadPageUrl('cloud', 'linux', 'x64')).toBe(
      'https://downloads.crewaid.io/desktop/cloud/linux',
    );
  });
});

describe('the update channels', () => {
  type Handler = (event: unknown, value?: unknown) => Promise<unknown>;

  it('answer our windows and refuse anything else, behind the one fence', async () => {
    const { instance, emit } = controller(true);
    emit('update-available', { version: '0.0.4' });
    emit('update-downloaded', { version: '0.0.4' });
    for (const trusted of [true, false]) {
      const handlers = new Map<string, Handler>();
      registerUpdateIpc({
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
        isTrustedSender: () => trusted,
        controller: instance,
      });
      const state = await handlers.get('crewaid:update:get')!({});
      expect(state).toEqual(
        trusted ? { status: 'ready', version: '0.0.4' } : { status: 'error', code: 'UNAUTHORIZED' },
      );
    }
  });
});
