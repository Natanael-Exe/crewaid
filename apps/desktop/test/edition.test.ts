import { describe, expect, it } from 'vitest';
import {
  APP_INFO_CHANNEL,
  pinOrchestrator,
  readDesktopEdition,
  registerAppInfoIpc,
} from '../src/edition';
import type { TokenStore, TokenStoreReadResult, TokenStoreWriteResult } from '../src/tokenStore';

/**
 * D-152 — which product a build is, and what the hosted one cannot be made
 * to do.
 */

const CLOUD_URL = 'https://api.crewaid.example';

/** An in-memory stand-in for the CC-07 file store, with its clear-on-empty rule. */
function memoryStore(initial: Record<string, string> | null = null) {
  let bag = initial;
  const writes: unknown[] = [];
  const store: TokenStore = {
    get: (): TokenStoreReadResult =>
      bag === null ? { status: 'missing' } : { status: 'configured', credentials: { ...bag } },
    set: (value): TokenStoreWriteResult => {
      writes.push(value);
      const next = value as Record<string, string>;
      if (Object.keys(next).length === 0) {
        bag = null;
        return { status: 'cleared' };
      }
      bag = { ...next };
      return { status: 'saved' };
    },
  };
  return { store, writes, contents: () => bag };
}

describe('readDesktopEdition', () => {
  it('reads a packaged build from the block electron-builder wrote', () => {
    expect(
      readDesktopEdition({
        packaged: true,
        packageJson: { crewaid: { edition: 'cloud', orchestratorUrl: `${CLOUD_URL}/` } },
        env: {},
      }),
    ).toEqual({ edition: 'cloud', orchestratorUrl: CLOUD_URL });
    expect(
      readDesktopEdition({
        packaged: true,
        packageJson: { crewaid: { edition: 'selfhosted' } },
        env: {},
      }),
    ).toEqual({ edition: 'selfhosted' });
  });

  it('ignores the environment in a packaged build', () => {
    // A shipped hosted app must not become a self-hosted one because of a
    // variable on someone's machine.
    expect(
      readDesktopEdition({
        packaged: true,
        packageJson: { crewaid: { edition: 'cloud', orchestratorUrl: CLOUD_URL } },
        env: { CREWAID_EDITION: 'selfhosted' },
      }).edition,
    ).toBe('cloud');
  });

  it('refuses a packaged build with no edition rather than defaulting one', () => {
    expect(() =>
      readDesktopEdition({ packaged: true, packageJson: { name: 'x' }, env: {} }),
    ).toThrow(/no edition/);
    expect(() =>
      readDesktopEdition({
        packaged: true,
        packageJson: { crewaid: { edition: 'enterprise' } },
        env: {},
      }),
    ).toThrow(/Unknown edition/);
  });

  it('refuses a hosted build without an https orchestrator', () => {
    expect(() =>
      readDesktopEdition({
        packaged: true,
        packageJson: { crewaid: { edition: 'cloud' } },
        env: {},
      }),
    ).toThrow(/needs its orchestrator URL/);
    expect(() =>
      readDesktopEdition({
        packaged: true,
        packageJson: {
          crewaid: { edition: 'cloud', orchestratorUrl: 'http://api.crewaid.example' },
        },
        env: {},
      }),
    ).toThrow(/must be https/);
  });

  it('defaults an unpackaged run to self-hosted, and allows http for a local cloud run', () => {
    expect(readDesktopEdition({ packaged: false, packageJson: undefined, env: {} })).toEqual({
      edition: 'selfhosted',
    });
    expect(
      readDesktopEdition({
        packaged: false,
        packageJson: undefined,
        env: { CREWAID_EDITION: 'cloud', CREWAID_ORCHESTRATOR_URL: 'http://localhost:3000' },
      }),
    ).toEqual({ edition: 'cloud', orchestratorUrl: 'http://localhost:3000' });
    expect(() =>
      readDesktopEdition({
        packaged: false,
        packageJson: undefined,
        env: { CREWAID_EDITION: 'cloud' },
      }),
    ).toThrow(/needs CREWAID_ORCHESTRATOR_URL/);
  });
});

describe('pinOrchestrator — a hosted build cannot be pointed anywhere else', () => {
  it('reports its own orchestrator on a fresh install, so the app goes straight to sign-in', () => {
    const { store } = memoryStore();
    expect(pinOrchestrator(store, CLOUD_URL).get()).toEqual({
      status: 'configured',
      credentials: { orchestratorBaseUrl: CLOUD_URL },
    });
  });

  it('reports its own orchestrator whatever the file holds', () => {
    const { store } = memoryStore({
      orchestratorBaseUrl: 'https://elsewhere.example',
      orchestratorToken: 't',
    });
    expect(pinOrchestrator(store, CLOUD_URL).get()).toEqual({
      status: 'configured',
      credentials: { orchestratorBaseUrl: CLOUD_URL, orchestratorToken: 't' },
    });
  });

  it('refuses a write that names another orchestrator, and writes nothing', () => {
    const { store, writes } = memoryStore();
    const pinned = pinOrchestrator(store, CLOUD_URL);
    expect(
      pinned.set({ orchestratorBaseUrl: 'https://elsewhere.example', orchestratorToken: 't' }),
    ).toEqual({ status: 'invalid', code: 'INVALID_CREDENTIALS' });
    expect(writes).toEqual([]);
  });

  it('stores the session token a sign-in writes beside its own address, and only the token', () => {
    const { store, contents } = memoryStore();
    const pinned = pinOrchestrator(store, CLOUD_URL);
    expect(
      pinned.set({ orchestratorBaseUrl: `${CLOUD_URL}/`, orchestratorToken: 'session' }),
    ).toEqual({
      status: 'saved',
    });
    expect(contents()).toEqual({ orchestratorToken: 'session' });
  });

  it('reports sign-out (the address alone) as saved, so it is not a storage error', () => {
    const { store, contents } = memoryStore({ orchestratorToken: 'session' });
    const pinned = pinOrchestrator(store, CLOUD_URL);
    expect(pinned.set({ orchestratorBaseUrl: CLOUD_URL })).toEqual({ status: 'saved' });
    expect(contents()).toBeNull();
    expect(pinned.get()).toEqual({
      status: 'configured',
      credentials: { orchestratorBaseUrl: CLOUD_URL },
    });
  });
});

describe('the app-info channel', () => {
  type Handler = (event: unknown, value?: unknown) => Promise<unknown>;

  function register(trusted: boolean) {
    const handlers = new Map<string, Handler>();
    registerAppInfoIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      isTrustedSender: () => trusted,
      info: { edition: 'cloud', version: '1.2.3' },
    });
    return handlers.get(APP_INFO_CHANNEL)!;
  }

  it('tells our own windows which build this is', async () => {
    await expect(register(true)({})).resolves.toEqual({
      status: 'ok',
      edition: 'cloud',
      version: '1.2.3',
    });
  });

  it('answers anything else with a refusal, behind the same fence as every channel', async () => {
    await expect(register(false)({})).resolves.toEqual({ status: 'error', code: 'UNAUTHORIZED' });
  });
});
