import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenBag, TokenStoreReadResult, TokenStoreWriteResult } from '../src/preload';
import { tokenStore } from '../src/renderer/bridge';

const FIXTURE_CREDENTIAL = 'renderer-fixture-credential';
const BASE_URL = 'https://orchestrator.example/api/v1';

type TokenApi = {
  readonly get: () => Promise<TokenStoreReadResult>;
  readonly set: (bag: TokenBag) => Promise<TokenStoreWriteResult>;
};

function installTokenApi(api: TokenApi): void {
  vi.stubGlobal('window', { crewaid: { token: api } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('renderer tokenStore bridge', () => {
  it('returns exact credentials only when the main process reports configured storage', async () => {
    const get = vi.fn<() => Promise<TokenStoreReadResult>>(() =>
      Promise.resolve({
        status: 'configured',
        credentials: { orchestratorToken: FIXTURE_CREDENTIAL, orchestratorBaseUrl: BASE_URL },
      }),
    );
    installTokenApi({ get, set: vi.fn() });

    await expect(tokenStore.get()).resolves.toEqual({
      orchestratorToken: FIXTURE_CREDENTIAL,
      orchestratorBaseUrl: BASE_URL,
    });
    await expect(tokenStore.getState()).resolves.toEqual({
      status: 'configured',
      credentials: { orchestratorToken: FIXTURE_CREDENTIAL, orchestratorBaseUrl: BASE_URL },
    });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('fails closed for first-run, unavailable, and storage-error states while preserving neutral status', async () => {
    for (const state of [
      { status: 'missing' },
      { status: 'unavailable', code: 'ENCRYPTION_UNAVAILABLE' },
      { status: 'error', code: 'STORAGE_ERROR' },
    ] satisfies readonly TokenStoreReadResult[]) {
      installTokenApi({ get: () => Promise.resolve(state), set: vi.fn() });
      await expect(tokenStore.get()).resolves.toEqual({});
      await expect(tokenStore.getState()).resolves.toEqual(state);
    }
  });

  it('normalizes rejected IPC calls without surfacing platform error details', async () => {
    const detail = 'storage failure detail must not reach the renderer';
    installTokenApi({
      get: () => Promise.reject(new Error(detail)),
      set: () => Promise.reject(new Error(detail)),
    });

    await expect(tokenStore.get()).resolves.toEqual({});
    await expect(tokenStore.getState()).resolves.toEqual({ status: 'error', code: 'IPC_ERROR' });
    await expect(tokenStore.set({ orchestratorToken: FIXTURE_CREDENTIAL })).resolves.toEqual({
      status: 'error',
      code: 'IPC_ERROR',
    });
    await expect(tokenStore.getState()).resolves.not.toMatchObject({ message: detail });
  });
});
