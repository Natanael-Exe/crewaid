import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Bot } from '@crewaid/shared';
import type { Message } from '@ag-ui/core';
import { toTranscript, toTranscriptMessage } from '../src/renderer/chat/uiMessage';
import type { TranscriptMessage } from '../src/renderer/state/viewTypes';
import { Transcript } from '../src/renderer/components/Transcript';

/**
 * M7-FE-01 — a message from another bot reads as one.
 *
 * §6/M7 stores an inter-bot message with `author: BOT` and the SENDER's
 * `fromBotId` — the same shape a bot's own reply has. And it is stored so the
 * MODEL reads it as a turn addressed to this bot, which is why it arrives
 * here with `role: 'user'`: the role is what the provider saw, and
 * `metadata.crewaid.author` is the column. Three readings of that pair are
 * wrong in three different ways, and all three are one line of code away:
 * trusting the role puts a teammate's words in the operator's own lane,
 * trusting the author alone stacks them against this bot's reply as if one
 * speaker said both, and trusting neither leaves nothing on screen to say a
 * teammate was involved at all.
 *
 * The cases drive the projection (`uiMessage.ts`) and render its output, so
 * what is proven is that the treatment survives the path a hydrated or
 * streamed message actually takes.
 */

const SELF = 'clx1a2b3c4d5e6f7g8h9i0j1';
const PEER = 'clx2b3c4d5e6f7g8h9i0j1k2';
const INBOUND = 'clxaaaaaaaaaaaaaaaaaaaa1';
const OWN_REPLY = 'clxaaaaaaaaaaaaaaaaaaaa2';

const bot = (id: string, name: string, avatarColor: string): Bot => ({
  id,
  userId: 'usr_crewaid_singleton_v1',
  name,
  role: 'Outbound Writer',
  avatarColor,
  systemPrompt: 'You write outbound email.',
  modelId: 'default',
  status: 'IDLE',
  autoReviewRules: [],
  hiddenFromSidebar: false,
  createdAt: new Date('2026-09-01T12:00:00.000Z'),
  updatedAt: new Date('2026-09-01T12:00:00.000Z'),
});

const SELF_BOT = bot(SELF, 'Quill', '#8B6F47');
const PEER_BOT = bot(PEER, 'Atlas', '#2F6F4F');

type Crewaid = Record<string, unknown>;

function message(
  id: string,
  role: Message['role'],
  content: string,
  crewaid: Crewaid,
  at = '2026-09-01T12:00:00.000Z',
): Message {
  return {
    id,
    role,
    content,
    metadata: {
      tanstack: { createdAt: at },
      crewaid: {
        author: 'BOT',
        fromBotId: SELF,
        runId: null,
        sequence: 0,
        stopReason: null,
        taskId: null,
        routineId: null,
        chainId: null,
        hopCount: 0,
        startsTopic: false,
        attachments: [],
        ...crewaid,
      },
    },
  };
}

/**
 * What the delivery worker's row looks like once the thread is read for the
 * operator: `role: 'user'`, because that is the turn the model was given, and
 * the SENDER's id in the projection beside it.
 */
const inbound = (crewaid: Crewaid = {}): Message =>
  message(INBOUND, 'user', 'the invoice totals are wrong', {
    fromBotId: PEER,
    chainId: 'clxchainchainchainchain1',
    hopCount: 1,
    ...crewaid,
  });

/** This bot's own reply, in the same thread, at a later instant. */
const ownReply = (content = 'on it', stopReason: string | null = 'stop'): Message =>
  message(
    OWN_REPLY,
    'assistant',
    content,
    { fromBotId: SELF, stopReason },
    '2026-09-01T12:00:05.000Z',
  );

function transcript(
  messages: readonly TranscriptMessage[],
  peers: readonly Bot[] = [SELF_BOT, PEER_BOT],
) {
  return renderToStaticMarkup(
    <Transcript
      bot={SELF_BOT}
      peers={peers}
      connection={{ status: 'connected', attempt: 0, retryDelayMs: null }}
      messages={messages}
      pending={[]}
      onSend={() => undefined}
      onStop={() => undefined}
      onFiles={() => undefined}
      onRemovePending={() => undefined}
      onRetryPending={() => undefined}
    />,
  );
}

/** The thread as the operator reads it, with nothing in flight. */
const render = (messages: readonly Message[], peers?: readonly Bot[]) =>
  transcript(toTranscript(messages, SELF, false), peers);

describe('M7-FE-01 a message delivered from another bot', () => {
  it('is read from the author column, not from the turn the model was given', () => {
    const view = toTranscriptMessage(inbound(), SELF);

    // It arrives as a `user` turn and it is not the operator's: the column
    // says BOT, and the sender's id is what makes it somebody else's.
    expect(view.author).toBe('BOT');
    expect(view.fromBotId).toBe(PEER);
    expect(render([inbound()])).toContain('the invoice totals are wrong');
  });

  it('is a finished message, not a reply waiting on a completion that never comes', () => {
    // Nothing is composing it: another bot's turn wrote it and the delivery
    // worker stored it whole. Read as this bot's reply in flight it would
    // leave a bubble that never settles, because no run of THIS thread is
    // going to end it.
    const view = toTranscriptMessage(inbound(), SELF);
    expect(view.stopReason).toBeNull();
    const html = render([inbound()]);
    expect(html).toContain('the invoice totals are wrong');
    expect(html).not.toContain('This reply did not finish.');
    // And it keeps the place the server gave it while this bot answers it:
    // only the LAST message can be the one a run is writing into.
    expect(
      toTranscript([inbound(), ownReply('working on it', null)], SELF, true).map((m) => m.id),
    ).toEqual([INBOUND, OWN_REPLY]);
  });

  it('does not displace the reply this bot is actually composing', () => {
    // The real sequence: this bot is mid-answer when a teammate writes in.
    // Both are messages in one list now, in the server's order, so neither
    // can take the other's place.
    const html = render([inbound(), ownReply('working on it', null)]);
    expect(html).toContain('working on it');
    expect(html).toContain('the invoice totals are wrong');
  });

  it('shows the sender by name with their actual mascot and colour', () => {
    const html = render([inbound()]);
    // §6/M7: "a distinct treatment showing the originating bot's name and
    // colour".
    expect(html).toContain('Atlas');
    // The colour is the SENDER's own `avatarColor`, so the transcript and
    // the sidebar teach one mapping rather than two.
    expect(html).toContain(PEER_BOT.avatarColor);
    expect(html).toContain('data-interbot-mascot');
    expect(html).toMatch(/data-interbot-mascot[^>]*>.*?<svg/s);
    expect(html).toContain('data-from-bot="true"');
  });

  it('leaves this bots own reply unattributed', () => {
    const html = render([ownReply()]);
    expect(html).toContain('on it');
    // Its own words are not someone else's: no attribution line at all.
    expect(html).not.toContain('data-from-bot');
  });

  it('does not stack a teammates message with this bots own reply', () => {
    const messages = toTranscript([inbound(), ownReply()], SELF, false);
    expect(messages).toHaveLength(2);
    // Both are `author: BOT`. Grouped on the author alone they stack as one
    // speaker, which puts the attribution line over somebody else's words.
    expect(messages[0]?.fromBotId).toBe(PEER);
    expect(messages[1]?.fromBotId).toBeUndefined();
  });

  it('names a sender that has since been removed rather than dropping it', () => {
    // The roster no longer has the sender — a bot can be deleted after it
    // spoke (M7-BE-05), and the message is still what explains what this bot
    // did next.
    const html = render([inbound()], [SELF_BOT]);
    expect(html).toContain('the invoice totals are wrong');
    expect(html).toContain('A removed bot');
  });

  it('marks nothing as foreign on a message that has no projection yet', () => {
    // This window's own send, and the reply being streamed back, carry no
    // product facts until the next read of the thread: the server's
    // projection has not reached them. The role is the fallback for exactly
    // those two, and getting it inverted would attribute every reply to its
    // own author.
    const streamed: Message = {
      id: OWN_REPLY,
      role: 'assistant',
      content: 'on it',
    };
    const sent: Message = {
      id: 'local-1',
      role: 'user',
      content: 'what is wrong with them?',
    };

    expect(toTranscriptMessage(streamed, SELF).author).toBe('BOT');
    expect(toTranscriptMessage(streamed, SELF).fromBotId).toBeUndefined();
    expect(toTranscriptMessage(sent, SELF).author).toBe('USER');
    expect(render([streamed, sent])).not.toContain('data-from-bot');
  });
});
