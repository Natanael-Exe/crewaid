import {
  SCREEN_STREAM_PATH,
  SCREEN_STREAM_QUALITY_PARAM,
  SCREEN_STREAM_TICKET_PARAM,
  ScreenStreamServerMessageSchema,
  type ScreenGrantResponse,
  type ScreenStreamClientMessage,
  type ScreenStreamEndpoint,
} from '@crewaid/shared';

import { isApiRequestError, isRetryable } from '../api';
import { t } from '../i18n/i18n';

/**
 * One bot's desktop pixels, on a socket of their own (`screen-stream.ts` in
 * the contract).
 *
 * The orchestrator grants each connection: the grant names where the stream
 * is served — the orchestrator itself, or the computer directly, so the pixels
 * never cross the orchestrator — and carries a one-use ticket. This client
 * opens wherever it points, hands every RFB message to the viewer, acks every
 * mark so the server can pace to this line, and tells the server when the
 * viewer wants another quality.
 *
 * Reconnecting
 *
 * A dropped socket is retried a bounded number of times, each with a FRESH
 * grant: a ticket opens one stream once, and asking again is also what checks
 * the computer is still running — a stopped one is refused, and reconnecting
 * never wakes it. The viewer keeps its canvas across a reconnect, because every
 * stream begins with a Tight reset and a whole-screen repaint.
 *
 * "Not running" is retried too, and only said once the retries run out. A
 * viewer exists because the app's own state says the computer is running, so a
 * refusal is the two disagreeing: the server's row may have moved for a moment,
 * or the app's frame saying it stopped is still on its way — and that frame
 * closes this stream anyway. Asking again costs a grant, which never wakes
 * anything.
 *
 * Input does not come this way. Keyboard and pointer go over WebSocket.
 */
export function openScreenStream(options: ScreenStreamOptions): ScreenStreamHandle {
  const stream = new ScreenStreamClient(options);
  stream.start();
  return stream;
}

export interface ScreenStreamOptions {
  readonly botId: string;
  /** The viewer's quality to start at, 0..9. */
  readonly quality: number;
  /** Asks the orchestrator for a grant; rejects as the API client does. */
  readonly grant: (botId: string) => Promise<ScreenGrantResponse>;
  /** The orchestrator address the app is configured with, for an `orchestrator` grant. */
  readonly orchestratorBaseUrl: () => Promise<string | undefined>;
  /** One complete RFB server message. */
  readonly onRfb: (message: Uint8Array) => void;
  /** The stream ended and will not come back by itself. */
  readonly onEnded: (ending: ScreenStreamEnding) => void;
  readonly webSocketFactory?: (url: string) => ScreenSocket;
  readonly setTimeoutFn?: (callback: () => void, delay: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
}

/** What a viewer holds: a way to change quality and to stop. */
export interface ScreenStreamHandle {
  setQuality(quality: number): void;
  close(): void;
}

/**
 * Why a stream stopped for good. `not-running`: the computer is stopped or
 * stopping, and the card already knows how to show that. `lost`: something
 * failed; the viewer offers to reconnect.
 */
export type ScreenStreamEnding =
  { readonly kind: 'not-running' } | { readonly kind: 'lost'; readonly message: string };

/** Close details read from a WebSocket close event. */
export interface ScreenSocketCloseEvent {
  readonly code?: number;
  readonly reason?: string;
}

/** The subset of `WebSocket` this client uses, so tests need no browser. */
export interface ScreenSocket {
  binaryType: string;
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event?: ScreenSocketCloseEvent) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/**
 * The stream's URL from a grant. An `orchestrator` grant is served beside
 * `/ws` on the address the app already holds; a `direct` one is the computer's
 * own address, which may carry the provider's access token in its query.
 */
export function buildScreenStreamUrl(
  endpoint: ScreenStreamEndpoint,
  orchestratorBaseUrl: string | undefined,
  ticket: string,
  quality: number,
): string {
  let url: URL;
  if (endpoint.kind === 'direct') {
    url = new URL(endpoint.url);
  } else {
    if (orchestratorBaseUrl === undefined || orchestratorBaseUrl.trim() === '') {
      throw new Error('No orchestrator address is configured.');
    }
    url = new URL(orchestratorBaseUrl);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
      throw new Error('Orchestrator URL must use HTTP or HTTPS');
    }
    url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
    url.pathname = SCREEN_STREAM_PATH;
    url.search = '';
    url.hash = '';
  }
  url.searchParams.set(SCREEN_STREAM_TICKET_PARAM, ticket);
  url.searchParams.set(SCREEN_STREAM_QUALITY_PARAM, String(quality));
  return url.toString();
}

/** Bounded, like the server's own recovery: a fourth failure is an outage. */
export const SCREEN_STREAM_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;

/** A stream that stayed up this long earns a fresh retry budget. */
export const SCREEN_STREAM_STABLE_MS = 30_000;

class ScreenStreamClient implements ScreenStreamHandle {
  private socket: ScreenSocket | null = null;
  private quality: number;
  private closed = false;
  private ended = false;
  private retries = 0;
  private retryTimer: unknown = null;
  private openedAt = 0;
  /** What the server said before closing, which decides whether to come back. */
  private serverEnding: ScreenStreamEnding | null = null;
  private readonly webSocketFactory: (url: string) => ScreenSocket;
  private readonly setTimeoutFn: (callback: () => void, delay: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  constructor(private readonly options: ScreenStreamOptions) {
    this.quality = options.quality;
    this.webSocketFactory =
      options.webSocketFactory ??
      ((url) => new globalThis.WebSocket(url) as unknown as ScreenSocket);
    this.setTimeoutFn =
      options.setTimeoutFn ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.clearTimeoutFn =
      options.clearTimeoutFn ??
      ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  start(): void {
    void this.connect();
  }

  setQuality(quality: number): void {
    if (quality === this.quality) return;
    this.quality = quality;
    // A reconnect carries it in its URL; an open stream is told now, and keeps
    // both ends' compression history rather than reconnecting.
    this.send({ t: 'quality', quality });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.retryTimer !== null) this.clearTimeoutFn(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'viewer closed');
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    let url: string;
    let openingQuality: number;
    try {
      const grant = await this.options.grant(this.options.botId);
      const orchestratorBaseUrl = await this.options.orchestratorBaseUrl();
      openingQuality = this.quality;
      url = buildScreenStreamUrl(grant.endpoint, orchestratorBaseUrl, grant.ticket, openingQuality);
    } catch (error: unknown) {
      if (this.closed) return;
      if (isApiRequestError(error)) {
        // The grant's refusal for a computer that is not running. See
        // RECONNECTING above for why it is asked again before it is believed.
        if (error.failure.code === 'CONFLICT') {
          this.retryOrEnd({ kind: 'not-running' });
          return;
        }
        // A token the server refuses, or a bot that is gone, will not change
        // by asking again a second later.
        if (!isRetryable(error.failure.code)) {
          this.end({ kind: 'lost', message: error.failure.message });
          return;
        }
      }
      this.retryOrEnd({
        kind: 'lost',
        message: t('screen.screenStreamClient.theDisplayCouldNotBe'),
      });
      return;
    }
    if (this.closed) return;

    const socket = this.webSocketFactory(url);
    // Before any handler: under the default `blob`, a frame would have to be
    // read asynchronously, which can reorder a stream whose contract is order.
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.serverEnding = null;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.openedAt = Date.now();
      // Changes made during the handshake could not be sent yet, and the
      // opening URL still names the quality from before those changes.
      if (this.quality !== openingQuality) this.send({ t: 'quality', quality: this.quality });
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) this.receive(event.data);
    };
    socket.onerror = () => undefined;
    socket.onclose = (event?: ScreenSocketCloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.closed) return;
      const ending = this.serverEnding;
      // The server's own retries are behind a `lost`; asking it again at once
      // would only repeat them.
      if (ending?.kind === 'lost') {
        this.end(ending);
        return;
      }
      const livedMs = this.openedAt === 0 ? 0 : Date.now() - this.openedAt;
      // A healthy stream closed for grant renewal is not an outage: renew at
      // once without retry backoff. Guarded by the stability floor so a
      // misconfigured server closing immediately still hits bounded retries.
      if (
        ending === null &&
        livedMs >= SCREEN_STREAM_STABLE_MS &&
        event?.code === CLOSE_NORMAL &&
        event.reason === RENEW_SCREEN_GRANT_REASON
      ) {
        this.openedAt = 0;
        this.retries = 0;
        void this.connect();
        return;
      }
      // A stream that held for a while and then dropped is a new outage, not
      // the last one continuing, so it gets the whole retry budget.
      if (livedMs >= SCREEN_STREAM_STABLE_MS) {
        this.retries = 0;
      }
      this.openedAt = 0;
      this.retryOrEnd(
        ending ?? { kind: 'lost', message: t('screen.screenStreamClient.theDisplayDisconnected') },
      );
    };
  }

  private receive(data: unknown): void {
    const bytes = asBytes(data);
    if (bytes !== null) {
      this.options.onRfb(bytes);
      return;
    }
    if (typeof data !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const message = ScreenStreamServerMessageSchema.safeParse(parsed);
    if (!message.success) return;
    if (message.data.t === 'mark') {
      // At once: the mark follows the bytes it confirms, and every millisecond
      // between receiving it and saying so reads to the server as a slower line.
      this.send({ t: 'ack', seq: message.data.seq });
      return;
    }
    this.serverEnding =
      message.data.code === 'SCREEN_NOT_RUNNING'
        ? { kind: 'not-running' }
        : { kind: 'lost', message: message.data.message };
  }

  /** Try again with a fresh grant, or say `ending` once the retries are spent. */
  private retryOrEnd(ending: ScreenStreamEnding): void {
    const delay = SCREEN_STREAM_RETRY_DELAYS_MS[this.retries];
    if (delay === undefined) {
      this.end(ending);
      return;
    }
    this.retries += 1;
    this.retryTimer = this.setTimeoutFn(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private end(ending: ScreenStreamEnding): void {
    if (this.ended || this.closed) return;
    this.ended = true;
    this.options.onEnded(ending);
  }

  private send(message: ScreenStreamClientMessage): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== OPEN) return;
    socket.send(JSON.stringify(message));
  }
}

/** `null` when the payload is not binary, so text can fall through to JSON. */
function asBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/** WebSocket's numeric OPEN state. */
const OPEN = 1;
const CLOSE_NORMAL = 1000;
const RENEW_SCREEN_GRANT_REASON = 'renew screen grant';
