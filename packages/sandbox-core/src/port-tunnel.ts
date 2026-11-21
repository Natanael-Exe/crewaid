/**
 * Remote ports as loopback addresses.
 *
 * Every caller of `getPortEndpoint` connects to a plain `host:port`: the
 * screen proxy speaks raw RFB and refuses an endpoint that carries headers
 * (D-012), and the CDP and bridge clients take a URL. A hosted provider
 * reaches a port inside a machine only through a WebSocket per connection —
 * DigitalOcean's port-forward, or the Cloudflare control Worker's tunnel — so
 * this listens on `127.0.0.1:0` for each remote port a caller asks about and
 * relays every accepted connection over a stream of its own, the way
 * `doctl harness-runtime port-forward` does, in-process.
 *
 * A WebSocket has no half-close, so when the caller finishes writing, the
 * stream ends in both directions. RFB, CDP and HTTP clients never half-close;
 * a protocol that did would lose its reply.
 *
 * A listener costs a file descriptor and nothing else until something
 * connects; opening a stream takes 200–400 ms from the VPS on either host,
 * which is why callers keep their connections rather than reopening per
 * request.
 */

import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

/**
 * The members of a `ws` WebSocket the relay uses, declared here so every
 * provider shares the relay without this package depending on `ws`.
 */
export interface TunnelStream {
  readonly readyState: number;
  readonly OPEN: number;
  on(
    event: 'message',
    listener: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void,
  ): unknown;
  once(event: 'close', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  send(data: Buffer, options: { binary: boolean }, callback: (error?: Error | null) => void): void;
  close(code?: number): void;
  terminate(): void;
  pause(): void;
  resume(): void;
}

export type OpenStream = (port: number) => Promise<TunnelStream>;

export interface TunnelEndpoint {
  readonly host: string;
  readonly port: number;
}

export class PortTunnels {
  readonly #open: OpenStream;
  readonly #listeners = new Map<number, Promise<{ server: Server; endpoint: TunnelEndpoint }>>();
  readonly #live = new Set<Socket>();
  readonly #onError: (port: number, error: unknown) => void;
  #closed = false;

  constructor(open: OpenStream, onError: (port: number, error: unknown) => void = () => undefined) {
    this.#open = open;
    this.#onError = onError;
  }

  /** The loopback address that reaches `remotePort` inside the machine. */
  async endpoint(remotePort: number): Promise<TunnelEndpoint> {
    if (this.#closed) throw new Error('the machine these tunnels served has stopped');
    let listener = this.#listeners.get(remotePort);
    if (listener === undefined) {
      listener = this.#listen(remotePort);
      this.#listeners.set(remotePort, listener);
      // A failed bind must not be cached: the next ask should try again.
      listener.catch(() => this.#listeners.delete(remotePort));
    }
    return (await listener).endpoint;
  }

  /**
   * Stop listening and drop every relayed connection. Called when the
   * machine pauses or goes away: a paused session answers a new stream by
   * resuming, and a tunnel left open would wake a machine nobody asked to
   * wake.
   */
  async close(): Promise<void> {
    this.#closed = true;
    for (const socket of this.#live) socket.destroy();
    this.#live.clear();
    const listeners = [...this.#listeners.values()];
    this.#listeners.clear();
    await Promise.all(
      listeners.map(async (listener) => {
        const { server } = await listener.catch(() => ({ server: null }));
        if (server === null) return;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }),
    );
  }

  #listen(remotePort: number): Promise<{ server: Server; endpoint: TunnelEndpoint }> {
    return new Promise((resolve, reject) => {
      const server = createServer((local) => this.#relay(remotePort, local));
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        server.unref();
        const { port } = server.address() as AddressInfo;
        resolve({ server, endpoint: { host: '127.0.0.1', port } });
      });
    });
  }

  #relay(remotePort: number, local: Socket): void {
    this.#live.add(local);
    local.setNoDelay(true);
    // Bytes the caller sends before the stream opens are held, not dropped:
    // an RFB or HTTP client writes its greeting the moment it connects.
    local.pause();
    local.once('close', () => this.#live.delete(local));

    this.#open(remotePort).then(
      (stream) => {
        if (local.destroyed) {
          stream.close();
          return;
        }
        stream.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
          if (!isBinary) return;
          const chunk = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.isBuffer(data)
              ? data
              : Buffer.from(data);
          if (!local.write(chunk)) {
            stream.pause();
            local.once('drain', () => stream.resume());
          }
        });
        stream.once('close', () => local.end());
        stream.once('error', (error) => {
          this.#onError(remotePort, error);
          local.destroy();
        });
        local.on('data', (chunk: Buffer) => {
          stream.send(chunk, { binary: true }, (error) => {
            if (error !== undefined && error !== null) local.destroy();
          });
        });
        // 'close', not 'end': close() destroys these sockets, which emits
        // neither 'end' nor 'error', and a stream left open holds a
        // connection to the machine after it has paused.
        local.once('close', () => {
          if (stream.readyState === stream.OPEN) stream.close(1000);
        });
        local.once('error', () => stream.terminate());
        local.resume();
      },
      (error: unknown) => {
        this.#onError(remotePort, error);
        local.destroy();
      },
    );
  }
}
