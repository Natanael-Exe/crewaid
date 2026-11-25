import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Bot } from '@crewaid/shared';
import type { Message } from '@ag-ui/core';
import { toTranscript } from '../src/renderer/chat/uiMessage';
import { Transcript } from '../src/renderer/components/Transcript';
import { textOfPart } from '../src/renderer/state/transcriptRows';
import { nextLocalId, readPersistedQueues } from '../src/renderer/state/messageQueue';
import type { TranscriptMessage } from '../src/renderer/state/viewTypes';

const SELF = 'clx1a2b3c4d5e6f7g8h9i0j1';

const BOT = {
  id: SELF,
  userId: 'clx1a2b3c4d5e6f7g8h9i0j9',
  name: 'Gideon',
  role: 'Marketing Project Manager',
  avatarColor: '#8b6f47',
  systemPrompt: '',
  modelId: 'default',
  autoReviewRules: [],
  status: 'IDLE',
  createdAt: '2026-11-25T11:00:00.000Z',
  updatedAt: '2026-11-25T11:00:00.000Z',
} as unknown as Bot;

function render(messages: readonly TranscriptMessage[], showBotWork = false): string {
  return renderToStaticMarkup(
    <Transcript
      bot={BOT}
      peers={[{ id: SELF, name: 'Gideon', role: 'PM', avatarColor: '#8b6f47' }]}
      historyLoaded
      showBotWork={showBotWork}
      connection={{ status: 'connected', attempt: 0, retryDelayMs: null }}
      messages={messages}
      pending={[]}
      onSend={() => {}}
      onStop={() => {}}
      onFiles={() => {}}
      onRemovePending={() => {}}
      onRetryPending={() => {}}
    />,
  );
}

const REPEATED_LOG = Array.from(
  { length: 8 },
  () => 'WARN retrying upstream request after timeout',
).join('\n');

describe('a person’s own words are never run through the bot-speech projection', () => {
  it('shows and copies a pasted log with repeated lines verbatim', () => {
    const projected = toTranscript(
      [{ id: 'u1', role: 'user', content: `Why does this keep happening?\n${REPEATED_LOG}` }],
      SELF,
      false,
    );
    const html = render(projected);
    expect(html).toContain('Why does this keep happening?');
    expect(html).toContain('WARN retrying upstream request after timeout');
    expect(projected[0]?.parts.map(textOfPart).join('')).toContain(REPEATED_LOG);
  });

  it('keeps an XML snippet with reasoning-like tags in a user message', () => {
    const projected = toTranscript(
      [{ id: 'u1', role: 'user', content: 'Wrap the summary in <analysis>like this</analysis> please' }],
      SELF,
      false,
    );
    expect(projected[0]?.parts.map(textOfPart).join('')).toContain('<analysis>like this</analysis>');
  });

  it('still hides a bot reply that is a runaway repetition loop', () => {
    const projected = toTranscript(
      [{ id: 'b1', role: 'assistant', content: REPEATED_LOG } as Message],
      SELF,
      false,
    );
    expect(projected[0]?.parts.map(textOfPart).join('')).toBe('');
  });
});

describe('text beside a tool call is narration only when the run says something after it', () => {
  const approvalStep = {
    id: 'step-1',
    role: 'assistant',
    content: 'Here is the draft to Alex — approve it and I will send it.',
    toolCalls: [
      { id: 'c1', type: 'function', function: { name: 'send_email', arguments: '{"to":"alex"}' } },
    ],
  } as Message;

  it('keeps it as the reply when the run parked on that step', () => {
    const html = render(toTranscript([approvalStep], SELF, false));
    expect(html).toContain('approve it and I will send it');
    expect(html).not.toContain('data-work-note');
  });

  it('treats it as narration while the run is still working', () => {
    const html = render(toTranscript([approvalStep], SELF, true));
    expect(html).not.toContain('approve it and I will send it');
  });

  it('keeps the last text-bearing step of a finished run as speech', () => {
    const raw: Message[] = [
      { id: 'u1', role: 'user', content: 'Check the board, then the files.' },
      {
        id: 'step-1',
        role: 'assistant',
        content: 'Checking the board first.',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'board_read', arguments: '{}' } }],
      } as Message,
      { id: 'r1', role: 'tool', toolCallId: 'c1', content: 'ok' } as Message,
      {
        id: 'step-2',
        role: 'assistant',
        content: 'The board is clear; I stopped at the turn limit before the files.',
        toolCalls: [{ id: 'c2', type: 'function', function: { name: 'fs_read', arguments: '{}' } }],
      } as Message,
      { id: 'r2', role: 'tool', toolCallId: 'c2', content: 'ok' } as Message,
    ];
    const html = render(toTranscript(raw, SELF, false));
    expect(html).toContain('I stopped at the turn limit');
    expect(html).not.toContain('Checking the board first.');
  });
});

describe('queued message ids survive a reload without colliding', () => {
  it('hands out ids that cannot repeat a restored counter id', () => {
    const first = nextLocalId();
    expect(first).not.toBe('q1');
    expect(first).not.toBe(nextLocalId());
  });

  it('renames a duplicated id found in a stored queue', () => {
    const storage = {
      getItem: () =>
        JSON.stringify({
          bot_a: [
            { localId: 'q1', text: 'first', attachmentIds: [] },
            { localId: 'q1', text: 'second', attachmentIds: [] },
          ],
        }),
      setItem: () => undefined,
    };
    const restored = readPersistedQueues(storage, 'k')['bot_a'] ?? [];
    expect(restored.map((item) => item.text)).toEqual(['first', 'second']);
    expect(restored[0]?.localId).toBe('q1');
    expect(new Set(restored.map((item) => item.localId)).size).toBe(2);
  });
});
