import { ScreenStream, type ScreenViewer, type ScreenStreamEnding } from './screen-stream.js';
import type { ScreenUpstream } from './screen-upstream.js';
import type { ScreenLogger } from './logger.js';

/**
 * Every seat a host is streaming, keyed by whatever names a seat to that host,
 * and the bookkeeping both hosts would otherwise repeat: one stream per seat
 * however many viewers arrive at once, and a stream forgotten the moment it
 * ends.
 */
export class ScreenStreamHub {
  private readonly streams = new Map<string, ScreenStream>();

  constructor(private readonly options: ScreenStreamHubOptions) {}

  /**
   * Add a viewer to its seat's stream, opening the upstream when it is the
   * first. Throws when the stream cannot be opened — `ScreenNotRunningError`
   * when the computer is not running — and leaves nothing registered behind.
   */
  async attach(key: string, viewer: ScreenViewer, quality: number): Promise<void> {
    const stream = this.streams.get(key) ?? this.create(key);
    stream.add(viewer, quality);
    try {
      await stream.ensureUpstream(async () => {
        const upstream = await this.options.connect(key);
        if (upstream === null) throw new ScreenNotRunningError();
        return upstream;
      });
    } catch (error: unknown) {
      stream.remove(viewer);
      throw error;
    }
  }

  setQuality(key: string, viewer: ScreenViewer, quality: number): void {
    this.streams.get(key)?.setQuality(viewer, quality);
  }

  acked(key: string, viewer: ScreenViewer, seq: number): void {
    this.streams.get(key)?.acked(viewer, seq);
  }

  detach(key: string, viewer: ScreenViewer): void {
    this.streams.get(key)?.remove(viewer);
  }

  /** How many viewers a seat's stream has; 0 when there is no stream. */
  viewerCount(key: string): number {
    return this.streams.get(key)?.size ?? 0;
  }

  /** How many seats this host holds an upstream for. */
  streamCount(): number {
    return this.streams.size;
  }

  /** A host invalidated this seat; end all of that generation's viewers. */
  end(key: string, ending: ScreenStreamEnding): void {
    const stream = this.streams.get(key);
    this.streams.delete(key);
    stream?.close(ending);
  }

  /** Ends every stream, telling no one: the host is going away. */
  close(): void {
    const streams = [...this.streams.values()];
    this.streams.clear();
    for (const stream of streams) stream.close(null);
  }

  private create(key: string): ScreenStream {
    const stream = new ScreenStream(key, this.options.logger, () => this.options.connect(key));
    stream.onGone(() => {
      if (this.streams.get(key) === stream) this.streams.delete(key);
    });
    this.streams.set(key, stream);
    return stream;
  }
}

export interface ScreenStreamHubOptions {
  readonly logger: ScreenLogger;
  /**
   * Opens the upstream for a seat. Null when its computer is not running: a
   * refusal to pass on, never something to retry, because a screen must never
   * be the thing that wakes a computer.
   */
  readonly connect: (key: string) => Promise<ScreenUpstream | null>;
}

/** The seat's computer is stopped or stopping, so there is nothing to stream. */
export class ScreenNotRunningError extends Error {
  constructor(message = 'The computer is not running.') {
    super(message);
    this.name = 'ScreenNotRunningError';
  }
}
