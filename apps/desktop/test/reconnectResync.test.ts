import { describe, expect, it } from 'vitest';
import type { ConnectionStatus } from '../src/renderer/connection/wsClient';
import {
  initialResyncMemory,
  stepResync,
  type ResyncMemory,
} from '../src/renderer/state/reconnectResync';

/**
 * M1-QA-04 (renderer half) — the repair after a socket drops mid-stream.
 *
 * The orchestrator side of this task proves the turn survives the drop and the
 * completed reply is fetchable over §4.1. That only helps the operator if the
 * client actually goes and fetches it, and exactly once: the transitions here
 * are the difference between a recovered transcript, a permanently missing
 * reply, and a refetch storm on every startup.
 */

/** Replay a status sequence, returning where a refetch fired. */
function replay(
  statuses: readonly ConnectionStatus[],
  seed: ConnectionStatus = 'disconnected',
): { readonly refetches: number; readonly at: number[]; readonly memory: ResyncMemory } {
  let memory = initialResyncMemory(seed);
  const at: number[] = [];
  statuses.forEach((status, index) => {
    const step = stepResync(memory, status);
    memory = step.memory;
    if (step.refetch) at.push(index);
  });
  return { refetches: at.length, at, memory };
}

describe('reconnect resync (M1-QA-04)', () => {
  it('does not refetch on the first connect, which has missed nothing', () => {
    expect(replay(['connecting', 'connected']).refetches).toBe(0);
  });

  it('refetches once when the socket drops and comes back', () => {
    // The scenario the orchestrator suite drives with a real socket: the reply
    // completes while the client is away, so nothing but a refetch will ever
    // surface it — `loadOlder` walks backwards from a stored cursor and would
    // step straight past a message newer than everything on screen.
    const run = replay(['connecting', 'connected', 'reconnecting', 'connected']);
    expect(run.refetches).toBe(1);
    expect(run.at).toEqual([3]);
  });

  it('refetches once per outage, not once per retry', () => {
    // 1s, 2s, 4s, 8s of backoff is four 'reconnecting' steps for one gap.
    const run = replay([
      'connecting',
      'connected',
      'reconnecting',
      'reconnecting',
      'reconnecting',
      'reconnecting',
      'connected',
    ]);
    expect(run.refetches).toBe(1);
  });

  it('ignores a repeated connected step, which is StrictMode and not a reconnect', () => {
    // React remounts effects in development. A re-run where the status did not
    // actually change must not read as a round trip through disconnected, or
    // every open bot refetches its history on startup.
    const run = replay(['connecting', 'connected', 'connected', 'connected']);
    expect(run.refetches).toBe(0);
  });

  it('refetches again on a second outage', () => {
    const run = replay([
      'connecting',
      'connected',
      'reconnecting',
      'connected',
      'reconnecting',
      'connected',
    ]);
    expect(run.at).toEqual([3, 5]);
  });

  it('treats a stop/start cycle as an outage once a session has connected', () => {
    // `WsClient.stop()` publishes 'disconnected' rather than 'reconnecting'.
    // The gap is identical from the transcript's point of view.
    expect(replay(['connected', 'disconnected', 'connecting', 'connected']).at).toEqual([3]);
  });

  it('never refetches for a session that has not connected yet', () => {
    // A misconfigured install cycles connecting/disconnected forever. There is
    // no history to repair, and each refetch would be a doomed request.
    const run = replay([
      'connecting',
      'disconnected',
      'connecting',
      'disconnected',
      'reconnecting',
    ]);
    expect(run.refetches).toBe(0);
    expect(run.memory.hasConnected).toBe(false);
  });

  it('remembers across steps that a connection once existed', () => {
    const run = replay(['connected', 'reconnecting']);
    expect(run.memory).toEqual({ hasConnected: true, previous: 'reconnecting' });
  });

  it('seeds from the status at mount without counting it as an observation', () => {
    // The hook seeds the ref during render from whatever status is current.
    // Seeding `hasConnected: true` there would make the very next 'connected'
    // step look like a reconnect and refetch on startup.
    expect(initialResyncMemory('connected')).toEqual({
      hasConnected: false,
      previous: 'connected',
    });
    expect(replay(['connected'], 'connected').refetches).toBe(0);
  });
});
