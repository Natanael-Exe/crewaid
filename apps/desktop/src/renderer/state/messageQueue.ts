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
}

export type MessageQueues = Readonly<Record<string, readonly QueuedMessage[]>>;

let counter = 0;

/** Ids are per-session and never leave the client, so a counter is enough. */
export function nextLocalId(): string {
  counter += 1;
  return `q${counter}`;
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
    [botId]: queueOf(queues, botId).map((item) =>
      item.localId === localId ? { ...item, text } : item,
    ),
  };
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
