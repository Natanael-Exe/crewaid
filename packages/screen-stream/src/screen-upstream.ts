import type { ScreenGeometry } from './rfb-protocol.js';
import type { ServerMessageMeta } from './rfb-upstream.js';
import type { ScreenLogger } from './logger.js';

/**
 * A screen stream's view of one upstream connection.
 *
 * Narrower than `RfbUpstream` on purpose: the stream's job is viewer
 * bookkeeping and fan-out, and every guarantee it makes — one connection per
 * seat, a full repaint before a viewer is attached, quality as the maximum
 * requested — is decidable without a socket. Behind this port those tests run
 * in milliseconds against a fake instead of booting a desktop.
 */
export interface ScreenUpstream {
  readonly isStreaming: boolean;
  readonly screen: ScreenGeometry | null;
  onReady(fn: (geometry: ScreenGeometry) => void): void;
  onMessage(fn: (message: Buffer, meta: ServerMessageMeta) => void): void;
  onClose(fn: (reason: Error | null) => void): void;
  /** Pump updates, no more often than `minRequestIntervalMs`. */
  resume(minRequestIntervalMs?: number): void;
  pause(): void;
  requestFullRepaint(): void;
  /**
   * Renegotiate JPEG quality. `repaint` (default true) asks for a whole-screen
   * update at the new quality; a step down on a slow line skips it.
   */
  setQuality(quality: number, repaint?: boolean): void;
  /** Forward one validated §4.3 client message; `false` if the link is down. */
  sendInput(bytes: Uint8Array): boolean;
  close(): void;
}

export interface ScreenUpstreamOptions {
  readonly host: string;
  readonly port: number;
  readonly quality: number;
  readonly logger?: ScreenLogger;
}

export type ScreenUpstreamFactory = (options: ScreenUpstreamOptions) => ScreenUpstream;
