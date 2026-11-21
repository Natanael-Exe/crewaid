import { connect } from 'node:net';

/**
 * The Redis probe behind `GET /health`.
 *
 * `true` means the configured Redis answered `PING` with `PONG` — a command
 * round trip, not a port check: a socket that merely accepts bytes is not a
 * cache that works.
 *
 * Speaks RESP directly over `node:net` instead of importing a client library.
 * The orchestrator needs exactly one command here, and a client would add a
 * connection lifecycle to leak for a boolean that a health route must be able
 * to answer in bounded time. When the queue work brings a real
 * client, this becomes its `ping()` — the route contract does not change.
 */

/**
 * Bounded so a black-holed host cannot hold the health response open: an
 * absolute deadline — an inactivity timer alone can be reset forever by a
 * peer trickling bytes.
 */
export const REDIS_PROBE_TIMEOUT_MS = 2_000;

export async function checkRedis(
  url: string | undefined,
  timeoutMs: number = REDIS_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const endpoint = parseRedisUrl(url);
  if (endpoint === null) return false;

  return await new Promise<boolean>((resolve) => {
    const socket = connect({ host: endpoint.host, port: endpoint.port });
    let settled = false;
    const finish = (healthy: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(healthy);
    };

    // One ABSOLUTE deadline, not a socket inactivity timer: an inactivity
    // bound resets on every byte, so a peer trickling one byte per window
    // could keep the probe open forever, while this cannot be reset — it is
    // the bound the route documents. `finish` only ever runs from the event
    // loop (timer or socket callbacks), so `deadline` is initialised before
    // any of them can clear it.
    const deadline = setTimeout(() => finish(false), timeoutMs);
    socket.on('error', () => finish(false));
    socket.on('connect', () => {
      // AUTH first when the URL carries credentials; the PING reply is the
      // only answer that counts as healthy.
      const auth = endpoint.auth === null ? '' : encodeCommand(endpoint.auth);
      socket.write(auth + encodeCommand(['PING']));
    });

    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const newline = buffer.indexOf('\r\n');
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        if (line === '+PONG') {
          finish(true);
          return;
        }
        if (line.startsWith('-')) {
          // Anything the server refuses (-NOAUTH, -ERR) is not healthy.
          finish(false);
          return;
        }
        // `+OK` from AUTH is the expected silence before the PING reply.
      }
    });
  });
}

interface RedisEndpoint {
  readonly host: string;
  readonly port: number;
  /** The full AUTH command when the URL carries credentials, else null. */
  readonly auth: readonly string[] | null;
}

function parseRedisUrl(url: string | undefined): RedisEndpoint | null {
  if (url === undefined || url.trim() === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // `rediss:` endpoints are not TLS-terminated by this probe and answer
  // false rather than a guess; the deployment's Redis is plain redis://.
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') return null;
  // A URL without a host names nothing to connect to; there is no default
  // Redis on this host to fall back to, and a guess would be worse than false.
  if (parsed.hostname === '') return null;

  const port = parsed.port === '' ? 6379 : Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;

  const username = decode(parsed.username);
  const password = decode(parsed.password);
  // Undecodable credentials are a malformed URL, not "no credentials".
  if (username === null && parsed.username !== '') return null;
  if (password === null && parsed.password !== '') return null;
  const auth =
    password === null
      ? null
      : username === null
        ? ['AUTH', password]
        : ['AUTH', username, password];

  return {
    host: parsed.hostname,
    port,
    auth,
  };
}

/** Percent-decoding that cannot throw into a health route. */
function decode(value: string): string | null {
  if (value === '') return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** One RESP command, as bytes it can be written verbatim. */
function encodeCommand(parts: readonly string[]): string {
  return (
    `*${parts.length}\r\n` +
    parts.map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join('')
  );
}
