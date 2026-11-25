import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Bot } from '@crewaid/shared';
import { Transcript } from '../src/renderer/components/Transcript';
import { toTranscriptRows } from '../src/renderer/state/transcriptRows';
import type { TranscriptMessage } from '../src/renderer/state/viewTypes';

/**
 * D-091 — a turn is bubbles of speech with its work between them.
 *
 * What this replaces: every part of a turn went inside ONE bubble, so a long
 * agentic reply rendered as a single grey slab holding four paragraphs, eleven
 * thinking blocks, an action log and a timestamp.
 */

describe('toTranscriptRows', () => {
  it('gives every text part its own bubble and everything else a quiet row', () => {
    const rows = toTranscriptRows([
      { type: 'reasoning-block', text: 'thinking' },
      { type: 'text', text: 'First finding.' },
      { type: 'tool-activity', calls: [] },
      { type: 'text', text: 'Second finding.' },
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['aside', 'bubble', 'aside', 'bubble']);
  });

  it('drops an empty text part rather than rendering an empty bubble', () => {
    // The SDK emits one for a step that only called a tool.
    expect(toTranscriptRows([{ type: 'text', text: '   ' }])).toEqual([]);
  });

  it('treats an unknown part as work, not as something the bot said', () => {
    const rows = toTranscriptRows([{ type: 'some-future-part', text: 'x' }]);
    expect(rows[0]?.kind).toBe('aside');
  });
});

const BOT: Bot = {
  id: 'clx1a2b3c4d5e6f7g8h9i0j1',
  userId: 'clx1a2b3c4d5e6f7g8h9i0j2',
  name: 'Nathan Bot',
  role: 'Senior Frontend',
  avatarColor: '#e0447c',
  systemPrompt: '',
  modelId: 'default',
  autoReviewRules: [],
  status: 'IDLE',
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-01T12:00:00.000Z',
} as unknown as Bot;

function message(overrides: Partial<TranscriptMessage>): TranscriptMessage {
  return {
    id: 'clxaaaaaaaaaaaaaaaaaaaa1',
    author: 'BOT',
    parts: [],
    timeLabel: '4:19 PM',
    dateLabel: 'Today',
    ...overrides,
  };
}

function transcript(messages: TranscriptMessage[], historyLoaded = false): string {
  return renderToStaticMarkup(
    <Transcript
      bot={BOT}
      historyLoaded={historyLoaded}
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

describe('Transcript', () => {
  it.each(['USER', 'BOT'] as const)('keeps two %s attachments in their author’s lane', (author) => {
    const html = transcript([
      message({
        author,
        attachments: ['resume.pdf', 'resume-ai.pdf'].map((filename, index) => ({
          id: `file-${index}`,
          filename,
          mimeType: 'application/pdf',
          sizeBytes: 1024,
        })),
      }),
    ]);
    const lane = author === 'USER' ? 'user' : 'bot';
    const alignment = author === 'USER' ? 'justify-end' : 'justify-start';
    expect(html).toContain(`data-message-attachments="${lane}" class="flex ${alignment} px-1"`);
    expect(html.match(/data-attachment-card=/g)).toHaveLength(2);
  });

  it('shows an accessible loading indicator until history arrives', () => {
    const loading = transcript([], false);
    expect(loading).toContain('data-transcript-loading');
    expect(loading).toContain('role="status"');
    expect(loading).toContain('Loading conversation…');
    expect(loading).not.toContain('What are we working on?');
    expect(transcript([], true)).not.toContain('data-transcript-loading');
  });
  it('renders one bubble per thing the bot said, not one per turn', () => {
    const html = transcript([
      message({
        parts: [
          { type: 'text', text: 'All ten verdicts are in.' },
          { type: 'tool-activity', calls: [] },
          { type: 'text', text: 'Pricing next.' },
        ],
      }),
    ]);
    expect(html.match(/data-message-bubble="bot"/g)).toHaveLength(2);
  });

  it('dates the day separator, and keeps the bubble’s own time for hover', () => {
    const html = transcript([message({ parts: [{ type: 'text', text: 'hi' }] })]);
    const visible = html.replace(/<[^>]*>/g, ' ');
    expect(visible).toContain('Today 4:19 PM');
    // Reachable on hover, which is where an exact time is actually wanted.
    expect(html).toContain('title="Today 4:19 PM"');
  });

  it('hides the time and copy button until the message is hovered, inside a floating side pill', () => {
    // Revealed rather than conditionally rendered, so nothing resizes as the
    // pointer crosses the transcript. The hover group belongs to the bubble:
    // a turn may contain several independently actionable bubbles.
    const html = transcript([
      message({ author: 'BOT', parts: [{ type: 'text', text: 'hi' }] }),
      message({ id: 'clxaaaaaaaaaaaaaaaaaaaa2', author: 'USER', parts: [{ type: 'text', text: 'yo' }] }),
    ]);
    expect(html).toContain('data-copy-message');
    expect(html).toContain('group/bubble');
    expect(html).toContain('opacity-0');
    expect(html).toContain('group-hover/bubble:opacity-100');
    // And for the keyboard, which cannot hover.
    expect(html).toContain('group-focus-within/bubble:opacity-100');
    expect(html).toContain('crewaid-bubble-footer-pill');
    expect(html).toContain('data-footer-side="end"');
    expect(html).toContain('data-footer-side="start"');
    expect(html).toContain('data-footer-tone="bot"');
    expect(html).toContain('data-footer-tone="user"');
    expect(html).toContain('bg-message-bot');
    expect(html).toContain('bg-message-user');
    // Copy sits closest to the bubble edge on both sides (before time on bot, after time on user).
    const botPill = html.slice(html.indexOf('data-footer-tone="bot"'), html.indexOf('data-footer-side="start"'));
    expect(botPill.indexOf('data-copy-message')).toBeLessThan(botPill.indexOf('4:19 PM'));
    const userPill = html.slice(html.indexOf('data-footer-tone="user"'));
    expect(userPill.indexOf('4:19 PM')).toBeLessThan(userPill.indexOf('data-copy-message'));
  });

  it('puts one copy action on each speech bubble, not at the bottom of the turn', () => {
    const html = transcript([
      message({
        parts: [
          { type: 'reasoning-block', text: 'private thinking' },
          { type: 'text', text: 'First finding.' },
          { type: 'tool-activity', calls: [] },
          { type: 'text', text: 'Second finding.' },
        ],
      }),
    ]);
    expect(html.match(/data-copy-message/g)).toHaveLength(2);
    expect(html.match(/group\/bubble/g)).toHaveLength(2);
  });

  it('gives a message that only acted no footer at all', () => {
    const html = transcript([message({ parts: [{ type: 'tool-activity', calls: [] }] })]);
    expect(html).not.toContain('data-copy-message');
  });

  it('renders a turn that only acted with no bubble at all', () => {
    const html = transcript([message({ parts: [{ type: 'tool-activity', calls: [] }] })]);
    expect(html).not.toContain('data-message-bubble');
  });

  it('hides messages that only contain leaked model control directives like budget:token_budget', () => {
    const html = transcript([
      message({
        parts: [{ type: 'text', text: '<budget:token_budget>200000</budget:token_budget>' }],
      }),
    ]);
    expect(html).not.toContain('data-message-bubble');
    expect(html).not.toContain('token_budget');
    expect(html).not.toContain('[blocked]');
  });

  it('strips leaked budget directives from mixed bot replies without rendering [blocked]', () => {
    const html = transcript([
      message({
        parts: [
          {
            type: 'text',
            text: 'Payment received.\n\n<budget:token_budget>200000</budget:token_budget>',
          },
        ],
      }),
    ]);
    expect(html).toContain('Payment received.');
    expect(html).not.toContain('token_budget');
    expect(html).not.toContain('[blocked]');
  });
});

describe('an empty conversation', () => {
  const PROMPT = 'What should Nathan Bot work on?';

  it('asks what the bot should work on once its history is known to be empty', () => {
    expect(transcript([], true)).toContain(PROMPT);
  });

  it('waits for the history, so switching to a busy bot does not flash it', () => {
    expect(transcript([], false)).not.toContain(PROMPT);
  });

  it('gives way to the first message', () => {
    const html = transcript([message({ parts: [{ type: 'text', text: 'hi' }] })], true);
    expect(html).not.toContain(PROMPT);
  });
});

describe('long transcripts', () => {
  // The browser skips laying out an off-screen message with
  // `content-visibility: auto`. The newest ones must never be skipped: a
  // reply that grew after it was last measured would snap to a stale height
  // when it scrolled off, and the view would drift.
  it('lets the browser skip older messages but always lays out the newest six', () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      message({
        id: `clxaaaaaaaaaaaaaaaaaaa${String(i).padStart(2, '0')}`,
        author: i % 2 === 0 ? 'USER' : 'BOT',
        parts: [{ type: 'text', text: `message ${String(i)}` }],
      }),
    );
    const html = transcript(messages, true);
    const skippable = [...html.matchAll(/content-visibility:auto/g)].length;
    expect(skippable).toBe(4);
    // The skippable ones are the OLDEST: the first row carries it, the last does not.
    const first = html.indexOf('message 0');
    const last = html.indexOf('message 9');
    expect(html.lastIndexOf('content-visibility:auto', first)).toBeGreaterThan(-1);
    expect(html.lastIndexOf('content-visibility:auto', last)).toBeLessThan(
      html.indexOf('message 3'),
    );
  });
});
