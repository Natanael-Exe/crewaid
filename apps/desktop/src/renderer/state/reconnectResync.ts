import type { ConnectionStatus } from '../connection/wsClient';

/**
 * Whether a connection transition means the transcript has a gap to repair.
 *
 * The socket carries every live message; while it is down, `message.created` /
 * `.delta` / `.completed` are simply gone. `loadOlder` only walks backwards
 * from a stored cursor, so nothing else would ever fetch them — without a
 * refetch on reconnect, the reply that arrived during a laptop sleep stays
 * missing until the app restarts.
 *
 * Extracted from the effect that acts on it because the interesting part is
 * the three-way decision, not the fetching: only a RE-connect repairs, and the
 * two cases that must NOT are easy to reintroduce and invisible when they
 * regress — a first connect has missed nothing, and a re-run where the status
 * did not actually change is StrictMode remounting the effect. Treating either
 * as a reconnect refetches every open bot's history on startup.
 */

export interface ResyncMemory {
  /** Whether a connection was ever established in this session. */
  readonly hasConnected: boolean;
  /** The status observed on the previous step. */
  readonly previous: ConnectionStatus;
}

export interface ResyncStep {
  readonly memory: ResyncMemory;
  readonly refetch: boolean;
}

/** Seeded from the status at mount, which has not been observed as a step yet. */
export function initialResyncMemory(status: ConnectionStatus): ResyncMemory {
  return { hasConnected: false, previous: status };
}

export function stepResync(memory: ResyncMemory, status: ConnectionStatus): ResyncStep {
  const next: ResyncMemory = {
    hasConnected: memory.hasConnected || status === 'connected',
    previous: status,
  };
  const reconnected =
    status === 'connected' && memory.hasConnected && memory.previous !== 'connected';
  return { memory: next, refetch: reconnected };
}
