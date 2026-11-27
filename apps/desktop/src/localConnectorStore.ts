import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import type { LocalConnectorReportMode } from '@crewaid/shared';
import type { SafeStorageLike, TokenStoreFileSystem } from './tokenStore.js';

export interface StoredLocalConnector {
  readonly connectorId: string;
  readonly name: string;
  readonly directory: string;
  readonly serverUrl: string;
  readonly token: string;
  readonly reportMode: LocalConnectorReportMode;
  readonly confirmInApp: boolean;
  readonly autoStart: boolean;
}

export type LocalConnectorStoreReadResult =
  | { readonly status: 'ok'; readonly connectors: readonly StoredLocalConnector[] }
  | { readonly status: 'unavailable'; readonly code: 'ENCRYPTION_UNAVAILABLE' }
  | { readonly status: 'error'; readonly code: 'STORAGE_ERROR' };

export type LocalConnectorStoreWriteResult =
  | { readonly status: 'saved' }
  | { readonly status: 'unavailable'; readonly code: 'ENCRYPTION_UNAVAILABLE' }
  | { readonly status: 'error'; readonly code: 'STORAGE_ERROR' };

export interface LocalConnectorStore {
  readonly list: () => LocalConnectorStoreReadResult;
  readonly upsert: (entry: StoredLocalConnector) => LocalConnectorStoreWriteResult;
  readonly remove: (connectorId: string) => LocalConnectorStoreWriteResult;
}

const STORE_FILE_NAME = 'local-connectors.encrypted';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const defaultFs: TokenStoreFileSystem = {
  existsSync: (filePath) => nodeFs.existsSync(filePath),
  mkdirSync: (directoryPath) => {
    nodeFs.mkdirSync(directoryPath, { recursive: true, mode: DIR_MODE });
  },
  readFileSync: (filePath) => nodeFs.readFileSync(filePath),
  writeFileSync: (filePath, data, options) => {
    nodeFs.writeFileSync(filePath, data, {
      flag: options?.flag ?? 'w',
      mode: options?.mode ?? FILE_MODE,
    });
  },
  renameSync: (sourcePath, destinationPath) => nodeFs.renameSync(sourcePath, destinationPath),
  unlinkSync: (filePath) => nodeFs.unlinkSync(filePath),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidServerUrl(raw: string): boolean {
  if (raw.length === 0 || raw !== raw.trim()) return false;
  try {
    const parsed = new URL(raw);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

function parseEntry(raw: unknown): StoredLocalConnector | null {
  if (!isRecord(raw)) return null;
  const connectorId = raw['connectorId'];
  const name = raw['name'];
  const directory = raw['directory'];
  const serverUrl = raw['serverUrl'];
  const token = raw['token'];
  const reportMode = raw['reportMode'];
  const confirmInApp = raw['confirmInApp'];
  const autoStart = raw['autoStart'];

  if (typeof connectorId !== 'string' || connectorId.trim() === '') return null;
  if (typeof name !== 'string' || name.trim() === '') return null;
  if (typeof directory !== 'string' || directory.trim() === '') return null;
  if (typeof serverUrl !== 'string' || !isValidServerUrl(serverUrl)) return null;
  if (typeof token !== 'string' || !token.startsWith('crw_conn_') || token.length < 24) {
    return null;
  }
  if (reportMode !== 'summary' && reportMode !== 'full') return null;
  if (typeof confirmInApp !== 'boolean') return null;
  if (typeof autoStart !== 'boolean') return null;

  return {
    connectorId,
    name,
    directory,
    serverUrl,
    token,
    reportMode,
    confirmInApp,
    autoStart,
  };
}

export function localConnectorStorePath(userDataPath: string): string {
  return path.join(userDataPath, STORE_FILE_NAME);
}

/**
 * Encrypted-only persistence for desktop-managed local connectors (D-242).
 *
 * Uses the same safeStorage + atomic rename discipline as `tokenStore.ts`:
 * connector bearer tokens never exist in plaintext on disk, and the store
 * never logs or falls back to unencrypted JSON.
 */
export function createLocalConnectorStore(options: {
  readonly safeStorage: SafeStorageLike;
  readonly userDataPath: string;
  readonly fileSystem?: TokenStoreFileSystem;
}): LocalConnectorStore {
  const fs = options.fileSystem ?? defaultFs;
  const filePath = localConnectorStorePath(options.userDataPath);

  function checkAvailability(): 'available' | 'unavailable' | 'error' {
    try {
      return options.safeStorage.isEncryptionAvailable() ? 'available' : 'unavailable';
    } catch {
      return 'error';
    }
  }

  function list(): LocalConnectorStoreReadResult {
    const availability = checkAvailability();
    if (availability === 'unavailable') {
      return { status: 'unavailable', code: 'ENCRYPTION_UNAVAILABLE' };
    }
    if (availability === 'error') {
      return { status: 'error', code: 'STORAGE_ERROR' };
    }
    try {
      if (!fs.existsSync(filePath)) return { status: 'ok', connectors: [] };
      const decrypted = options.safeStorage.decryptString(fs.readFileSync(filePath));
      const parsed: unknown = JSON.parse(decrypted);
      if (!Array.isArray(parsed)) return { status: 'error', code: 'STORAGE_ERROR' };
      const valid: StoredLocalConnector[] = [];
      for (const item of parsed) {
        const entry = parseEntry(item);
        if (entry === null) return { status: 'error', code: 'STORAGE_ERROR' };
        valid.push(entry);
      }
      return { status: 'ok', connectors: valid };
    } catch {
      return { status: 'error', code: 'STORAGE_ERROR' };
    }
  }

  function writeAll(entries: readonly StoredLocalConnector[]): LocalConnectorStoreWriteResult {
    const availability = checkAvailability();
    if (availability === 'unavailable') {
      return { status: 'unavailable', code: 'ENCRYPTION_UNAVAILABLE' };
    }
    if (availability === 'error') {
      return { status: 'error', code: 'STORAGE_ERROR' };
    }
    if (entries.length === 0) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return { status: 'saved' };
      } catch {
        return { status: 'error', code: 'STORAGE_ERROR' };
      }
    }

    let tmpPath: string | undefined;
    try {
      tmpPath = `${filePath}.${randomUUID()}.tmp`;
      const encrypted = options.safeStorage.encryptString(JSON.stringify(entries));
      fs.mkdirSync(options.userDataPath);
      fs.writeFileSync(tmpPath, encrypted, { flag: 'w', mode: FILE_MODE });
      fs.renameSync(tmpPath, filePath);
      tmpPath = undefined;
      return { status: 'saved' };
    } catch {
      return { status: 'error', code: 'STORAGE_ERROR' };
    } finally {
      if (tmpPath !== undefined) {
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
          // Silent best-effort cleanup.
        }
      }
    }
  }

  function upsert(entry: StoredLocalConnector): LocalConnectorStoreWriteResult {
    const validated = parseEntry(entry);
    if (validated === null) return { status: 'error', code: 'STORAGE_ERROR' };
    const current = list();
    if (current.status === 'unavailable') return current;
    if (current.status === 'error') return current;
    const next = current.connectors.filter((item) => item.connectorId !== validated.connectorId);
    next.push(validated);
    return writeAll(next);
  }

  function remove(connectorId: string): LocalConnectorStoreWriteResult {
    const current = list();
    if (current.status === 'unavailable') return current;
    if (current.status === 'error') return current;
    const next = current.connectors.filter((item) => item.connectorId !== connectorId);
    return writeAll(next);
  }

  return { list, upsert, remove };
}
