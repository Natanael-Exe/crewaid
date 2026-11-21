import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTokenStore,
  isTrustedRendererSender,
  registerTokenIpc,
  type SafeStorageLike,
  type TokenStore,
} from '../src/tokenStore';

const FIXTURE_CREDENTIAL = 'cc07-fixture-credential';
const BASE_URL = 'https://orchestrator.example/api/v1';

class FakeSafeStorage implements SafeStorageLike {
  available = true;
  throwOnAvailability = false;
  encryptInputs: string[] = [];
  decryptInputs: Buffer[] = [];
  throwOnEncrypt = false;
  throwOnDecrypt = false;

  isEncryptionAvailable(): boolean {
    if (this.throwOnAvailability) throw new Error(`availability failed for ${FIXTURE_CREDENTIAL}`);
    return this.available;
  }

  encryptString(value: string): Buffer {
    if (this.throwOnEncrypt) throw new Error(`encrypt failed for ${FIXTURE_CREDENTIAL}`);
    this.encryptInputs.push(value);
    return Buffer.from([...Buffer.from(value, 'utf8')].map((byte) => byte ^ 0xa5));
  }

  decryptString(value: Buffer): string {
    if (this.throwOnDecrypt) throw new Error(`decrypt failed for ${FIXTURE_CREDENTIAL}`);
    this.decryptInputs.push(Buffer.from(value));
    return Buffer.from([...value].map((byte) => byte ^ 0xa5)).toString('utf8');
  }
}

const tempDirectories: string[] = [];

function makeStore(safeStorage = new FakeSafeStorage()): {
  readonly store: TokenStore;
  readonly safeStorage: FakeSafeStorage;
  readonly userDataPath: string;
} {
  const userDataPath = mkdtempSync(path.join(tmpdir(), 'crewaid-cc07-'));
  tempDirectories.push(userDataPath);
  return { store: createTokenStore({ safeStorage, userDataPath }), safeStorage, userDataPath };
}

function writeLegacyPlaintext(filePath: string): void {
  writeFileSync(filePath, `{"orchestratorToken":"${FIXTURE_CREDENTIAL}"}`, 'utf8');
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('createTokenStore', () => {
  it('reports first-run storage as missing without creating a credential file', () => {
    const { store, userDataPath } = makeStore();

    expect(store.get()).toEqual({ status: 'missing' });
    expect(readdirSync(userDataPath)).toEqual([]);
  });

  it('round-trips authenticated credentials through encrypted bytes with restrictive permissions', () => {
    const { store, safeStorage, userDataPath } = makeStore();
    const credentials = { orchestratorToken: FIXTURE_CREDENTIAL, orchestratorBaseUrl: BASE_URL };

    expect(store.set(credentials)).toEqual({ status: 'saved' });
    expect(readdirSync(userDataPath)).toEqual(['token.encrypted']);

    const onDisk = readFileSync(path.join(userDataPath, 'token.encrypted'));
    expect(onDisk.toString('utf8')).not.toContain(FIXTURE_CREDENTIAL);
    expect(onDisk.toString('utf8')).not.toContain(JSON.stringify(credentials));
    expect(statSync(path.join(userDataPath, 'token.encrypted')).mode & 0o777).toBe(0o600);
    expect(safeStorage.encryptInputs).toEqual([JSON.stringify(credentials)]);

    expect(store.get()).toEqual({ status: 'configured', credentials });
    expect(safeStorage.decryptInputs).toHaveLength(1);
  });

  it('replaces ciphertext atomically without leaving temporary files or old token bytes', () => {
    const { store, userDataPath } = makeStore();
    const first = { orchestratorToken: 'first-fixture-credential', orchestratorBaseUrl: BASE_URL };
    const second = {
      orchestratorToken: 'second-fixture-credential',
      orchestratorBaseUrl: BASE_URL,
    };

    expect(store.set(first)).toEqual({ status: 'saved' });
    expect(store.set(second)).toEqual({ status: 'saved' });

    expect(readdirSync(userDataPath)).toEqual(['token.encrypted']);
    const onDisk = readFileSync(path.join(userDataPath, 'token.encrypted'), 'utf8');
    expect(onDisk).not.toContain('first-fixture-credential');
    expect(onDisk).not.toContain('second-fixture-credential');
    expect(store.get()).toEqual({ status: 'configured', credentials: second });
  });

  it('clears credentials without writing an empty plaintext fallback', () => {
    const { store, userDataPath } = makeStore();

    expect(
      store.set({ orchestratorToken: FIXTURE_CREDENTIAL, orchestratorBaseUrl: BASE_URL }),
    ).toEqual({
      status: 'saved',
    });
    expect(store.set({})).toEqual({ status: 'cleared' });
    expect(store.get()).toEqual({ status: 'missing' });
    expect(readdirSync(userDataPath)).toEqual([]);
  });

  it('keeps the address after a sign-out clears only the token', () => {
    // The shape `SignInController.signOut` writes, read back through the real
    // store rather than a fake. It reported `missing` here — indistinguishable
    // from first run — so logging out silently forgot which orchestrator this
    // install belonged to, and the sign-in gate then asked for an address the
    // file on disk still held.
    const { store } = makeStore();

    expect(
      store.set({ orchestratorToken: FIXTURE_CREDENTIAL, orchestratorBaseUrl: BASE_URL }),
    ).toEqual({ status: 'saved' });
    expect(store.set({ orchestratorBaseUrl: BASE_URL })).toEqual({ status: 'saved' });

    expect(store.get()).toEqual({
      status: 'configured',
      credentials: { orchestratorBaseUrl: BASE_URL },
    });
  });

  it('refuses to read or write when OS encryption is unavailable', () => {
    const { store, safeStorage, userDataPath } = makeStore();
    safeStorage.available = false;

    expect(store.get()).toEqual({ status: 'unavailable', code: 'ENCRYPTION_UNAVAILABLE' });
    expect(
      store.set({ orchestratorToken: FIXTURE_CREDENTIAL, orchestratorBaseUrl: BASE_URL }),
    ).toEqual({
      status: 'unavailable',
      code: 'ENCRYPTION_UNAVAILABLE',
    });
    expect(readdirSync(userDataPath)).toEqual([]);
    expect(safeStorage.encryptInputs).toEqual([]);
  });

  it('normalizes safeStorage availability failures without pretending storage is unavailable', () => {
    const { store, safeStorage, userDataPath } = makeStore();
    safeStorage.throwOnAvailability = true;

    expect(store.get()).toEqual({ status: 'error', code: 'STORAGE_ERROR' });
    expect(store.set({ orchestratorToken: FIXTURE_CREDENTIAL })).toEqual({
      status: 'error',
      code: 'STORAGE_ERROR',
    });
    expect(readdirSync(userDataPath)).toEqual([]);
  });

  it('never reads a legacy plaintext credential file', () => {
    const { store, userDataPath } = makeStore();
    const legacyPath = path.join(userDataPath, 'token.json');
    writeLegacyPlaintext(legacyPath);

    expect(store.get()).toEqual({ status: 'missing' });
    expect(readFileSync(legacyPath, 'utf8')).toContain(FIXTURE_CREDENTIAL);
  });

  it('normalizes encryption and decryption failures without exposing error detail', () => {
    const encryptFailure = makeStore();
    encryptFailure.safeStorage.throwOnEncrypt = true;
    const writeResult = encryptFailure.store.set({
      orchestratorToken: FIXTURE_CREDENTIAL,
      orchestratorBaseUrl: BASE_URL,
    });
    expect(writeResult).toEqual({ status: 'error', code: 'STORAGE_ERROR' });
    expect(JSON.stringify(writeResult)).not.toContain(FIXTURE_CREDENTIAL);
    expect(readdirSync(encryptFailure.userDataPath)).toEqual([]);

    const decryptFailure = makeStore();
    expect(
      decryptFailure.store.set({
        orchestratorToken: FIXTURE_CREDENTIAL,
        orchestratorBaseUrl: BASE_URL,
      }),
    ).toEqual({ status: 'saved' });
    decryptFailure.safeStorage.throwOnDecrypt = true;
    const readResult = decryptFailure.store.get();
    expect(readResult).toEqual({ status: 'error', code: 'STORAGE_ERROR' });
    expect(JSON.stringify(readResult)).not.toContain(FIXTURE_CREDENTIAL);
  });

  it('rejects malformed or unsafe credential input before encryption', () => {
    const { store, safeStorage, userDataPath } = makeStore();

    expect(store.set({ orchestratorToken: '   ' })).toEqual({
      status: 'invalid',
      code: 'INVALID_CREDENTIALS',
    });
    expect(store.set({ orchestratorToken: 42 } as never)).toEqual({
      status: 'invalid',
      code: 'INVALID_CREDENTIALS',
    });
    expect(
      store.set({ orchestratorToken: FIXTURE_CREDENTIAL, unexpected: 'field' } as never),
    ).toEqual({
      status: 'invalid',
      code: 'INVALID_CREDENTIALS',
    });
    expect(
      store.set({
        orchestratorToken: FIXTURE_CREDENTIAL,
        orchestratorBaseUrl: 'file:///tmp/token',
      }),
    ).toEqual({
      status: 'invalid',
      code: 'INVALID_CREDENTIALS',
    });
    expect(safeStorage.encryptInputs).toEqual([]);
    expect(readdirSync(userDataPath)).toEqual([]);
  });

  it('normalizes credential accessor failures without throwing or writing', () => {
    const { store, userDataPath } = makeStore();
    const hostile = {
      get orchestratorToken(): string {
        throw new Error('credential accessor detail');
      },
    };

    expect(store.set(hostile as never)).toEqual({
      status: 'invalid',
      code: 'INVALID_CREDENTIALS',
    });
    expect(readdirSync(userDataPath)).toEqual([]);
  });

  it('never logs token or storage error details', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { store, safeStorage } = makeStore();
    safeStorage.throwOnEncrypt = true;

    expect(store.set({ orchestratorToken: FIXTURE_CREDENTIAL })).toEqual({
      status: 'error',
      code: 'STORAGE_ERROR',
    });
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});

describe('registerTokenIpc', () => {
  it('only returns credentials to the authenticated main renderer sender', async () => {
    const handlers = new Map<string, (event: unknown, value?: unknown) => unknown>();
    const ipcMain = {
      handle(channel: string, handler: (event: unknown, value?: unknown) => unknown): void {
        handlers.set(channel, handler);
      },
    };
    const store = {
      get: vi.fn(
        () =>
          ({
            status: 'configured',
            credentials: { orchestratorToken: FIXTURE_CREDENTIAL },
          }) as const,
      ),
      set: vi.fn(() => ({ status: 'saved' }) as const),
    };
    const isTrustedSender = vi.fn((event: unknown) => event === 'trusted');
    registerTokenIpc({ ipcMain, store, isTrustedSender });

    const get = handlers.get('crewaid:token:get');
    const set = handlers.get('crewaid:token:set');
    expect(get).toBeDefined();
    expect(set).toBeDefined();
    if (get === undefined || set === undefined) return;

    await expect(get('untrusted')).resolves.toEqual({ status: 'error', code: 'UNAUTHORIZED' });
    expect(store.get).not.toHaveBeenCalled();
    await expect(set('untrusted', { orchestratorToken: FIXTURE_CREDENTIAL })).resolves.toEqual({
      status: 'error',
      code: 'UNAUTHORIZED',
    });
    expect(store.set).not.toHaveBeenCalled();

    await expect(get('trusted')).resolves.toEqual({
      status: 'configured',
      credentials: { orchestratorToken: FIXTURE_CREDENTIAL },
    });
    await expect(set('trusted', { orchestratorToken: FIXTURE_CREDENTIAL })).resolves.toEqual({
      status: 'saved',
    });
    expect(store.set).toHaveBeenCalledWith({ orchestratorToken: FIXTURE_CREDENTIAL });
  });

  it('normalizes unexpected store exceptions at the IPC boundary', async () => {
    const handlers = new Map<string, (event: unknown, value?: unknown) => unknown>();
    const ipcMain = {
      handle(channel: string, handler: (event: unknown, value?: unknown) => unknown): void {
        handlers.set(channel, handler);
      },
    };
    const store: TokenStore = {
      get: () => {
        throw new Error('unexpected storage detail');
      },
      set: () => {
        throw new Error('unexpected storage detail');
      },
    };
    registerTokenIpc({ ipcMain, store, isTrustedSender: () => true });

    const get = handlers.get('crewaid:token:get');
    const set = handlers.get('crewaid:token:set');
    if (get === undefined || set === undefined) throw new Error('IPC handlers were not registered');

    await expect(get('trusted')).resolves.toEqual({ status: 'error', code: 'IPC_ERROR' });
    await expect(set('trusted', { orchestratorToken: FIXTURE_CREDENTIAL })).resolves.toEqual({
      status: 'error',
      code: 'IPC_ERROR',
    });
  });
});

describe('isTrustedRendererSender', () => {
  const RENDERER =
    'file:///Applications/Crewaid.app/Contents/Resources/app.asar/dist/renderer/index.html';
  const isRenderer = (url: unknown): boolean => url === RENDERER;

  /** A stand-in for a BrowserWindow, as narrow as the fence's own port. */
  function fakeWindow(
    destroyed = false,
    url = RENDERER,
  ): {
    isDestroyed: () => boolean;
    webContents: { mainFrame: { url: string } };
  } {
    return { isDestroyed: () => destroyed, webContents: { mainFrame: { url } } };
  }

  const eventFrom = (window: ReturnType<typeof fakeWindow>): object => ({
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  });

  const isTrustedRendererSenderOf = (
    event: unknown,
    windows: Parameters<typeof isTrustedRendererSender>[1],
  ): boolean => isTrustedRendererSender(event, windows, isRenderer);

  it('accepts only the top-level renderer frame of a listed window', () => {
    const window = fakeWindow();
    const { webContents } = window;

    expect(isTrustedRendererSenderOf(eventFrom(window), [window])).toBe(true);
    expect(
      isTrustedRendererSenderOf({ sender: webContents, senderFrame: { url: RENDERER } }, [window]),
    ).toBe(false);
    expect(
      isTrustedRendererSenderOf({ sender: {}, senderFrame: webContents.mainFrame }, [window]),
    ).toBe(false);
    expect(isTrustedRendererSenderOf(null, [window])).toBe(false);
  });

  it('refuses one of its own windows once it shows a page that is not the renderer', () => {
    // The preload rides with the window: a window that navigated to another
    // page still has `window.crewaid`, and the token must not go with it.
    const navigated = fakeWindow(false, 'https://attacker.example/');
    expect(isTrustedRendererSenderOf(eventFrom(navigated), [navigated])).toBe(false);
    const noUrl = { isDestroyed: () => false, webContents: { mainFrame: {} } };
    expect(
      isTrustedRendererSender(
        { sender: noUrl.webContents, senderFrame: noUrl.webContents.mainFrame },
        [noUrl],
        isRenderer,
      ),
    ).toBe(false);
  });

  it('fails closed for a destroyed, absent, or empty window list', () => {
    const window = fakeWindow();
    const event = eventFrom(window);

    expect(isTrustedRendererSenderOf(event, [])).toBe(false);
    expect(isTrustedRendererSenderOf(event, [null])).toBe(false);
    expect(isTrustedRendererSenderOf(event, [fakeWindow(true)])).toBe(false);
    // Present but destroyed alongside a live peer: the live one still answers,
    // so closing one window must not lock the other out.
    expect(isTrustedRendererSenderOf(event, [fakeWindow(true), window])).toBe(true);
  });

  it('trusts every window this app opened, not only the newest (M1-QA-06)', () => {
    // PRD M1: two windows against the same orchestrator both receive
    // `message.delta`. Each reads its own credentials over this IPC first, so
    // a fence that tracked a single window handle would unauthenticate
    // whichever window was not created last — and that window would connect,
    // fail to read a token, and then simply receive nothing.
    const first = fakeWindow();
    const second = fakeWindow();
    const open = [first, second];

    expect(isTrustedRendererSenderOf(eventFrom(first), open)).toBe(true);
    expect(isTrustedRendererSenderOf(eventFrom(second), open)).toBe(true);

    // A window the app did not open stays out, whichever order it is asked in.
    const foreign = fakeWindow();
    expect(isTrustedRendererSenderOf(eventFrom(foreign), open)).toBe(false);

    // ...and a sub-frame inside a trusted window is still not trusted, which
    // is the half of the check that generalising must not have loosened.
    expect(
      isTrustedRendererSenderOf(
        { sender: second.webContents, senderFrame: { url: RENDERER } },
        open,
      ),
    ).toBe(false);
  });
});
