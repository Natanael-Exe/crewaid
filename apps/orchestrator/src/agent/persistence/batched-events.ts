import { EventType, type StreamChunk } from '@tanstack/ai';
const DELTAS = new Set<string>([
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.REASONING_MESSAGE_CONTENT,
  EventType.TOOL_CALL_ARGS,
]);

/** Bounded write-behind for content; boundaries and external delivery stay durable. */
export function batchRunEvents(
  write: (events: StreamChunk[]) => Promise<void>,
  failed: (error: unknown) => void,
) {
  let pending: StreamChunk[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> | undefined;
  let failure: { error: unknown } | undefined;
  async function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    if (failure !== undefined) throw failure.error;
    if (writing !== undefined) {
      await writing;
      return flush();
    }
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    const operation = Promise.resolve().then(() => write(batch));
    writing = operation;
    try {
      await operation;
    } catch (error) {
      if (failure === undefined) {
        failure = { error };
        failed(error);
      }
      throw error;
    } finally {
      writing = undefined;
    }
    // Content queued during a slow write stays in the bounded pending array.
    // Never turn each timer tick into another unbounded chained batch.
    if (pending.length > 0) await flush();
  }
  return {
    flush,
    async append(event: StreamChunk): Promise<void> {
      if (failure !== undefined) throw failure.error;
      pending.push(event);
      if (!DELTAS.has(event.type) || pending.length >= 32) await flush();
      else if (timer === undefined && writing === undefined)
        timer = setTimeout(() => void flush().catch(() => undefined), 16);
    },
  };
}
