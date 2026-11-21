import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventType, type StreamChunk } from '@tanstack/ai';
import { batchRunEvents } from '../src/agent/persistence/batched-events.js';
const delta = (value: number): StreamChunk => ({
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId: 'm',
  delta: String(value),
});
afterEach(() => vi.useRealTimers());
describe('bounded durable content batches', () => {
  it('writes 700 deltas in 22 batches in order, and flushes a lifecycle boundary', async () => {
    const batches: StreamChunk[][] = [];
    const writer = batchRunEvents(
      async (batch) => {
        batches.push(batch);
      },
      () => {},
    );
    for (let index = 0; index < 700; index++) await writer.append(delta(index));
    await writer.append({ type: EventType.TEXT_MESSAGE_END, messageId: 'm' });
    await writer.flush();
    expect(batches).toHaveLength(22);
    expect(Math.max(...batches.map((batch) => batch.length))).toBeLessThanOrEqual(32);
    expect(batches.flat()).toEqual([
      ...Array.from({ length: 700 }, (_, i) => delta(i)),
      { type: EventType.TEXT_MESSAGE_END, messageId: 'm' },
    ]);
  });
  it('flushes sparse output after 16 ms', async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => {});
    const writer = batchRunEvents(write, () => {});
    await writer.append(delta(1));
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16);
    expect(write).toHaveBeenCalledWith([delta(1)]);
    await writer.flush();
  });
  it('backpressures at the bound and permits only one append at a time', async () => {
    let release: (() => void) | undefined;
    const write = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const writer = batchRunEvents(write, () => {});
    for (let i = 0; i < 31; i++) await writer.append(delta(i));
    let advanced = false;
    const blocked = writer.append(delta(31)).then(() => {
      advanced = true;
    });
    await Promise.resolve();
    expect(advanced).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    release?.();
    await blocked;
    await writer.flush();
    expect(advanced).toBe(true);
  });
  it('keeps queued content bounded while a timer-triggered append is stalled', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const write = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const writer = batchRunEvents(write, () => {});
    await writer.append(delta(0));
    await vi.advanceTimersByTimeAsync(16);
    for (let i = 1; i <= 31; i++) await writer.append(delta(i));
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).toHaveBeenCalledTimes(1);
    let advanced = false;
    const blocked = writer.append(delta(32)).then(() => {
      advanced = true;
    });
    await Promise.resolve();
    expect(advanced).toBe(false);
    release?.();
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    release?.();
    await blocked;
    await writer.flush();
    expect(write.mock.calls.map(([batch]) => batch.length)).toEqual([1, 32]);
  });

  it('propagates timer write failures to the producer and every later boundary', async () => {
    vi.useFakeTimers();
    const failure = new Error('stale epoch');
    const abort = vi.fn();
    const writer = batchRunEvents(async () => {
      throw failure;
    }, abort);
    await writer.append(delta(1));
    await vi.advanceTimersByTimeAsync(16);
    expect(abort).toHaveBeenCalledWith(failure);
    await expect(writer.append(delta(2))).rejects.toThrow('stale epoch');
    await expect(writer.flush()).rejects.toThrow('stale epoch');
  });
});
