import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { Recording } from '@prisma/client';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { TurnEventBus } from '../src/agent/turn-event.bus.js';
import type { SandboxReadinessService } from '../src/sandbox/sandbox-readiness.service.js';
import { RecordingTeeService } from '../src/recordings/recording-tee.service.js';
import { MAX_RECORDING_EVENTS } from '../src/recordings/recording-limits.js';
import { RecordingsService } from '../src/recordings/recordings.service.js';
import type { ClickScreenshotService } from '../src/recordings/click-screenshot.service.js';
import type { CdpAttachService } from '../src/recordings/cdp-attach.service.js';
import type { CdpCaptureService } from '../src/recordings/cdp-capture.service.js';
import type { ClickCorrelatorService } from '../src/recordings/click-correlator.service.js';

function setup() {
  const rows = new Map<string, Recording>(
    ['old', 'new'].map((id) => [
      id,
      {
        id,
        botId: 'bot',
        state: 'RECORDING',
        intent: null,
        startedAt: new Date(),
        endedAt: null,
        cdpAvailable: false,
        warning: null,
      },
    ]),
  );
  const createMany = vi.fn().mockResolvedValue({ count: 1 });
  const update = vi.fn().mockImplementation(({ where, data }) => {
    const row = { ...rows.get(where.id)!, ...data };
    rows.set(where.id, row);
    return Promise.resolve(row);
  });
  const updateMany = vi.fn(
    ({
      where,
      data,
    }: {
      where: { id: string; state?: string; cdpAvailable?: boolean };
      data: Record<string, unknown>;
    }) => {
      const row = rows.get(where.id);
      if (
        row === undefined ||
        (where.state !== undefined && row.state !== where.state) ||
        (where.cdpAvailable !== undefined && row.cdpAvailable !== where.cdpAvailable)
      ) {
        return Promise.resolve({ count: 0 });
      }
      rows.set(where.id, { ...row, ...data });
      return Promise.resolve({ count: 1 });
    },
  );
  const findMany = vi.fn((args?: { where?: { state?: string } }) => {
    const wanted = args?.where?.state;
    return Promise.resolve(
      [...rows.values()]
        .filter((row) => wanted === undefined || row.state === wanted)
        .map((row) => ({ id: row.id, botId: row.botId })),
    );
  });
  const findUnique = vi.fn(({ where }) => Promise.resolve(rows.get(where.id) ?? null));
  const create = vi.fn(({ data }: { data: { botId: string; intent?: string | null } }) => {
    const row = {
      id: 'started',
      botId: data.botId,
      state: 'RECORDING',
      intent: data.intent ?? null,
      startedAt: new Date(),
      endedAt: null,
      cdpAvailable: true,
      warning: null,
      error: null,
    } as Recording;
    rows.set(row.id, row);
    return Promise.resolve(row);
  });
  const skillDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const client = {
    recording: {
      findFirst: vi.fn(({ where }) => Promise.resolve({ ...rows.get(where.id)! })),
      findUnique,
      findMany,
      update,
      updateMany,
      create,
    },
    recordingEvent: { createMany, groupBy: vi.fn().mockResolvedValue([]) },
    skill: { findFirst: vi.fn().mockResolvedValue(null), deleteMany: skillDeleteMany },
    bot: { findFirst: vi.fn(() => Promise.resolve({ id: 'bot' })) },
  };
  const transaction = vi.fn((fn: (tx: typeof client) => Promise<unknown>) => fn(client));
  const prisma = {
    ...client,
    $transaction: transaction,
  } as unknown as PrismaService;
  const events = {
    emitRecordingEvent: vi.fn(),
    emitRecordingState: vi.fn(),
  } as unknown as TurnEventBus;
  // The lifecycle never sees a click screenshot: it settles rows, and
  // M3-BE-04 hangs entirely off the tee's write path.
  const screenshots = {
    capture: vi.fn().mockResolvedValue(null),
    forget: vi.fn(),
  } as unknown as ClickScreenshotService;
  const tee = new RecordingTeeService(prisma, events, screenshots);
  // M4-BE-01: the browser half of capture, faked to a recorder. This suite is
  // about WHEN the lifecycle attaches and detaches; how a CDP connection is
  // built is `cdp-attach.test.ts`, against a real socket.
  let unavailableListener: ((botId: string, recordingId: string) => void) | null = null;
  const cdp = {
    attach: vi.fn(),
    detach: vi.fn(() => Promise.resolve()),
    // M4-BE-07: the attach reports a recording that never got a CDP
    // connection (or lost it); the lifecycle records it on the row. Captured
    // here so a test can fire either moment the way the attach would.
    onUnavailable: vi.fn((listener: (botId: string, recordingId: string) => void) => {
      unavailableListener = listener;
    }),
  };
  // M4-BE-02: the capture rides on the attach's connection. This suite is
  // about WHEN the lifecycle arms and disarms it; how a page is actually
  // armed is `cdp-capture.test.ts`.
  const capture = {
    arm: vi.fn(),
    disarm: vi.fn(() => Promise.resolve()),
  };
  // §4.1's start wakes the computer through ensure-ready (D-039 §16); the
  // lease is what D-039 §17 hands over to the recording row.
  const computers = {
    ensureReady: vi.fn(() =>
      Promise.resolve({
        status: { state: 'RUNNING' },
        lease: { release: vi.fn(() => Promise.resolve()) },
      }),
    ),
  } as unknown as SandboxReadinessService;
  // §4.1's stop "enqueues compilation" (M3-BE-06). What is under test here is
  // the state machine around that hand-off, so the queue records rather than
  // runs: a real BullMQ queue would put Redis between these assertions and
  // the transition they are about.
  const enqueued: string[] = [];
  const compiles = {
    enqueue: vi.fn((recordingId: string) => {
      enqueued.push(recordingId);
      return queueControl.fail === null ? Promise.resolve() : Promise.reject(queueControl.fail);
    }),
    close: vi.fn(() => Promise.resolve()),
  };
  const queueControl = { fail: null as Error | null };
  // M4-BE-05: the pass the settle path runs between "capture ended" and
  // "COMPILING". The judgement is `click-correlator.test.ts`; what this suite
  // watches is WHEN the lifecycle runs it — so it records rather than pairs.
  const correlator = {
    correlate: vi.fn(() => Promise.resolve(0)),
  } as unknown as ClickCorrelatorService;
  const service = new RecordingsService(
    prisma,
    tee,
    cdp as unknown as CdpAttachService,
    capture as unknown as CdpCaptureService,
    correlator,
    computers,
    events,
    compiles,
  );
  const begin = (id: string) => {
    tee.reserve('bot');
    tee.begin('bot', id, new Date());
    tee.tee('bot', { kind: 'pointer', x: 1, y: 1, buttonMask: 0 });
  };
  /** Fire the report the attach sends for a recording with no CDP (M4-BE-07). */
  const fireCdpUnavailable = (botId: string, recordingId: string): void => {
    unavailableListener?.(botId, recordingId);
  };
  return {
    rows,
    createMany,
    findUnique,
    update,
    updateMany,
    skillDeleteMany,
    transaction,
    create,
    tee,
    service,
    begin,
    events,
    enqueued,
    compiles,
    queueControl,
    cdp,
    capture,
    computers,
    correlator,
    fireCdpUnavailable,
  };
}

describe('recording lifecycle isolation', () => {
  it('settles discard and removes every linked draft in one transaction', async () => {
    const { rows, service, update, skillDeleteMany, transaction } = setup();
    rows.get('old')!.state = 'READY';

    await service.discard('user', 'old');

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(skillDeleteMany).toHaveBeenCalledWith({
      where: { sourceRecordingId: 'old', status: 'DRAFT', bot: { userId: 'user' } },
    });
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(
      skillDeleteMany.mock.invocationCallOrder[0]!,
    );
    expect(rows.get('old')!.state).toBe('DISCARDED');
  });

  it('discarding an old recording leaves the current recording capturing', async () => {
    const { rows, service, tee, begin } = setup();
    rows.get('old')!.state = 'READY';
    begin('new');
    await service.discard('user', 'old');
    expect(tee.recordingIdOf('bot')).toBe('new');
    await tee.end('bot');
  });

  it('stopping a detached recording does not end a newer tee', async () => {
    const { service, tee, begin } = setup();
    begin('new');
    expect((await service.stop('user', 'old')).state).toBe('FAILED');
    expect(tee.recordingIdOf('bot')).toBe('new');
    await tee.end('bot');
  });

  it('reading an old recording does not flush the current trace', async () => {
    const { service, tee, begin, createMany } = setup();
    begin('new');
    await service.status('user', 'old');
    expect(createMany).not.toHaveBeenCalled();
    await tee.end('bot');
  });

  it('serializes stop and discard until the trace is durable', async () => {
    const { service, begin, createMany, update, rows } = setup();
    let release!: () => void;
    createMany.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    begin('old');
    const stopping = service.stop('user', 'old');
    await vi.waitFor(() => expect(createMany).toHaveBeenCalled());
    const discarding = service.discard('user', 'old');
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      expect(update).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await Promise.all([stopping, discarding]);
    expect(rows.get('old')!.state).toBe('DISCARDED');
  });

  it('does not call a detached trace READY after a failed state write', async () => {
    const { service, begin, createMany, update } = setup();
    begin('old');
    createMany.mockRejectedValueOnce(new Error('lost batch'));
    update.mockRejectedValueOnce(new Error('state write failed'));
    await expect(service.stop('user', 'old')).rejects.toThrow('state write failed');
    expect((await service.stop('user', 'old')).state).toBe('FAILED');
  });
});

/**
 * M3-BE-05 — the settle half of §6/M3's hard limits. The tee decides WHEN
 * capture stops (`recording-tee.test.ts`); this is what the row looks like
 * afterwards.
 */
describe('recording hard limits', () => {
  /** Drive the trace past the event ceiling with transitions nothing thins. */
  const fillPastCeiling = (tee: RecordingTeeService): void => {
    for (let i = 0; i < MAX_RECORDING_EVENTS; i += 1) {
      tee.tee('bot', { kind: 'pointer', x: i, y: 1, buttonMask: i % 2 });
    }
  };

  /**
   * The auto-stop is triggered from a socket frame, so nothing returns a
   * handle to await — the same reason the listener is fire-and-forget in the
   * service.
   */
  const drain = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 10));

  async function until(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 500; i += 1) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error('the recording was never settled');
  }

  it('stops itself at the event ceiling and says so on the row', async () => {
    const { rows, tee, begin } = setup();
    begin('new');

    fillPastCeiling(tee);
    await until(() => rows.get('new')!.state !== 'RECORDING');

    // §6/M3: "auto-stops and marks the recording READY with a warning". The
    // warning is written here, at the moment capture ends; READY is where the
    // compile settles it (M3-BE-06). A trace cut short by a ceiling is whole
    // up to where it stops, so it is worth compiling like any other — the
    // warning says which stopped it, not whether to bother.
    expect(rows.get('new')).toMatchObject({ state: 'COMPILING', warning: 'EVENT_LIMIT' });
    expect(rows.get('new')!.endedAt).not.toBeNull();
    // The slot is free: hitting a ceiling ends the recording, it does not
    // leave the bot unable to start another one.
    expect(tee.recordingIdOf('bot')).toBeNull();
  });

  it('tells the client, which is how it learns a stop it did not ask for', async () => {
    const { rows, tee, begin, events } = setup();
    begin('new');

    fillPastCeiling(tee);
    await until(() => rows.get('new')!.state !== 'RECORDING');

    expect(events.emitRecordingState).toHaveBeenCalledWith('bot', 'new', 'COMPILING');
  });

  it('fails a recording it cannot queue, rather than leaving it COMPILING', async () => {
    const { service, rows, queueControl, begin } = setup();
    begin('new');
    queueControl.fail = new Error('skill compilation needs a job queue, and REDIS_URL is not set');

    const status = await service.stop('user', 'new');

    // A COMPILING row with nothing behind it is a state nothing can advance,
    // which reads to the UI as a recording stuck forever. §6 asks for the
    // other outcome — "a FAILED recording with a readable error" — and the
    // reason is what tells an operator this is their deployment, not their
    // recording.
    expect(status.state).toBe('FAILED');
    expect(status.error).toMatch(/REDIS_URL/);
    expect(rows.get('new')).toMatchObject({ state: 'FAILED' });
  });

  it('dates a recording by when capture ended, not by when it stopped failing', async () => {
    vi.useFakeTimers();
    try {
      const { service, rows, compiles, begin } = setup();
      begin('new');
      const capturedUntil = Date.now();
      // Half a minute passes between capture ending and the queue refusing —
      // short of M3-BE-05's twenty-minute deadline, long enough to tell the
      // two clocks apart.
      compiles.enqueue.mockImplementation(() => {
        vi.setSystemTime(capturedUntil + 30_000);
        return Promise.reject(new Error('no queue'));
      });

      await service.stop('user', 'new');

      // A recording now passes through two settlements on its way to a
      // terminal state — COMPILING, then READY or FAILED — and `endedAt` says
      // when the PERSON stopped demonstrating. Re-dating it on the second
      // would make every recording look as long as its compile took.
      expect(rows.get('new')!.endedAt?.getTime()).toBe(capturedUntil);
      expect(rows.get('new')!.error).toBe('no queue');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a recording that ran out of budget to the compiler like any other', async () => {
    const { tee, begin, rows, enqueued } = setup();
    begin('new');

    fillPastCeiling(tee);
    await until(() => rows.get('new')!.state !== 'RECORDING');

    // The alternative — a ceiling that stops at READY without compiling —
    // would make the limits the one way to teach a task that never becomes a
    // skill, which is the opposite of what bounding a recording is for.
    expect(enqueued).toEqual(['new']);
  });

  it('leaves a recording the operator stopped first exactly as they left it', async () => {
    const { rows, service, tee, begin, update } = setup();
    begin('new');

    // The operator's stop is already in the transition chain when the last
    // frame crosses the ceiling, so the auto-stop queues behind it and finds
    // the row settled. Whichever gets there first is the real one; a second
    // settle would move `endedAt` and overwrite a state a user action chose.
    const stopping = service.stop('user', 'new');
    fillPastCeiling(tee);
    expect((await stopping).state).toBe('COMPILING');
    const settledAt = rows.get('new')!.endedAt;
    const writes = update.mock.calls.length;
    await drain();

    expect(rows.get('new')).toMatchObject({ state: 'COMPILING', warning: null });
    expect(rows.get('new')!.endedAt).toBe(settledAt);
    expect(update.mock.calls).toHaveLength(writes);
  });

  it('keeps why a recording stopped itself when its trace is discarded', async () => {
    const { rows, service, tee, begin } = setup();
    begin('new');

    fillPastCeiling(tee);
    await until(() => rows.get('new')!.state !== 'RECORDING');
    await service.discard('user', 'new');

    // Discarding settles an already settled row. Wiping the reason while
    // deleting the trace erases the answer to the only question left about it.
    expect(rows.get('new')).toMatchObject({ state: 'DISCARDED', warning: 'EVENT_LIMIT' });
  });

  it('does not call a trace with a hole in it READY because it hit a ceiling', async () => {
    const { rows, tee, begin, createMany } = setup();
    begin('new');
    createMany.mockRejectedValue(new Error('database down'));

    fillPastCeiling(tee);
    await until(() => rows.get('new')!.state !== 'RECORDING');

    // The ceiling explains where the trace ends; it says nothing about the
    // events that never reached Postgres in the middle of it (M3-BE-01).
    expect(rows.get('new')).toMatchObject({ state: 'FAILED', warning: 'EVENT_LIMIT' });
  });

  it('releases the capture slot when durable auto-stop settlement cannot start', async () => {
    const { rows, tee, begin, findUnique } = setup();
    begin('new');
    findUnique.mockRejectedValueOnce(new Error('database unavailable'));

    fillPastCeiling(tee);
    await until(() => tee.recordingIdOf('bot') === null);

    // The durable row remains for bootstrap recovery, but the dead in-memory
    // slot must not block another recording for the rest of this process.
    expect(rows.get('new')).toMatchObject({ state: 'RECORDING', warning: null });
    expect(tee.reserve('bot')).toBe(true);
    tee.abandon('bot');
  });
});

/**
 * M3-BE-06 — the boot pass over rows a dead process left `COMPILING`.
 *
 * The row sits between "settled" and "enqueued", and `finishCapture` cannot
 * make those one transaction; the job can also have been lost with Redis.
 * Without the sweep nothing re-enqueues, and the row reads to the UI as a
 * compile stuck forever.
 */
describe('stranded compilations', () => {
  it('re-queues a recording left COMPILING by a process that is gone', async () => {
    const { service, rows, enqueued } = setup();
    rows.get('old')!.state = 'COMPILING';

    const requeued = await service.recoverStrandedCompilations();

    // The job id is the recording id, so re-adding is safe even when the job
    // is still in Redis: the duplicate dedupes and the existing job does the
    // work.
    expect(requeued).toBe(1);
    expect(enqueued).toEqual(['old']);
    expect(rows.get('old')!.state).toBe('COMPILING');
  });

  it('settles a stranded recording FAILED when the queue refuses it', async () => {
    const { service, rows, queueControl, events } = setup();
    rows.get('old')!.state = 'COMPILING';
    queueControl.fail = new Error('skill compilation needs a job queue, and REDIS_URL is not set');

    await service.recoverStrandedCompilations();

    // A row nothing can advance reads as stuck forever; §6 asks for the other
    // outcome, with the reason a person can act on (D-044).
    expect(rows.get('old')).toMatchObject({ state: 'FAILED' });
    expect(rows.get('old')!.error).toMatch(/REDIS_URL/);
    expect(events.emitRecordingState).toHaveBeenCalledWith('bot', 'old', 'FAILED');
  });

  it('leaves recordings that are not COMPILING alone', async () => {
    const { service, enqueued, rows } = setup();

    await service.recoverStrandedCompilations();

    expect(enqueued).toEqual([]);
    expect(rows.get('old')!.state).toBe('RECORDING');
  });
});

/**
 * M4-BE-01 — the lifecycle's half of the CDP attach.
 *
 * The attach/detach mechanics live in `cdp-attach.test.ts`; this is the
 * wiring that would regress silently — a lifecycle that never attaches, or
 * settles without detaching, fails no test that only knows about the service.
 * Every path that ends a recording is covered, because a layer left attached
 * is not a small leak: its events land in a settled row, or its socket
 * outlives the recording entirely.
 */
describe('recording CDP attach (M4-BE-01)', () => {
  it('attaches for the recording the row names, and detaches before it is settled', async () => {
    const { service, cdp, tee, update } = setup();

    const { recordingId } = await service.start('user', 'bot', { intent: 'open settings' });

    expect(recordingId).toBe('started');
    expect(cdp.attach).toHaveBeenCalledWith('bot', 'started');
    expect(tee.recordingIdOf('bot')).toBe('started');

    const status = await service.stop('user', 'started');

    expect(cdp.detach).toHaveBeenCalledWith('bot', 'started');
    // Ended before the row was settled: settling first would leave a live
    // layer feeding a recording that is already over.
    expect(cdp.detach.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0]!,
    );
    expect(status.state).toBe('COMPILING');
  });

  it('detaches when a ceiling stops capture, exactly as an operator stop would', async () => {
    const { cdp, tee, begin } = setup();
    begin('new');

    for (let i = 0; i < MAX_RECORDING_EVENTS; i += 1) {
      tee.tee('bot', { kind: 'pointer', x: i, y: 1, buttonMask: i % 2 });
    }
    await vi.waitFor(() => {
      expect(cdp.detach).toHaveBeenCalledWith('bot', 'new');
    });
  });

  it('detaches on discard, so a thrown-away trace leaves nothing attached', async () => {
    const { service, cdp, begin } = setup();
    begin('new');

    await service.discard('user', 'new');

    expect(cdp.detach).toHaveBeenCalledWith('bot', 'new');
  });

  it('detaches what it attached when the start itself fails', async () => {
    const { service, cdp, events } = setup();
    vi.mocked(events.emitRecordingState).mockImplementationOnce(() => {
      throw new Error('bus failed');
    });

    await expect(service.start('user', 'bot', {})).rejects.toThrow('bus failed');

    // The attach is fire-and-forget and may still be connecting; the catch
    // has to drop it by bot because the row a recordingId would name is the
    // thing that failed.
    expect(cdp.attach).toHaveBeenCalledWith('bot', 'started');
    expect(cdp.detach).toHaveBeenCalledWith('bot');
  });
});

/**
 * M4-BE-02 — the lifecycle's half of the capture.
 *
 * The arming mechanics live in `cdp-capture.test.ts`; this is the wiring a
 * refactor drops silently — a lifecycle that never arms, or settles a row
 * with the capture still installed. The order matters at the seam: the
 * capture is disarmed BEFORE the attach closes the socket, because removing
 * a page's registration is a command and there is nothing left to send it
 * over once the socket is gone.
 */
describe('recording CDP capture (M4-BE-02)', () => {
  it('arms the capture for the recording the row names', async () => {
    const { service, capture } = setup();

    const { recordingId } = await service.start('user', 'bot', { intent: 'open settings' });

    expect(recordingId).toBe('started');
    expect(capture.arm).toHaveBeenCalledWith('bot', 'started');
  });

  it('disarms the capture before the attach closes the socket and before the row settles', async () => {
    const { service, capture, cdp, update } = setup();
    await service.start('user', 'bot', {});

    const status = await service.stop('user', 'started');

    expect(capture.disarm).toHaveBeenCalledWith('bot', 'started');
    // Disarm, then detach, then settle: the registrations are removed while
    // the connection is still open, and no settle runs with capture live.
    expect(capture.disarm.mock.invocationCallOrder[0]).toBeLessThan(
      cdp.detach.mock.invocationCallOrder[0]!,
    );
    expect(capture.disarm.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0]!,
    );
    expect(status.state).toBe('COMPILING');
  });

  it('disarms when a ceiling stops capture, exactly as an operator stop would', async () => {
    const { capture, tee, begin } = setup();
    begin('new');

    for (let i = 0; i < MAX_RECORDING_EVENTS; i += 1) {
      tee.tee('bot', { kind: 'pointer', x: i, y: 1, buttonMask: i % 2 });
    }
    await vi.waitFor(() => {
      expect(capture.disarm).toHaveBeenCalledWith('bot', 'new');
    });
  });

  it('disarms on discard, so a thrown-away trace leaves nothing installed', async () => {
    const { service, capture, begin } = setup();
    begin('new');

    await service.discard('user', 'new');

    expect(capture.disarm).toHaveBeenCalledWith('bot', 'new');
  });

  it('disarms when the start itself fails, before the attach closes the socket', async () => {
    const { service, capture, events, cdp } = setup();
    vi.mocked(events.emitRecordingState).mockImplementationOnce(() => {
      throw new Error('bus failed');
    });

    await expect(service.start('user', 'bot', {})).rejects.toThrow('bus failed');

    // Both fire-and-forget, in order: the capture's registrations come out
    // while the socket is still open, then the attach closes it.
    expect(capture.disarm).toHaveBeenCalledWith('bot');
    await vi.waitFor(() => {
      expect(cdp.detach).toHaveBeenCalledWith('bot');
    });
    expect(capture.disarm.mock.invocationCallOrder[0]).toBeLessThan(
      cdp.detach.mock.invocationCallOrder[0]!,
    );
  });
});

/**
 * M4-BE-07 — the lifecycle's half of §6/M4's degradation clause.
 *
 * The attach reports a recording that never got a CDP connection (or lost
 * one mid-recording); the row records it as `cdpAvailable = false` and
 * nothing else changes. What the report looks like from the attach's side is
 * `cdp-attach.test.ts`; this is the write.
 */
describe('recording CDP degradation (M4-BE-07)', () => {
  it('flips cdpAvailable false with nothing else on the row, and emits nothing', async () => {
    const { service, rows, fireCdpUnavailable, updateMany, events } = setup();
    const { recordingId } = await service.start('user', 'bot', {});
    expect(rows.get(recordingId)!.cdpAvailable).toBe(true);
    const before = { ...rows.get(recordingId)! };
    // `start` emits the row's initial state; a degradation must add no frame
    // of its own to the bus.
    const emitted = vi.mocked(events.emitRecordingState).mock.calls.length;

    fireCdpUnavailable('bot', recordingId);
    await vi.waitFor(() => {
      expect(rows.get(recordingId)!.cdpAvailable).toBe(false);
    });

    // Compare-and-set pinned to the value it flips, so the write can only
    // ever move true -> false.
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: recordingId, cdpAvailable: true },
      data: { cdpAvailable: false },
    });
    // A degradation is a mode, not a state: the row keeps capturing, keeps
    // its reasons empty, and nothing is pushed to the operator (§4.2's
    // `recording.state` carries states, not flags).
    const after = rows.get(recordingId)!;
    expect(after.state).toBe('RECORDING');
    expect(after.warning).toBeNull();
    expect(after.error ?? null).toBeNull();
    expect(after.endedAt).toBeNull();
    expect(after.startedAt).toBe(before.startedAt);
    expect(vi.mocked(events.emitRecordingState).mock.calls.length).toBe(emitted);
  });

  it('cannot flip twice, and never moves a flag that is already false', async () => {
    const { service, rows, fireCdpUnavailable, updateMany } = setup();
    const { recordingId } = await service.start('user', 'bot', {});

    fireCdpUnavailable('bot', recordingId);
    await vi.waitFor(() => expect(rows.get(recordingId)!.cdpAvailable).toBe(false));
    const calls = updateMany.mock.calls.length;

    // A second report — a retried close, both failure moments — matches
    // nothing, because the row no longer carries the value it flips.
    fireCdpUnavailable('bot', recordingId);
    await vi.waitFor(() => expect(updateMany.mock.calls.length).toBe(calls + 1));
    expect(rows.get(recordingId)!.cdpAvailable).toBe(false);
  });

  it('swallows a failed write — the flag is a hint, and the recording must not notice', async () => {
    const { service, rows, fireCdpUnavailable, updateMany } = setup();
    const { recordingId } = await service.start('user', 'bot', {});
    updateMany.mockRejectedValueOnce(new Error('database unavailable'));

    // Not thrown into the caller: the attach calls this from its own failure
    // path, which is documented never to reject into the recording.
    expect(() => fireCdpUnavailable('bot', recordingId)).not.toThrow();
    await vi.waitFor(() => expect(updateMany).toHaveBeenCalled());

    // The recording stays perfectly readable, and the row keeps the value it
    // had — a lost hint rather than a corrupted row.
    await expect(service.status('user', recordingId)).resolves.toMatchObject({
      state: 'RECORDING',
    });
    expect(rows.get(recordingId)!.cdpAvailable).toBe(true);
  });
});

/**
 * M4-BE-05 — the lifecycle's half of the correlator: WHEN the pass runs.
 *
 * The judgement is `click-correlator.test.ts`, the durable write is
 * `click-correlator.integration.test.ts`; here it is a recorder, because what
 * needs fencing is the order: a trace is correlated between "capture ended"
 * and "COMPILING", so no compiler can ever be handed an unmarked one (§6/M4:
 * "the compiler must not emit both").
 */
describe('recording click correlation (M4-BE-05)', () => {
  it('correlates the trace before the compiler is told to look at it', async () => {
    const { service, begin, correlator, compiles } = setup();
    begin('old');

    await service.stop('user', 'old');

    expect(correlator.correlate).toHaveBeenCalledWith('old');
    expect(vi.mocked(correlator.correlate).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(compiles.enqueue).mock.invocationCallOrder[0]!,
    );
  });

  it('waits for the pass — a slow correlation holds the settle, it does not race it', async () => {
    const { service, begin, correlator, rows, enqueued } = setup();
    begin('old');
    let releaseCorrelation!: (count: number) => void;
    vi.mocked(correlator.correlate).mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          releaseCorrelation = resolve;
        }),
    );

    const stopping = service.stop('user', 'old');
    await vi.waitFor(() => expect(correlator.correlate).toHaveBeenCalled());

    // While the pass is in flight the row is still the capture's: not
    // COMPILING yet, and nothing in the compile queue.
    expect(rows.get('old')!.state).toBe('RECORDING');
    expect(enqueued).toEqual([]);

    releaseCorrelation(2);
    const settled = await stopping;
    expect(settled.state).toBe('COMPILING');
    expect(enqueued).toEqual(['old']);
  });

  it('skips a trace with a hole — it never reaches the compiler, so there is nothing to correlate', async () => {
    const { service, begin, correlator, createMany } = setup();
    begin('old');
    createMany.mockRejectedValueOnce(new Error('the database refused the batch'));

    const settled = await service.stop('user', 'old');

    expect(settled.state).toBe('FAILED');
    expect(correlator.correlate).not.toHaveBeenCalled();
  });
});
