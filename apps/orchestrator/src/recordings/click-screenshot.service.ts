import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { SANDBOX_PORTS } from '@crewaid/sandbox-core';

import { PrismaService } from '../prisma/prisma.service.js';
import { ARTIFACT_STORE, type ArtifactStore } from '../attachments/artifact-store.js';
import { DiskArtifactStore } from '../attachments/disk-artifact-store.js';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../sandbox/sandbox.provider.js';
import { cropScreenshot, MAX_SCREENSHOT_BYTES, type CropRect } from './png-crop.js';
import { computerOfBot } from '../sandbox/attached-computer.js';

/**
 * "On every button-down, capture a screenshot via the bridge and
 * store a 200x200 px crop centered on the click point."
 *
 * Why this cannot fail a recording
 *
 * `capture` resolves rather than rejects, always. §3 already models a click
 * with no image — `screenshotKey` is nullable and set on X11 clicks only — so
 * a bridge that is slow, a desktop that was restarted mid-recording, an
 * artifact store that refuses the write: each costs one crop, not the trace. The events are
 * what compile into a skill; the crops only disambiguate them, and
 * §6 already says the model gets "up to 8", never all of them.
 *
 * The inverse would be much worse. A screenshot is a round trip to a container
 * that a click has just made busy, and letting it decide whether a click is
 * recorded would make the recorder least reliable exactly when the desktop is
 * doing the most.
 *
 * Why the bridge endpoint is resolved once per bot
 *
 * Reaching the bridge means a `Sandbox` row, a Docker inspect, and a port
 * lookup. None of that changes while a recording runs — the idle sweep
 * refuses to stop a bot with a `RECORDING` row, which is the only thing that
 * would move the port — so it is resolved on the first click and reused. The
 * promise is cached rather than its result, so a burst of clicks during a slow
 * inspect shares one lookup instead of starting one each.
 *
 * A failure clears the cache. The case that matters is an operator stopping
 * and starting the computer mid-recording: Docker publishes a NEW host port,
 * and a cached endpoint would send every remaining click of that recording to
 * a port nothing is listening on. Re-resolving on the next click costs one
 * inspect and recovers on its own.
 */
@Injectable()
export class ClickScreenshotService {
  private readonly logger = new Logger(ClickScreenshotService.name);

  /**
   * How long one capture may take end to end.
   *
   * This is not on the input path — `RecordingTeeService.tee` never awaits it,
   * so a keystroke is never behind a screenshot. It is the ceiling on how long
   * the batch containing a click waits before it is written, because the crop
   * has to exist before the row that names it does.
   *
   * Five seconds is generous against a healthy desktop (the bridge answers
   * over loopback in well under a second) and short of the bridge's own 10 s
   * `scrot` timeout, so a wedged X server surfaces here as a missing crop
   * rather than as a stalled recording.
   */
  static readonly TIMEOUT_MS = 5_000;

  /** Per-bot bridge endpoint and failure count, dropped when a recording ends. */
  private readonly bots = new Map<string, BotCapture>();

  // Explicit tokens: vitest/esbuild emits no design:paramtypes, so type-based
  // DI resolution silently fails in the integration suite.
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SANDBOX_PROVIDER) private readonly provider: SandboxProvider,
    @Optional()
    @Inject(ARTIFACT_STORE)
    private readonly artifacts: ArtifactStore = new DiskArtifactStore(),
  ) {}

  /**
   * Capture, crop and store one click's screenshot.
   *
   * Never rejects; a failure resolves `null` and the event is written without
   * a `screenshotKey`.
   */
  async capture(
    botId: string,
    recordingId: string,
    clickX: number,
    clickY: number,
  ): Promise<StoredCrop | null> {
    const state = this.stateOf(botId);
    try {
      const crop = await this.withDeadline(this.store(state, botId, recordingId, clickX, clickY));
      state.failures = 0;
      return crop;
    } catch (error: unknown) {
      // Drop the endpoint on ANY failure, not just a connection error. A crop
      // that failed to decode says nothing about the port, but re-resolving is
      // one Docker inspect on the next click and getting this wrong strands a
      // recording on a dead port for its remaining twenty minutes.
      state.bridge = null;
      state.failures += 1;
      // Once per RUN of failures at `warn`, the rest at `debug` — the counter
      // resets on the next success, so a recording that recovers and breaks
      // again speaks up both times. The 5000-event ceiling permits thousands
      // of clicks, and a misconfigured artifact store fails every one of them
      // identically — a `warn` each would bury the rest of the recording's
      // diagnostics under its own repetition.
      const detail = error instanceof Error ? error.message : String(error);
      if (state.failures === 1) {
        this.logger.warn(
          `recording ${recordingId}: no click screenshot for bot ${botId}: ${detail}. ` +
            'Further failures for this bot are logged at debug.',
        );
      } else {
        this.logger.debug(
          `recording ${recordingId}: click screenshot ${state.failures} failed: ${detail}`,
        );
      }
      return null;
    }
  }

  /**
   * Fetch, decode and write the crop, resolving only once the store has it.
   *
   * Split out of `capture` so the deadline below wraps the whole operation
   * instead of one await inside it.
   */
  private async store(
    state: BotCapture,
    botId: string,
    recordingId: string,
    clickX: number,
    clickY: number,
  ): Promise<StoredCrop> {
    const endpoint = await this.bridgeOf(botId, state);
    const png = await this.fetchScreenshot(endpoint, botId);
    const crop = cropScreenshot(png, clickX, clickY);
    const key = storageKeyFor(recordingId);
    await this.artifacts.put(key, crop.png, 'image/png');
    return { key, rect: crop.rect };
  }

  /**
   * Hold one capture to `TIMEOUT_MS` end to end.
   *
   * The abort signal in `fetchScreenshot` bounds the bridge round trip, which
   * is the part the sandbox can stall by itself — but it bounds nothing after
   * it. The decode, the re-encode and the write are the orchestrator's own
   * work, and this is the promise `RecordingTeeService.drain` waits on: every
   * later batch, `stop`, and the `status` reads M3-FE-01 polls are all chained
   * behind it. Without this, a store that stops answering holds the whole
   * recorder for as long as it likes, and the ceiling `TIMEOUT_MS` documents is
   * only a claim about the network.
   *
   * Losing the race does not cancel the work. A crop that lands after the
   * deadline becomes an unreferenced file, which is the cheap half of the two
   * outcomes; aborting mid-write would mean holding a handle to unwind, for a
   * case no retention pass covers yet either way.
   */
  private async withDeadline<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      // `unref`, like every other background timer here: a capture in flight
      // must never be the thing holding a shutdown open.
      timer = setTimeout(
        () => reject(new Error(`the capture exceeded ${ClickScreenshotService.TIMEOUT_MS} ms`)),
        ClickScreenshotService.TIMEOUT_MS,
      ).unref();
    });
    try {
      return await Promise.race([work, expiry]);
    } finally {
      // Cleared on the winning path too, so a capture that answered promptly
      // does not leave a five-second timer behind. The losing `work` gets a
      // handler here, so a rejection that arrives after the deadline has
      // passed is not an unhandled one.
      if (timer !== undefined) clearTimeout(timer);
      void work.catch(() => undefined);
    }
  }

  /**
   * Drop what was cached for this bot; called when its recording ends.
   *
   * Without it the map holds one entry per bot ever recorded for the life of
   * the process, and — worse than the memory — the next recording would
   * inherit the previous one's failure count and log nothing when it breaks
   * for its own reasons.
   */
  forget(botId: string): void {
    this.bots.delete(botId);
  }

  private stateOf(botId: string): BotCapture {
    const existing = this.bots.get(botId);
    if (existing !== undefined) return existing;
    const created: BotCapture = { bridge: null, failures: 0 };
    this.bots.set(botId, created);
    return created;
  }

  private bridgeOf(botId: string, state: BotCapture): Promise<BridgeEndpoint> {
    const cached = state.bridge;
    if (cached !== null) return cached;
    // Cached before it settles so concurrent clicks share one lookup. A
    // rejection is cleared by the caller's catch, which is the only place that
    // knows the whole capture failed.
    const resolving = this.resolveBridge(botId);
    state.bridge = resolving;
    return resolving;
  }

  private async resolveBridge(botId: string): Promise<BridgeEndpoint> {
    const sandbox = await computerOfBot(this.prisma, botId, { sessionId: true });
    if (sandbox === null) throw new Error(`bot ${botId} has no sandbox`);
    // Falls back to botId exactly as the lifecycle does: a container created
    // before its session id was persisted still answers to that key.
    const sessionId = sandbox.sessionId ?? botId;
    const session = await this.provider.attachSession({ sessionId });
    if (session === null) throw new Error(`no container is attached to session ${sessionId}`);
    const endpoint = await session.getPortEndpoint({ port: SANDBOX_PORTS.bridge });
    // A provider may require headers on its endpoints. Unlike the RFB
    // proxy, which has nowhere to put them, this is plain HTTP — so they are
    // simply sent, and the decision D-012 exists to force never arises here.
    return { url: endpoint.url, headers: endpoint.headers ?? {} };
  }

  private async fetchScreenshot(endpoint: BridgeEndpoint, botId: string): Promise<Buffer> {
    const response = await fetch(`${endpoint.url}/screenshot?botId=${encodeURIComponent(botId)}`, {
      headers: endpoint.headers,
      signal: AbortSignal.timeout(ClickScreenshotService.TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`the bridge answered ${response.status} for /screenshot`);
    }
    return await readCapped(response, MAX_SCREENSHOT_BYTES);
  }
}

/** What a stored crop contributes to the `RecordingEvent` that names it. */
export interface StoredCrop {
  /** `RecordingEvent.screenshotKey` — a key in the artifact store. */
  readonly key: string;
  readonly rect: CropRect;
}

interface BotCapture {
  /** The in-flight or resolved bridge endpoint; null until the first click. */
  bridge: Promise<BridgeEndpoint> | null;
  /** Consecutive failures, so only the first is logged loudly. */
  failures: number;
}

interface BridgeEndpoint {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/**
 * Grouped by recording, named at random.
 *
 * The directory is the recording so that discarding one is a single subtree
 * to remove rather than a query. The basename carries no click coordinates
 * and no index: a storage key is handed out, and one that encoded where the
 * user clicked would leak the contents of a recording to anyone who could see
 * a filename.
 */
function storageKeyFor(recordingId: string): string {
  return path.posix.join('recordings', recordingId, `${randomUUID()}.png`);
}

/**
 * Read a response body, refusing one that outgrows the cap.
 *
 * `arrayBuffer` would buffer whatever arrives before anything could check
 * it, and `content-length` is a claim the sender makes, not a constraint on
 * what it sends. The sandbox is the untrusted side of this connection,
 * so the running total is what actually bounds the read.
 */
async function readCapped(response: Response, cap: number): Promise<Buffer> {
  const body = response.body;
  if (body === null) throw new Error('the bridge sent no screenshot body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Annotated because `Response['body']` reaches here untyped under
  // @types/node, and an `any` chunk would silently defeat the size accounting
  // below — the one thing in this function that has to be right.
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) throw new Error(`the screenshot exceeded ${cap} bytes`);
      chunks.push(value);
    }
  } finally {
    // Releases the socket on the throwing path too; without it a refused
    // oversize body leaks a connection per click.
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, total);
}
