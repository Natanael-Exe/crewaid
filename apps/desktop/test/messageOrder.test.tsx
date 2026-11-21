import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Bot } from '@crewaid/shared';
import type { Message } from '@ag-ui/core';
import { toTranscript } from '../src/renderer/chat/uiMessage';
import type { TranscriptMessage } from '../src/renderer/state/viewTypes';
import { Transcript } from '../src/renderer/components/Transcript';

/**
 * The order a conversation is rendered in.
 *
 * The defect this suite exists for: a message sent DURING a turn is a settled
 * row — the server stores it after the running draft and answers it afterwards
 * — so a transcript rendered as "everything settled, then the reply being
 * written" put it above the reply it was sent during. The operator typed a
 * correction and watched it jump in front of the answer it was about.
 *
 * The reply in flight is now a message in the thread rather than a slot beside
 * it, so the server's order IS the list's order and nothing has to be spliced
 * back into position. That is what the transcript cases below assert: the
 * reply renders where the server put it while it is still arriving, and does
 * not move when it settles.
 */

const BOT = 'clx1a2b3c4d5e6f7g8h9i0j1';

const T1 = '2026-09-18T10:00:00.000Z';
const T2 = '2026-09-18T10:00:05.000Z';
const T3 = '2026-09-18T10:00:10.000Z';

function view(id: string, createdAt: string, author: 'USER' | 'BOT' = 'USER'): TranscriptMessage {
  return {
    id,
    author,
    parts: [{ type: 'text', text: id }],
    timeLabel: '10:00',
    dateLabel: 'Today',
    createdAt: epochOf(createdAt),
  };
}

/** A stored row as the thread's operator view hands it over. */
function stored(
  id: string,
  createdAt: string,
  author: 'USER' | 'BOT',
  stopReason: string | null = null,
): Message {
  return {
    id,
    role: author === 'USER' ? 'user' : 'assistant',
    content: id,
    metadata: {
      tanstack: { createdAt },
      crewaid: {
        author,
        fromBotId: author === 'BOT' ? BOT : null,
        runId: author === 'BOT' ? 'run-1' : null,
        sequence: 0,
        stopReason,
        taskId: null,
        routineId: null,
        chainId: null,
        hopCount: 0,
        startsTopic: false,
        attachments: [],
      },
    },
  };
}

const bot = {
  id: BOT,
  userId: 'clx1a2b3c4d5e6f7g8h9i0j2',
  name: 'Nathan Bot',
  role: 'Senior Frontend',
  avatarColor: '#e0447c',
  systemPrompt: '',
  modelId: 'default',
  autoReviewRules: [],
  status: 'IDLE',
  createdAt: T1,
  updatedAt: T1,
} as unknown as Bot;

function transcript(messages: readonly Message[], generating: boolean): string {
  return renderToStaticMarkup(
    <Transcript
      bot={bot}
      connection={{ status: 'connected', attempt: 0, retryDelayMs: null }}
      messages={toTranscript(messages, BOT, generating)}
      pending={[]}
      onSend={() => undefined}
      onStop={() => undefined}
      onFiles={() => undefined}
      onRemovePending={() => undefined}
      onRetryPending={() => undefined}
    />,
  );
}

/** `[user-1, bot-1, user-2]` as it actually appears in the markup. */
function renderedOrder(html: string): string[] {
  return ['user-1', 'bot-1', 'user-2']
    .map((id) => ({ id, at: html.indexOf(`data-message="${id}"`) }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.id);
}

describe('the transcript renders the reply where it belongs', () => {
  /**
   * The mid-turn send, in the server's order: the operator wrote while the
   * reply was being composed, so their message is stored after the reply's
   * own row and answered once it ends.
   */
  const midTurnSend = (replyStopReason: string | null): Message[] => [
    stored('user-1', T1, 'USER'),
    stored('bot-1', T2, 'BOT', replyStopReason),
    stored('user-2', T3, 'USER'),
  ];

  it('puts the reply still being written above the message sent during it', () => {
    expect(renderedOrder(transcript(midTurnSend(null), true))).toEqual([
      'user-1',
      'bot-1',
      'user-2',
    ]);
  });

  it('leaves it in the same place when it settles', () => {
    // The reply ending must not move it, or the operator watches the answer
    // they were reading jump across their own message.
    expect(renderedOrder(transcript(midTurnSend('stop'), false))).toEqual([
      'user-1',
      'bot-1',
      'user-2',
    ]);
  });
});
