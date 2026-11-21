import { describe, expect, it } from 'vitest';
import {
  botsWithQueue,
  nextDrain,
  editQueued,
  enqueue,
  headOf,
  moveQueued,
  nextLocalId,
  queueOf,
  removeQueued,
  type MessageQueues,
} from '../src/renderer/state/messageQueue';

/**
 * CC-45 — the ordering rules of a queue nothing has been sent from.
 */

const BOT = 'bot-1';

function withItems(...texts: string[]): MessageQueues {
  return texts.reduce<MessageQueues>(
    (queues, text) => enqueue(queues, BOT, { localId: text, text, attachmentIds: [] }),
    {},
  );
}

describe('the message queue', () => {
  it('keeps what was typed, in the order it was typed', () => {
    const queues = withItems('first', 'second');
    expect(queueOf(queues, BOT).map((item) => item.text)).toEqual(['first', 'second']);
    expect(headOf(queues, BOT)?.text).toBe('first');
    expect(headOf({}, BOT)).toBeUndefined();
  });

  it('gives every item its own id, because the list is reordered by drag', () => {
    // A key by index hands a moved row somebody else's identity mid-drag, and
    // React reuses the DOM node that was being edited.
    expect(nextLocalId()).not.toBe(nextLocalId());
  });

  it('edits in place, keeping the position', () => {
    const queues = editQueued(withItems('a', 'b', 'c'), BOT, 'b', 'edited');
    expect(queueOf(queues, BOT).map((item) => item.text)).toEqual(['a', 'edited', 'c']);
  });

  it('treats an emptied edit as a removal', () => {
    // The two readings of "cleared the text of something unsent" are delete
    // and send-nothing, and the send gate refuses the second anyway.
    const queues = editQueued(withItems('a', 'b'), BOT, 'a', '   ');
    expect(queueOf(queues, BOT).map((item) => item.text)).toEqual(['b']);
  });

  it('removes by id, never by position', () => {
    const queues = removeQueued(withItems('a', 'b', 'c'), BOT, 'b');
    expect(queueOf(queues, BOT).map((item) => item.text)).toEqual(['a', 'c']);
  });

  describe('reordering', () => {
    it('moves an item down and up', () => {
      const three = withItems('a', 'b', 'c');
      expect(queueOf(moveQueued(three, BOT, 0, 2), BOT).map((i) => i.text)).toEqual([
        'b',
        'c',
        'a',
      ]);
      expect(queueOf(moveQueued(three, BOT, 2, 0), BOT).map((i) => i.text)).toEqual([
        'c',
        'a',
        'b',
      ]);
      expect(queueOf(moveQueued(three, BOT, 1, 0), BOT).map((i) => i.text)).toEqual([
        'b',
        'a',
        'c',
      ]);
    });

    it('is total over indices the list no longer has', () => {
      // A drop lands after a render, and the head may have been sent the
      // moment the turn ended.
      const three = withItems('a', 'b', 'c');
      expect(queueOf(moveQueued(three, BOT, 5, 0), BOT).map((i) => i.text)).toEqual([
        'a',
        'b',
        'c',
      ]);
      expect(queueOf(moveQueued(three, BOT, 0, 99), BOT).map((i) => i.text)).toEqual([
        'b',
        'c',
        'a',
      ]);
      expect(queueOf(moveQueued(three, BOT, 1, 1), BOT)).toBe(queueOf(three, BOT));
      expect(moveQueued({}, BOT, 0, 1)).toEqual({});
    });
  });

  it('lists only the bots that actually have something waiting', () => {
    // What the drain effect iterates: an emptied queue leaves a key behind,
    // and a bot with no messages must not be woken by it.
    const queues = removeQueued(
      enqueue(withItems('a'), 'bot-2', {
        localId: 'x',
        text: 'x',
        attachmentIds: [],
      }),
      'bot-2',
      'x',
    );
    expect(botsWithQueue(queues)).toEqual([BOT]);
  });
});

describe('the drain decision', () => {
  const idle = () => false;
  const busy = () => true;
  const none = new Set<string>();

  it('takes the head of a queue whose bot is free', () => {
    expect(nextDrain(withItems('a', 'b'), idle, none)).toEqual({
      botId: BOT,
      message: { localId: 'a', text: 'a', attachmentIds: [] },
    });
  });

  it('waits while the bot is working — the queue is why the follow-ups are separate turns', () => {
    expect(nextDrain(withItems('a'), busy, none)).toBeUndefined();
  });

  it('does not re-post a message whose send is in flight or has just failed', () => {
    // The retry storm: a failed send leaves the message queued (losing it
    // would be worse) and clears the working flag, so without the hold the
    // effect posts it again immediately, forever.
    expect(nextDrain(withItems('a'), idle, new Set([BOT]))).toBeUndefined();
  });

  it('has nothing to do when every queue is empty', () => {
    expect(nextDrain({}, idle, none)).toBeUndefined();
    expect(nextDrain({ [BOT]: [] }, idle, none)).toBeUndefined();
  });
});
