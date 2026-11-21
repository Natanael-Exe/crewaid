import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ServerFrame } from '@crewaid/shared';
import { chatReducer, initialChatState, type ChatState } from '../src/renderer/state/chatReducer';
import { formatElapsed, WorkingIndicator } from '../src/renderer/components/WorkingIndicator';

/**
 * CC-44 — "it is working", while nothing has arrived to prove it.
 *
 * Reported from a live session: a message goes, the composer empties, and
 * nothing at all appears until the reply lands whole. The transcript can only
 * render what has arrived, so this state cannot be derived from content.
 *
 * Two clocks answer it now and they answer about different bots. The thread on
 * screen has a chat client, and whether it is producing is the client's own
 * fact — the shell reads it there, which is what starts the indicator the
 * instant a send lands. Every OTHER bot has no client, and the reducer's
 * `activityByBot` is what the sidebar and the right rail ask about those: it
 * takes its edges from the §4.2 frames, which are the only thing a window
 * hears about a bot it is not looking at.
 *
 * This suite is the reducer's half. Its earliest edge is the first thing the
 * server says about a turn — a BOT draft, or the status that opens it — and
 * its endings are the ones CC-25 guarantees plus a failure, plus the roster as
 * the durable repair for an ending whose frame never arrived. The send-side
 * edge is the client's and belongs to the shell that reads it.
 */

const BOT = 'clx1a2b3c4d5e6f7g8h9i0j1';
const PEER = 'clx2b3c4d5e6f7g8h9i0j1k2';
const MSG = 'clxaaaaaaaaaaaaaaaaaaaa1';

function frame(type: string, payload: unknown, botId: string | undefined = BOT): ServerFrame {
  return {
    id: '3f1a5c2e-9b47-4d81-a6f2-0e5c7b8d1234',
    type,
    ts: Date.now(),
    ...(botId === undefined ? {} : { botId }),
    payload,
  } as ServerFrame;
}

function apply(state: ChatState, ...frames: ServerFrame[]): ChatState {
  return frames.reduce((current, f) => chatReducer(current, { type: 'ws/frame', frame: f }), state);
}

/** The draft reply a turn opens with, as the server announces it. */
const draft = (fromBotId: string = BOT, author = 'BOT') => ({
  id: MSG,
  conversationId: 'clx9z8y7x6w5v4u3t2s1r0q9',
  author,
  fromBotId,
  content: '',
  parts: null,
  stopReason: null,
  chainId: null,
  hopCount: 0,
  createdAt: '2026-09-18T12:00:00.000Z',
  attachments: [],
});

/** A bot the server has said something about: a turn is under way. */
function working(state: ChatState = initialChatState): ChatState {
  return apply(state, frame('message.created', draft()));
}

describe('when a bot counts as working', () => {
  it('starts on the first thing the server says, before any content has arrived', () => {
    // The whole gap: on a reasoning model behind a tool call, the first token
    // is tens of seconds after the draft exists. A draft with no parts and no
    // text is still proof that a turn is running.
    expect(working().activityByBot[BOT]?.startedAt).toBeTypeOf('number');
  });

  it('does not restart the clock each time the turn announces itself again', () => {
    // The draft is created, the status goes THINKING, the status goes ACTING —
    // three announcements of one turn. The operator is reading the FIRST one.
    const first = working();
    const later = apply(
      first,
      frame('bot.status', { botId: BOT, status: 'THINKING' }),
      frame('bot.status', { botId: BOT, status: 'ACTING' }),
    );
    expect(later.activityByBot[BOT]?.startedAt).toBe(first.activityByBot[BOT]?.startedAt);
  });

  it('starts for a turn this client did not send', () => {
    // A routine, or a teammate's delegation (§6/M7).
    const woken = apply(initialChatState, frame('bot.status', { botId: BOT, status: 'ACTING' }));
    expect(woken.activityByBot[BOT]).toBeDefined();
  });

  it('does not count a message delivered FROM another bot as this bot working', () => {
    // §6/M7 stores an inter-bot message as a BOT row with the SENDER's id, so
    // it looks exactly like a draft reply. Nothing is composing it — it
    // arrived whole — and a spinner over a message that is already on screen
    // would run until the next status frame contradicted it.
    const delivered = apply(initialChatState, frame('message.created', draft(PEER)));
    expect(delivered.activityByBot[BOT]).toBeUndefined();
  });

  it('stops when the bot goes idle, which is the end CC-25 guarantees', () => {
    const done = apply(working(), frame('bot.status', { botId: BOT, status: 'IDLE' }));
    expect(done.activityByBot[BOT]).toBeUndefined();
  });

  it('stops when the bot is waiting on the operator, not on itself', () => {
    // An approval prompt is up. The bot is not working, and two competing
    // claims about what is happening is worse than one.
    const asked = apply(
      working(),
      frame('bot.status', { botId: BOT, status: 'AWAITING_APPROVAL' }),
    );
    expect(asked.activityByBot[BOT]).toBeUndefined();
  });

  it('stops when a turn fails', () => {
    // Whatever status frames do or do not arrive after it, a failed turn is an
    // ended turn.
    const failed = apply(working(), frame('error', { code: 'UNKNOWN', message: 'went wrong' }));
    expect(failed.activityByBot[BOT]).toBeUndefined();
  });

  it('stops when the roster says the turn this client never saw end is over', () => {
    // Every server-side ending writes a status, but a socket down for that one
    // frame would leave a spinner running forever. The roster is the durable
    // version of the same fact.
    const repaired = chatReducer(working(), {
      type: 'bots/loaded',
      bots: [{ id: BOT, status: 'IDLE' }] as never,
    });
    expect(repaired.activityByBot[BOT]).toBeUndefined();
  });

  it('leaves a bot the roster says is still working alone', () => {
    const stillWorking = chatReducer(working(), {
      type: 'bots/loaded',
      bots: [{ id: BOT, status: 'ACTING' }] as never,
    });
    expect(stillWorking.activityByBot[BOT]).toBeDefined();
  });
});

const AVATAR = { name: 'Nathan Bot', avatarColor: '#e0447c' };

describe('WorkingIndicator', () => {
  it('wears the bot itself rather than a spinner (CC-47)', () => {
    // The mascot already animates what it is doing, and this row sits where
    // the reply is about to appear. A generic spinner beside it would be a
    // second, worse answer to the same question.
    const acting = renderToStaticMarkup(
      <WorkingIndicator bot={AVATAR} startedAt={Date.now()} status="ACTING" />,
    );
    expect(acting).toContain('crewaid-mascot-body');
    expect(acting).toContain('data-activity="acting"');
    // And the ornaments a 32px row avatar normally cannot afford: this one is
    // alone on its line.
    expect(acting).toContain('crewaid-mascot-ring');
    expect(
      renderToStaticMarkup(
        <WorkingIndicator bot={AVATAR} startedAt={Date.now()} status="THINKING" />,
      ),
    ).toContain('crewaid-mascot-dot');
  });

  it('still looks alive before the first status frame arrives', () => {
    // Most of the gap this component exists for is before the server has said
    // anything, and a mascot standing perfectly still through it would be the
    // original bug wearing a face.
    const html = renderToStaticMarkup(<WorkingIndicator bot={AVATAR} startedAt={Date.now()} />);
    expect(html).toContain('data-activity="thinking"');
  });

  it('says what it is doing and for how long', () => {
    const html = renderToStaticMarkup(
      <WorkingIndicator bot={AVATAR} startedAt={Date.now() - 12_000} status="ACTING" />,
    );
    expect(html).toContain('Working for');
    expect(
      renderToStaticMarkup(
        <WorkingIndicator bot={AVATAR} startedAt={Date.now()} status="THINKING" />,
      ),
    ).toContain('Thinking for');
    // Before the first status frame — which is most of the gap this exists
    // for — the honest word is the general one.
    expect(
      renderToStaticMarkup(<WorkingIndicator bot={AVATAR} startedAt={Date.now()} />),
    ).toContain('Working for');
  });

  it('reads an elapsed time the way a person would say it', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(12_400)).toBe('12s');
    expect(formatElapsed(60_000)).toBe('1m');
    expect(formatElapsed(64_000)).toBe('1m 4s');
    expect(formatElapsed(-5)).toBe('0s');
  });
});
