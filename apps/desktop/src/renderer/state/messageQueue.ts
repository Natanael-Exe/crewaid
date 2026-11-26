/**
 * Messages typed while the bot is still working.
 *
 * The rule is that nothing here has been sent. A queued message exists only
 * in this window: it can be edited, removed and reordered, and it reaches the
 * server when the turn ends, in the order the operator left it in. That is
 * the whole reason the queue is client-side rather than the server's own
 * deferral (M5-BE-16, which already accepts a message mid-turn and answers it
 * afterwards) — once a message is posted it is in the transcript and in the
 * model's next prompt, and "wait, not like that" is no longer expressible.
 *
 * Pure functions over a plain list, so the ordering rules are testable
 * without a component and without a clock.
 */

export interface QueuedMessage {
  /**
   * A client id. Nothing on the server has one for this yet, and the list is
   * reordered by drag — a key by index would hand a moved row somebody else's
   * identity mid-drag, and React would reuse the DOM node it was editing.
   */
  readonly localId: string;
  readonly text: string;
  /** Uploads claimed at enqueue time, sent with it. */
  readonly attachmentIds: readonly string[];
  /** Stable idempotency id sent as `Message.id` so reconnects/retries never duplicate sends. */
  readonly messageId?: string;
  /** Active run id observed when this message was queued, for target-scoped "Stop and send". */
  readonly targetRunId?: string | null;
  /** Inline feedback when an interruption target changed or could not complete. */
  readonly notice?: string;
}

export type MessageQueues = Readonly<Record<string, readonly QueuedMessage[]>>;

/**
 * Ids never leave the client, but they do outlive the page: queues are kept in
 * sessionStorage across reloads. A counter restarts at zero on every load and
 * would hand out `q1` again beside a restored `q1`, so that removing one —
 * which matches by id — removes both.
 */
export function nextLocalId(): string {
  return `q-${crypto.randomUUID()}`;
}

export function queueOf(queues: MessageQueues, botId: string): readonly QueuedMessage[] {
  return queues[botId] ?? [];
}

export function enqueue(
  queues: MessageQueues,
  botId: string,
  message: QueuedMessage,
): MessageQueues {
  return { ...queues, [botId]: [...queueOf(queues, botId), message] };
}

export function removeQueued(queues: MessageQueues, botId: string, localId: string): MessageQueues {
  return { ...queues, [botId]: queueOf(queues, botId).filter((item) => item.localId !== localId) };
}

/**
 * Edit in place, keeping the item's position.
 *
 * An empty edit REMOVES it: the operator cleared the text of something that
 * has not been sent, and the only two readings of that are "delete this" and
 * "send an empty message", which the send gate would refuse anyway.
 */
export function editQueued(
  queues: MessageQueues,
  botId: string,
  localId: string,
  text: string,
): MessageQueues {
  if (text.trim() === '') return removeQueued(queues, botId, localId);
  return {
    ...queues,
    [botId]: queueOf(queues, botId).map((item) => {
      if (item.localId !== localId) return item;
      const { notice: _cleared, ...rest } = item;
      return { ...rest, text };
    }),
  };
}

/** Updates a queued item's inline notice and optionally refreshes its targeted run id. */
export function setQueuedNotice(
  queues: MessageQueues,
  botId: string,
  localId: string,
  notice: string | undefined,
  nextTargetRunId?: string | null,
): MessageQueues {
  return {
    ...queues,
    [botId]: queueOf(queues, botId).map((item) => {
      if (item.localId !== localId) return item;
      const { notice: _prev, ...rest } = item;
      return {
        ...rest,
        ...(nextTargetRunId === undefined ? {} : { targetRunId: nextTargetRunId }),
        ...(notice === undefined ? {} : { notice }),
      };
    }),
  };
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** Reads persisted queued drafts and their target runs across window reloads/reconnects. */
export function readPersistedQueues(storage: StorageLike | null, key: string): MessageQueues {
  if (storage === null) return {};
  try {
    const raw = storage.getItem(key);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, readonly QueuedMessage[]> = {};
    for (const [botId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const items: QueuedMessage[] = [];
      const seen = new Set<string>();
      for (const entry of value) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
        const row = entry as Record<string, unknown>;
        if (typeof row['localId'] !== 'string' || typeof row['text'] !== 'string') continue;
        const attachmentIds = Array.isArray(row['attachmentIds'])
          ? row['attachmentIds'].filter((id): id is string => typeof id === 'string')
          : [];
        // A store written before ids were unique can hold the same id twice.
        const localId = seen.has(row['localId']) ? nextLocalId() : row['localId'];
        seen.add(localId);
        items.push({
          localId,
          text: row['text'],
          attachmentIds,
          ...(typeof row['messageId'] === 'string' ? { messageId: row['messageId'] } : {}),
          ...(typeof row['targetRunId'] === 'string' || row['targetRunId'] === null
            ? { targetRunId: row['targetRunId'] }
            : {}),
        });
      }
      if (items.length > 0) out[botId] = items;
    }
    return out;
  } catch {
    return {};
  }
}

export function writePersistedQueues(
  storage: StorageLike | null,
  key: string,
  queues: MessageQueues,
): void {
  if (storage === null) return;
  try {
    const clean: Record<string, readonly QueuedMessage[]> = {};
    for (const [botId, items] of Object.entries(queues)) {
      if (items.length === 0) continue;
      clean[botId] = items.map(({ notice: _notice, ...item }) => item);
    }
    storage.setItem(key, JSON.stringify(clean));
  } catch {
    // Hardened profiles may refuse storage; the in-memory queue still works.
  }
}

/**
 * Move one item to another index (drag to reorder).
 *
 * Total over any pair of indices, including ones no longer in the list: a
 * drop lands after a render, and the list can have changed underneath it —
 * the previous item may have been sent the moment the turn ended.
 */
export function moveQueued(
  queues: MessageQueues,
  botId: string,
  from: number,
  to: number,
): MessageQueues {
  const items = queueOf(queues, botId);
  if (from === to || from < 0 || from >= items.length) return queues;
  const clamped = Math.max(0, Math.min(items.length - 1, to));
  const moved = items[from];
  if (moved === undefined) return queues;
  const rest = [...items.slice(0, from), ...items.slice(from + 1)];
  return { ...queues, [botId]: [...rest.slice(0, clamped), moved, ...rest.slice(clamped)] };
}

/** The next message to send, or undefined when this bot's queue is empty. */
export function headOf(queues: MessageQueues, botId: string): QueuedMessage | undefined {
  return queueOf(queues, botId)[0];
}

/** Every bot with something waiting — what the drain effect iterates. */
export function botsWithQueue(queues: MessageQueues): string[] {
  return Object.keys(queues).filter((botId) => queueOf(queues, botId).length > 0);
}

/**
 * The next queued message to post, or nothing to do.
 *
 * Pure, and separate from the effect that acts on it, because the two things
 * that can go wrong here are both invisible in a component:
 *
 *   - **Draining while the bot is busy** defeats the point. The queue exists
 *     so the operator's follow-ups arrive one at a time, in order, each as
 *     its own turn.
 *   - **Draining a bot that is `held`** is the retry storm. A send that failed
 *     leaves its message in the queue (losing it would be worse), and the
 *     failure itself clears the working flag — so without this the effect
 *     immediately posts it again, and again, for as long as the server keeps
 *     refusing. `held` is also what covers the gap between posting and the
 *     state that records it.
 *
 * ONE at a time by construction: it returns a single decision, so the effect
 * cannot accidentally fan the whole queue out into one turn.
 */
export function nextDrain(
  queues: MessageQueues,
  isWorking: (botId: string) => boolean,
  held: ReadonlySet<string>,
): { readonly botId: string; readonly message: QueuedMessage } | undefined {
  for (const botId of botsWithQueue(queues)) {
    if (isWorking(botId) || held.has(botId)) continue;
    const message = headOf(queues, botId);
    if (message !== undefined) return { botId, message };
  }
  return undefined;
}
