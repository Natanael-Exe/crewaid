import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { PNG } from 'pngjs';

import { ClickScreenshotService } from '../src/recordings/click-screenshot.service.js';
import { CROP_PX, MAX_SCREENSHOT_BYTES } from '../src/recordings/png-crop.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { SandboxProvider } from '../src/sandbox/sandbox.provider.js';

/**
 * M3-BE-04 — "capture a screenshot via the bridge and store a 200x200 px crop
 * centered on the click point" (PRD §6/M3).
 *
 * The property under test throughout is that this never costs the recording
 * anything: `capture` resolves `null` for every failure a container, a
 * network, or a disk can produce, and the caller writes the event without a
 * `screenshotKey` — a state §3 already models.
 */

function screenshot(width = 1280, height = 800): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(0x40);
  return PNG.sync.write(png);
}

/** A body that yields the given chunks and then ends. */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) controller.close();
      else controller.enqueue(chunks[index++]!);
    },
  });
}

/**
 * A body one megabyte past the cap, declaring nothing about its size.
 *
 * Bounded rather than infinite on purpose: an endless body makes an
 * unbounded read hang the runner instead of failing it, which proves the cap
 * by relying on it. This ends either way, and the counters say which happened
 * — a read that stopped early, or one that swallowed the whole body.
 */
const OVERSIZE_CHUNKS = MAX_SCREENSHOT_BYTES / (1024 * 1024) + 10;

function oversizeStream(): {
  stream: ReadableStream<Uint8Array>;
  pulled: () => number;
  cancelled: () => boolean;
} {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= OVERSIZE_CHUNKS) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

function respond(body: ReadableStream<Uint8Array>, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, body } as unknown as Response;
}

function setup(options: { sessionId?: string | null; sandbox?: boolean } = {}) {
  // `?? ` would swallow the point of the null case: a row whose sessionId was
  // never persisted is exactly what the botId fallback exists for.
  const sessionId = 'sessionId' in options ? options.sessionId! : 'session-1';
  const findUnique = vi.fn().mockResolvedValue(options.sandbox === false ? null : { sessionId });
  const prisma = { sandbox: { findFirst: findUnique } } as unknown as PrismaService;

  const getPortEndpoint = vi.fn().mockResolvedValue({ url: 'http://127.0.0.1:7070' });
  const attachSession = vi.fn().mockResolvedValue({ getPortEndpoint });
  const provider = { attachSession } as unknown as SandboxProvider;

  const service = new ClickScreenshotService(prisma, provider);
  return { service, findUnique, attachSession, getPortEndpoint };
}

let artifactDir: string;
const fetchMock = vi.fn();

beforeEach(async () => {
  artifactDir = await mkdtemp(path.join(tmpdir(), 'crewaid-crop-'));
  process.env['ARTIFACT_DIR'] = artifactDir;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env['ARTIFACT_DIR'];
});

describe('ClickScreenshotService — storing a click crop', () => {
  it('stores a 200x200 crop and reports where it came from', async () => {
    const { service } = setup();
    fetchMock.mockImplementation(() => respond(streamOf([screenshot()])));

    const stored = await service.capture('bot-1', 'rec-1', 640, 400);

    expect(stored).not.toBeNull();
    expect(stored!.rect).toEqual({ x: 540, y: 300, width: CROP_PX, height: CROP_PX });
    const written = PNG.sync.read(await readFile(path.join(artifactDir, stored!.key)));
    expect(written.width).toBe(CROP_PX);
    expect(written.height).toBe(CROP_PX);
  });

  it('asks the agent-bridge, on its own port, for the screenshot', async () => {
    const { service } = setup();
    fetchMock.mockImplementation(() => respond(streamOf([screenshot()])));

    await service.capture('bot-1', 'rec-1', 10, 10);

    // §5.2's route on §5.1's bridge port. Naming either by hand somewhere else
    // is what D-012 exists to prevent.
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:7070/screenshot?botId=bot-1');
  });

  it('groups keys by recording and leaks nothing about the click', async () => {
    const { service } = setup();
    fetchMock.mockImplementation(() => respond(streamOf([screenshot()])));

    const stored = await service.capture('bot-1', 'rec-1', 640, 400);
    const second = await service.capture('bot-1', 'rec-1', 100, 100);

    expect(stored!.key.startsWith('recordings/rec-1/')).toBe(true);
    // A storage key is handed out. One encoding where the user clicked would
    // describe the contents of a recording to anyone who can see a filename.
    // Asserted as a SHAPE, not as a substring search for the coordinates: the
    // key ends in a random uuid, and one containing "400" by chance failed
    // this in CI (recordings/rec-1/1dcdb89a-0400-4de0-…). What the test means
    // is that the key carries nothing but the recording and an opaque id.
    const suffix = stored!.key.slice('recordings/rec-1/'.length);
    expect(suffix).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/,
    );
    // Two clicks, two files: a name derived from the recording alone would
    // have every crop in it overwrite the one before, and the trace would
    // point every click at the last screenshot taken.
    expect(second!.key).not.toBe(stored!.key);
    expect(await readdir(path.join(artifactDir, 'recordings', 'rec-1'))).toHaveLength(2);
  });

  it('sends the headers a D-012 endpoint requires', async () => {
    const { service, getPortEndpoint } = setup();
    getPortEndpoint.mockResolvedValue({
      url: 'http://127.0.0.1:7070',
      headers: { authorization: 'Bearer provider-token' },
    });
    fetchMock.mockImplementation(() => respond(streamOf([screenshot()])));

    await service.capture('bot-1', 'rec-1', 10, 10);

    // Unlike the RFB proxy, which has nowhere to put them, this is plain HTTP.
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { authorization: 'Bearer provider-token' },
    });
  });

  it('falls back to the bot id when no session id was persisted', async () => {
    const { service, attachSession } = setup({ sessionId: null });
    fetchMock.mockImplementation(() => respond(streamOf([screenshot()])));

    await service.capture('bot-1', 'rec-1', 10, 10);

    expect(attachSession).toHaveBeenCalledWith({ sessionId: 'bot-1' });
  });
});

describe('ClickScreenshotService — the endpoint cache', () => {
  it('resolves the bridge once for a whole recording', async () => {
    const { service, attachSession, findUnique } = setup();
    fetchMock.mockImplementation(() => respond(streamOf([screenshot()])));

    for (let i = 0; i < 5; i += 1) await service.capture('bot-1', 'rec-1', i, i);

    // Five clicks, one Docker inspect. Nothing that decides the port can move
    // while a recording holds the sandbox open (§8 refuses to stop it).
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(attachSession).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('shares one lookup between clicks that arrive during it', async () => {
    const { service, attachSession } = setup();
    let release!: () => void;
    attachSession.mockReturnValue(
      new Promise((resolve) => {
        release = () =>
          resolve({ getPortEndpoint: vi.fn().mockResolvedValue({ url: 'http://h:1' }) });
      }),
    );
    fetchMock.mockImplementation(() => respond(streamOf([screenshot()])));

    const clicks = [
      service.capture('bot-1', 'rec-1', 1, 1),
      service.capture('bot-1', 'rec-1', 2, 2),
      service.capture('bot-1', 'rec-1', 3, 3),
    ];
    release();
    await Promise.all(clicks);

    // The promise is cached, not its result, so a burst during a slow inspect
    // does not start an inspect each.
    expect(attachSession).toHaveBeenCalledTimes(1);
  });

  it('re-resolves after a failure, so a restarted computer recovers', async () => {
    const { service, attachSession } = setup();
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    fetchMock.mockImplementation(() => respond(streamOf([screenshot()])));

    expect(await service.capture('bot-1', 'rec-1', 10, 10)).toBeNull();
    expect(await service.capture('bot-1', 'rec-1', 20, 20)).not.toBeNull();

    // Docker publishes a NEW host port on restart. A cached endpoint would
    // send every remaining click of the recording to a dead one.
    expect(attachSession).toHaveBeenCalledTimes(2);
  });

  it('forgets a bot, so the next recording starts clean', async () => {
    const { service, attachSession } = setup();
    fetchMock.mockImplementation(() => respond(streamOf([screenshot()])));

    await service.capture('bot-1', 'rec-1', 10, 10);
    service.forget('bot-1');
    await service.capture('bot-1', 'rec-2', 10, 10);

    expect(attachSession).toHaveBeenCalledTimes(2);
  });
});

describe('ClickScreenshotService — a failure costs one crop, never the trace', () => {
  it('resolves null when the bridge refuses, whatever it sends with the refusal', async () => {
    const { service } = setup();
    // A PERFECTLY GOOD PNG behind a 503. The status is what says "this is not
    // your screenshot" — a stale frame, a proxy's error page that happens to
    // be an image, a cached body. Judging the bytes instead would store one of
    // those against a click it does not show.
    fetchMock.mockResolvedValue(respond(streamOf([screenshot()]), 503));

    await expect(service.capture('bot-1', 'rec-1', 10, 10)).resolves.toBeNull();
    await expect(readdir(path.join(artifactDir, 'recordings'))).rejects.toThrow();
  });

  it('resolves null when the bot has no sandbox row', async () => {
    const { service } = setup({ sandbox: false });

    await expect(service.capture('bot-1', 'rec-1', 10, 10)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves null when no container is attached', async () => {
    const { service, attachSession } = setup();
    attachSession.mockResolvedValue(null);

    await expect(service.capture('bot-1', 'rec-1', 10, 10)).resolves.toBeNull();
  });

  it('says so when the bridge answers with no body at all', async () => {
    const { service } = setup();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    // A 204, or a proxy that dropped the payload. Both end as "no crop"; the
    // log line is the only difference an operator ever sees, and "not a PNG"
    // would send them looking at scrot.
    fetchMock.mockResolvedValue({ ok: true, status: 204, body: null } as unknown as Response);

    await expect(service.capture('bot-1', 'rec-1', 10, 10)).resolves.toBeNull();

    expect(warn.mock.calls[0]?.[0]).toContain('no screenshot body');
    warn.mockRestore();
  });

  it('resolves null when the bridge sends something that is not a PNG', async () => {
    const { service } = setup();
    fetchMock.mockResolvedValue(respond(streamOf([Buffer.from('<html>error</html>')])));

    await expect(service.capture('bot-1', 'rec-1', 10, 10)).resolves.toBeNull();
  });

  it('gives up on a capture that outlives its deadline', async () => {
    vi.useFakeTimers();
    try {
      const { service } = setup();
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      // A body that never ends and never errors. The fetch's own abort signal
      // bounds the bridge round trip; it cannot bound the work that is not the
      // bridge's — the decode, the re-encode, the write.
      fetchMock.mockResolvedValue(respond(new ReadableStream<Uint8Array>({ pull() {} })));

      const pending = service.capture('bot-1', 'rec-1', 10, 10);
      await vi.advanceTimersByTimeAsync(ClickScreenshotService.TIMEOUT_MS);

      // `drain` awaits this with every later batch, `stop` and the `status`
      // polls M3-FE-01 makes all chained behind it, so the ceiling the class
      // documents has to be a bound on the whole capture and not just on the
      // network half of it.
      await expect(pending).resolves.toBeNull();
      expect(warn.mock.calls[0]?.[0]).toContain('exceeded');
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves null when ARTIFACT_DIR is not configured', async () => {
    const { service } = setup();
    delete process.env['ARTIFACT_DIR'];
    fetchMock.mockImplementation(() => respond(streamOf([screenshot()])));

    await expect(service.capture('bot-1', 'rec-1', 10, 10)).resolves.toBeNull();
  });

  it('stops reading a body that outgrows the cap, and hangs up', async () => {
    const { service } = setup();
    const { stream, pulled, cancelled } = oversizeStream();
    fetchMock.mockResolvedValue(respond(stream));

    await expect(service.capture('bot-1', 'rec-1', 10, 10)).resolves.toBeNull();

    // `content-length` is a claim the sender makes, not a constraint on what
    // it sends, so the running total is what bounds this read. It stops at the
    // cap rather than after the body ends.
    expect(pulled()).toBeLessThan(OVERSIZE_CHUNKS);
    // And releases the socket on the way out: without this a refused body
    // leaks a connection per click.
    expect(cancelled()).toBe(true);
  });

  it('logs the first failure loudly and the rest at debug', async () => {
    const { service } = setup();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

    for (let i = 0; i < 4; i += 1) await service.capture('bot-1', 'rec-1', i, i);

    // A misconfigured ARTIFACT_DIR or a dead bridge fails every one of a
    // recording's thousands of permitted clicks identically. One line each
    // would bury the rest of the recording's diagnostics under its own
    // repetition.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledTimes(3);
    warn.mockRestore();
    debug.mockRestore();
  });

  it('speaks up again after a recovery, not only after a forget', async () => {
    const { service } = setup();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    fetchMock.mockImplementationOnce(() => respond(streamOf([screenshot()])));
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await service.capture('bot-1', 'rec-1', 1, 1);
    await service.capture('bot-1', 'rec-1', 2, 2);
    await service.capture('bot-1', 'rec-1', 3, 3);

    // The count is about a RUN of failures. A desktop that broke, came back,
    // and broke again for a different reason has a second thing worth saying.
    expect(warn).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it('speaks up again for the next recording on the same bot', async () => {
    const { service } = setup();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await service.capture('bot-1', 'rec-1', 1, 1);
    await service.capture('bot-1', 'rec-1', 2, 2);
    service.forget('bot-1');
    await service.capture('bot-1', 'rec-2', 3, 3);

    // Inheriting the previous recording's failure count is how a recording
    // breaks for its own reasons and says nothing about it.
    expect(warn).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it('attaches an abort signal, so a wedged desktop cannot stall a batch', async () => {
    const { service } = setup();
    fetchMock.mockImplementation(() => respond(streamOf([screenshot()])));

    await service.capture('bot-1', 'rec-1', 10, 10);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    // Short of the bridge's own 10 s scrot timeout (`bridge.py`), so a wedged
    // X server surfaces here as a missing crop rather than as a recording
    // whose writes have stopped.
    expect(ClickScreenshotService.TIMEOUT_MS).toBeLessThan(10_000);
  });

  it('writes no file for a click it could not capture', async () => {
    const { service } = setup();
    fetchMock.mockResolvedValue(respond(streamOf([Buffer.from('nope')])));

    await service.capture('bot-1', 'rec-1', 10, 10);

    // A half-written or placeholder image would be indistinguishable from a
    // real one to the model that reads it (§6/M3 sends up to 8 to the
    // compiler).
    await expect(readdir(path.join(artifactDir, 'recordings'))).rejects.toThrow();
  });
});
