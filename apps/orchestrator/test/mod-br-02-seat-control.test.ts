import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SeatControl, type SeatIo } from '../src/screen/seat-control.js';
import { readSeatControlConfig } from '../src/screen/seat-control.service.js';
import { withSeatAdmission, SEAT_TOOL_KINDS } from '../src/agent/seat-admission.js';
import { browserTools } from '../src/agent/browser-tools.js';
import type { ToolContext } from '../src/agent/tool-registry.js';

const bot = 'bot';
const human = {};
const observer = {};
function fixture() {
  const io = { forward: vi.fn(), broadcast: vi.fn(), refuse: vi.fn() } satisfies SeatIo;
  const seats = new SeatControl(io, { drainMs: 50, leaseMs: 300, agentWaitMs: 500 });
  seats.observed(bot);
  return { seats, io };
}
const take = (seats: SeatControl, socket = human) =>
  seats.control(socket, bot, { botId: bot, action: 'take' });
const release = (seats: SeatControl, socket = human) =>
  seats.control(socket, bot, {
    botId: bot,
    action: 'release',
    epoch: seats.stateFor(socket, bot).epoch,
  });

describe('seat control authority', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('drains actions before a login transition and blocks later actions until it finishes', async () => {
    const { seats } = fixture();
    const running = await seats.admit(bot, 'targeted');
    let transitioned = false;
    const transition = seats.admit(bot, 'exclusive').then((value) => {
      transitioned = true;
      return value;
    });
    let acted = false;
    const later = seats.admit(bot, 'targeted').then((value) => {
      acted = true;
      return value;
    });
    await Promise.resolve();
    expect(transitioned).toBe(false);
    expect(acted).toBe(false);
    if (running.ok) running.release();
    const exclusive = await transition;
    expect(exclusive.ok).toBe(true);
    expect(acted).toBe(false);
    expect(seats.admitRecordingStart(bot).ok).toBe(false);
    // A completed replacement invalidates the old observation before waiters wake.
    seats.seatEnded(bot);
    if (exclusive.ok) exclusive.release();
    expect(await later).toMatchObject({ ok: false, refusal: { code: 'OBSERVATION_REQUIRED' } });
  });

  it('cancelling a waiting transition does not strand other actions or teaching', async () => {
    const { seats } = fixture();
    const running = await seats.admit(bot, 'targeted');
    const abort = new AbortController();
    const transition = seats.admit(bot, 'exclusive', abort.signal);
    const later = seats.admit(bot, 'targeted');
    abort.abort();
    expect((await transition).ok).toBe(false);
    const action = await later;
    expect(action.ok).toBe(true);
    const recording = seats.admitRecordingStart(bot);
    expect(recording.ok).toBe(true);
    if (recording.ok) recording.release();
    if (action.ok) action.release();
    if (running.ok) running.release();
  });

  it('recording startup drains before a transition and human takeover drains that transition', async () => {
    const { seats } = fixture();
    const recording = seats.admitRecordingStart(bot);
    let settled = false;
    const transition = seats.admitIdentityRelease(bot).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    if (recording.ok) recording.release();
    const exclusive = await transition;
    expect(exclusive.ok).toBe(true);
    take(seats);
    expect(seats.stateFor(human, bot).mode).toBe('draining');
    if (exclusive.ok) exclusive.release();
    expect(seats.stateFor(human, bot).mode).toBe('human');
    release(seats);
    const operatorRelease = await seats.admitIdentityRelease(bot);
    expect(operatorRelease.ok).toBe(true);
    if (operatorRelease.ok) operatorRelease.release();
    expect(await seats.admit(bot, 'exclusive')).toMatchObject({
      ok: false,
      refusal: { code: 'OBSERVATION_REQUIRED' },
    });
  });

  it('drains a slow action before granting human control and closes new admission', async () => {
    const { seats } = fixture();
    const first = await seats.admit(bot, 'targeted');
    expect(first.ok).toBe(true);
    take(seats);
    expect(seats.stateFor(human, bot).mode).toBe('draining');
    let started = false;
    const pending = seats.admit(bot, 'untargeted').then((x) => {
      started = true;
      return x;
    });
    if (first.ok) first.release();
    expect(seats.stateFor(human, bot)).toMatchObject({ mode: 'human', epoch: 1, holder: 'self' });
    await Promise.resolve();
    expect(started).toBe(false);
    release(seats);
    expect(await pending).toMatchObject({ ok: false, refusal: { code: 'OBSERVATION_REQUIRED' } });
  });

  it('refuses an undrained takeover without claiming exclusivity', async () => {
    const { seats, io } = fixture();
    const action = await seats.admit(bot, 'targeted');
    take(seats);
    await vi.advanceTimersByTimeAsync(50);
    expect(seats.stateFor(human, bot).mode).toBe('agent');
    expect(io.refuse).toHaveBeenCalledWith(
      human,
      bot,
      expect.objectContaining({ code: 'DRAIN_TIMEOUT' }),
    );
    if (action.ok) action.release();
    expect(seats.stateFor(human, bot).mode).toBe('agent');
  });

  it('refuses observer input and duplicate or stale control without stealing a lease', () => {
    const { seats, io } = fixture();
    take(seats);
    const epoch = seats.stateFor(human, bot).epoch;
    take(seats, observer);
    take(seats);
    expect(seats.stateFor(human, bot).epoch).toBe(epoch);
    expect(seats.input(observer, bot, { kind: 'key', keysym: 65, down: true }, 1)).toMatchObject({
      code: 'NOT_CONTROLLER',
    });
    seats.control(human, bot, { botId: bot, action: 'release', epoch: epoch - 1 });
    expect(io.refuse).toHaveBeenLastCalledWith(
      human,
      bot,
      expect.objectContaining({ code: 'STALE_EPOCH' }),
    );
    expect(seats.stateFor(observer, bot).holder).toBe('other');
    release(seats);
    expect(seats.input(human, bot, { kind: 'key', keysym: 65, down: true }, 1)).toMatchObject({
      code: 'NOT_CONTROLLER',
    });
  });

  it.each(['targeted', 'untargeted'] as const)(
    'requires a fresh observation for %s actions after hand-back',
    async (kind) => {
      const { seats } = fixture();
      take(seats);
      release(seats);
      expect(await seats.admit(bot, kind)).toMatchObject({
        ok: false,
        refusal: { code: 'OBSERVATION_REQUIRED' },
      });
      seats.beginObservation(bot)();
      const admitted = await seats.admit(bot, kind);
      expect(admitted.ok).toBe(true);
      if (admitted.ok) admitted.release();
    },
  );

  it('cannot clear freshness with an observation begun before takeover or during human control', () => {
    const { seats } = fixture();
    const oldRead = seats.beginObservation(bot);
    take(seats);
    const humanRead = seats.beginObservation(bot);
    release(seats);
    oldRead();
    humanRead();
    expect(seats.stateFor(human, bot).observationRequired).toBe(true);
    seats.beginObservation(bot)();
    expect(seats.stateFor(human, bot).observationRequired).toBe(false);
  });

  it('rechecks authority after waking when another holder immediately takes the seat', async () => {
    const { seats } = fixture();
    take(seats);
    let settled = false;
    const pending = seats.admit(bot, 'targeted').then((x) => {
      settled = true;
      return x;
    });
    release(seats);
    seats.observed(bot);
    take(seats, observer);
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(await pending).toMatchObject({ ok: false, refusal: { code: 'OBSERVATION_REQUIRED' } });
  });

  it('times out human-held waits and aborts waits without executing', async () => {
    const { seats } = fixture();
    take(seats);
    const abort = new AbortController();
    const cancelled = seats.admit(bot, 'targeted', abort.signal);
    abort.abort();
    expect((await cancelled).ok).toBe(false);
    // Keep the human lease alive beyond the agent wait deadline.
    const wait = seats.admit(bot, 'targeted');
    await vi.advanceTimersByTimeAsync(250);
    seats.control(human, bot, { botId: bot, action: 'renew', epoch: 1 });
    await vi.advanceTimersByTimeAsync(250);
    expect(await wait).toMatchObject({ ok: false, refusal: { code: 'HUMAN_IN_CONTROL' } });
    release(seats);
    expect((await seats.admit(bot, 'untargeted', abort.signal)).ok).toBe(false);
  });

  it.each(['detached', 'unsubscribed', 'seatEnded', 'expired', 'dispose'])(
    'releases held input on %s',
    async (how) => {
      const { seats, io } = fixture();
      take(seats);
      seats.input(human, bot, { kind: 'key', keysym: 0xffe1, down: true }, 1);
      seats.input(human, bot, { kind: 'pointer', buttonMask: 1, x: 12, y: 34 }, 1);
      if (how === 'detached') seats.detached(human);
      else if (how === 'unsubscribed') seats.unsubscribed(human, bot);
      else if (how === 'seatEnded') seats.seatEnded(bot);
      else if (how === 'dispose') seats.dispose();
      else await vi.advanceTimersByTimeAsync(300);
      expect(io.forward.mock.calls.map(([, bytes]) => [...bytes])).toEqual([
        [4, 0, 0, 0, 0, 0, 255, 225],
        [5, 0, 0, 12, 0, 34],
      ]);
      expect(seats.stateFor(human, bot)).toMatchObject({
        mode: 'agent',
        observationRequired: true,
      });
    },
  );

  it('cancels a draining take when its socket leaves', async () => {
    const { seats } = fixture();
    const action = await seats.admit(bot, 'targeted');
    take(seats);
    seats.detached(human);
    if (action.ok) action.release();
    expect(seats.stateFor(human, bot).mode).toBe('agent');
    await vi.advanceTimersByTimeAsync(50);
    expect(seats.stateFor(human, bot).mode).toBe('agent');
  });

  it('refuses delayed input from the same socket after it reacquires control', () => {
    const { seats } = fixture();
    take(seats);
    release(seats);
    seats.observed(bot);
    take(seats);
    expect(seats.input(human, bot, { kind: 'key', down: true, keysym: 65 }, 1)).toMatchObject({
      code: 'STALE_EPOCH',
    });
    expect(seats.input(human, bot, { kind: 'key', down: true, keysym: 65 }, 3)).toBeNull();
  });

  it('releases modifiers on first contact and again after a lost display', () => {
    const { seats, io } = fixture();
    seats.firstContact(bot);
    seats.firstContact(bot);
    expect(io.forward).toHaveBeenCalledTimes(11);
    seats.seatEnded(bot);
    seats.firstContact(bot);
    expect(io.forward).toHaveBeenCalledTimes(22);
  });

  it.each(Object.entries(SEAT_TOOL_KINDS).filter(([, kind]) => kind !== 'observation'))(
    'gates the %s tool at execution',
    async (name) => {
      const { seats } = fixture();
      take(seats);
      const execute = vi.fn(() => 'ran');
      const tools = withSeatAdmission(
        { [name]: { execute, description: '', inputSchema: {} as never } },
        {
          admit: (kind, signal) => seats.admit(bot, kind, signal),
          beginObservation: () => seats.beginObservation(bot),
        },
      );
      const call = tools[name]?.execute;
      if (typeof call !== 'function') throw new Error('missing execute');
      const waiting = call({}, { toolCallId: 'call', messages: [] });
      await vi.advanceTimersByTimeAsync(300);
      expect(await waiting).toContain('OBSERVATION_REQUIRED');
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('a failed browser_read does not clear the observation requirement', async () => {
    const { seats } = fixture();
    take(seats);
    release(seats);
    const context = {
      userId: 'user',
      botId: bot,
      messageId: 'msg',
      trigger: { id: 'msg', chainId: null, hopCount: 0 },
      browser: async () => {
        throw new Error('read unavailable');
      },
      session: async () => {
        throw new Error('unused');
      },
      useIdentity: async () => {
        throw new Error('unused');
      },
      seat: {
        admit: (kind, signal) => seats.admit(bot, kind, signal),
        beginObservation: () => seats.beginObservation(bot),
      },
    } satisfies ToolContext;
    const tool = browserTools()
      .find((x) => x.name === 'browser_read')
      ?.build(context);
    if (typeof tool?.execute !== 'function') throw new Error('missing read');
    expect(await tool.execute({}, { toolCallId: 'read', messages: [] })).toContain('read failed');
    expect(seats.stateFor(human, bot).observationRequired).toBe(true);
  });

  it('validates boot configuration instead of scheduling an overflowing timer', () => {
    expect(readSeatControlConfig({})).toMatchObject({
      drainMs: 5000,
      leaseMs: 30000,
      agentWaitMs: 120000,
    });
    expect(() => readSeatControlConfig({ SEAT_CONTROL_LEASE_MS: '10000' })).toThrow();
    expect(() => readSeatControlConfig({ SEAT_CONTROL_DRAIN_MS: '2147483648' })).toThrow();
  });
});
