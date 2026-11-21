import { ScreenSeatBindingSchema, type ScreenSeatBinding } from '@crewaid/shared';
import type { ScreenGeometry, ScreenUpstream, ServerMessageMeta } from '@crewaid/screen-stream';

export type ResolveScreenSeat = (botId: string) => Promise<ScreenSeatBinding | null>;

/** Read only identity metadata from the bridge; this never allocates a seat. */
export const resolveScreenSeat: ResolveScreenSeat = async (botId) => {
  const url = new URL('http://127.0.0.1:7070/seats');
  url.searchParams.set('botId', botId);
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`screen seat lookup failed (${response.status})`);
  const body: unknown = await response.json();
  if (
    typeof body !== 'object' ||
    body === null ||
    !('seat' in body) ||
    !('ok' in body) ||
    body.ok !== true
  )
    return null;
  const seat = ScreenSeatBindingSchema.safeParse(body.seat);
  return seat.success && seat.data.botId === botId ? seat.data : null;
};

export function sameSeat(a: ScreenSeatBinding | null, b: ScreenSeatBinding): boolean {
  return a !== null && a.seatId === b.seatId && a.botId === b.botId && a.rfbPort === b.rfbPort;
}

/**
 * A port can be retired between its lookup and the TCP handshake. Quarantine
 * the connection until a lookup AFTER the handshake confirms the same seat
 * generation, so even that race cannot send another bot's bytes to a viewer.
 */
export class SeatBoundUpstream implements ScreenUpstream {
  private verified = false;
  private closed = false;
  private readyFn: ((geometry: ScreenGeometry) => void) | null = null;
  private messageFn: ((message: Buffer, meta: ServerMessageMeta) => void) | null = null;
  private closeFn: ((reason: Error | null) => void) | null = null;

  constructor(
    private readonly upstream: ScreenUpstream,
    private readonly seat: ScreenSeatBinding,
    private readonly resolve: ResolveScreenSeat,
  ) {
    upstream.onMessage((message, meta) => {
      if (this.verified && !this.closed) this.messageFn?.(message, meta);
    });
    upstream.onClose((reason) => this.finish(reason));
    upstream.onReady((geometry) => {
      if (this.closed) return;
      void this.verify(geometry).catch((error: unknown) =>
        this.finish(error instanceof Error ? error : new Error(String(error))),
      );
    });
  }

  get isStreaming(): boolean {
    return this.verified && !this.closed && this.upstream.isStreaming;
  }
  get screen(): ScreenGeometry | null {
    return this.verified ? this.upstream.screen : null;
  }
  onReady(fn: (geometry: ScreenGeometry) => void): void {
    this.readyFn = fn;
  }
  onMessage(fn: (message: Buffer, meta: ServerMessageMeta) => void): void {
    this.messageFn = fn;
  }
  onClose(fn: (reason: Error | null) => void): void {
    this.closeFn = fn;
  }
  resume(interval?: number): void {
    if (this.verified) this.upstream.resume(interval);
  }
  pause(): void {
    this.upstream.pause();
  }
  requestFullRepaint(): void {
    if (this.verified) this.upstream.requestFullRepaint();
  }
  setQuality(quality: number, repaint = true): void {
    this.upstream.setQuality(quality, this.verified && repaint);
  }
  sendInput(): boolean {
    return false;
  }
  close(): void {
    this.finish(null);
  }

  private async verify(geometry: ScreenGeometry): Promise<void> {
    const current = await this.resolve(this.seat.botId);
    if (this.closed) return;
    if (!sameSeat(current, this.seat)) {
      this.finish(null);
      return;
    }
    this.verified = true;
    this.readyFn?.(geometry);
  }

  private finish(reason: Error | null): void {
    if (this.closed) return;
    this.closed = true;
    this.upstream.close();
    this.closeFn?.(reason);
  }
}
