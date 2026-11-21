import { EditionSchema, type Edition } from '@crewaid/shared';
import { guardedIpc } from './tokenStore.js';
import type { TokenIpcMainLike, TokenStore, TokenStoreWriteResult } from './tokenStore.js';

/**
 * Which product this build is, and for the hosted one, where it lives.
 *
 * Fixed when the app is BUILT. electron-builder writes a `crewaid` block into
 * the packaged `package.json` (`extraMetadata` in `electron-builder.<edition>.yml`),
 * and nothing a person can do at run time changes it. The hosted app has its
 * orchestrator's address compiled in and no field anywhere to type another:
 * an address a user could edit is a way to point the paid product at a server
 * that charges nothing.
 */
export type DesktopEdition =
  | { readonly edition: 'cloud'; readonly orchestratorUrl: string }
  | { readonly edition: 'selfhosted' };

/** What the renderer is told about the build: enough to hide what this edition does not have. */
export type AppInfo = { readonly edition: Edition; readonly version: string };

export type EditionSource = {
  readonly packaged: boolean;
  /** The packaged `package.json`, parsed. Unused when not packaged. */
  readonly packageJson: unknown;
  readonly env: Readonly<Record<string, string | undefined>>;
};

/**
 * Read the edition, or throw.
 *
 * A packaged build with no `crewaid` block was built wrong, and is refused
 * rather than defaulted: a hosted build that fell back to `selfhosted` would
 * ask for an address, and one that fell back the other way would have none.
 * Electron shows a thrown main-process error as a dialog, so it surfaces on the
 * first launch of a bad release rather than as an app that half works.
 *
 * Unpackaged (`pnpm dev`, the e2e suite) reads `CREWAID_EDITION` and defaults
 * to `selfhosted`, which asks for an address — the only edition a developer can
 * point at whatever orchestrator they are running.
 */
export function readDesktopEdition(source: EditionSource): DesktopEdition {
  if (!source.packaged) {
    const edition = (source.env['CREWAID_EDITION'] ?? '').trim() || 'selfhosted';
    return parseEdition(
      { edition, orchestratorUrl: source.env['CREWAID_ORCHESTRATOR_URL'] },
      false,
    );
  }
  const block =
    typeof source.packageJson === 'object' && source.packageJson !== null
      ? (source.packageJson as { crewaid?: unknown }).crewaid
      : undefined;
  if (typeof block !== 'object' || block === null) {
    throw new Error(
      'This build has no edition: package.json carries no "crewaid" block. Package it with ' +
        'electron-builder.cloud.yml or electron-builder.selfhosted.yml.',
    );
  }
  return parseEdition(block, true);
}

function parseEdition(
  block: { readonly edition?: unknown; readonly orchestratorUrl?: unknown },
  packaged: boolean,
): DesktopEdition {
  const edition = EditionSchema.safeParse(block.edition);
  if (!edition.success) {
    throw new Error(
      `Unknown edition ${JSON.stringify(block.edition)}; expected "cloud" or "selfhosted"`,
    );
  }
  if (edition.data === 'selfhosted') return { edition: 'selfhosted' };

  const raw = typeof block.orchestratorUrl === 'string' ? block.orchestratorUrl.trim() : '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      packaged
        ? 'A cloud build needs its orchestrator URL (crewaid.orchestratorUrl in package.json)'
        : 'CREWAID_EDITION=cloud needs CREWAID_ORCHESTRATOR_URL',
    );
  }
  // The session token goes to this address on every request. A shipped build
  // pointed at plain http would send it in clear; a developer's localhost is
  // the one place that is acceptable.
  if (url.protocol !== 'https:' && (packaged || url.protocol !== 'http:')) {
    throw new Error(`The cloud orchestrator URL must be https://, got ${JSON.stringify(raw)}`);
  }
  return { edition: 'cloud', orchestratorUrl: url.origin };
}

/**
 * The CC-07 store as a hosted build sees it: always pointing at its own
 * orchestrator, and unable to be pointed anywhere else.
 *
 * Reads report the compiled-in address whatever the file holds — including
 * nothing, so a fresh install goes straight to "sign in" and never to "where
 * is your orchestrator". Writes carrying any other address are refused, which
 * is what makes this a rule rather than a hidden settings field: the renderer
 * channel, the sign-in controller and anything added later all write through
 * here. Only the token is persisted, because the address is not the user's to
 * store.
 */
export function pinOrchestrator(store: TokenStore, orchestratorUrl: string): TokenStore {
  const pinned = orchestratorUrl.replace(/\/+$/, '');
  return {
    get: () => {
      const result = store.get();
      if (result.status === 'missing') {
        return { status: 'configured', credentials: { orchestratorBaseUrl: pinned } };
      }
      if (result.status !== 'configured') return result;
      return {
        status: 'configured',
        credentials: { ...result.credentials, orchestratorBaseUrl: pinned },
      };
    },
    set: (value): TokenStoreWriteResult => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return store.set(value);
      }
      const { orchestratorBaseUrl, ...rest } = value as Record<string, unknown>;
      if (
        orchestratorBaseUrl !== undefined &&
        (typeof orchestratorBaseUrl !== 'string' ||
          orchestratorBaseUrl.replace(/\/+$/, '') !== pinned)
      ) {
        return { status: 'invalid', code: 'INVALID_CREDENTIALS' };
      }
      const written = store.set(rest);
      // `{ orchestratorBaseUrl }` alone is how sign-out clears the token. The
      // file is emptied, but the bag the caller wrote — the address and no
      // token — is exactly what a read now returns, so it was saved.
      return written.status === 'cleared' && orchestratorBaseUrl !== undefined
        ? { status: 'saved' }
        : written;
    },
  };
}

/** The channel the renderer asks which build it is running in. */
export const APP_INFO_CHANNEL = 'crewaid:app:info';

const APP_INFO_REFUSED = { status: 'error', code: 'UNAUTHORIZED' } as const;
const APP_INFO_FAILED = { status: 'error', code: 'IPC_ERROR' } as const;

export type AppInfoResult =
  ({ readonly status: 'ok' } & AppInfo) | typeof APP_INFO_REFUSED | typeof APP_INFO_FAILED;

/** Behind the one trusted-sender fence, from the same call site as every other channel. */
export function registerAppInfoIpc(options: {
  readonly ipcMain: TokenIpcMainLike;
  readonly isTrustedSender: (event: unknown) => boolean;
  readonly info: AppInfo;
}): void {
  const register = guardedIpc(options);
  const answer: AppInfoResult = { status: 'ok', ...options.info };
  register<AppInfoResult>(APP_INFO_CHANNEL, () => answer, {
    unauthorized: APP_INFO_REFUSED,
    failed: APP_INFO_FAILED,
  });
}
