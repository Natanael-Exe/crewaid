import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { RecordingWarning } from '@crewaid/shared';

import { PrismaService } from '../prisma/prisma.service.js';
import { TurnEventBus } from '../agent/turn-event.bus.js';
import type { RfbInputEvent } from '../screen/rfb-input.js';
import type { CapturedCdpEvent, TracePayload } from './cdp-events.js';
import {
  coalesceInput,
  createInputCoalescer,
  drainHeld,
  isClickPress,
  markTypingSecret,
  nextOffsetMs,
  SECRET_TYPING_TEXT,
  type InputCoalescer,
} from './recording-events.js';
import { breachedLimit, MAX_RECORDING_MS } from './recording-limits.js';
import { ClickScreenshotService, type StoredCrop } from './click-screenshot.service.js';

/**
 * The crop of a row that has none: one shared, already-settled promise rather
 * than a fresh `Promise.resolve` per event. Every row in a batch is awaited
 * together (see `drain`) and all but the button-downs are this one.
 */
const NO_CROP: Promise<StoredCrop | null> = Promise.resolve(null);

/** How late a page's password-field report can be and still be about a run of typing. */
const SECRET_LOOKBACK_MS = 2_000;

/**
 * A page's report of input into a password field. HTML attribute values are
 * ASCII case-insensitive, so `Password` is one too.
 */
export function isPasswordInput(event: CapturedCdpEvent): boolean {
  const inputType = event.payload['inputType'];
  return (
    (event.type === 'input' || event.type === 'change') &&
    typeof inputType === 'string' &&
    inputType.toLowerCase() === 'password'
  );
}

/** Events observed per layer. `atspi` exists in §3 but is unused in v1. */
export interface LayerCounts {
  x11: number;
  cdp: number;
  atspi: number;
}

/**
 * Told that capture has stopped itself, so the lifecycle can settle the row.
 * Called at most once per recording, from whichever of the two
 * ceilings is reached first.
 */
export type RecordingLimitListener = (
  botId: string,
  recordingId: string,
  warning: RecordingWarning,
) => void;

/**
 * What the 5000-event ceiling counts.
 *
 * Every layer, not just `x11`: §6/M3 says "5000 events", and M4 starts
 * writing CDP rows into the same trace and sending all of them to the same
 * compiler. Counting one layer would raise the real ceiling the moment a
 * second one appears.
 */
export function totalEvents(counts: LayerCounts): number {
  return counts.x11 + counts.cdp + counts.atspi;
}

/** What `end` reports back to the lifecycle, so it can settle the row. */
export interface TeeResult {
  readonly counts: LayerCounts;
  /** Events accepted by the tee that never reached Postgres. */
  readonly lostEvents: number;
}

/** The layers this trace writer can produce. `ATSPI` exists in §3 but is unused in v1. */
export type CaptureLayerName = 'X11' | 'CDP' | 'ATSPI';

interface PendingEvent {
  readonly tsOffsetMs: number;
  readonly layer: CaptureLayerName;
  readonly type: string;
  readonly payload: TracePayload;
  /**
   * The click screenshot this row will name, still in flight.
   *
   * Null on all but the button-down rows, and settled before the row is
   * written — see `drain`. It resolves rather than rejects, always: the
   * capture owns its own failures, and one that reached here as a rejection
   * would take the whole batch's events down with it.
   */
  crop: Promise<StoredCrop | null> | null;
}

interface ActiveRecording {
  readonly botId: string;
  /** Null between reserving this bot's slot and the row existing; see `reserve`. */
  recordingId: string | null;
  startedAtMs: number;
  lastOffsetMs: number | null;
  readonly counts: LayerCounts;
  /** Per-recording, so one bot's suppressed moves cannot leak into another's. */
  readonly coalescer: InputCoalescer;
  pending: PendingEvent[];
  /** The tail of the write chain, so batches land in the order they were teed. */
  flushing: Promise<void>;
  timer: NodeJS.Timeout | null;
  /** Fires the 20-minute ceiling when no input arrives to notice it. */
  deadline: NodeJS.Timeout | null;
  /** The ceiling this recording hit; non-null means capture has stopped. */
  limit: RecordingWarning | null;
  notifiedAtMs: number;
  lostEvents: number;
}

/**
 * The tee: "if the bot has an active `Recording`, every validated
 * inbound event is *also* written to the recording pipeline before being
 * forwarded. This is the entire recorder."
 *
 * Why the active set is in memory
 *
 * `ScreenService.input` carries every mouse move the operator makes and is
 * built to cost zero queries (D-036 — membership in the subscriber set IS the
 * authorisation). Asking Postgres "is this bot recording?" per event would
 * undo that on the hottest path in the product, and the answer changes twice
 * per recording. So the set lives here, and the durable `Recording` row is
 * reconciled to it at boot rather than consulted per event: a `RECORDING` row
 * with no entry in this map belongs to a process that no longer exists, and
 * `RecordingsService` settles those on bootstrap. That reconciliation is what
 * lets this map be the authority — without it a crash would leave a row that
 * captures nothing yet still counts as work to the idle sweep, pinning a
 * container open for as long as the orchestrator runs.
 *
 * Why writes are batched and ordered
 *
 * A row per event on the input path would put a round trip between a keystroke
 * and the desktop. Buffering decouples them, but only if the batches land in
 * the order they were filled: two `createMany` calls in flight at once can
 * commit in either order, and `tsOffsetMs` is a value we assigned, not one
 * Postgres derives, so the rows would be right while a reader taking them in
 * primary-key order would not. Hence one write in flight per recording, with
 * the next batch chained behind it.
 *
 * Offsets are assigned at tee time for the same reason: the order is decided
 * where the events actually arrive, not where they happen to be persisted.
 *
 * Why a lost batch fails the recording
 *
 * A trace with a hole still compiles, into a skill that silently
 * skips whatever was in the hole. That is worse than no skill: it fails on the
 * user's screen, at whatever step the missing events were, long after the
 * cause. So a batch that cannot be written is counted rather than retried
 * forever — retrying an unavailable database grows the buffer without bound —
 * and `end` reports the loss so the lifecycle can mark the recording `FAILED`.
 */
@Injectable()
export class RecordingTeeService implements OnModuleDestroy {
  private readonly logger = new Logger(RecordingTeeService.name);

  /**
   * Events per write. Large enough that a drag costs a handful of statements
   * rather than hundreds, small enough that the buffer is a rounding error
   * against the 5000-event ceiling M3-BE-05 puts on a whole recording.
   */
  static readonly FLUSH_BATCH = 64;

  /**
   * How long a partial batch may wait. Only reached when input STOPS — a burst
   * hits the batch size first — so this is the latency on the last few events
   * before a pause, and the ceiling on how much a crash can lose.
   */
  static readonly FLUSH_INTERVAL_MS = 250;

  /**
   * WebSocket `recording.event` carries `counts`, not an event log, so one frame per
   * captured event is not what the contract asks for. Coalescing
   * thins the moves but not the clicks and keys, which a fast typist still
   * delivers faster than a UI repaints — on the same socket the desktop is
   * streaming over. One frame per interval carries exact counts and the type
   * that produced it, which is everything the live counter renders, at
   * a rate a UI can actually paint.
   */
  static readonly NOTIFY_INTERVAL_MS = 100;

  private readonly active = new Map<string, ActiveRecording>();

  /**
   * One listener, not a fan-out: the ceilings settle a row, and two owners
   * settling the same row is a race rather than a feature. `RecordingsService`
   * registers in its constructor — the tee cannot import it back (that is the
   * cycle this slot exists to avoid), but it does not need to know who is
   * listening either.
   */
  private limitListener: RecordingLimitListener | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
    @Inject(ClickScreenshotService) private readonly screenshots: ClickScreenshotService,
  ) {}

  /**
   * Claim this bot's recording slot, before anything is awaited.
   *
   * `POST /bots/:id/recordings` has to wake a computer and insert a row before
   * a recording exists, and two requests arriving together would both find no
   * active recording and both create one — leaving a second row that nothing
   * can ever stop, because `stop` resolves by bot. Reserving synchronously is
   * what makes that check atomic: there is no await between the read and the
   * write, so the loser is refused before it starts a container.
   */
  reserve(botId: string): boolean {
    if (this.active.has(botId)) return false;
    this.active.set(botId, {
      botId,
      recordingId: null,
      startedAtMs: 0,
      lastOffsetMs: null,
      counts: { x11: 0, cdp: 0, atspi: 0 },
      coalescer: createInputCoalescer(),
      pending: [],
      flushing: Promise.resolve(),
      timer: null,
      deadline: null,
      limit: null,
      notifiedAtMs: 0,
      lostEvents: 0,
    });
    return true;
  }

  /** The row exists: start capturing against it. */
  begin(botId: string, recordingId: string, startedAt: Date): void {
    const entry = this.active.get(botId);
    if (entry === undefined || entry.recordingId !== null) {
      throw new Error(`no reserved recording slot for bot ${botId}`);
    }
    entry.recordingId = recordingId;
    entry.startedAtMs = startedAt.getTime();
    // Measured from the row's own `startedAt`, not from now: the recording is
    // as old as the row a reader will find, and the two differ by however long
    // the insert took.
    const remainingMs = Math.max(0, MAX_RECORDING_MS - (Date.now() - entry.startedAtMs));
    entry.deadline = setTimeout(() => {
      entry.deadline = null;
      this.reachLimit(entry, 'TIME_LIMIT');
    }, remainingMs).unref();
  }

  /** Register the lifecycle's auto-stop. See `limitListener`. */
  onLimitReached(listener: RecordingLimitListener): void {
    this.limitListener = listener;
  }

  /** Give the slot back when the row was never created. */
  abandon(botId: string): void {
    const entry = this.active.get(botId);
    if (entry === undefined || entry.recordingId !== null) return;
    this.active.delete(botId);
  }

  /** Whether input to this bot is currently being captured. */
  isRecording(botId: string): boolean {
    return this.recordingIdOf(botId) !== null;
  }

  /** The recording capturing this bot's input, or null. */
  recordingIdOf(botId: string): string | null {
    return this.active.get(botId)?.recordingId ?? null;
  }

  /**
   * The tee, on the input path.
   *
   * Synchronous, unawaited and non-throwing by contract: the caller is
   * forwarding an RFB message to a container, and the recorder must never be
   * able to delay a keystroke or fail one. A recording that loses events is
   * marked `FAILED` on stop; a desktop that stalls because the recorder is
   * slow is a bug the operator feels immediately.
   */
  tee(botId: string, event: RfbInputEvent): void {
    const entry = this.active.get(botId);
    if (entry === undefined || entry.recordingId === null) return;
    // A reached ceiling stops capture HERE, synchronously, rather than when the
    // settle it triggers finishes writing. Otherwise the trace would grow by
    // however many events arrived while Postgres answered, and a limit whose
    // real value depends on database latency is not a hard limit.
    if (entry.limit !== null) return;

    const elapsedMs = Date.now() - entry.startedAtMs;
    // Check the clock before handing the frame to the coalescer. The deadline
    // timer normally gets here first, but a busy event loop can deliver input
    // after the deadline while its timeout is still queued. Appending that
    // frame and checking afterwards would make the time ceiling exceedable by
    // exactly the case this second clock read exists to cover.
    if (this.enforceLimit(entry, elapsedMs)) return;
    // M3-BE-04, and asked BEFORE the coalescer advances its button mask: this
    // is the only moment both masks exist, and a press is the difference
    // between them.
    const press = isClickPress(entry.coalescer, event);
    // A move inside the 100 ms window contributes nothing here and is
    // held instead, so most events on a drag cost one comparison and no row.
    const emitted = coalesceInput(entry.coalescer, event, elapsedMs);
    if (emitted.length === 0) return;
    let last: PendingEvent | null = null;
    for (const emission of emitted)
      last = this.append(entry, 'X11', emission.event, emission.elapsedMs);
    // A frame that presses a button emits its pointer row LAST — anything the
    // press released (a held move, a run of typing) is older and goes ahead of
    // it — so the row the crop belongs to is the one `append` just returned.
    if (press && last !== null) this.captureClick(entry, last, event);

    this.schedule(entry);
    // The counter follows what the trace will actually contain, not what the
    // socket delivered: it is the number M3-BE-05 measures its 5000-event
    // ceiling against, and the one M3-FE-01 shows the user.
    this.notify(entry, 'X11', emitted[emitted.length - 1]!.event.type);
    // Checked after the whole frame is appended, never mid-frame: one event
    // can emit a released move, a run of typing and the key that ended it, and
    // they describe one thing the user did. Landing exactly on 5000 by
    // dropping part of that would end the trace inside a gesture, which reads
    // to the compiler as a step that never finished — a worse trace than one
    // two rows over a ceiling that exists to bound cost, not to be exact.
    //
    // Only the event arm can fire here: the same `elapsedMs` was already
    // judged above, and a recording with no input at all is the deadline
    // timer's case.
    this.enforceLimit(entry, elapsedMs);
  }

  /**
   * The CDP half of the same trace.
   *
   * Why this goes through the x11 writer rather than a second one
   *
   * `tsOffsetMs` is the trace's only order — §3 indexes on
   * `[recordingId, tsOffsetMs]` and carries no tiebreaker. Two producers
   * assigning offsets independently would stamp the same millisecond on the
   * move that aimed a click and the click itself, and a reader (or the
   * compiler) taking rows in whatever order Postgres returned them would get
   * both orders. Handing both layers to one chain of `append` calls keeps a
   * real gesture's interleaving honest, because a page click and the X11 click
   * that delivered it arrive milliseconds apart.
   *
   * The ceiling and the loss accounting arrive with the same decision. §6/M3's
   * 5000 events is a ceiling on the TRACE — `totalEvents` already counts every
   * layer — so a CDP event must be able to reach that count, to stop capture
   * at it, and to fail the recording if it cannot be written, exactly as an
   * X11 one does.
   *
   * Why no coalescing
   *
   * The X11 coalescers exist because RFB samples are not events: a drag
   * delivers dozens of positions per second and only the endpoints mean
   * something. A binding call is the opposite — the page reports that the user
   * clicked or typed, once, at the moment it happened. There is nothing to
   * thin, and the 5000-event ceiling bounds what a chatty page can cost.
   *
   * Same contract as `tee`: synchronous, unawaited, never throws. Its caller
   * is a WebSocket frame from a sandbox, and a recorder that could delay or
   * fail that path would be measuring the wrong thing.
   */
  teeCdp(botId: string, event: CapturedCdpEvent): void {
    const entry = this.active.get(botId);
    if (entry === undefined || entry.recordingId === null) return;
    if (entry.limit !== null) return;

    const elapsedMs = Date.now() - entry.startedAtMs;
    if (this.enforceLimit(entry, elapsedMs)) return;
    if (isPasswordInput(event)) this.keepTypingSecret(entry, elapsedMs);
    this.append(entry, 'CDP', event, elapsedMs);
    this.schedule(entry);
    this.notify(entry, 'CDP', event.type);
    this.enforceLimit(entry, elapsedMs);
  }

  /**
   * The page says the user is typing into a password field, so the X11 keys
   * that typed it must not reach the trace as text.
   *
   * The run still being coalesced is the usual case — every keystroke fires
   * an `input`, so the report arrives while the user is still typing — and
   * it is marked so it is emitted redacted. A run that something ended just
   * before the report arrived is still in the write buffer, and is redacted
   * there; the lookback is how late a page's report can be and still be
   * about those keys.
   */
  private keepTypingSecret(entry: ActiveRecording, elapsedMs: number): void {
    markTypingSecret(entry.coalescer);
    entry.pending = entry.pending.map((row) =>
      row.layer === 'X11' &&
      row.type === 'type' &&
      row.payload['secret'] !== true &&
      row.tsOffsetMs >= elapsedMs - SECRET_LOOKBACK_MS
        ? { ...row, payload: { text: SECRET_TYPING_TEXT, secret: true } }
        : row,
    );
  }

  /**
   * Whether this recording has reached a ceiling, stopping capture when it
   * has.
   *
   * Both producers check it on the way in — before a frame is captured, so a
   * recording that ran out of budget captures nothing further — and on the
   * way out, because one frame can buffer more than one row and the ceiling
   * must be noticed even when nothing else arrives afterwards.
   */
  private enforceLimit(entry: ActiveRecording, elapsedMs: number): boolean {
    const warning = breachedLimit(elapsedMs, totalEvents(entry.counts));
    if (warning === null) return false;
    this.reachLimit(entry, warning);
    return true;
  }

  /**
   * Stop capturing and hand the recording to whoever settles rows.
   *
   * Idempotent by the `limit` check: both ceilings can be reached at once, and
   * a settle running twice against one row would race the user's own stop.
   */
  private reachLimit(entry: ActiveRecording, warning: RecordingWarning | null): void {
    const recordingId = entry.recordingId;
    if (warning === null || entry.limit !== null || recordingId === null) return;
    entry.limit = warning;
    if (entry.deadline !== null) clearTimeout(entry.deadline);
    entry.deadline = null;
    this.logger.warn(
      `recording ${recordingId} reached the ${warning} ceiling after ` +
        `${totalEvents(entry.counts)} events; capture stopped`,
    );
    this.limitListener?.(entry.botId, recordingId, warning);
  }

  /** Assign the offset that keeps the trace ordered, and buffer the row. */
  private append(
    entry: ActiveRecording,
    layer: CaptureLayerName,
    captured: { readonly type: string; readonly payload: TracePayload },
    elapsedMs: number,
  ): PendingEvent {
    const offset = nextOffsetMs(elapsedMs, entry.lastOffsetMs);
    entry.lastOffsetMs = offset;
    this.countEvent(entry, layer);
    const pending: PendingEvent = {
      layer,
      tsOffsetMs: offset,
      type: captured.type,
      payload: captured.payload,
      crop: null,
    };
    entry.pending.push(pending);
    return pending;
  }

  /** Count the row the trace is about to hold, for the ceiling and the counter. */
  private countEvent(entry: ActiveRecording, layer: CaptureLayerName): void {
    if (layer === 'X11') entry.counts.x11 += 1;
    else if (layer === 'CDP') entry.counts.cdp += 1;
    else entry.counts.atspi += 1;
  }

  /**
   * PRD §6/M3: "On every button-down, capture a screenshot via the bridge and
   * store a 200x200 px crop centered on the click point."
   *
   * Started here and awaited in `drain`, which is what keeps a stored key
   * honest: the row naming a crop is written only once that crop is on disk,
   * so a reader never holds a `screenshotKey` pointing at nothing. The cost is
   * that the batch carrying a click waits for it — bounded by
   * `ClickScreenshotService.TIMEOUT_MS`, and paid by the writer rather than by
   * the operator, whose keystroke was forwarded long before.
   *
   * The `catch` is belt and braces over a promise the service already
   * documents as never rejecting. It is here rather than there because THIS is
   * where a rejection would do the damage: `drain` awaits the whole batch at
   * once, so one rejected crop would count every event beside it as lost and
   * mark an otherwise perfect recording FAILED.
   */
  private captureClick(entry: ActiveRecording, row: PendingEvent, event: RfbInputEvent): void {
    // Both conditions are already true at the one call site — `tee` returns
    // early without a recordingId, and only a pointer event can be a press.
    // They are here to NARROW, not to check: `event.x` does not exist on a key
    // event and a null recordingId is not a recording. Read as a runtime
    // guard this line is dead, which is worth knowing before deleting it.
    const recordingId = entry.recordingId;
    if (recordingId === null || event.kind !== 'pointer') return;
    row.crop = this.screenshots
      .capture(entry.botId, recordingId, event.x, event.y)
      .catch(() => null);
  }

  /**
   * Commit whatever the coalescer is still holding — a move, or a run of
   * typing that nothing has ended.
   *
   * Every path that ends capture goes through here first, because both are
   * real things the user did: leaving them in memory would make "the cursor
   * ended up here" and "this is what they typed last" the two things a
   * completed recording drops.
   */
  private releaseHeld(entry: ActiveRecording): void {
    for (const emission of drainHeld(entry.coalescer)) {
      this.append(entry, 'X11', emission.event, emission.elapsedMs);
    }
  }

  /**
   * Make emitted events durable without ending the recording.
   *
   * Status reads must not drain the coalescer: polling would otherwise retain
   * every suppressed sample and bypass the 100 ms capture limit. The held
   * move remains eligible for replacement until input or recording end
   * releases it; counts describe only events committed to the trace.
   */
  async settle(botId: string, recordingId?: string): Promise<TeeResult | null> {
    const entry = this.active.get(botId);
    if (entry === undefined || (recordingId !== undefined && entry.recordingId !== recordingId))
      return null;
    await this.flush(entry);
    return { counts: { ...entry.counts }, lostEvents: entry.lostEvents };
  }

  /**
   * Stop capturing and make the trace durable.
   *
   * Removed from the active set FIRST, so an input racing the stop is dropped
   * rather than landing after the flush that was supposed to be final — an
   * event written after `endedAt` is a row no reader expects.
   */
  async end(botId: string, recordingId?: string): Promise<TeeResult | null> {
    const entry = this.active.get(botId);
    if (entry === undefined || (recordingId !== undefined && entry.recordingId !== recordingId))
      return null;
    this.active.delete(botId);
    this.disarm(entry);
    // Before the flush, not after: this bot may start another recording the
    // moment this one is out of the active set, and a `forget` running later
    // would drop the NEW recording's cached endpoint instead of this one's.
    // Crops still in flight hold their own state object and are unaffected.
    this.screenshots.forget(botId);
    this.releaseHeld(entry);
    await this.flush(entry);
    return { counts: { ...entry.counts }, lostEvents: entry.lostEvents };
  }

  /** Drop both timers, so nothing fires against a recording that is over. */
  private disarm(entry: ActiveRecording): void {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    if (entry.deadline !== null) clearTimeout(entry.deadline);
    entry.deadline = null;
  }

  /**
   * A graceful shutdown flushes; it does not settle the rows. Marking them is
   * the bootstrap reconciliation's job, which has to handle the ungraceful
   * case anyway and would otherwise be two code paths for one situation.
   */
  async onModuleDestroy(): Promise<void> {
    const entries = [...this.active.values()];
    this.active.clear();
    for (const entry of entries) {
      this.disarm(entry);
      this.screenshots.forget(entry.botId);
      this.releaseHeld(entry);
      await this.flush(entry);
    }
  }

  private schedule(entry: ActiveRecording): void {
    if (entry.pending.length >= RecordingTeeService.FLUSH_BATCH) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.timer = null;
      void this.flush(entry);
      return;
    }
    if (entry.timer !== null) return;
    // `unref`, like every other background timer here: a buffered event must
    // never be the thing keeping a shutdown or a test runner open.
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.flush(entry);
    }, RecordingTeeService.FLUSH_INTERVAL_MS).unref();
  }

  /** Chain behind whatever is already in flight, so batches land in order. */
  private flush(entry: ActiveRecording): Promise<void> {
    const chained = entry.flushing.then(() => this.drain(entry));
    // The stored tail never rejects: one failed batch must not poison every
    // later flush, and `drain` has already recorded the loss.
    entry.flushing = chained;
    return chained;
  }

  private async drain(entry: ActiveRecording): Promise<void> {
    const recordingId = entry.recordingId;
    if (recordingId === null || entry.pending.length === 0) return;
    const batch = entry.pending;
    entry.pending = [];

    try {
      // The one place this pipeline waits on anything but Postgres. A row's
      // `screenshotKey` is a promise the storage has to have kept already:
      // written before its crop lands, it would name a file that does not
      // exist yet, and M3-BE-06 reads a finished recording with no way to tell
      // "not there yet" from "never arrived". Awaiting the whole batch at once
      // costs the slowest crop in it, not the sum.
      const crops = await Promise.all(batch.map((event) => event.crop ?? NO_CROP));
      await this.prisma.recordingEvent.createMany({
        data: batch.map((event, index) => {
          const crop = crops[index] ?? null;
          return {
            recordingId,
            tsOffsetMs: event.tsOffsetMs,
            layer: event.layer,
            type: event.type,
            // The crop's origin travels with the event because the window is
            // clamped, not centered, near an edge (see `cropWindow`): without
            // it, locating the click inside its own crop means re-deriving the
            // clamp from the resolution, and M3-BE-07 hands this trace to a
            // model rather than to code that could.
            payload:
              crop === null
                ? event.payload
                : { ...event.payload, cropX: crop.rect.x, cropY: crop.rect.y },
            screenshotKey: crop?.key ?? null,
          };
        }),
      });
    } catch (error: unknown) {
      entry.lostEvents += batch.length;
      this.logger.error(
        `recording ${recordingId} lost ${batch.length} events (${entry.lostEvents} total): ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private notify(entry: ActiveRecording, layer: CaptureLayerName, type: string): void {
    const now = Date.now();
    if (now - entry.notifiedAtMs < RecordingTeeService.NOTIFY_INTERVAL_MS) return;
    entry.notifiedAtMs = now;
    if (entry.recordingId === null) return;
    this.events.emitRecordingEvent(entry.botId, entry.recordingId, layer, type, {
      x11: entry.counts.x11,
      cdp: entry.counts.cdp,
    });
  }
}
