import { afterEach, describe, expect, it, vi } from 'vitest';

import { lifecycleLeaseFresh, renewLifecycleLease } from '../src/sandbox/lifecycle-lease.js';

afterEach(() => vi.useRealTimers());

describe('long computer starts', () => {
  it('keeps a renewed start fenced without changing its original lease timestamp', () => {
    const row = { lastStartedAt: new Date(1000), lastActiveAt: new Date(90_000) };
    expect(lifecycleLeaseFresh(row, 100_000, 60_000)).toBe(true);
    expect(lifecycleLeaseFresh(row, 151_000, 60_000)).toBe(false);
  });

  it('renews serially and waits for an in-flight renewal before finishing', async () => {
    vi.useFakeTimers();
    let resolve!: (value: boolean) => void;
    const held = new Promise<boolean>((done) => {
      resolve = done;
    });
    const renew = vi.fn(() => held);
    const lease = renewLifecycleLease(renew, 100);
    await vi.advanceTimersByTimeAsync(150);
    expect(renew).toHaveBeenCalledTimes(1);
    let finished = false;
    const finishing = lease.finish().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    resolve(true);
    await finishing;
    expect(renew).toHaveBeenCalledTimes(1);
    expect(lease.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it.each([false, new Error('database unavailable')])(
    'cancels migration when renewal fails: %s',
    async (failure) => {
      vi.useFakeTimers();
      const lease = renewLifecycleLease(async () => {
        if (failure instanceof Error) throw failure;
        return failure;
      }, 100);
      await vi.advanceTimersByTimeAsync(100);
      expect(lease.signal.aborted).toBe(true);
      await expect(lease.finish()).rejects.toThrow();
    },
  );

  it('cancels before the existing lease can expire when the database never answers', async () => {
    vi.useFakeTimers();
    const lease = renewLifecycleLease(() => new Promise<boolean>(() => undefined), 100);
    await vi.advanceTimersByTimeAsync(201);
    expect(lease.signal.aborted).toBe(true);
    await expect(lease.finish()).rejects.toThrow('renewal timed out');
  });
});
