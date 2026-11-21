import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Bot } from '@crewaid/shared';

import { Transcript } from '../src/renderer/components/Transcript';
import { ConversationsSection } from '../src/renderer/settings/GeneralPane';
import { isBotWorkPart, readShowBotWork } from '../src/renderer/state/transcriptPrefs';
import type { TranscriptMessage } from '../src/renderer/state/viewTypes';

/**
 * A bot's thinking and actions are hidden unless the Settings switch shows
 * them; what it said, and the working indicator, show either way.
 */

const BOT = {
  id: 'clx1a2b3c4d5e6f7g8h9i0j1',
  userId: 'clx1a2b3c4d5e6f7g8h9i0j2',
  name: 'Nathan',
  role: 'CEO',
  avatarColor: '#e0447c',
  systemPrompt: '',
  modelId: 'default',
  autoReviewRules: [],
  status: 'IDLE',
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-01T12:00:00.000Z',
} as unknown as Bot;

const REPLY: TranscriptMessage = {
  id: 'clxaaaaaaaaaaaaaaaaaaaa1',
  author: 'BOT',
  parts: [
    { type: 'reasoning-block', text: 'weighing the options' },
    {
      type: 'tool-activity',
      calls: [
        {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: 'read_file',
          status: 'complete',
          input: {},
        },
      ],
    },
    { type: 'text', text: 'Done, the report is attached.' },
  ],
  timeLabel: '4:19 PM',
  dateLabel: 'Today',
};

function transcript(
  showBotWork: boolean | undefined,
  activity = false,
  messages = [REPLY],
): string {
  return renderToStaticMarkup(
    <Transcript
      bot={BOT}
      historyLoaded
      connection={{ status: 'connected', attempt: 0, retryDelayMs: null }}
      messages={messages}
      pending={[]}
      onSend={() => {}}
      onStop={() => {}}
      onFiles={() => {}}
      onRemovePending={() => {}}
      onRetryPending={() => {}}
      {...(showBotWork === undefined ? {} : { showBotWork })}
      {...(activity ? { activity: { startedAt: Date.now(), status: 'THINKING' as const } } : {})}
    />,
  );
}

describe('the bot’s work in the transcript', () => {
  it('removes hidden work-only messages from the layout, including their date and spacing', () => {
    const workOnly = Array.from({ length: 25 }, (_, index) => ({
      ...REPLY,
      id: `hidden-${index}`,
      parts: REPLY.parts.slice(0, 2),
      dateLabel: 'Yesterday',
    }));
    const messages = [...workOnly, REPLY];
    const off = transcript(false, false, messages);
    expect(off).not.toContain('data-motion-message="hidden-');
    expect(off).not.toContain('Yesterday');
    expect(off.match(/data-motion-message=/g)).toHaveLength(1);
    expect(transcript(true, false, messages).match(/data-motion-message=/g)).toHaveLength(26);
  });

  it('keeps incomplete replies and real system notices even when work is hidden', () => {
    const html = transcript(false, false, [
      { ...REPLY, id: 'interrupted', parts: [], stopReason: 'interrupted' },
      {
        ...REPLY,
        id: 'notice',
        author: 'SYSTEM',
        parts: [{ type: 'text', text: 'Continuing the work.' }],
      },
    ]);
    expect(html).toContain('Interrupted — this reply is incomplete.');
    expect(html).toContain('Continuing the work.');
  });
  it('shows only what the bot said when the switch is off', () => {
    const html = transcript(false);
    expect(html).toContain('Done, the report is attached.');
    expect(html).not.toContain('data-reasoning');
    expect(html).not.toContain('data-tool-activity');
  });

  it('shows the thinking and actions when it is on', () => {
    const html = transcript(true);
    expect(html).toContain('Done, the report is attached.');
    // The same markers the off case looks for, present here.
    expect(html).toContain('data-reasoning');
    expect(html).toContain('data-tool-activity');
  });

  it('still shows that a bot is thinking while it is, with the switch off', () => {
    expect(transcript(false, true)).toContain('Thinking for');
  });

  it('knows thinking and actions from speech', () => {
    for (const type of [
      'reasoning',
      'reasoning-block',
      'tool-call',
      'tool-result',
      'tool-activity',
    ]) {
      expect(isBotWorkPart(type)).toBe(true);
    }
    for (const type of ['text', 'system-event', 'file']) expect(isBotWorkPart(type)).toBe(false);
  });
});

describe('the preference', () => {
  it('is off unless it was turned on, and survives storage that refuses', () => {
    const store = (value: string | null) => ({ getItem: () => value, setItem: () => {} });
    expect(readShowBotWork(store(null))).toBe(false);
    expect(readShowBotWork(store('true'))).toBe(true);
    expect(readShowBotWork(store('false'))).toBe(false);
    expect(readShowBotWork(null)).toBe(false);
    const refusing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {},
    };
    expect(readShowBotWork(refusing)).toBe(false);
  });

  it('is a switch in Settings, off by default', () => {
    const html = renderToStaticMarkup(<ConversationsSection />);
    expect(html).toContain('Show thinking and actions');
    expect(html).toContain('data-show-bot-work');
    expect(html).toMatch(/<input[^>]*role="switch"/);
    expect(html).not.toMatch(/data-selected="true"/);
  });
});
