import { describe, expect, it } from 'vitest';
import type { BotGroup, ServerFrame } from '@crewaid/shared';
import { chatReducer, initialChatState, type ChatState } from '../src/renderer/state/chatReducer';

/**
 * D-131 — unread counts and groups in the reducer.
 *
 * The server's count is the durable one; what is pinned here is what keeps
 * the badge honest between two reads of it.
 *
 * D-192 narrowed how the live half can know: a bot the operator is not
 * looking at has no chat client and no transcript in this window, so a
 * message frame is counted on its own evidence rather than checked against
 * the messages already on screen. The cases below pin both halves of that
 * trade — the count that rises from a frame, and the roster read that
 * replaces it.
 */
const QUILL = 'clx1a2b3c4d5e6f7g8h9i0j1';
const WARDEN = 'clx9z8y7x6w5v4u3t2s1r0q9';

function teammateMessage(botId: string, messageId: string): ServerFrame {
  return {
    id: '3f1a5c2e-9b47-4d81-a6f2-0e5c7b8d1234',
    type: 'message.created',
    botId,
    ts: 1,
    payload: {
      id: messageId,
      conversationId: 'clxccccccccccccccccc',
      author: 'BOT',
      fromBotId: WARDEN,
      content: 'A teammate wrote this.',
      parts: [],
      stopReason: null,
      chainId: null,
      hopCount: 0,
      taskId: null,
      routineId: null,
      startsTopic: false,
      createdAt: new Date(0),
      attachments: [],
    },
  } as ServerFrame;
}

function loaded(counts: Record<string, number>, groupIds: Record<string, string | null> = {}) {
  return chatReducer(initialChatState, {
    type: 'bots/loaded',
    bots: Object.entries(counts).map(([id, unreadCount]) => ({
      id,
      name: id,
      status: 'IDLE',
      sandbox: null,
      groupId: groupIds[id] ?? null,
      unreadCount,
    })) as never,
  });
}

const view = (state: ChatState, botId: string | null) =>
  chatReducer(state, { type: 'selection/changed', botId });

describe('unread counts', () => {
  it("seeds from the roster's counts", () => {
    expect(loaded({ [QUILL]: 2, [WARDEN]: 0 }).unreadByBot).toEqual({ [QUILL]: 2, [WARDEN]: 0 });
  });

  it('counts a teammate message on arrival — nothing else ever will', () => {
    // A teammate's message is complete when it appears: no run of this bot's
    // wrote it, so no run's end will re-read the count for it.
    const state = view(loaded({ [QUILL]: 0, [WARDEN]: 0 }), WARDEN);
    const arrived = chatReducer(state, {
      type: 'ws/frame',
      frame: teammateMessage(QUILL, 'm1'),
    });
    expect(arrived.unreadByBot[QUILL]).toBe(1);
  });

  it("lets the server's count correct a redelivered frame, rather than deduping it", () => {
    // Counted from the frame alone (D-192). The check this used to make was
    // against the settled transcript, which an off-screen bot no longer has
    // in this window — so a redelivery counts twice, and the next read of the
    // roster is what makes it right again. That is the whole reason the badge
    // can be counted from frames at all: the server owns the number, and
    // every read of `GET /bots` takes it for every bot but the one on screen.
    const frame = teammateMessage(QUILL, 'm1');
    const twice = [frame, frame].reduce(
      (state, f) => chatReducer(state, { type: 'ws/frame', frame: f }),
      view(loaded({ [QUILL]: 0, [WARDEN]: 0 }), WARDEN),
    );
    expect(twice.unreadByBot[QUILL]).toBe(2);

    const reread = chatReducer(twice, {
      type: 'bots/loaded',
      bots: [
        { id: QUILL, name: QUILL, status: 'IDLE', sandbox: null, unreadCount: 1 },
        { id: WARDEN, name: WARDEN, status: 'IDLE', sandbox: null, unreadCount: 0 },
      ] as never,
    });
    expect(reread.unreadByBot[QUILL]).toBe(1);
  });

  it('does not count a teammate message that arrives on screen', () => {
    const state = view(loaded({ [QUILL]: 0 }), QUILL);
    const next = chatReducer(state, {
      type: 'ws/frame',
      frame: teammateMessage(QUILL, 'm1'),
    });
    expect(next.unreadByBot[QUILL]).toBe(0);
  });

  it('clears a bot when it is opened, and keeps it clear through a roster re-read', () => {
    const opened = view(loaded({ [QUILL]: 3 }), QUILL);
    expect(opened.unreadByBot[QUILL]).toBe(0);
    // The server's mark may not have landed yet; the bot on screen is read.
    const reread = chatReducer(opened, {
      type: 'bots/loaded',
      bots: [{ id: QUILL, name: QUILL, status: 'IDLE', sandbox: null, unreadCount: 3 }] as never,
    });
    expect(reread.unreadByBot[QUILL]).toBe(0);
  });

  it("takes the server's count after Mark as unread", () => {
    const state = chatReducer(loaded({ [QUILL]: 0 }), {
      type: 'unread/set',
      botId: QUILL,
      count: 1,
    });
    expect(state.unreadByBot[QUILL]).toBe(1);
  });

  it('keeps an explicit unread mark through a roster refresh while viewing', () => {
    const viewed = view(loaded({ [QUILL]: 0 }), QUILL);
    const marked = chatReducer(viewed, { type: 'unread/set', botId: QUILL, count: 1 });
    const refreshed = chatReducer(marked, {
      type: 'bots/loaded',
      bots: [{ id: QUILL, name: QUILL, status: 'IDLE', sandbox: null, unreadCount: 1 }] as never,
    });
    expect(refreshed.unreadByBot[QUILL]).toBe(1);
  });

  it('touches nothing but the badge when it counts', () => {
    // The badge is read by the sidebar rows, which are memoized on the roster
    // and on the activity map; a count that copied either would re-render
    // every row in the list for a number on one of them.
    const state = loaded({ [QUILL]: 0 });
    const next = chatReducer(state, { type: 'ws/frame', frame: teammateMessage(QUILL, 'm1') });
    expect(next.unreadByBot[QUILL]).toBe(1);
    expect(next.bots).toBe(state.bots);
    expect(next.activityByBot).toBe(state.activityByBot);
  });
});

describe('groups', () => {
  const SALES = {
    id: 'grp_sales',
    userId: 'usr_1',
    name: 'Sales team',
    instructions: '',
    sortOrder: 0,
    collapsed: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } satisfies BotGroup;

  it('adds a saved group, then replaces it in place', () => {
    const added = chatReducer(initialChatState, { type: 'group/saved', group: SALES });
    const renamed = chatReducer(added, { type: 'group/saved', group: { ...SALES, name: 'Sales' } });
    expect(renamed.groups).toEqual([{ ...SALES, name: 'Sales' }]);
  });

  it('keeps groups in sort order after a move', () => {
    const support = { ...SALES, id: 'grp_support', name: 'Support', sortOrder: 1 };
    const state = chatReducer(initialChatState, {
      type: 'groups/loaded',
      groups: [SALES, support],
    });
    // "Move up" on Support saves it at 0 and Sales at 1.
    const moved = [
      { ...support, sortOrder: 0 },
      { ...SALES, sortOrder: 1 },
    ].reduce((acc, group) => chatReducer(acc, { type: 'group/saved', group }), state);
    expect(moved.groups.map((group) => group.id)).toEqual(['grp_support', 'grp_sales']);
  });

  it('moves the bots of a deleted group to Unassigned', () => {
    const state = chatReducer(loaded({ [QUILL]: 0, [WARDEN]: 0 }, { [QUILL]: SALES.id }), {
      type: 'groups/loaded',
      groups: [SALES],
    });
    const next = chatReducer(state, { type: 'group/removed', groupId: SALES.id });
    expect(next.groups).toEqual([]);
    expect(next.bots.find((bot) => bot.id === QUILL)?.groupId).toBeNull();
  });
});
