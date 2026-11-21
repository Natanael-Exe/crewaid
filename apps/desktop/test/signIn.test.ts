import { describe, expect, it, vi } from 'vitest';
import { desktopAuthDeepLink } from '@crewaid/shared';
import {
  createSignInController,
  isDesktopAuthCallback,
  registerAuthIpc,
  signInPageUrl,
  type AuthExchange,
  type AuthStatus,
  type SignInStore,
} from '../src/signIn';
import type { TokenStoreReadResult, TokenStoreWriteResult } from '../src/tokenStore';

/**
 * V1-11 — the callback, and what happens after it (D-088).
 *
 * ── WHY THE CALLBACK GETS THIS MUCH ATTENTION ───────────────────────────────
 *
 * A custom protocol handler is a door the operating system opens for anything
 * that asks. Any page on the web can navigate to `crewaid://…`, any app can
 * register the same scheme, and whatever arrives lands in this process as a
 * string. The code inside is worthless without the PKCE verifier — that is the
 * design, and `desktop-sign-in.integration.test.ts` holds the orchestrator to
 * it — but "the server will refuse it" is not a reason for the client to hand
 * an arbitrary URL to its auth code.
 *
 * So the rule is stated as a pure function and pinned here, including the two
 * places it is deliberately narrower than the library's own check.
 */

const VALID = `${desktopAuthDeepLink('cloud')}#token=eyJhIjoxfQ`;

describe('V1-11 — is this deep link a sign-in callback', () => {
  it('accepts the link the sign-in page actually sends', () => {
    // Built from the shared constant rather than typed out, so a change to the
    // scheme or the path in `@crewaid/shared` cannot pass this by moving both
    // sides of a comparison at once.
    expect(isDesktopAuthCallback(VALID, 'cloud')).toBe(true);
  });

  it('refuses another application scheme wearing the right path', () => {
    expect(isDesktopAuthCallback('crewaidbot://auth/callback#token=eyJhIjoxfQ', 'cloud')).toBe(
      false,
    );
    // D-152: the two apps can share a machine, and each takes only its own
    // edition's callback — the other one holds no verifier for that code.
    const selfHosted = `${desktopAuthDeepLink('selfhosted')}#token=eyJhIjoxfQ`;
    expect(isDesktopAuthCallback(selfHosted, 'selfhosted')).toBe(true);
    expect(isDesktopAuthCallback(selfHosted, 'cloud')).toBe(false);
    expect(isDesktopAuthCallback(VALID, 'selfhosted')).toBe(false);
    expect(isDesktopAuthCallback('https://auth/callback#token=eyJhIjoxfQ', 'cloud')).toBe(false);
  });

  it('refuses a path that is not the callback', () => {
    expect(isDesktopAuthCallback('crewaid://auth/other#token=eyJhIjoxfQ', 'cloud')).toBe(false);
    expect(isDesktopAuthCallback('crewaid://callback#token=eyJhIjoxfQ', 'cloud')).toBe(false);
  });

  it('refuses a path that only becomes the callback before normalization', () => {
    // `new URL` collapses the traversal to `/evil`, so the rejoined path is
    // `/auth/evil`. Asserted because a check written against the RAW string
    // would have matched the prefix and let this through.
    expect(
      isDesktopAuthCallback('crewaid://auth/callback/../../evil#token=eyJhIjoxfQ', 'cloud'),
    ).toBe(false);
  });

  it('refuses a link carrying credentials — the library does not', () => {
    // `handleDeepLink` compares host and path and never looks at userinfo, so
    // this reaches its exchange. It is refused here instead: credentials in a
    // deep link are never ours, and userinfo before an `@` is the oldest way
    // of making a URL read as one host to a person and another to a parser.
    expect(
      isDesktopAuthCallback('crewaid://user:pass@auth/callback#token=eyJhIjoxfQ', 'cloud'),
    ).toBe(false);
  });

  it('refuses a link carrying a query string — the library does not', () => {
    // A real callback has none: everything travels in the fragment, which is
    // the half of a URL that browsers and servers do not log.
    expect(isDesktopAuthCallback('crewaid://auth/callback?next=x#token=eyJhIjoxfQ', 'cloud')).toBe(
      false,
    );
  });

  it('refuses a fragment that is not a token', () => {
    expect(isDesktopAuthCallback('crewaid://auth/callback', 'cloud')).toBe(false);
    expect(isDesktopAuthCallback('crewaid://auth/callback#', 'cloud')).toBe(false);
    expect(isDesktopAuthCallback('crewaid://auth/callback#token=', 'cloud')).toBe(false);
    expect(isDesktopAuthCallback('crewaid://auth/callback#code=eyJhIjoxfQ', 'cloud')).toBe(false);
  });

  it('refuses a token that is not base64url, or is absurdly long', () => {
    expect(isDesktopAuthCallback('crewaid://auth/callback#token=has spaces', 'cloud')).toBe(false);
    expect(isDesktopAuthCallback('crewaid://auth/callback#token=<script>', 'cloud')).toBe(false);
    expect(
      isDesktopAuthCallback(`crewaid://auth/callback#token=${'a'.repeat(1025)}`, 'cloud'),
    ).toBe(false);
  });

  it('refuses anything that is not a URL at all', () => {
    // The OS hands over a string, and on a cold start it is simply whatever
    // was last on the command line.
    for (const value of ['', 'not a url', '.', undefined, null, 42, {}]) {
      expect(isDesktopAuthCallback(value, 'cloud')).toBe(false);
    }
  });
});

// ── The controller ──────────────────────────────────────────────────────────

const BASE = 'http://localhost:3000';
const USER = { id: 'usr_1', email: 'someone@example.com', name: 'Someone' };

function storeWith(credentials: { baseUrl?: string; token?: string }): {
  store: SignInStore;
  writes: unknown[];
} {
  const writes: unknown[] = [];
  let current: { orchestratorBaseUrl?: string; orchestratorToken?: string } = {};
  if (credentials.baseUrl !== undefined) current.orchestratorBaseUrl = credentials.baseUrl;
  if (credentials.token !== undefined) current.orchestratorToken = credentials.token;

  const store: SignInStore = {
    get: (): TokenStoreReadResult =>
      current.orchestratorToken === undefined && current.orchestratorBaseUrl === undefined
        ? { status: 'missing' }
        : { status: 'configured', credentials: current },
    set: (value): TokenStoreWriteResult => {
      writes.push(value);
      current = value as typeof current;
      return { status: 'saved' };
    },
  };
  return { store, writes };
}

function exchangeThat(behaviour: Partial<AuthExchange> = {}): AuthExchange & {
  requestAuth: ReturnType<typeof vi.fn>;
  authenticate: ReturnType<typeof vi.fn>;
} {
  const requestAuth = vi.fn(behaviour.requestAuth ?? (() => Promise.resolve()));
  const authenticate = vi.fn(
    behaviour.authenticate ?? (() => Promise.resolve({ token: 'sess_new', user: USER })),
  );
  return { requestAuth, authenticate } as never;
}

describe('V1-11 — the sign-in controller', () => {
  it('opens the orchestrator its credentials point at', async () => {
    const { store } = storeWith({ baseUrl: BASE, token: 'sess_old' });
    const exchange = exchangeThat();
    const controller = createSignInController({ edition: 'cloud', store, exchange });

    await expect(controller.start()).resolves.toEqual({ status: 'opened' });
    expect(exchange.requestAuth).toHaveBeenCalledWith(BASE);
    expect(signInPageUrl(BASE)).toBe(`${BASE}/api/v1/auth/electron/sign-in`);
  });

  it('opens nothing when no orchestrator has been named', async () => {
    // Not an error, and not a browser window either. Somebody who has not set
    // an address yet is one field away, not one failure away — and opening a
    // browser at nothing would be the most confusing possible answer.
    const { store } = storeWith({});
    const exchange = exchangeThat();
    const controller = createSignInController({ edition: 'cloud', store, exchange });

    await expect(controller.start()).resolves.toEqual({ status: 'unconfigured' });
    expect(exchange.requestAuth).not.toHaveBeenCalled();
  });

  it('ignores a deep link that is not ours, without touching auth code', async () => {
    const { store } = storeWith({ baseUrl: BASE });
    const exchange = exchangeThat();
    const controller = createSignInController({ edition: 'cloud', store, exchange });

    await expect(controller.handleCallback('crewaid://auth/other#token=abc')).resolves.toBeNull();
    await expect(controller.handleCallback('https://example.com')).resolves.toBeNull();
    expect(exchange.authenticate).not.toHaveBeenCalled();
  });

  it('spends a real callback and stores the session beside its address', async () => {
    const { store, writes } = storeWith({ baseUrl: BASE });
    const exchange = exchangeThat();
    const announced: AuthStatus[] = [];
    const controller = createSignInController({
      edition: 'cloud',
      store,
      exchange,
      onChanged: (status) => announced.push(status),
    });

    await expect(controller.handleCallback(VALID)).resolves.toEqual({
      status: 'signed-in',
      user: USER,
    });

    expect(exchange.authenticate).toHaveBeenCalledWith(BASE, 'eyJhIjoxfQ');
    // The address is written with the token, not left to whatever was there.
    // A token beside a stale URL is a client authenticating confidently
    // against the wrong server.
    expect(writes).toEqual([{ orchestratorBaseUrl: BASE, orchestratorToken: 'sess_new' }]);
    expect(announced).toEqual([{ status: 'signed-in', user: USER }]);
  });

  it('writes nothing when the exchange is refused', async () => {
    // The refusal is the normal case for a stolen link, a replayed code, or a
    // restart mid-flow — and writing a partial credential after any of them
    // would leave the app pointed at a session it does not have.
    const { store, writes } = storeWith({ baseUrl: BASE });
    const exchange = exchangeThat({ authenticate: () => Promise.reject(new Error('nope')) });
    const controller = createSignInController({ edition: 'cloud', store, exchange });

    await expect(controller.handleCallback(VALID)).resolves.toEqual({
      status: 'error',
      code: 'REFUSED',
    });
    expect(writes).toEqual([]);
  });

  it('reports a session that could not be written to disk', async () => {
    // Signed in at the server and nowhere on this machine is WORSE than signed
    // out: the row is live and the app cannot use it, so saying "signed in"
    // here would be a lie with a live credential behind it.
    const { store } = storeWith({ baseUrl: BASE });
    const failing: SignInStore = {
      get: store.get,
      set: () => ({ status: 'unavailable', code: 'ENCRYPTION_UNAVAILABLE' }),
    };
    const controller = createSignInController({
      edition: 'cloud',
      store: failing,
      exchange: exchangeThat(),
    });

    await expect(controller.handleCallback(VALID)).resolves.toEqual({
      status: 'error',
      code: 'STORAGE',
    });
  });

  it('refuses an empty pasted code without a round trip', async () => {
    const { store } = storeWith({ baseUrl: BASE });
    const exchange = exchangeThat();
    const controller = createSignInController({ edition: 'cloud', store, exchange });

    await expect(controller.complete('   ')).resolves.toEqual({ status: 'error', code: 'REFUSED' });
    expect(exchange.authenticate).not.toHaveBeenCalled();
  });

  it('ends the session at the server as well as locally', async () => {
    // Clearing only the local copy leaves a live `Session` row that anything
    // holding it can still spend, which is the one thing "sign out" is for.
    const { store, writes } = storeWith({ baseUrl: BASE, token: 'sess_old' });
    const fetched: Array<[string, RequestInit | undefined]> = [];
    const controller = createSignInController({
      edition: 'cloud',
      store,
      exchange: exchangeThat(),
      fetch: ((url: string, init?: RequestInit) => {
        fetched.push([url, init]);
        return Promise.resolve(new Response('{}', { status: 200 }));
      }) as typeof fetch,
    });

    await expect(controller.signOut()).resolves.toEqual({ status: 'signed-out' });

    expect(fetched[0]?.[0]).toBe(`${BASE}/api/v1/auth/sign-out`);
    expect((fetched[0]?.[1]?.headers as Record<string, string>)['authorization']).toBe(
      'Bearer sess_old',
    );
    // The address survives; only the credential goes.
    expect(writes).toEqual([{ orchestratorBaseUrl: BASE }]);
  });

  it('still signs out locally when the orchestrator cannot be reached', async () => {
    // Otherwise someone whose server is gone can never sign out of it — and
    // the credential they wanted rid of stays on their disk.
    const { store, writes } = storeWith({ baseUrl: BASE, token: 'sess_old' });
    const controller = createSignInController({
      edition: 'cloud',
      store,
      exchange: exchangeThat(),
      fetch: (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch,
    });

    await expect(controller.signOut()).resolves.toEqual({ status: 'signed-out' });
    expect(writes).toEqual([{ orchestratorBaseUrl: BASE }]);
  });

  it('asks the orchestrator who the stored token belongs to', async () => {
    const { store } = storeWith({ baseUrl: BASE, token: 'sess_old' });
    const controller = createSignInController({
      edition: 'cloud',
      store,
      exchange: exchangeThat(),
      fetch: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ user: USER }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )) as typeof fetch,
    });

    await expect(controller.status()).resolves.toEqual({ status: 'signed-in', user: USER });
  });

  it('carries the account photo, and only an https one', async () => {
    // The photo becomes an `<img src>` in the renderer. A `file:` address
    // there reads this machine's disk and a plain-http one leaks who is signed
    // in, so anything but https is dropped and the avatar shows initials.
    const { store } = storeWith({ baseUrl: BASE, token: 'sess_old' });
    const statusFor = (image: unknown) =>
      createSignInController({
        edition: 'cloud',
        store,
        exchange: exchangeThat(),
        fetch: (() =>
          Promise.resolve(
            new Response(JSON.stringify({ user: { ...USER, image } }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          )) as typeof fetch,
      }).status();

    const photo = 'https://lh3.googleusercontent.com/a/photo=s96-c';
    await expect(statusFor(photo)).resolves.toEqual({
      status: 'signed-in',
      user: { ...USER, image: photo },
    });
    for (const refused of [
      'file:///etc/passwd',
      'http://example.com/a.png',
      'not a url',
      null,
      7,
    ]) {
      const result = await statusFor(refused);
      expect(result, String(refused)).toEqual({ status: 'signed-in', user: USER });
      expect(result.status === 'signed-in' && 'image' in result.user, String(refused)).toBe(false);
    }
  });

  it('reports a revoked session as signed out, not as an error', async () => {
    // V1-09 made revocation bite at the next frame. A status read from local
    // state would keep printing a name for a session that ended elsewhere;
    // asking is what makes this honest. Better Auth answers 200 with a null
    // body for a token it does not know, which is a signed-OUT answer — shown
    // as an error it would put a red banner in front of a normal sign-in.
    const { store } = storeWith({ baseUrl: BASE, token: 'sess_revoked' });
    for (const response of [
      new Response('null', { status: 200, headers: { 'content-type': 'application/json' } }),
      new Response('', { status: 401 }),
    ]) {
      const controller = createSignInController({
        edition: 'cloud',
        store,
        exchange: exchangeThat(),
        fetch: (() => Promise.resolve(response.clone())) as typeof fetch,
      });
      await expect(controller.status()).resolves.toEqual({ status: 'signed-out' });
    }
  });

  it('separates "no address" from "not signed in"', async () => {
    const { store } = storeWith({ baseUrl: BASE });
    const signedOut = createSignInController({ edition: 'cloud', store, exchange: exchangeThat() });
    await expect(signedOut.status()).resolves.toEqual({ status: 'signed-out' });

    const { store: empty } = storeWith({});
    const unconfigured = createSignInController({
      edition: 'cloud',
      store: empty,
      exchange: exchangeThat(),
    });
    await expect(unconfigured.status()).resolves.toEqual({ status: 'unconfigured' });
  });
});

// ── The IPC fence ───────────────────────────────────────────────────────────

describe('V1-11 — sign-in is behind CC-07‘s fence, not beside it', () => {
  function fakeIpc(): {
    ipcMain: {
      handle: (
        channel: string,
        handler: (event: unknown, value?: unknown) => Promise<unknown>,
      ) => void;
    };
    invoke: (channel: string, event: unknown, value?: unknown) => Promise<unknown>;
    channels: string[];
  } {
    const handlers = new Map<string, (event: unknown, value?: unknown) => Promise<unknown>>();
    return {
      ipcMain: {
        handle: (channel, handler) => {
          handlers.set(channel, handler);
        },
      },
      invoke: (channel, event, value) => {
        const handler = handlers.get(channel);
        if (handler === undefined) throw new Error(`no handler for ${channel}`);
        return handler(event, value);
      },
      channels: [],
    };
  }

  const CHANNELS = [
    'crewaid:auth:status',
    'crewaid:auth:start',
    'crewaid:auth:complete',
    'crewaid:auth:signOut',
  ];

  it('answers an untrusted sender without calling the controller', async () => {
    // THE CASE THE BOARD NOTE NAMES. `@better-auth/electron`'s own bridge
    // registers `(_evt, …) => …` — no sender check at all — so adopting it
    // wholesale would have put a second, looser door next to CC-07's. These
    // channels go through `guardedIpc`, which is the same closure and the same
    // predicate the token channels use.
    const ipc = fakeIpc();
    const controller = {
      start: vi.fn(),
      complete: vi.fn(),
      handleCallback: vi.fn(),
      signOut: vi.fn(),
      status: vi.fn(),
    };
    registerAuthIpc({
      ipcMain: ipc.ipcMain,
      controller: controller as never,
      isTrustedSender: () => false,
    });

    for (const channel of CHANNELS) {
      await expect(ipc.invoke(channel, { sender: 'a window we did not make' })).resolves.toEqual(
        expect.objectContaining({ status: 'error', code: 'UNAUTHORIZED' }),
      );
    }
    for (const spy of Object.values(controller)) expect(spy).not.toHaveBeenCalled();
  });

  it('normalizes a thrown handler rather than rejecting across the bridge', async () => {
    // A rejection would surface in the renderer as an unhandled promise and
    // the pane would simply never update — which is the failure mode CC-07's
    // result unions exist to avoid.
    const ipc = fakeIpc();
    registerAuthIpc({
      ipcMain: ipc.ipcMain,
      controller: {
        start: () => Promise.reject(new Error('boom')),
        complete: () => Promise.reject(new Error('boom')),
        handleCallback: () => Promise.reject(new Error('boom')),
        signOut: () => Promise.reject(new Error('boom')),
        status: () => Promise.reject(new Error('boom')),
      } as never,
      isTrustedSender: () => true,
    });

    for (const channel of CHANNELS) {
      await expect(ipc.invoke(channel, {})).resolves.toEqual(
        expect.objectContaining({ status: 'error', code: 'IPC_ERROR' }),
      );
    }
  });
});
