import type { Edition } from '@crewaid/shared';
import type {
  AuthStatus,
  CrewaidBridge,
  OpenExternalResult,
  SignInResult,
  TokenBag,
  TokenStoreReadResult,
  TokenStoreWriteResult,
  UpdateInstallResult,
  UpdateState,
} from '../preload';
import type { TokenCredentials } from './connection/wsClient';

/**
 * Typed access to the preload bridge. The renderer has NO other privileged
 * surface: contextIsolation is on, nodeIntegration off, sandbox on.
 */
declare global {
  interface Window {
    crewaid: CrewaidBridge;
  }
}

export {};

const IPC_ERROR: TokenStoreReadResult = { status: 'error', code: 'IPC_ERROR' };
const IPC_WRITE_ERROR: TokenStoreWriteResult = { status: 'error', code: 'IPC_ERROR' };

/**
 * token-store accessors. Renderer never touches fs or safeStorage. The compatibility
 * `get` returns credentials only for a configured store; first-run,
 * unavailable, corrupt, and IPC-error states become empty credentials so the
 * WS/model clients fail closed with their normalized configuration state.
 */
export const tokenStore = {
  get: async (): Promise<TokenCredentials> => {
    try {
      const result = await window.crewaid.token.get();
      return result.status === 'configured' ? result.credentials : {};
    } catch {
      return {};
    }
  },
  getState: async (): Promise<TokenStoreReadResult> => {
    try {
      return await window.crewaid.token.get();
    } catch {
      return IPC_ERROR;
    }
  },
  set: async (bag: TokenBag): Promise<TokenStoreWriteResult> => {
    try {
      return await window.crewaid.token.set(bag);
    } catch {
      return IPC_WRITE_ERROR;
    }
  },
};

/**
 * Which build this is, or `null` when the bridge cannot say.
 *
 * `null` rather than a guessed edition: a renderer that assumed `selfhosted`
 * would show a hosted build an address field for a moment, and one that
 * assumed `cloud` would hide a self-hosted install's only way to be pointed
 * anywhere. Callers render neither edition's extras until they know.
 */
export const appInfo = {
  edition: async (): Promise<Edition | null> => {
    try {
      const result = await window.crewaid.app.info();
      return result.status === 'ok' ? result.edition : null;
    } catch {
      return null;
    }
  },
  /** This app's own release, or `null` without the bridge (D-155: compared with the server's). */
  version: async (): Promise<string | null> => {
    try {
      const result = await window.crewaid.app.info();
      return result.status === 'ok' ? result.version : null;
    } catch {
      return null;
    }
  },
};

/**
 * In-app updates, fail-closed like the rest of this file: without
 * the bridge there is simply no update on offer, never an exception.
 */
export const appUpdate = {
  state: async (): Promise<UpdateState> => {
    try {
      const result = await window.crewaid.update.state();
      return 'code' in result ? { status: 'idle' } : result;
    } catch {
      return { status: 'idle' };
    }
  },
  install: async (): Promise<UpdateInstallResult> => {
    try {
      return await window.crewaid.update.install();
    } catch {
      return { status: 'error', code: 'IPC_ERROR' };
    }
  },
  onChanged: (listener: (state: UpdateState) => void): (() => void) => {
    try {
      return window.crewaid.update.onChanged(listener);
    } catch {
      return () => undefined;
    }
  },
};

/**
 * Open a URL in the operating system's browser.
 *
 * Fail-closed like `tokenStore` above, and for the same reason: a renderer
 * running without the bridge — a unit test, a preload that failed to load —
 * must get a normalized answer rather than a `TypeError` in the middle of a
 * connect flow the operator started. `failed` is the honest one, because the
 * browser did not open either way and the operator's next move is the same.
 */
/**
 * Tell the main process which language this window shows, so the
 * menu bar follows it. Nothing to do without a bridge, and a failure leaves
 * the menu in the language it had.
 */
export function reportLocale(locale: string): void {
  if (typeof window === 'undefined' || typeof window.crewaid === 'undefined') return;
  window.crewaid.app.setLocale(locale).catch(() => undefined);
}

/**
 * Tell the main process which theme preference is active so native menus,
 * scrollbars, and resize frames never flash the opposite color scheme.
 */
export function reportTheme(theme: 'light' | 'dark' | 'system'): void {
  if (typeof window === 'undefined' || typeof window.crewaid === 'undefined') return;
  window.crewaid.app.setTheme(theme).catch(() => undefined);
}

export const systemBrowser = {
  open: async (url: string): Promise<OpenExternalResult> => {
    try {
      return await window.crewaid.shell.openExternal(url);
    } catch {
      return { status: 'failed' };
    }
  },
};

/**
 * The credentials every orchestrator client reads. Kept here, next to the only
 * privileged surface the renderer has, so the "no bridge → empty credentials"
 * rule is written once: three clients previously each carried their own copy
 * of this guard, and a fourth would have made the fail-closed behaviour a
 * convention rather than a fact.
 *
 * Empty credentials are deliberate, not an error. Every caller fails closed on
 * them with its own normalized configuration state.
 */
export function credentialsProvider(): Promise<TokenCredentials> {
  if (typeof window === 'undefined' || typeof window.crewaid === 'undefined') {
    return Promise.resolve({});
  }
  return tokenStore.get();
}

/**
 * Session sign-in, through the same bridge and the same failure discipline.
 *
 * Every call normalizes a thrown IPC error into a result the UI can render,
 * for the reason the accessors above do: a rejected promise from the bridge
 * would surface as an unhandled rejection in a component, and the operator
 * would see a screen that simply never updates.
 *
 * Rendering without a bridge at all is a real case — the settings panes are
 * unit-tested with `renderToStaticMarkup`, where `window.crewaid` does not exist —
 * so the absent-bridge answer is `unconfigured`, which is also the truth.
 */
/**
 * The sign-in surface the renderer has, exactly.
 *
 * Named as a type so a caller injects one object instead of five functions,
 * and so the set of things a component can do about a session stays visible in
 * one place: start, finish by hand, end, ask, and be told. It lives beside
 * `authBridge` because that is the thing that implements it — two components
 * now depend on the shape, and a copy in each would drift.
 */
export type AuthPort = {
  readonly status: () => Promise<AuthStatus>;
  readonly start: () => Promise<SignInResult>;
  readonly complete: (code: string) => Promise<AuthStatus>;
  readonly signOut: () => Promise<AuthStatus>;
  readonly onChanged: (listener: (status: AuthStatus) => void) => () => void;
};

const AUTH_IPC_ERROR: AuthStatus = { status: 'error', code: 'IPC_ERROR' };
const AUTH_ABSENT: AuthStatus = { status: 'unconfigured' };

function hasBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.crewaid !== 'undefined';
}

export const authBridge = {
  status: async (): Promise<AuthStatus> => {
    if (!hasBridge()) return AUTH_ABSENT;
    try {
      return await window.crewaid.auth.status();
    } catch {
      return AUTH_IPC_ERROR;
    }
  },
  start: async (): Promise<SignInResult> => {
    if (!hasBridge()) return { status: 'unconfigured' };
    try {
      return await window.crewaid.auth.start();
    } catch {
      return { status: 'error', code: 'IPC_ERROR' };
    }
  },
  complete: async (code: string): Promise<AuthStatus> => {
    if (!hasBridge()) return AUTH_ABSENT;
    try {
      return await window.crewaid.auth.complete(code);
    } catch {
      return AUTH_IPC_ERROR;
    }
  },
  signOut: async (): Promise<AuthStatus> => {
    if (!hasBridge()) return AUTH_ABSENT;
    try {
      return await window.crewaid.auth.signOut();
    } catch {
      return AUTH_IPC_ERROR;
    }
  },
  onChanged: (listener: (status: AuthStatus) => void): (() => void) => {
    if (!hasBridge()) return () => undefined;
    try {
      return window.crewaid.auth.onChanged(listener);
    } catch {
      return () => undefined;
    }
  },
};

/**
 * The application menu, as an event the shell can subscribe to.
 *
 * A one-way announcement from the main process, so it carries the same
 * failure discipline as the rest of this file for the same reason: rendering
 * without a bridge is a real case (the panes are unit-tested with
 * `renderToStaticMarkup`), and an absent or broken bridge must leave the
 * menu item inert rather than throw inside an effect.
 */
export const menuBridge = {
  onNewBot: (listener: () => void): (() => void) => {
    if (!hasBridge()) return () => undefined;
    try {
      return window.crewaid.menu.onNewBot(listener);
    } catch {
      return () => undefined;
    }
  },
};
