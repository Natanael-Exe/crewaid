/**
 * MOD-AI-01 — a loopback stand-in for a provider's HTTP API.
 *
 * Each request takes the next scripted answer off a queue and is recorded
 * (path, headers, parsed body), so a case can assert both what the adapter
 * sent and what it made of the answer. An answer is SSE frames, a status with
 * an error body, or a stream that sends some frames and then holds the
 * connection open, which is what cancelling a slow model looks like.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type StubAnswer =
  | { readonly kind: 'sse'; readonly frames: readonly string[] }
  | { readonly kind: 'error'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'hang'; readonly frames: readonly string[] }
  | { readonly kind: 'redirect'; readonly status: number; readonly location: string };

export type StubRequest = {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: unknown;
};

export type ProviderStub = {
  readonly origin: string;
  readonly requests: StubRequest[];
  /** Resolves when a held stream's connection closes: the client hung up. */
  readonly closed: Promise<void>;
  answer(...answers: StubAnswer[]): void;
  close(): Promise<void>;
};

export async function startProviderStub(): Promise<ProviderStub> {
  const queue: StubAnswer[] = [];
  const requests: StubRequest[] = [];
  // One per held stream, so each cancel case proves its own disconnect.
  let closed: Promise<void> = Promise.resolve();

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      requests.push({ path: req.url ?? '', headers: req.headers, body: parse(raw) });
      // The last answer repeats: an SDK that retries a 429 or a refused
      // redirect asks again, and gets the same answer a provider would give.
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next === undefined) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'the stub has no answer scripted' } }));
        return;
      }
      if (next.kind === 'redirect') {
        res.writeHead(next.status, { location: next.location });
        res.end();
        return;
      }
      if (next.kind === 'error') {
        res.writeHead(next.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(next.body));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const frame of next.frames) res.write(frame);
      if (next.kind === 'sse') {
        res.end();
        return;
      }
      closed = new Promise<void>((resolve) => res.on('close', () => resolve()));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    get closed() {
      return closed;
    },
    answer: (...answers) => {
      queue.length = 0;
      queue.push(...answers);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** One SSE frame, with an `event:` line when the API names its events. */
export function frame(data: unknown, event?: string): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `${event === undefined ? '' : `event: ${event}\n`}data: ${payload}\n\n`;
}
