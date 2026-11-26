import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { CONNECTOR_TOKEN_PREFIX, CONNECTOR_WS_PATH } from '@crewaid/shared';

interface StoredConnectorTokens {
  readonly version: 1;
  readonly entries: Record<string, string>;
}

/**
 * Normalizes an orchestrator base URL for keying stored tokens and building
 * the outbound `/ws/connectors` URL. Refuses embedded credentials and fragments.
 */
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new Error('Server URL is required (pass --url https://...).');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (error: unknown) {
    throw new Error(`Invalid server URL: ${raw}`, { cause: error });
  }
  if (
    parsed.protocol !== 'http:' &&
    parsed.protocol !== 'https:' &&
    parsed.protocol !== 'ws:' &&
    parsed.protocol !== 'wss:'
  ) {
    throw new Error(`Unsupported server URL scheme "${parsed.protocol}". Use http:// or https://.`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('Server URL must not contain embedded credentials.');
  }
  if (parsed.hash !== '') {
    throw new Error('Server URL must not contain a #fragment.');
  }
  const httpProtocol =
    parsed.protocol === 'ws:'
      ? 'http:'
      : parsed.protocol === 'wss:'
        ? 'https:'
        : parsed.protocol;
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  return `${httpProtocol}//${parsed.host}${cleanPath}`;
}

/** Builds the exact outbound WebSocket URL (`/ws/connectors`) with zero token query params. */
export function buildConnectorWsUrl(serverUrl: string): string {
  const normalized = normalizeServerUrl(serverUrl);
  const parsed = new URL(normalized);
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  const basePath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = `${basePath}${CONNECTOR_WS_PATH}`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

export function defaultTokenStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env['XDG_CONFIG_HOME']?.trim();
  const baseDir =
    configHome !== undefined && configHome !== ''
      ? configHome
      : path.join(os.homedir(), '.config');
  return path.join(baseDir, 'crewaid', 'connectors.json');
}

function storeKey(serverUrl: string, canonicalDir: string): string {
  return `${normalizeServerUrl(serverUrl)}::${canonicalDir}`;
}

function readStoreFile(storePath: string): StoredConnectorTokens {
  if (!existsSync(storePath)) {
    return { version: 1, entries: {} };
  }
  try {
    const raw = JSON.parse(readFileSync(storePath, 'utf8')) as unknown;
    if (
      typeof raw === 'object' &&
      raw !== null &&
      'entries' in raw &&
      typeof (raw as { entries?: unknown }).entries === 'object' &&
      (raw as { entries?: unknown }).entries !== null
    ) {
      const entries: Record<string, string> = {};
      for (const [k, v] of Object.entries((raw as { entries: Record<string, unknown> }).entries)) {
        if (typeof v === 'string') entries[k] = v;
      }
      return { version: 1, entries };
    }
  } catch {
    // Treat malformed store as empty rather than crashing startup.
  }
  return { version: 1, entries: {} };
}

export function readSavedToken(
  storePath: string,
  serverUrl: string,
  canonicalDir: string,
): string | null {
  const store = readStoreFile(storePath);
  const token = store.entries[storeKey(serverUrl, canonicalDir)];
  return typeof token === 'string' && token.trim() !== '' ? token.trim() : null;
}

/**
 * Persists a connector bearer token keyed by `(serverUrl, canonicalDir)` with
 * strict `0700` parent directory and `0600` file permissions.
 */
export function saveToken(
  storePath: string,
  serverUrl: string,
  canonicalDir: string,
  token: string,
): void {
  const dir = path.dirname(storePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const current = readStoreFile(storePath);
  const next: StoredConnectorTokens = {
    version: 1,
    entries: {
      ...current.entries,
      [storeKey(serverUrl, canonicalDir)]: token.trim(),
    },
  };
  writeFileSync(storePath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(storePath, 0o600);
}

export function validateTokenFormat(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(CONNECTOR_TOKEN_PREFIX) || trimmed.length < 24 || trimmed.length > 256) {
    throw new Error(
      `Invalid connector token format (expected a token starting with "${CONNECTOR_TOKEN_PREFIX}").`,
    );
  }
  return trimmed;
}

/** Reads a single trimmed token line from stdin (for `--token-stdin`). */
export function readTokenFromStream(input: Readable): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const newline = buffer.search(/[\r\n]/);
      if (newline !== -1) {
        cleanup();
        resolve(buffer.slice(0, newline).trim());
      }
    };
    const onEnd = () => {
      cleanup();
      resolve(buffer.trim());
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
    };
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    input.resume();
  });
}

type TtyReadable = Readable & {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

/**
 * Prompts interactively for the connector bearer token without echoing characters
 * to the terminal, keeping secrets out of shell history and scrollback.
 */
export function promptHiddenToken(options: {
  readonly input?: TtyReadable;
  readonly output?: Writable;
  readonly prompt?: string;
} = {}): Promise<string> {
  const input: TtyReadable = options.input ?? process.stdin;
  const output: Writable = options.output ?? process.stderr;
  const label = options.prompt ?? 'Connector token (hidden): ';

  output.write(label);

  if (input.isTTY !== true || typeof input.setRawMode !== 'function') {
    return readTokenFromStream(input).then((token) => {
      output.write('\n');
      return token;
    });
  }

  return new Promise<string>((resolve, reject) => {
    const wasRaw = input.isRaw === true;
    input.setRawMode?.(true);
    input.resume();
    let value = '';

    const cleanup = () => {
      input.off('data', onData);
      input.off('error', onError);
      if (!wasRaw) input.setRawMode?.(false);
      input.pause();
    };

    const onError = (err: Error) => {
      cleanup();
      output.write('\n');
      reject(err);
    };

    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const ch of text) {
        if (ch === '\u0003') {
          cleanup();
          output.write('\n');
          reject(new Error('Token entry cancelled.'));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          cleanup();
          output.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (ch >= ' ') {
          value += ch;
        }
      }
    };

    input.on('data', onData);
    input.once('error', onError);
  });
}
