import {
  ClientFrameSchema,
  encodeScreenInputFrame,
  readServerFrame,
  type ClientFrame,
  type ServerFrame,
} from '@crewaid/shared';
import { reconnectDelayMs } from './wsBackoff';
import { t } from '../i18n/i18n';

export const WS_OPEN = 1 as const;

export type TokenCredentials = {
  orchestratorToken?: string;
  orchestratorBaseUrl?: string;
};

export type WebSocketLike = {
  readonly readyState: number;
  /**
   * Optional because the test fakes do not need it. The browser default hands
   * a binary frame over as a `Blob`, readable only asynchronously — enough to
   * reorder frames on a stream whose contract is that they arrive in order.
   */
  binaryType?: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send: (data: string | ArrayBufferView | ArrayBuffer) => void;
  close: (code?: number, reason?: string) => void;
};

export type WebSocketFactory = (url: string) => WebSocketLike;

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export type WsConnectionState = {
  readonly status: ConnectionStatus;
  /** Number of consecutive reconnect attempts scheduled after a disconnect. */
  readonly attempt: number;
  /** Delay for the scheduled retry, or null when no retry is pending. */
  readonly retryDelayMs: number | null;
};

/**
 * `UNSUPPORTED_WIRE_VERSION` is CC-19/D-071's, and it is a separate code
 * rather than another `PROTOCOL_ERROR` because the two mean different things
 * to the person reading them: one says this build is behind the orchestrator
 * and names both versions, which they can act on, and the other says a frame
 * was broken, which they cannot. One code for both is the silent gap the task
 * exists to close.
 */
export type WsClientErrorCode =
  'CONFIGURATION_ERROR' | 'NETWORK_ERROR' | 'PROTOCOL_ERROR' | 'UNSUPPORTED_WIRE_VERSION';

export type WsClientError = {
  readonly code: WsClientErrorCode;
  readonly message: string;
};

export type WsClientOptions = {
  readonly tokenProvider: () => Promise<TokenCredentials>;
  readonly webSocketFactory?: WebSocketFactory;
  readonly setTimeoutFn?: (callback: () => void, delay: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
  readonly onStatus?: (state: WsConnectionState) => void;
  readonly onFrame?: (frame: ServerFrame) => void;
  readonly onError?: (error: WsClientError) => void;
};

const defaultWebSocketFactory: WebSocketFactory = (url) =>
  new globalThis.WebSocket(url) as unknown as WebSocketLike;

/**
 * Convert the REST-style orchestrator base URL to the authenticated WS endpoint.
 * The gateway is mounted at `/ws`, not under the REST `/api/v1` prefix.
 */
export function buildWsUrl(baseUrl: string, token: string): string {
  if (token.trim() === '') throw new Error('WebSocket credentials are missing');

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Orchestrator URL must use HTTP or HTTPS');
  }
  if (
    url.protocol !== 'http:' &&
    url.protocol !== 'https:' &&
    url.protocol !== 'ws:' &&
    url.protocol !== 'wss:'
  ) {
    throw new Error('Orchestrator URL must use HTTP or HTTPS');
  }

  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  url.searchParams.set('token', token);
  return url.toString();
}

/**
 * Small, typed renderer-side WS transport. It owns lifecycle/reconnect only;
 * server event interpretation remains in the shared Zod contract and callers'
 * frame listeners.
 */
export class WsClient {
  private readonly seatEpochs = new Map<string, number>();
  private readonly tokenProvider: WsClientOptions['tokenProvider'];
  private readonly webSocketFactory: WebSocketFactory;
  private readonly setTimeoutFn: (callback: () => void, delay: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly statusListeners = new Set<(state: WsConnectionState) => void>();
  private readonly frameListeners = new Set<(frame: ServerFrame) => void>();
  private readonly errorListeners = new Set<(error: WsClientError) => void>();
  private socket: WebSocketLike | null = null;
  private retryTimer: unknown = null;
  private stopped = true;
  private opening = false;
  private attempt = 0;
  private _state: WsConnectionState = {
    status: 'disconnected',
    attempt: 0,
    retryDelayMs: null,
  };

  constructor(options: WsClientOptions) {
    this.tokenProvider = options.tokenProvider;
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.setTimeoutFn =
      options.setTimeoutFn ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.clearTimeoutFn =
      options.clearTimeoutFn ??
      ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
    if (options.onStatus !== undefined) this.statusListeners.add(options.onStatus);
    if (options.onFrame !== undefined) this.frameListeners.add(options.onFrame);
    if (options.onError !== undefined) this.errorListeners.add(options.onError);
  }

  get state(): WsConnectionState {
    return this._state;
  }

  start(): void {
    if (!this.stopped || this.opening || this.socket !== null || this.retryTimer !== null) return;
    this.stopped = false;
    void this.open();
  }

  stop(): void {
    this.stopped = true;
    this.opening = false;
    if (this.retryTimer !== null) {
      this.clearTimeoutFn(this.retryTimer);
      this.retryTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.seatEpochs.clear();
    if (socket !== null) socket.close(1000, 'Client stopped');
    this.attempt = 0;
    this.publish({ status: 'disconnected', attempt: 0, retryDelayMs: null });
  }

  send(frame: ClientFrame): boolean {
    const parsed = ClientFrameSchema.safeParse(frame);
    if (!parsed.success) {
      this.reportError({
        code: 'PROTOCOL_ERROR',
        message: t('connection.wsClient.refusedToSendAnInvalid'),
      });
      return false;
    }
    if (this.socket === null || this.socket.readyState !== WS_OPEN) return false;
    try {
      this.socket.send(JSON.stringify(parsed.data));
      return true;
    } catch {
      this.reportError({
        code: 'NETWORK_ERROR',
        message: t('connection.wsClient.theLiveConnectionFailed'),
      });
      return false;
    }
  }

  /** Send one D-036 RFB input event over the authenticated WebSocket. */
  sendScreenInput(botId: string, rfb: Uint8Array): boolean {
    if (this.socket === null || this.socket.readyState !== WS_OPEN) return false;
    try {
      const epoch = this.seatEpochs.get(botId);
      if (epoch === undefined) return false;
      this.socket.send(encodeScreenInputFrame(botId, epoch, rfb));
      return true;
    } catch (error: unknown) {
      if (error instanceof RangeError) {
        this.reportError({
          code: 'PROTOCOL_ERROR',
          message: t('connection.wsClient.refusedToSendAnInvalid2'),
        });
      } else {
        this.reportError({
          code: 'NETWORK_ERROR',
          message: t('connection.wsClient.theLiveConnectionFailed'),
        });
      }
      return false;
    }
  }

  onStatus(listener: (state: WsConnectionState) => void): () => void {
    this.statusListeners.add(listener);
    listener(this._state);
    return () => this.statusListeners.delete(listener);
  }

  onFrame(listener: (frame: ServerFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onError(listener: (error: WsClientError) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  private async open(): Promise<void> {
    if (this.stopped || this.opening) return;
    this.opening = true;
    this.publish({
      status: this.attempt === 0 ? 'connecting' : 'reconnecting',
      attempt: this.attempt,
      retryDelayMs: this.attempt === 0 ? null : reconnectDelayMs(this.attempt - 1),
    });

    try {
      const credentials = await this.tokenProvider();
      if (this.stopped) return;
      const token = credentials.orchestratorToken;
      const baseUrl = credentials.orchestratorBaseUrl;
      if (
        token === undefined ||
        baseUrl === undefined ||
        token.trim() === '' ||
        baseUrl.trim() === ''
      ) {
        this.reportError({
          code: 'CONFIGURATION_ERROR',
          message: t('connection.wsClient.thisAppIsNotSigned'),
        });
        this.attempt = 0;
        this.publish({ status: 'disconnected', attempt: 0, retryDelayMs: null });
        return;
      }

      let url: string;
      try {
        url = buildWsUrl(baseUrl, token);
      } catch {
        this.reportError({
          code: 'CONFIGURATION_ERROR',
          message: t('connection.wsClient.theServerAddressInSettings'),
        });
        this.attempt = 0;
        this.publish({ status: 'disconnected', attempt: 0, retryDelayMs: null });
        return;
      }

      const socket = this.webSocketFactory(url);
      // Before any handler is attached: a frame arriving under the default
      // `blob` type would have to be read asynchronously.
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      socket.onopen = () => {
        if (this.socket !== socket || this.stopped) return;
        this.attempt = 0;
        this.publish({ status: 'connected', attempt: 0, retryDelayMs: null });
      };
      socket.onmessage = (event) => {
        if (this.socket === socket && !this.stopped) this.receive(event.data);
      };
      socket.onerror = () => {
        if (this.socket === socket && !this.stopped) {
          this.reportError({
            code: 'NETWORK_ERROR',
            message: t('connection.wsClient.theLiveConnectionFailed'),
          });
        }
      };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.seatEpochs.clear();
        if (!this.stopped) this.scheduleReconnect();
      };
    } catch {
      if (!this.stopped) {
        this.reportError({
          code: 'NETWORK_ERROR',
          message: t('connection.wsClient.theLiveConnectionFailed'),
        });
        this.scheduleReconnect();
      }
    } finally {
      this.opening = false;
    }
  }

  private receive(data: unknown): void {
    // Every server event here is JSON text. Screen pixels have a stream of
    // their own (`screen/screenStreamClient.ts`), so a binary frame is a
    // server this build does not understand, not a picture.
    if (typeof data !== 'string') {
      this.reportError({
        code: 'PROTOCOL_ERROR',
        message: t('connection.wsClient.receivedAnInvalidServerEvent'),
      });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.reportError({
        code: 'PROTOCOL_ERROR',
        message: t('connection.wsClient.receivedAnInvalidServerEvent'),
      });
      return;
    }

    // The version is read off the envelope BEFORE the union narrows,
    // and an older frame is normalised on the way through. A frame from a
    // newer orchestrator carries members this build has never heard of, so
    // parsing it first would report "invalid server event" for a problem
    // whose real answer is "update this app".
    const frame = readServerFrame(parsed);
    if (!frame.ok) {
      if (frame.reason === 'unsupported-version') {
        this.reportError({
          code: 'UNSUPPORTED_WIRE_VERSION',
          message: t('connection.wsClient.unsupportedWireVersion', {
            version: String(frame.wireVersion),
            supported: String(frame.supported),
          }),
        });
        return;
      }
      this.reportError({
        code: 'PROTOCOL_ERROR',
        message: t('connection.wsClient.receivedAnInvalidServerEvent'),
      });
      return;
    }
    if (frame.frame.type === 'screen.control.state') {
      const control = frame.frame.payload;
      if (control.mode === 'human' && control.holder === 'self')
        this.seatEpochs.set(control.botId, control.epoch);
      else this.seatEpochs.delete(control.botId);
    }
    for (const listener of this.frameListeners) listener(frame.frame);
  }

  private scheduleReconnect(): void {
    if (this.retryTimer !== null || this.stopped) return;
    const delay = reconnectDelayMs(this.attempt);
    this.attempt += 1;
    this.publish({ status: 'reconnecting', attempt: this.attempt, retryDelayMs: delay });
    this.retryTimer = this.setTimeoutFn(() => {
      this.retryTimer = null;
      void this.open();
    }, delay);
  }

  private publish(state: WsConnectionState): void {
    this._state = state;
    for (const listener of this.statusListeners) listener(state);
  }

  private reportError(error: WsClientError): void {
    for (const listener of this.errorListeners) listener(error);
  }
}
