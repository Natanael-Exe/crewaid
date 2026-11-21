import {
  AUTH_BASE_PATH,
  DESKTOP_AUTH_CALLBACK_PATH,
  DESKTOP_AUTH_CLIENT_ID,
  desktopAuthScheme,
  type Edition,
} from '@crewaid/shared';
import { guardedIpc } from './tokenStore.js';
import type {
  TokenBag,
  TokenIpcMainLike,
  TokenStoreReadResult,
  TokenStoreWriteResult,
} from './tokenStore.js';

/**
 * Browser sign-in for the desktop.
 *
 * The shape of the flow
 *
 * 1. The renderer asks to sign in. The main process generates a PKCE verifier,
 * keeps it, and opens the SYSTEM BROWSER at the orchestrator's sign-in page
 * carrying only the challenge.
 * 2. The person signs in there, with whatever the orchestrator is configured
 * for. The page bounces back to `crewaid://auth/callback#token=<code>`.
 * 3. This process validates that callback, spends the code together with the
 * verifier it never transmitted, and receives a session token.
 * 4. The token goes into the CC-07 store — the same bag, the same shape the
 * renderer has always read. Nothing downstream of it changes.
 *
 * The browser is not an implementation detail. An embedded window would mean
 * asking people to type a Google password into a window this app controls,
 * which is the exact thing OAuth exists to stop (RFC 8252 §8.12), and it would
 * also break every provider that refuses to render in a WebView.
 *
 * What this file owns, and what it does not
 *
 * The protocol wire format — the code blob, the PKCE derivation, the exchange
 * request — belongs to `@better-auth/electron`, pinned to the same version as
 * the orchestrator's plugin. None of it is specified anywhere; re-deriving it
 * here would pin this app to an internal shape that can move in a patch.
 *
 * What is written here is everything the library does NOT do: the callback
 * check below, the IPC surface behind the existing fence, and putting the
 * result where the rest of the app already looks for it.
 */

/** Where the sign-in flow can end up, as far as the renderer is concerned. */
export type SignInUser = {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  /** The identity provider's profile photo, absent when there is none worth loading. */
  readonly image?: string;
};

/**
 * The profile photo, if it is one the renderer may load.
 *
 * https only. The address comes from whatever the identity provider told the
 * orchestrator, and it ends up as an `<img src>`: a `file:` URL there reads
 * this machine's disk, and a plain-http one leaks who is signed in to anyone
 * on the network path. Anything else is dropped, and the avatar falls back to
 * initials — the same thing it shows for an account with no photo at all.
 */
export function accountImage(value: unknown): { image: string } | Record<string, never> {
  if (typeof value !== 'string') return {};
  try {
    return new URL(value).protocol === 'https:' ? { image: value } : {};
  } catch {
    return {};
  }
}

export type AuthStatus =
  | { readonly status: 'signed-in'; readonly user: SignInUser }
  | { readonly status: 'signed-out' }
  /** No orchestrator address yet — there is nothing to sign in TO. */
  | { readonly status: 'unconfigured' }
  | {
      readonly status: 'error';
      readonly code: 'NETWORK' | 'REFUSED' | 'STORAGE' | 'IPC_ERROR' | 'UNAUTHORIZED';
    };

export type SignInResult =
  | { readonly status: 'opened' }
  | { readonly status: 'unconfigured' }
  | {
      readonly status: 'error';
      readonly code: 'NETWORK' | 'REFUSED' | 'IPC_ERROR' | 'UNAUTHORIZED';
    };

/**
 * Is this deep link one of ours, and is it shaped like a callback?
 *
 * Why this exists when the library also checks
 *
 * `handleDeepLink` checks the scheme, the path and the `#token=` prefix, and
 * then spends the code. This runs FIRST and is strictly narrower, so the pair
 * composes to the stricter rule rather than to the looser one — which is the
 * only way two checks on the same thing are ever safe.
 *
 * It earns its place three ways. It is a pure function, so the rule is stated
 * somewhere a test can hold it, and a change to the scheme or the path in
 * `@crewaid/shared` fails a test instead of producing a callback that silently
 * never arrives. It refuses a URL carrying a query string or credentials,
 * which a real callback never has. And it means the main process does not call
 * into auth code at all for a link that is not a sign-in — every other URL the
 * OS hands this app stops here.
 *
 * What it deliberately does NOT do is decide whether the code is GOOD. That
 * question has one correct answer and the orchestrator holds it: the code is
 * bound to a PKCE challenge, single use, and expires in five minutes. A client
 * that tried to pre-judge it would be guessing.
 *
 * Only this build's edition's scheme passes: the cloud and self-hosted
 * apps can share a machine, and a callback meant for the other one carries a
 * code this process holds no verifier for.
 */
export function isDesktopAuthCallback(url: unknown, edition: Edition): boolean {
  if (typeof url !== 'string' || url === '') return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== `${desktopAuthScheme(edition)}:`) return false;
  // Credentials in a deep link are never ours and are a classic way to smuggle
  // something past a naive host check.
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.search !== '') return false;

  // The scheme is not registered as "standard", so `crewaid://auth/callback`
  // parses with `auth` as the host and `/callback` as the path. Rejoining is
  // what makes the comparison a comparison against one contract string rather
  // than against two halves that can each look plausible alone.
  if (`/${parsed.hostname}${parsed.pathname}` !== DESKTOP_AUTH_CALLBACK_PATH) return false;

  const token = parsed.hash.startsWith('#token=') ? parsed.hash.slice('#token='.length) : '';
  if (token === '') return false;
  // base64url of a small JSON object. The cap is not a security boundary — the
  // exchange is — it just keeps an arbitrarily large fragment from being
  // decoded and parsed before anything has vouched for it.
  return token.length <= 1024 && /^[A-Za-z0-9_-]+={0,2}$/.test(token);
}

/**
 * The page the browser is sent to, derived from the orchestrator's address.
 *
 * Exported because two places need the same string and neither should spell
 * it: `main.ts` configures the auth client with it, and `start` opens it.
 */
export function signInPageUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${AUTH_BASE_PATH}/electron/sign-in`;
}

export type SignInStore = {
  readonly get: () => TokenStoreReadResult;
  readonly set: (value: unknown) => TokenStoreWriteResult;
};

/**
 * The library surface, injected rather than imported here.
 *
 * `@better-auth/electron/client` insists on running in an Electron main
 * process — it throws on `process.type` — so a controller that imported it
 * directly could not be constructed in a unit test at all. The seam keeps the
 * wiring in `main.ts`, where it belongs, and leaves the decisions in this file
 * testable.
 */
export type AuthExchange = {
  /** Open the browser at this orchestrator's sign-in page, remembering the PKCE verifier. */
  readonly requestAuth: (baseUrl: string) => Promise<void>;
  /** Spend a code. Resolves to the session token and its owner. */
  readonly authenticate: (
    baseUrl: string,
    token: string,
  ) => Promise<{ readonly token: string; readonly user: SignInUser }>;
};

export type SignInControllerOptions = {
  /** Which build this is; decides the only scheme a callback may arrive on. */
  readonly edition: Edition;
  readonly store: SignInStore;
  readonly exchange: AuthExchange;
  /** Injected so the status check can be driven without a server. */
  readonly fetch?: typeof globalThis.fetch;
  /** Called after the stored credentials change, so the shell can reconnect. */
  readonly onChanged?: (status: AuthStatus) => void;
};

export type SignInController = {
  readonly start: () => Promise<SignInResult>;
  readonly complete: (token: unknown) => Promise<AuthStatus>;
  readonly handleCallback: (url: unknown) => Promise<AuthStatus | null>;
  readonly signOut: () => Promise<AuthStatus>;
  readonly status: () => Promise<AuthStatus>;
};

function configuredBaseUrl(store: SignInStore): string | null {
  const result = store.get();
  const url = result.status === 'configured' ? result.credentials.orchestratorBaseUrl : undefined;
  return url === undefined || url === '' ? null : url.replace(/\/+$/, '');
}

function storedToken(store: SignInStore): string | null {
  const result = store.get();
  const token = result.status === 'configured' ? result.credentials.orchestratorToken : undefined;
  return token === undefined || token === '' ? null : token;
}

export function createSignInController(options: SignInControllerOptions): SignInController {
  const doFetch = options.fetch ?? globalThis.fetch;

  function announce(status: AuthStatus): AuthStatus {
    options.onChanged?.(status);
    return status;
  }

  /**
   * Write the session token into the CC-07 bag, keeping the address.
   *
   * The address is re-read rather than remembered from the start of the flow:
   * the two are one record, and writing a token beside a stale URL is how a
   * client ends up authenticating confidently against the wrong server.
   */
  function persist(baseUrl: string, token: string): TokenStoreWriteResult {
    const bag: TokenBag = { orchestratorBaseUrl: baseUrl, orchestratorToken: token };
    return options.store.set(bag);
  }

  async function exchangeCode(token: string): Promise<AuthStatus> {
    const baseUrl = configuredBaseUrl(options.store);
    if (baseUrl === null) return announce({ status: 'unconfigured' });

    let result: { token: string; user: SignInUser };
    try {
      result = await options.exchange.authenticate(baseUrl, token);
    } catch {
      // Every way this fails — an expired code, a replayed one, a verifier
      // this process no longer has after a restart — is the same thing to the
      // person holding the app: that sign-in did not take, start again.
      return announce({ status: 'error', code: 'REFUSED' });
    }

    const written = persist(baseUrl, result.token);
    if (written.status !== 'saved') {
      // A session that exists on the server and nowhere on this machine is
      // worse than no session: the app looks signed out and the row lives on.
      return announce({ status: 'error', code: 'STORAGE' });
    }
    return announce({ status: 'signed-in', user: result.user });
  }

  return {
    start: async () => {
      const baseUrl = configuredBaseUrl(options.store);
      if (baseUrl === null) return { status: 'unconfigured' };
      try {
        await options.exchange.requestAuth(baseUrl);
        return { status: 'opened' };
      } catch {
        return { status: 'error', code: 'NETWORK' };
      }
    },

    /**
     * The paste-the-code path.
     *
     * Not a nicety. Custom-scheme handoff is the part of this flow that is
     * least reliable on someone else's machine — an unpackaged build on macOS
     * registers the scheme to Electron itself, a Linux desktop may have no
     * handler at all, and a browser running in a sandbox may refuse the
     * navigation outright. The page shows the code for exactly this, and
     * without somewhere to put it that display would be decoration.
     *
     * It is not a weaker door. The same code, the same verifier, the same
     * server-side check — only the transport differs.
     */
    complete: (token) => {
      if (typeof token !== 'string' || token.trim() === '') {
        return Promise.resolve({ status: 'error', code: 'REFUSED' } as const);
      }
      return exchangeCode(token.trim());
    },

    /**
     * `null` means "not for us" — the URL was some other deep link, and the
     * caller should leave it alone rather than report a failed sign-in.
     */
    handleCallback: async (url) => {
      if (!isDesktopAuthCallback(url, options.edition)) return null;
      const hash = new URL(url as string).hash;
      return await exchangeCode(hash.slice('#token='.length));
    },

    /**
     * End the session at the server, then locally.
     *
     * In that order, and both halves matter. Clearing only the local token
     * leaves a live `Session` row that anything holding a copy can still spend
     * — which is what "log out" is supposed to prevent. Refusing to clear
     * locally when the server cannot be reached would strand someone signed in
     * to an orchestrator that no longer exists, so the local clear happens
     * regardless and the unreachable server keeps a row that expires on its
     * own.
     */
    signOut: async () => {
      const baseUrl = configuredBaseUrl(options.store);
      const token = storedToken(options.store);
      if (baseUrl !== null && token !== null) {
        try {
          await doFetch(`${baseUrl}${AUTH_BASE_PATH}/sign-out`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: '{}',
          });
        } catch {
          // Deliberately swallowed: see above.
        }
      }
      if (baseUrl !== null) {
        const cleared = options.store.set({ orchestratorBaseUrl: baseUrl });
        if (cleared.status !== 'saved') return announce({ status: 'error', code: 'STORAGE' });
      }
      return announce({ status: 'signed-out' });
    },

    /**
     * Ask the orchestrator who this token belongs to.
     *
     * A live question rather than a remembered answer, because the stored
     * token is not proof of anything: V1-09 made revocation bite at the next
     * frame, and a status read from local state would keep reporting a name
     * for a session that was ended from somewhere else. This is also why
     * nothing about the account is persisted — there is no second copy to go
     * stale.
     */
    status: async () => {
      const baseUrl = configuredBaseUrl(options.store);
      if (baseUrl === null) return { status: 'unconfigured' };
      const token = storedToken(options.store);
      if (token === null) return { status: 'signed-out' };

      let response: Response;
      try {
        response = await doFetch(`${baseUrl}${AUTH_BASE_PATH}/get-session`, {
          headers: { authorization: `Bearer ${token}` },
        });
      } catch {
        return { status: 'error', code: 'NETWORK' };
      }
      if (response.status === 401 || response.status === 403) return { status: 'signed-out' };
      if (!response.ok) return { status: 'error', code: 'NETWORK' };

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { status: 'error', code: 'NETWORK' };
      }
      const user = readUser(body);
      // Better Auth answers 200 with a null body for a token it does not
      // recognise, which is a signed-OUT answer and not an error — reporting
      // it as one would put a red banner in front of someone who simply needs
      // to sign in.
      return user === null ? { status: 'signed-out' } : { status: 'signed-in', user };
    },
  };
}

/** Narrow `GET /get-session`'s body without trusting it. */
function readUser(body: unknown): SignInUser | null {
  if (typeof body !== 'object' || body === null) return null;
  const user = (body as { user?: unknown }).user;
  if (typeof user !== 'object' || user === null) return null;
  const { id, email, name, image } = user as {
    id?: unknown;
    email?: unknown;
    name?: unknown;
    image?: unknown;
  };
  if (typeof id !== 'string' || id === '') return null;
  return {
    id,
    email: typeof email === 'string' ? email : '',
    name: typeof name === 'string' ? name : '',
    ...accountImage(image),
  };
}

/** The client id the orchestrator will mint a code for. Re-exported so `main.ts` has one import. */
export const SIGN_IN_CLIENT_ID = DESKTOP_AUTH_CLIENT_ID;

/**
 * Where the renderer is told a sign-in finished, or ended.
 *
 * One-way, main → renderer. It carries a status and never a credential: the
 * token itself goes to the CC-07 store, which the renderer already reads
 * through its own guarded channel, so nothing is duplicated onto an event bus
 * where a stale copy could outlive the real one.
 */
export const AUTH_CHANGED_CHANNEL = 'crewaid:auth:changed';

const IPC_FAILURE: AuthStatus = { status: 'error', code: 'IPC_ERROR' };
const IPC_UNAUTHORIZED: AuthStatus = { status: 'error', code: 'UNAUTHORIZED' };
const START_FAILURE: SignInResult = { status: 'error', code: 'IPC_ERROR' };
const START_UNAUTHORIZED: SignInResult = { status: 'error', code: 'UNAUTHORIZED' };

export type RegisterAuthIpcOptions = {
  readonly ipcMain: TokenIpcMainLike;
  readonly controller: SignInController;
  readonly isTrustedSender: (event: unknown) => boolean;
};

/**
 * The renderer's four doors into sign-in, behind the existing fence.
 *
 * Registered through `guardedIpc` — the same closure the token channels use,
 * carrying the same trusted-sender predicate from the same call site in
 * `main.ts`. That is the point: sign-in did not bring a second fence with it,
 * so there is no looser one to find.
 */
export function registerAuthIpc(options: RegisterAuthIpcOptions): void {
  const register = guardedIpc(options);
  const status = { unauthorized: IPC_UNAUTHORIZED, failed: IPC_FAILURE };

  register('crewaid:auth:status', () => options.controller.status(), status);
  register('crewaid:auth:signOut', () => options.controller.signOut(), status);
  register('crewaid:auth:complete', (value) => options.controller.complete(value), status);
  register('crewaid:auth:start', () => options.controller.start(), {
    unauthorized: START_UNAUTHORIZED,
    failed: START_FAILURE,
  });
}
