/**
 * One microphone recording — for dictation or a voice message.
 *
 * Written against narrow ports (`getUserMedia`, a recorder factory, a clock)
 * the way `wsClient.ts` is, so the state machine is tested without a
 * microphone. The renderer only records; transcribing and speaking are the
 * orchestrator's.
 */

export type RecorderPhase = 'idle' | 'starting' | 'recording' | 'stopping';

export type RecordedClip = {
  readonly blob: Blob;
  readonly durationMs: number;
};

/** The part of `MediaRecorder` this module uses. */
export type MediaRecorderLike = {
  readonly mimeType: string;
  start(timesliceMs?: number): void;
  stop(): void;
  listen(handlers: {
    readonly data: (chunk: Blob) => void;
    readonly stop: () => void;
    readonly error: () => void;
  }): void;
};

export type MediaStreamLike = {
  getTracks(): ReadonlyArray<{ stop(): void }>;
};

/** `true` for the system default, or one device by id. */
export type AudioConstraint = true | { readonly deviceId: { readonly exact: string } };

export type RecorderDeps = {
  readonly getUserMedia: (constraints: { audio: AudioConstraint }) => Promise<MediaStreamLike>;
  readonly createRecorder: (
    stream: MediaStreamLike,
    mimeType: string | undefined,
  ) => MediaRecorderLike;
  readonly isTypeSupported: (mimeType: string) => boolean;
  readonly now: () => number;
  readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  readonly clearTimeoutFn: (handle: unknown) => void;
};

export type RecorderOptions = {
  /** A hard stop, so a forgotten recording cannot run up a transcription bill. */
  readonly maxDurationMs: number;
  /** Called when the cap stops the recording; the clip is still delivered. */
  readonly onLimit?: () => void;
  readonly onPhase?: (phase: RecorderPhase) => void;
  /**
   * The device to record from, asked at each start so a microphone plugged
   * in or out since the last one is seen. Undefined is the system default.
   */
  readonly microphone?: () => Promise<string | undefined>;
};

/** Opus in webm is what Chromium records best; mp4 is the fallback elsewhere. */
const PREFERRED_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'] as const;

export type RecorderErrorCode = 'PERMISSION_DENIED' | 'NO_MICROPHONE' | 'FAILED';

export class RecorderError extends Error {
  constructor(readonly code: RecorderErrorCode) {
    super(code);
    this.name = 'RecorderError';
  }
}

export class VoiceRecorder {
  private phase: RecorderPhase = 'idle';
  private stream: MediaStreamLike | null = null;
  private recorder: MediaRecorderLike | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private limitTimer: unknown = null;
  private finished: ((clip: RecordedClip | null) => void) | null = null;
  private cancelled = false;

  constructor(
    private readonly deps: RecorderDeps,
    private readonly options: RecorderOptions,
  ) {}

  get state(): RecorderPhase {
    return this.phase;
  }

  /** Milliseconds recorded so far; zero when nothing is recording. */
  elapsedMs(): number {
    return this.phase === 'recording' ? this.deps.now() - this.startedAt : 0;
  }

  /** The live stream, for a level meter. Null whenever nothing is recording. */
  get liveStream(): MediaStreamLike | null {
    return this.phase === 'recording' ? this.stream : null;
  }

  async start(): Promise<void> {
    if (this.phase !== 'idle') return;
    this.setPhase('starting');
    this.cancelled = false;
    let stream: MediaStreamLike;
    try {
      const deviceId = await this.options.microphone?.();
      stream = await this.deps.getUserMedia({
        audio: deviceId === undefined ? true : { deviceId: { exact: deviceId } },
      });
    } catch (error) {
      this.setPhase('idle');
      throw new RecorderError(mediaErrorCode(error));
    }
    if (this.cancelled) {
      // Cancelled while the permission prompt was up: let go of the microphone.
      stopTracks(stream);
      this.setPhase('idle');
      return;
    }
    this.stream = stream;
    const mimeType = PREFERRED_TYPES.find((type) => this.deps.isTypeSupported(type));
    const recorder = this.deps.createRecorder(stream, mimeType);
    this.recorder = recorder;
    this.chunks = [];
    recorder.listen({
      data: (chunk) => {
        if (chunk.size > 0) this.chunks.push(chunk);
      },
      error: () => this.finish(null),
      stop: () => this.finish(this.cancelled ? null : this.clip(recorder)),
    });
    recorder.start(250);
    this.startedAt = this.deps.now();
    this.limitTimer = this.deps.setTimeoutFn(() => {
      if (this.phase !== 'recording') return;
      this.options.onLimit?.();
      this.requestStop();
    }, this.options.maxDurationMs);
    this.setPhase('recording');
  }

  /** Stop and hand back the clip, or null when there was nothing to keep. */
  stop(): Promise<RecordedClip | null> {
    if (this.phase === 'starting') {
      this.cancel();
      return Promise.resolve(null);
    }
    if (this.phase !== 'recording' && this.phase !== 'stopping') return Promise.resolve(null);
    const done = new Promise<RecordedClip | null>((resolve) => {
      const previous = this.finished;
      this.finished = (clip) => {
        previous?.(clip);
        resolve(clip);
      };
    });
    this.requestStop();
    return done;
  }

  /** Drop the recording; whoever is waiting on `stop` gets null. */
  cancel(): void {
    this.cancelled = true;
    if (this.phase === 'recording') this.requestStop();
  }

  private requestStop(): void {
    if (this.phase !== 'recording') return;
    this.setPhase('stopping');
    this.recorder?.stop();
  }

  private clip(recorder: MediaRecorderLike): RecordedClip | null {
    if (this.chunks.length === 0) return null;
    const type = recorder.mimeType === '' ? 'audio/webm' : recorder.mimeType;
    return {
      blob: new Blob(this.chunks, { type }),
      durationMs: Math.max(0, this.deps.now() - this.startedAt),
    };
  }

  private finish(clip: RecordedClip | null): void {
    if (this.limitTimer !== null) this.deps.clearTimeoutFn(this.limitTimer);
    this.limitTimer = null;
    if (this.stream !== null) stopTracks(this.stream);
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.setPhase('idle');
    const finished = this.finished;
    this.finished = null;
    finished?.(clip);
  }

  private setPhase(phase: RecorderPhase): void {
    this.phase = phase;
    this.options.onPhase?.(phase);
  }
}

function stopTracks(stream: MediaStreamLike): void {
  for (const track of stream.getTracks()) track.stop();
}

function mediaErrorCode(error: unknown): RecorderErrorCode {
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'PERMISSION_DENIED';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'NO_MICROPHONE';
  return 'FAILED';
}

/** The browser's own recorder, for the app. Tests pass their own deps. */
export function browserRecorderDeps(): RecorderDeps {
  return {
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createRecorder: (stream, mimeType) => {
      const native = new MediaRecorder(
        stream as MediaStream,
        mimeType === undefined ? {} : { mimeType },
      );
      return {
        get mimeType() {
          return native.mimeType;
        },
        start: (timesliceMs) => native.start(timesliceMs),
        stop: () => native.stop(),
        listen: (handlers) => {
          native.ondataavailable = (event) => handlers.data(event.data);
          native.onstop = () => handlers.stop();
          native.onerror = () => handlers.error();
        },
      };
    },
    isTypeSupported: (type) =>
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type),
    now: () => Date.now(),
    setTimeoutFn: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeoutFn: (handle) => window.clearTimeout(handle as number),
  };
}

/** Seconds as `m:ss`, for a recording timer or a clip's length. */
export function formatClipTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
