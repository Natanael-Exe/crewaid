import { electronClient } from '@better-auth/electron/client';
import { createAuthClient } from 'better-auth/client';
import type { BetterAuthClientPlugin } from 'better-auth/client';
import {
  AUTH_BASE_PATH,
  DESKTOP_AUTH_CALLBACK_PATH,
  DESKTOP_AUTH_CLIENT_ID,
  desktopAuthScheme,
  type Edition,
} from '@crewaid/shared';
import { accountImage, signInPageUrl, type AuthExchange, type SignInUser } from './signIn.js';

/**
 * The library half of session sign-in, kept in one file away from the decisions.
 *
 * `@better-auth/electron/client` refuses to load outside an Electron main
 * process, so everything that touches it lives here and reaches the rest of
 * the app through the `AuthExchange` port — which is what lets `signIn.ts` be
 * unit-tested at all.
 *
 * What is taken, and what is left
 *
 * Taken: `requestAuth` (PKCE generation, `shell.openExternal`) and
 * `authenticate` (decode the code, look up the verifier by state, POST the
 * exchange). That is the wire format, and it is shared with the server plugin
 * at the same pinned version.
 *
 * Left alone, deliberately:
 *
 * - `setupMain` / `setupRenderer`. Its preload helper calls
 * `contextBridge.exposeInMainWorld` SEVEN times — `window.requestAuth`,
 * `window.signOut`, `window.getUser` and friends as bare globals — and its
 * `ipcMain.handle` callbacks take `(_evt, …)`: no sender check, no frame
 * check. Alongside the fence that is a second door with a weaker lock on
 * it. The four channels this app exposes go through `guardedIpc` instead.
 * - `storage`, which is the `conf` package writing a JSON file. The session
 * token belongs in the token store like every other credential; the map
 * below holds only the cookie jar for one in-flight exchange, and there is
 * nothing in it worth keeping once the token has landed.
 * - `userImageProxy`, which registers a `user-image://` scheme and fetches
 * avatars through it, and the CSP rewriter, which edits
 * `Content-Security-Policy` on every response the app loads. Neither is
 * wanted, and the second one silently widens `connect-src` for the whole
 * renderer.
 */

/**
 * The cookie jar, in memory, for the length of one exchange.
 *
 * Better Auth's client keeps cookies because a web client would need them.
 * This one does not: what it comes away with is a session token, and §4.4 has
 * accepted `Authorization: Bearer` for a while now. Persisting the jar would mean
 * a second copy of a live credential in a second file with its own lifetime —
 * the copy that gets forgotten when the first is cleared.
 */
function ephemeralStorage(): {
  getItem: (name: string) => unknown;
  setItem: (name: string, value: unknown) => void;
} {
  const memory = new Map<string, unknown>();
  return {
    getItem: (name) => memory.get(name) ?? null,
    setItem: (name, value) => {
      memory.set(name, value);
    },
  };
}

/**
 * The two actions this app calls, named locally.
 *
 * Why the client is built through a cast
 *
 * `electronClient`'s fetch plugin declares `init` as returning options
 * whose `credentials` is `RequestCredentials | undefined`, and this workspace
 * compiles with `exactOptionalPropertyTypes`, under which that is not the same
 * type as an optional `credentials`. The plugin therefore does not satisfy
 * `BetterAuthClientPlugin` here, in a twenty-line variance error about a
 * property nothing in this file sets. It is a typing mismatch between a
 * library and a strict flag, not a disagreement about what the code does.
 *
 * The cast is narrow and it establishes nothing about DATA: what comes back
 * from `authenticate` is still `unknown` to this file, and `readExchange`
 * below is what decides it is a session. That is the distinction the repo's
 * rule about casting draws — silencing a type error about a value is how a
 * live defect hides; naming a library's shape is not.
 */
type ElectronAuthClient = {
  readonly requestAuth: (options?: { readonly provider?: string }) => Promise<void>;
  readonly authenticate: (data: {
    readonly token: string;
    readonly fetchOptions?: { readonly throw?: boolean };
  }) => Promise<unknown>;
};

/**
 * Build the real exchange.
 *
 * One client per orchestrator address, because better-fetch fixes its base URL
 * at construction and the address is a setting a person can change. The PKCE
 * verifier does not live on the client — `@better-auth/electron` keeps it in a
 * process-wide map keyed by state — so a sign-in survives the address being
 * edited mid-flow, and fails at the exchange rather than silently succeeding
 * against the wrong server.
 */
export function createAuthExchange(edition: Edition): AuthExchange {
  const clients = new Map<string, ElectronAuthClient>();

  function clientFor(baseUrl: string): ElectronAuthClient {
    const existing = clients.get(baseUrl);
    if (existing !== undefined) return existing;

    const plugin = electronClient({
      signInURL: signInPageUrl(baseUrl),
      protocol: { scheme: desktopAuthScheme(edition) },
      callbackPath: DESKTOP_AUTH_CALLBACK_PATH,
      clientID: DESKTOP_AUTH_CLIENT_ID,
      storage: ephemeralStorage(),
      userImageProxy: { enabled: false },
    }) as unknown as BetterAuthClientPlugin;

    const client = createAuthClient({
      baseURL: baseUrl,
      basePath: AUTH_BASE_PATH,
      plugins: [plugin],
    }) as unknown as ElectronAuthClient;

    clients.set(baseUrl, client);
    return client;
  }

  return {
    requestAuth: async (baseUrl) => {
      await clientFor(baseUrl).requestAuth();
    },

    authenticate: async (baseUrl, token) => {
      // `throw: true` so a refusal is an exception rather than an `{ error }`
      // the caller could forget to read — and every refusal here means the
      // same thing to the person signing in.
      const result = await clientFor(baseUrl).authenticate({
        token,
        fetchOptions: { throw: true },
      });

      const parsed = readExchange(result);
      if (parsed === null) throw new Error('the exchange returned no session');
      return parsed;
    },
  };
}

/** Narrow the exchange response rather than trusting its declared type. */
function readExchange(value: unknown): { token: string; user: SignInUser } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { token, user } = value as { token?: unknown; user?: unknown };
  if (typeof token !== 'string' || token === '') return null;
  if (typeof user !== 'object' || user === null) return null;
  const { id, email, name, image } = user as {
    id?: unknown;
    email?: unknown;
    name?: unknown;
    image?: unknown;
  };
  if (typeof id !== 'string' || id === '') return null;
  return {
    token,
    user: {
      id,
      email: typeof email === 'string' ? email : '',
      name: typeof name === 'string' ? name : '',
      ...accountImage(image),
    },
  };
}
