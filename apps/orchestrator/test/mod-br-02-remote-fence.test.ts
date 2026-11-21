import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SeatControl, type RemoteSeatLease } from '../src/screen/seat-control.js';

const human = {};
const bot = 'bot';
function fixture() {
  let acknowledge!: (lease: RemoteSeatLease) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<RemoteSeatLease>((resolve, fail) => {
    acknowledge = resolve;
    reject = fail;
  });
  const remote = { renew: vi.fn(async () => undefined), release: vi.fn(async () => undefined) };
  const io = {
    prepareHuman: vi.fn(() => pending),
    forward: vi.fn(),
    broadcast: vi.fn(),
    refuse: vi.fn(),
  };
  const seats = new SeatControl(io, { drainMs: 50, leaseMs: 300, agentWaitMs: 500 });
  const take = () => seats.control(human, bot, { botId: bot, action: 'take' });
  return { seats, take, io, acknowledge, reject, remote };
}

describe('sandbox acknowledgement fences local human control', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a fresh server with no local in-flight count still waits for the sandbox', async () => {
    const { seats, take, acknowledge, remote } = fixture();
    const pending = take();
    expect(seats.stateFor(human, bot).mode).toBe('draining');
    expect(seats.input(human, bot, { kind: 'key', keysym: 65, down: true }, 1)?.code).toBe(
      'NOT_CONTROLLER',
    );
    acknowledge(remote);
    await pending;
    expect(seats.stateFor(human, bot)).toMatchObject({ mode: 'human', holder: 'self', epoch: 1 });
    seats.dispose();
  });

  it('a late acknowledgement after disconnect only releases its own token', async () => {
    const { seats, take, acknowledge, remote } = fixture();
    const pending = take();
    seats.detached(human);
    acknowledge(remote);
    await pending;
    expect(seats.stateFor(human, bot).mode).toBe('agent');
    expect(remote.release).toHaveBeenCalledOnce();
    seats.dispose();
  });

  it('a remote drain that exceeds the local deadline never grants control', async () => {
    const { seats, take, acknowledge, remote, io } = fixture();
    const pending = take();
    await vi.advanceTimersByTimeAsync(50);
    acknowledge(remote);
    await pending;
    expect(seats.stateFor(human, bot).mode).toBe('agent');
    expect(remote.release).toHaveBeenCalledOnce();
    expect(io.refuse).toHaveBeenCalledWith(
      human,
      bot,
      expect.objectContaining({ code: 'DRAIN_TIMEOUT' }),
    );
    seats.dispose();
  });

  it('a bridge that cannot acknowledge fails closed', async () => {
    const { seats, take, reject, io } = fixture();
    const pending = take();
    reject(new Error('unreachable'));
    await pending;
    expect(seats.stateFor(human, bot).mode).toBe('agent');
    expect(io.refuse).toHaveBeenCalledWith(
      human,
      bot,
      expect.objectContaining({ code: 'SEAT_UNAVAILABLE' }),
    );
    seats.dispose();
  });

  it('renewal cannot extend the local lease while its remote reply is pending', async () => {
    const { seats, take, acknowledge, remote } = fixture();
    const pending = take();
    acknowledge(remote);
    await pending;
    const expires = seats.stateFor(human, bot);
    let complete!: () => void;
    remote.renew.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(200);
    const renewing = seats.control(human, bot, { botId: bot, action: 'renew', epoch: 1 });
    expect(seats.stateFor(human, bot)).toEqual(expires);
    await vi.advanceTimersByTimeAsync(100);
    expect(seats.stateFor(human, bot).mode).toBe('agent');
    complete();
    await renewing;
    expect(seats.stateFor(human, bot).mode).toBe('agent');
    expect(remote.release).toHaveBeenCalledOnce();
    seats.dispose();
  });
});
