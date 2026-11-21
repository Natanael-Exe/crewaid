import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';
import path from 'node:path';

/** The only credentials the desktop client may persist. */
export type TokenBag = {
  readonly orchestratorToken?: string;
  readonly orchestratorBaseUrl?: string;
};

export type TokenStoreErrorCode =
  'ENCRYPTION_UNAVAILABLE' | 'INVALID_CREDENTIALS' | 'STORAGE_ERROR' | 'IPC_ERROR' | 'UNAUTHORIZED';

export type TokenStoreReadResult =
  | { readonly status: 'configured'; readonly credentials: TokenBag }
  | { readonly status: 'missing' }
  | { readonly status: 'unavailable'; readonly code: 'ENCRYPTION_UNAVAILABLE' }
  | { readonly status: 'error'; readonly code: 'IPC_ERROR' | 'STORAGE_ERROR' | 'UNAUTHORIZED' };

export type TokenStoreWriteResult =
  | { readonly status: 'saved' }
  | { readonly status: 'cleared' }
  | { readonly status: 'unavailable'; readonly code: 'ENCRYPTION_UNAVAILABLE' }
  | { readonly status: 'invalid'; readonly code: 'INVALID_CREDENTIALS' }
  | { readonly status: 'error'; readonly code: 'IPC_ERROR' | 'STORAGE_ERROR' | 'UNAUTHORIZED' };

/** The narrow Electron safeStorage surface used by the store. */
export type SafeStorageLike = {
  readonly isEncryptionAvailable: () => boolean;
  readonly encryptString: (value: string) => Buffer;
  readonly decryptString: (value: Buffer) => string;
};

type FileWriteOptions = {
  readonly flag?: 'w';
  readonly mode?: number;
};

/** Narrow file-system port so storage failures can be tested without Electron. */
export type TokenStoreFileSystem = {
  readonly existsSync: (filePath: string) => boolean;
  readonly mkdirSync: (directoryPath: string) => void;
  readonly readFileSync: (filePath: string) => Buffer;
  readonly writeFileSync: (filePath: string, data: Buffer, options?: FileWriteOptions) => void;
  readonly renameSync: (sourcePath: string, destinationPath: string) => void;
  readonly unlinkSync: (filePath: string) => void;
};

const TOKEN_FILE_NAME = 'token.encrypted';
const TOKEN_DIRECTORY_MODE = 0o700;
const TOKEN_FILE_MODE = 0o600;
const ENCRYPTED_FILE_WRITE_OPTIONS: FileWriteOptions = {
  flag: 'w',
  mode: TOKEN_FILE_MODE,
};

const defaultFileSystem: TokenStoreFileSystem = {
  existsSync: (filePath) => nodeFs.existsSync(filePath),
  mkdirSync: (directoryPath) => {
    nodeFs.mkdirSync(directoryPath, { recursive: true, mode: TOKEN_DIRECTORY_MODE });
  },
  readFileSync: (filePath) => nodeFs.readFileSync(filePath),
  writeFileSync: (filePath, data, options) => {
    nodeFs.writeFileSync(filePath, data, {
      flag: options?.flag ?? 'w',
      mode: options?.mode ?? TOKEN_FILE_MODE,
    });
  },
  renameSync: (sourcePath, destinationPath) => nodeFs.renameSync(sourcePath, destinationPath),
  unlinkSync: (filePath) => nodeFs.unlinkSync(filePath),
};

const UNAVAILABLE_RESULT: TokenStoreReadResult = {
  status: 'unavailable',
  code: 'ENCRYPTION_UNAVAILABLE',
};
const WRITE_UNAVAILABLE_RESULT: TokenStoreWriteResult = {
  status: 'unavailable',
  code: 'ENCRYPTION_UNAVAILABLE',
};
const STORAGE_READ_ERROR: TokenStoreReadResult = {
  status: 'error',
  code: 'STORAGE_ERROR',
};
const STORAGE_WRITE_ERROR: TokenStoreWriteResult = {
  status: 'error',
  code: 'STORAGE_ERROR',
};
const AVAILABILITY_READ_ERROR: TokenStoreReadResult = {
  status: 'error',
  code: 'STORAGE_ERROR',
};
const AVAILABILITY_WRITE_ERROR: TokenStoreWriteResult = {
  status: 'error',
  code: 'STORAGE_ERROR',
};
const IPC_ERROR_RESULT: TokenStoreReadResult = {
  status: 'error',
  code: 'IPC_ERROR',
};
const IPC_WRITE_ERROR_RESULT: TokenStoreWriteResult = {
  status: 'error',
  code: 'IPC_ERROR',
};

export type TokenStore = {
  readonly get: () => TokenStoreReadResult;
  readonly set: (value: unknown) => TokenStoreWriteResult;
};

export type RendererSecurityWindow = {
  readonly isDestroyed: () => boolean;
  readonly webContents: { readonly mainFrame: unknown };
};

export type CreateTokenStoreOptions = {
  readonly safeStorage: SafeStorageLike;
  readonly userDataPath: string;
  readonly fileSystem?: TokenStoreFileSystem;
};

type ValidatedTokenBag = {
  readonly orchestratorToken?: string;
  readonly orchestratorBaseUrl?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidBaseUrl(value: string): boolean {
  if (value.length === 0 || value !== value.trim()) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

/** Validate untrusted renderer input before it reaches JSON or safeStorage. */
function validateTokenBag(value: unknown): ValidatedTokenBag | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'orchestratorToken' && key !== 'orchestratorBaseUrl')) return null;

  const token = value.orchestratorToken;
  if (token !== undefined && (typeof token !== 'string' || token.trim() === '')) return null;

  const baseUrl = value.orchestratorBaseUrl;
  if (baseUrl !== undefined && (typeof baseUrl !== 'string' || !isValidBaseUrl(baseUrl)))
    return null;

  const result: ValidatedTokenBag = {};
  if (token !== undefined) {
    (result as { orchestratorToken?: string }).orchestratorToken = token;
  }
  if (baseUrl !== undefined) {
    (result as { orchestratorBaseUrl?: string }).orchestratorBaseUrl = baseUrl;
  }
  return result;
}

function parseStoredTokenBag(value: string): ValidatedTokenBag | null {
  try {
    return validateTokenBag(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function emptyBag(bag: ValidatedTokenBag): boolean {
  return bag.orchestratorToken === undefined && bag.orchestratorBaseUrl === undefined;
}

export function tokenStoreFilePath(userDataPath: string): string {
  return path.join(userDataPath, TOKEN_FILE_NAME);
}

/**
 * Fail closed unless an invocation came from the main frame of one of this
 * app's own windows, showing this app's own renderer.
 */
export function isTrustedRendererSender(
  event: unknown,
  windows: readonly (RendererSecurityWindow | null)[],
  isRendererDocument: (url: unknown) => boolean,
): boolean {
  try {
    if (typeof event !== 'object' || event === null) return false;
    const invokeEvent = event as { readonly sender?: unknown; readonly senderFrame?: unknown };
    // The preload belongs to the window, so a window that navigated elsewhere
    // still carries `window.crewaid`. The document is what is trusted, and
    // its URL is the one thing that says which document it is.
    const frame = invokeEvent.senderFrame;
    if (typeof frame !== 'object' || frame === null) return false;
    if (!isRendererDocument((frame as { readonly url?: unknown }).url)) return false;
    // MEMBERSHIP, not identity. The fence is "a window this app created, and
    // its top-level frame" — checking against one window instead makes a
    // second window revoke the first one's credentials, which reads in the UI
    // as a window that connects and then silently receives nothing.
    return windows.some((window) => {
      if (window === null || window.isDestroyed()) return false;
      return (
        invokeEvent.sender === window.webContents &&
        // Still the main frame only: a sub-frame inside a trusted window is
        // not trusted, which is the half of this check that stops embedded
        // content from reaching the token store.
        frame === window.webContents.mainFrame
      );
    });
  } catch {
    return false;
  }
}

/**
 * Create an encrypted-only token store.
 *
 * The plaintext JSON exists only as an argument to safeStorage.encryptString;
 * the file-system port receives ciphertext bytes exclusively. Availability,
 * parse, and I/O failures are normalized so no platform/vendor error detail
 * can cross the preload boundary.
 */
export function createTokenStore(options: CreateTokenStoreOptions): TokenStore {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const filePath = tokenStoreFilePath(options.userDataPath);

  function encryptionAvailability(): 'available' | 'unavailable' | 'error' {
    try {
      return options.safeStorage.isEncryptionAvailable() ? 'available' : 'unavailable';
    } catch {
      return 'error';
    }
  }

  function get(): TokenStoreReadResult {
    const availability = encryptionAvailability();
    if (availability === 'unavailable') return UNAVAILABLE_RESULT;
    if (availability === 'error') return AVAILABILITY_READ_ERROR;
    try {
      if (!fileSystem.existsSync(filePath)) return { status: 'missing' };
      const decrypted = options.safeStorage.decryptString(fileSystem.readFileSync(filePath));
      const credentials = parseStoredTokenBag(decrypted);
      if (credentials === null) return STORAGE_READ_ERROR;
      // `missing` means NOTHING is stored — the same question `set` asks
      // before deleting the file, deliberately through the same predicate.
      // It used to mean "no token", which stopped being the same thing the
      // moment V1-11 gave this store an address-only shape: signing out
      // rewrites the bag as `{ orchestratorBaseUrl }` on purpose, so that
      // ending a session does not also forget which server it was with.
      // Reading that back as `missing` threw the address away on the way out,
      // and the app then asked for an orchestrator it still had on disk.
      // Safe to widen because nothing downstream treats a bag as credentials:
      // `ApiClient.resolveCredentials` and `WsClient.connect` each fail closed
      // when EITHER half is empty, so an address with no token still cannot
      // produce an unauthenticated request.
      if (emptyBag(credentials)) return { status: 'missing' };
      return { status: 'configured', credentials };
    } catch {
      return STORAGE_READ_ERROR;
    }
  }

  function set(value: unknown): TokenStoreWriteResult {
    let credentials: ValidatedTokenBag | null;
    try {
      credentials = validateTokenBag(value);
    } catch {
      return { status: 'invalid', code: 'INVALID_CREDENTIALS' };
    }
    if (credentials === null) {
      return { status: 'invalid', code: 'INVALID_CREDENTIALS' };
    }
    const availability = encryptionAvailability();
    if (availability === 'unavailable') return WRITE_UNAVAILABLE_RESULT;
    if (availability === 'error') return AVAILABILITY_WRITE_ERROR;

    if (emptyBag(credentials)) {
      try {
        if (fileSystem.existsSync(filePath)) fileSystem.unlinkSync(filePath);
        return { status: 'cleared' };
      } catch {
        return STORAGE_WRITE_ERROR;
      }
    }

    let temporaryPath: string | undefined;
    try {
      // The temporary name contains no credential material. Rename replaces the
      // target atomically on the supported desktop platforms.
      temporaryPath = `${filePath}.${randomUUID()}.tmp`;
      const encrypted = options.safeStorage.encryptString(JSON.stringify(credentials));
      fileSystem.mkdirSync(options.userDataPath);
      fileSystem.writeFileSync(temporaryPath, encrypted, ENCRYPTED_FILE_WRITE_OPTIONS);
      fileSystem.renameSync(temporaryPath, filePath);
      temporaryPath = undefined;
      return { status: 'saved' };
    } catch {
      return STORAGE_WRITE_ERROR;
    } finally {
      if (temporaryPath !== undefined) {
        try {
          if (fileSystem.existsSync(temporaryPath)) fileSystem.unlinkSync(temporaryPath);
        } catch {
          // Cleanup is best effort and deliberately silent: never log storage data.
        }
      }
    }
  }

  return { get, set };
}

export type TokenIpcMainLike = {
  readonly handle: (
    channel: string,
    handler: (event: unknown, value?: unknown) => Promise<unknown>,
  ) => void;
};

export type RegisterTokenIpcOptions = {
  readonly ipcMain: TokenIpcMainLike;
  readonly store: TokenStore;
  readonly isTrustedSender: (event: unknown) => boolean;
};

const UNAUTHORIZED_RESULT: TokenStoreReadResult = {
  status: 'error',
  code: 'UNAUTHORIZED',
};
const WRITE_UNAUTHORIZED_RESULT: TokenStoreWriteResult = {
  status: 'error',
  code: 'UNAUTHORIZED',
};

export type GuardedIpcOptions = {
  readonly ipcMain: TokenIpcMainLike;
  readonly isTrustedSender: (event: unknown) => boolean;
};

/**
 * ⚠️ THE ONLY WAY A CHANNEL REACHES THE MAIN PROCESS. Register through this,
 * never through `ipcMain.handle` directly.
 *
 * CC-07's rule is that an invocation is answered only when it came from the
 * main frame of a window this app created, and that every other outcome — an
 * untrusted sender, a thrown handler, a rejected promise — becomes a
 * normalized result rather than an exception carrying platform detail across
 * the preload boundary.
 *
 * It is a returned closure rather than a convention because V1-11 is the first
 * time a second feature needed the same rule. The tempting shape was a fresh
 * `ipcMain.handle` beside the existing pair with its own sender check — and
 * two fences with slightly different rules is precisely how the looser one
 * quietly becomes the one that matters. There is one fence; new channels pass
 * through it or they do not exist.
 */
export function guardedIpc(options: GuardedIpcOptions) {
  return function register<TResult>(
    channel: string,
    handle: (value: unknown) => TResult | Promise<TResult>,
    fallbacks: { readonly unauthorized: TResult; readonly failed: TResult },
  ): void {
    options.ipcMain.handle(channel, (event, value) => {
      if (!options.isTrustedSender(event)) return Promise.resolve(fallbacks.unauthorized);
      return Promise.resolve()
        .then(() => handle(value))
        .catch(() => fallbacks.failed);
    });
  };
}

/** Register a fail-closed, normalized IPC surface for the preload bridge. */
export function registerTokenIpc(options: RegisterTokenIpcOptions): void {
  const register = guardedIpc(options);

  register('crewaid:token:get', () => options.store.get(), {
    unauthorized: UNAUTHORIZED_RESULT,
    failed: IPC_ERROR_RESULT,
  });

  register('crewaid:token:set', (value) => options.store.set(value), {
    unauthorized: WRITE_UNAUTHORIZED_RESULT,
    failed: IPC_WRITE_ERROR_RESULT,
  });
}
