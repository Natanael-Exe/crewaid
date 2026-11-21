import { describe, expect, it, vi } from 'vitest';
import type { SandboxStatusResponse } from '@crewaid/shared';
import {
  createTurnComputer,
  type TurnComputer,
  type TurnReadinessPort,
} from '../src/agent/turn-computer.js';
import * as turnComputerModule from '../src/agent/turn-computer.js';

/**
 * M5-BE-14 — when a turn wakes a computer, and when it must not.
 *
 * The readiness path itself is M3-BE-11's and is tested there. What is new
 * here is the POLICY: laziness, one wake per turn, a lease released on every
 * exit, and a capacity refusal that does not poison the rest of the turn.
 */

const RUNNING = { state: 'RUNNING' } as unknown as SandboxStatusResponse;

function fakeReadiness(options: { failWith?: Error; delayMs?: number } = {}) {
  const released: number[] = [];
  let calls = 0;
  const port: TurnReadinessPort = {
    ensureReady: async (_userId, _botId, owner) => {
      calls += 1;
      const n = calls;
      if (options.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      if (options.failWith !== undefined) throw options.failWith;
      return {
        status: RUNNING,
        lease: {
          owner,
          renew: async () => undefined,
          release: async () => void released.push(n),
        } as never,
      };
    },
  };
  return { port, released, calls: () => calls };
}

function computerWith(readiness: TurnReadinessPort) {
  return createTurnComputer({ readiness, userId: 'usr_1', botId: 'bot_1' });
}

describe('M5-BE-14 a text-only turn starts nothing', () => {
  it('never reaches the readiness path when no tool asks', async () => {
    // The case most turns are. Waking a container for a question-and-answer
    // costs 2 GiB and seconds of host budget, and under D-046 it is spent on
    // behalf of every bot attached to that computer.
    const readiness = fakeReadiness();
    const computer = computerWith(readiness.port);

    await computer.dispose();

    expect(readiness.calls()).toBe(0);
    expect(computer.wasRequested()).toBe(false);
  });
});

describe('M5-BE-14 the computer is woken once per turn', () => {
  it('collapses concurrent asks onto one readiness request', async () => {
    // A step can call several tools at once and all of them want the same
    // desktop. Five acquisitions would be five leases to release.
    const readiness = fakeReadiness({ delayMs: 20 });
    const computer = computerWith(readiness.port);

    const results = await Promise.all([
      computer.ensure(),
      computer.ensure(),
      computer.ensure(),
      computer.ensure(),
      computer.ensure(),
    ]);

    expect(readiness.calls()).toBe(1);
    expect(results.every((r) => r === RUNNING)).toBe(true);
    expect(computer.wasRequested()).toBe(true);
  });

  it('reuses the settled computer for a later step', async () => {
    const readiness = fakeReadiness();
    const computer = computerWith(readiness.port);

    await computer.ensure();
    await computer.ensure();

    expect(readiness.calls()).toBe(1);
  });
});

describe('M5-BE-14 the lease is released on every exit', () => {
  it('releases on dispose', async () => {
    const readiness = fakeReadiness();
    const computer = computerWith(readiness.port);
    await computer.ensure();

    await computer.dispose();

    expect(readiness.released).toEqual([1]);
  });

  it('releases exactly once when dispose is called twice', async () => {
    // The turn's `finally` is the only caller today, but a second release
    // would hand the lease service an owner it has already forgotten.
    const readiness = fakeReadiness();
    const computer = computerWith(readiness.port);
    await computer.ensure();

    await computer.dispose();
    await computer.dispose();

    expect(readiness.released).toEqual([1]);
  });

  it('releases a lease that arrived after the turn was already disposed', async () => {
    // Cancellation during the wake. Nothing will call dispose again, so the
    // lease this readiness call is about to return is released here or never
    // — and a lease nobody released pins the container until its bound
    // expires.
    const readiness = fakeReadiness({ delayMs: 30 });
    const computer = computerWith(readiness.port);

    const pending = computer.ensure();
    await computer.dispose();

    await expect(pending).rejects.toThrow(/cancelled/);
    expect(readiness.released).toEqual([1]);
  });

  it('refuses to wake a computer for a turn that already finished', async () => {
    const readiness = fakeReadiness();
    const computer = computerWith(readiness.port);
    await computer.dispose();

    await expect(computer.ensure()).rejects.toThrow(/already finished/);
    expect(readiness.calls()).toBe(0);
  });
});

describe('M5-BE-14 capacity and errors', () => {
  it('passes a capacity refusal through unchanged', async () => {
    // §4.1's 503 SANDBOX_CAPACITY is the host being momentarily full. The
    // readiness service deliberately does not translate it and neither does
    // this: a caller that cannot get a desktop needs the real reason.
    const refusal = Object.assign(new Error('SANDBOX_CAPACITY'), { status: 503 });
    const readiness = fakeReadiness({ failWith: refusal });
    const computer = computerWith(readiness.port);

    await expect(computer.ensure()).rejects.toBe(refusal);
  });

  it('does not remember a failure, so a later tool can try again', async () => {
    // Caching the rejection would turn one full moment on the host into a
    // turn that can never touch a desktop again. Capacity is explicitly a
    // temporary, retryable condition.
    let attempt = 0;
    const port: TurnReadinessPort = {
      ensureReady: async (_u, _b, owner) => {
        attempt += 1;
        if (attempt === 1) throw new Error('SANDBOX_CAPACITY');
        return {
          status: RUNNING,
          lease: { owner, renew: async () => undefined, release: async () => undefined } as never,
        };
      },
    };
    const computer = createTurnComputer({ readiness: port, userId: 'u', botId: 'b' });

    await expect(computer.ensure()).rejects.toThrow(/CAPACITY/);
    await expect(computer.ensure()).resolves.toBe(RUNNING);
    expect(attempt).toBe(2);
  });

  it('holds no lease to release when the wake never succeeded', async () => {
    const readiness = fakeReadiness({ failWith: new Error('nope') });
    const computer = computerWith(readiness.port);

    await expect(computer.ensure()).rejects.toThrow();
    await computer.dispose();

    expect(readiness.released).toEqual([]);
  });
});

describe('M5-BE-14 the owner it claims', () => {
  it('claims the computer as an agent tool', async () => {
    // §17's vocabulary already reserved this owner. The idle sweep and the
    // §8 activity read both key off it.
    const owners: string[] = [];
    const port: TurnReadinessPort = {
      ensureReady: async (_u, _b, owner) => {
        owners.push(owner);
        return {
          status: RUNNING,
          lease: { owner, renew: async () => undefined, release: async () => undefined } as never,
        };
      },
    };

    await createTurnComputer({ readiness: port, userId: 'u', botId: 'b' }).ensure();

    expect(owners).toEqual(['agent-tool']);
  });
});

describe('M5-BE-13 a suspended turn lets go of the desktop', () => {
  it('hands the lease back and asks again when the turn resumes', async () => {
    // The shape of a turn parked on an approval: it had a desktop, the person
    // took a while, and it needs one again when they answer. Until `release`
    // existed the lease was held for the whole of that wait — an explicit
    // promise about wall-clock time, which outranks every inference the idle
    // sweep makes, on behalf of every bot attached to the same computer.
    const readiness = fakeReadiness();
    const computer = computerWith(readiness.port);

    await computer.ensure();
    expect(readiness.calls()).toBe(1);

    await computer.release();
    expect(readiness.released).toEqual([1]);

    // The half that matters more than the lease. `ensure()` memoises SUCCESS,
    // so without forgetting it a resumed turn would act on a cached RUNNING
    // for a machine the sweep has since stopped, and hand its tools a
    // container that is not there.
    await computer.ensure();
    expect(readiness.calls()).toBe(2);
  });

  it('is idempotent, and safe on a turn that never asked for a desktop', async () => {
    const untouched = fakeReadiness();
    const never = computerWith(untouched.port);
    await never.release();
    expect(untouched.calls()).toBe(0);
    // Not a claim that a desktop was wanted: `wasRequested` is what M5-BE-14
    // asserts laziness with, and releasing must not make a text-only turn
    // look like it woke something.
    expect(never.wasRequested()).toBe(false);

    const readiness = fakeReadiness();
    const computer = computerWith(readiness.port);
    await computer.ensure();
    await computer.release();
    await computer.release();
    expect(readiness.released).toEqual([1]);
  });

  it('stays released once the turn is over', async () => {
    // `release` is not a way back from a finished turn. A `dispose` after a
    // suspension is the ordinary end of a cancelled one, and an `ensure`
    // after that must not wake a desktop nobody will release.
    const readiness = fakeReadiness();
    const computer = computerWith(readiness.port);
    await computer.ensure();
    await computer.dispose();
    await computer.release();

    await expect(computer.ensure()).rejects.toThrow(/already finished/);
    expect(readiness.calls()).toBe(1);
  });
});
