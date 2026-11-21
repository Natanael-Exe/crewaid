/**
 * What a screen stream knows about the line to its slowest viewer, and how
 * many updates it may therefore have on the way at once.
 *
 * Why more than one
 *
 * With one update in flight, the next request to x11vnc waits for the
 * viewer's pong, so every frame pays the viewer's round trip AND the round
 * trip to the machine, one after the other. With the orchestrator in Oregon,
 * the machine in Virginia and a viewer 185 ms away, that is a quarter of a
 * second per frame however fast either line is: four frames a second, and a
 * keystroke typed just after an update waits for the whole cycle to show.
 *
 * So the stream asks for the next update as soon as the window has room,
 * which keeps a request parked at x11vnc for the next change, and forwards
 * each update the moment it arrives. Nothing is held at the orchestrator: an
 * update held for the viewer's pong would show a picture one round trip older
 * than the one a fresh request would have fetched.
 *
 * Why it is bounded by bytes
 *
 * Updates sent faster than the line drains them queue on the way, which is
 * the failure delivery pacing was introduced for: on a 1 Mbit/s line with
 * 700 ms of latency, 3 MB queued and a scroll showed up seconds late. A line
 * holds its delivery rate times its latency without queueing (the
 * bandwidth-delay product), so another update is asked for only while the
 * bytes already on the way are below that. On a slow line that is less than
 * one busy update, and the stream behaves exactly as stop-and-wait did; on a
 * fast, distant one it is several. Until the line is measured, the window
 * admits only small updates — a caret, a typed word — next to one in flight.
 *
 * Both figures come from the viewers' pongs, which travel in order with the
 * data. Latency is read from small updates sent onto an idle line, whose
 * transfer is negligible. Rate is read from large ones: an update cannot
 * reach the viewer before its own latency has passed, nor before the update
 * ahead of it did, and whatever it took beyond the later of the two is its own
 * transfer.
 */
export class DeliveryLine {
  #latencyMs: number | null = null;
  #bytesPerMs: number | null = null;
  #lastDeliveredAt = Number.NEGATIVE_INFINITY;

  /** One round trip with nothing queued, or null before a quiet update has shown it. */
  get latencyMs(): number | null {
    return this.#latencyMs;
  }

  /**
   * Bytes that may be on the way before the next request waits for a pong.
   */
  get budgetBytes(): number {
    if (this.#latencyMs === null || this.#bytesPerMs === null) return UNMEASURED_BUDGET_BYTES;
    return this.#bytesPerMs * this.#latencyMs;
  }

  /**
   * One update reached every viewer it was sent to, at `deliveredAt`.
   *
   * Returns how long its own bytes took on the line: net of latency, and of
   * waiting behind the update before it. That is the figure quality is judged
   * on. Null for an update too small to say anything about transfer.
   */
  delivered(update: DeliveredUpdate, deliveredAt: number): number | null {
    const previous = this.#lastDeliveredAt;
    this.#lastDeliveredAt = Math.max(previous, deliveredAt);

    if (update.bytes <= LATENCY_SAMPLE_MAX_BYTES) {
      // Only an update that had the line to itself shows its latency; behind
      // another, it shows the other's transfer too. Falls at once, rises
      // slowly: a quiet moment shows the line's latency, and one congested
      // small update should not erase it.
      if (update.lineWasIdle) {
        const sample = deliveredAt - update.sentAt;
        this.#latencyMs =
          this.#latencyMs === null
            ? sample
            : Math.min(sample, this.#latencyMs + (sample - this.#latencyMs) * 0.05);
      }
      return null;
    }

    const transferMs = Math.max(
      0,
      deliveredAt - Math.max(previous, update.sentAt + (this.#latencyMs ?? 0)),
    );
    if (update.bytes >= RATE_SAMPLE_MIN_BYTES) {
      const measured = update.bytes / Math.max(RATE_SAMPLE_MIN_MS, transferMs);
      // Pongs held up on the viewer's side arrive together, and the later
      // updates then look as if they took no time at all. So one sample may at
      // most double the estimate, which still falls fast and rises slowly:
      // overestimating the rate is the error that queues.
      const sample =
        this.#bytesPerMs === null ? measured : Math.min(measured, this.#bytesPerMs * 2);
      this.#bytesPerMs =
        this.#bytesPerMs === null
          ? sample
          : sample < this.#bytesPerMs
            ? this.#bytesPerMs * 0.5 + sample * 0.5
            : this.#bytesPerMs * 0.8 + sample * 0.2;
    }
    return transferMs;
  }
}

/** An update on its way to the viewers, as the line needs to know it. */
export interface DeliveredUpdate {
  readonly bytes: number;
  readonly sentAt: number;
  /** Nothing else was on the way when it was sent. */
  readonly lineWasIdle: boolean;
}

/**
 * Updates on the way at once, the next request counting as one. Past about
 * three, more frames per round trip stop being visible as smoothness and start
 * being latency.
 */
export const SCREEN_MAX_UPDATES_IN_FLIGHT = 3;
/** An update this small is mostly latency: it calibrates, it is not judged. */
export const LATENCY_SAMPLE_MAX_BYTES = 4 * 1024;
/** An update this large is mostly transfer: it measures the rate. */
export const RATE_SAMPLE_MIN_BYTES = 16 * 1024;
/**
 * The shortest transfer a rate is read from. Pongs are timed to the
 * millisecond, so a shorter one says only that the line is fast; reading it as
 * this long underestimates such a line, which is the safe direction.
 */
export const RATE_SAMPLE_MIN_MS = 5;
/**
 * The window before the line is measured: room for small updates beside one in
 * flight, never for a second busy one. 16 KiB is an eighth of a second at
 * 1 Mbit/s.
 */
export const UNMEASURED_BUDGET_BYTES = 16 * 1024;
