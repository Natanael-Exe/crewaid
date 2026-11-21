import {
  ScreenStreamClientMessageSchema,
  SCREEN_STREAM_QUALITY_PARAM,
  ScreenQualitySchema,
  type ScreenStreamErrorCode,
  type ScreenStreamServerMessage,
} from '@crewaid/shared';

import type { ScreenLogger } from './logger.js';
import type { ScreenStreamEnding, ScreenViewer } from './screen-stream.js';
import { ScreenNotRunningError, type ScreenStreamHub } from './screen-stream-hub.js';

/**
 * The members of a `ws` WebSocket a stream uses, written out so this package
 * needs no `ws` of its own: each host passes its socket, and the gateway inside
 * a computer bundles nothing it does not call.
 */
export interface ViewerSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(
    data: string | Uint8Array,
    options: { readonly binary: boolean },
    callback: (error?: Error | null) => void,
  ): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: ViewerSocketData, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
}

/** What `ws` hands a message listener. */
export type ViewerSocketData = Buffer | ArrayBuffer | Buffer[];

/**
 * The most a viewer may send in one frame. An ack or a quality change is a few
 * dozen bytes; a host sets this as its server's `maxPayload`, so a viewer that
 * sends more is cut by `ws` before anything here parses it.
 */
export const SCREEN_STREAM_MAX_CLIENT_FRAME_BYTES = 1024;

/** The quality a stream starts at when the viewer named none it may have. */
export const SCREEN_STREAM_DEFAULT_QUALITY = 3;

/** The viewer's starting quality, from the stream URL's query. */
export function qualityFromQuery(search: URLSearchParams): number {
  const raw = search.get(SCREEN_STREAM_QUALITY_PARAM);
  const quality = ScreenQualitySchema.safeParse(raw === null ? null : Number(raw));
  return quality.success ? quality.data : SCREEN_STREAM_DEFAULT_QUALITY;
}

/**
 * Serve one viewer's socket from a seat's stream: attach it, read its acks and
 * quality changes, and detach it when it closes. Resolves once the viewer is
 * attached or refused; the socket lives on after that.
 */
export async function serveScreenViewer(options: {
  readonly expiresAt: number;
  readonly now?: () => number;
  readonly hub: ScreenStreamHub;
  readonly key: string;
  readonly socket: ViewerSocket;
  readonly quality: number;
  readonly logger: ScreenLogger;
  /**
   * The host may refuse this viewer because its ticket names a computer that
   * has since been replaced. An async check runs after listeners are bound,
   * so early quality changes and closes are kept. A refusal ends the socket
   * saying why, and attaches nothing.
   */
  readonly refuse?: ScreenStreamErrorCode | (() => Promise<ScreenStreamErrorCode | undefined>);
}): Promise<void> {
  const { hub, key, socket, logger } = options;
  const now = options.now ?? Date.now;
  const viewer = new SocketScreenViewer(socket, logger, () => now() < options.expiresAt);
  // A host may have awaited its ticket's computer lookup before handing us
  // the socket. Its close event may already have passed by then.
  if (socket.readyState !== OPEN) return;
  if (!viewer.isOpen) {
    socket.close(1000, 'renew screen grant');
    return;
  }
  const expiry = setTimeout(
    () => socket.close(1000, 'renew screen grant'),
    options.expiresAt - now(),
  ).unref();
  let quality = options.quality;

  socket.on('message', (data, isBinary) => {
    // A viewer never speaks RFB: the stream is read-only by construction, and
    // input reaches the desktop another way. Anything binary is a client that
    // does not know this protocol.
    if (isBinary) {
      socket.close(CLOSE_UNSUPPORTED, 'viewers send text only');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(textOf(data));
    } catch {
      socket.close(CLOSE_INVALID, 'not JSON');
      return;
    }
    const message = ScreenStreamClientMessageSchema.safeParse(parsed);
    if (!message.success) {
      socket.close(CLOSE_POLICY, 'not a screen stream message');
      return;
    }
    if (message.data.t === 'ack') hub.acked(key, viewer, message.data.seq);
    else {
      quality = message.data.quality;
      hub.setQuality(key, viewer, quality);
    }
  });
  socket.on('close', () => {
    clearTimeout(expiry);
    hub.detach(key, viewer);
  });

  const refuse = typeof options.refuse === 'function' ? await options.refuse() : options.refuse;
  if (!viewer.isOpen) return;
  if (refuse !== undefined) {
    viewer.end({ code: refuse, message: REFUSALS[refuse] });
    return;
  }

  try {
    await hub.attach(key, viewer, quality);
  } catch (error: unknown) {
    if (error instanceof ScreenNotRunningError) {
      viewer.end({ code: 'SCREEN_NOT_RUNNING', message: error.message });
      return;
    }
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`screen stream ${key} could not open: ${reason}`);
    viewer.end({ code: 'SCREEN_STREAM_LOST', message: 'The display could not be opened.' });
  }
}

const REFUSALS: Readonly<Record<ScreenStreamErrorCode, string>> = {
  SCREEN_NOT_RUNNING: 'The computer is no longer running.',
  SCREEN_STREAM_LOST: 'The display could not be opened.',
};

/** A `ScreenViewer` over one WebSocket. */
class SocketScreenViewer implements ScreenViewer {
  constructor(
    private readonly socket: ViewerSocket,
    private readonly logger: ScreenLogger,
    private readonly authorized: () => boolean,
  ) {}

  get isOpen(): boolean {
    return this.socket.readyState === OPEN && this.authorized();
  }

  get bufferedBytes(): number {
    return this.socket.bufferedAmount;
  }

  sendRfb(message: Uint8Array): void {
    this.send(message, true);
  }

  sendMark(seq: number): void {
    this.sendText({ t: 'mark', seq });
  }

  terminate(): void {
    this.socket.terminate();
  }

  end(ending: ScreenStreamEnding | null): void {
    if (ending !== null) this.sendText({ t: 'error', code: ending.code, message: ending.message });
    this.socket.close(CLOSE_NORMAL, ending?.code ?? 'stream ended');
  }

  private sendText(message: ScreenStreamServerMessage): void {
    this.send(JSON.stringify(message), false);
  }

  private send(data: string | Uint8Array, binary: boolean): void {
    if (!this.isOpen) return;
    // Never awaited: one slow viewer must not stall the pump for the others.
    //
    // The callback parameter is `Error | null | undefined`, not `Error?`. `ws`
    // invokes it with an explicit `null` on SUCCESS, so an `!== undefined`
    // check reads a null as a failure and dereferences it — which throws
    // inside a stream write callback, where nothing catches it. That once took
    // a whole orchestrator down on the first frame forwarded to a real client.
    this.socket.send(data, { binary }, (error?: Error | null) => {
      if (error !== undefined && error !== null) {
        this.logger.debug(`dropping a screen frame: ${error.message}`);
      }
    });
  }
}

function textOf(data: ViewerSocketData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/** ws's numeric OPEN state, named rather than repeated as a literal 1. */
const OPEN = 1;
const CLOSE_NORMAL = 1000;
const CLOSE_UNSUPPORTED = 1003;
const CLOSE_INVALID = 1007;
const CLOSE_POLICY = 1008;
