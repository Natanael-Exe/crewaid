import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Bot } from '@crewaid/shared';
import { Transcript, type TranscriptWork } from '../src/renderer/components/Transcript';
import type { TranscriptMessage } from '../src/renderer/state/viewTypes';
import { taskDraftFromMessage, titleFromMessage } from '../src/renderer/work/fromMessage';
import { usageText } from '../src/renderer/work/workState';

/**
 * M10-FE-08 — the message menu (PRD-WORK §7.4, D-141): a task or a
 * deliverable made from a transcript message, and what a task's turns cost.
 */

const BOT = {
  id: 'clx1a2b3c4d5e6f7g8h9i0j1',
  userId: 'clx1a2b3c4d5e6f7g8h9i0j2',
  name: 'Atlas',
  role: 'Product manager',
  avatarColor: '#e0447c',
  systemPrompt: '',
  modelId: 'default',
  autoReviewRules: [],
  status: 'IDLE',
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-01T12:00:00.000Z',
} as unknown as Bot;

function message(id: string, text: string): TranscriptMessage {
  return {
    id,
    author: 'BOT',
    parts: [{ type: 'text', text }],
    timeLabel: '4:19 PM',
    dateLabel: 'Today',
  };
}

function transcript(messages: TranscriptMessage[], work: TranscriptWork | undefined): string {
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
      {...(work === undefined ? {} : { work })}
    />,
  );
}

const WORK: TranscriptWork = {
  onOpenTask: () => {},
  filedTask: () => undefined,
  onMessageAction: () => {},
};

describe('the message menu', () => {
  it('sits beside Copy on a settled message, and not on the reply still streaming', () => {
    const settled = message('clxaaaaaaaaaaaaaaaaaaaa1', 'The weekly report.');
    // D-192: the reply in flight is a row in the list, marked `live`. It has
    // no saved content yet, so there is nothing for the menu to act on.
    const live: TranscriptMessage = {
      ...message('clxaaaaaaaaaaaaaaaaaaaa2', 'Still writing'),
      live: true,
    };
    const html = transcript([settled, live], WORK);
    const bubbles = html.split('data-message-bubble').slice(1);
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]).toContain('data-message-menu');
    expect(bubbles[1]).toContain('data-copy-message');
    expect(bubbles[1]).not.toContain('data-message-menu');
  });

  it('is absent where the shell offers no Work actions', () => {
    const html = transcript([message('clxaaaaaaaaaaaaaaaaaaaa1', 'Hello.')], {
      onOpenTask: () => {},
      filedTask: () => undefined,
    });
    expect(html).toContain('data-copy-message');
    expect(html).not.toContain('data-message-menu');
  });
});

describe('a draft from a message', () => {
  it('titles it by its first line, markdown taken off', () => {
    expect(titleFromMessage('\n## **Weekly** report\n\nChurn is down.')).toBe('Weekly report');
    expect(titleFromMessage('- `Renew` the domain')).toBe('Renew the domain');
    expect(titleFromMessage('   ')).toBe('');
  });

  it('cuts a long first line at a word, near 80 characters', () => {
    const title = titleFromMessage(`${'word '.repeat(30)}end`);
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(81);
    expect(title).not.toMatch(/wor…$/);
  });

  it('quotes the whole message as the brief, within the brief’s bound', () => {
    expect(taskDraftFromMessage('Fix login.\n\nIt 500s on Safari.')).toEqual({
      title: 'Fix login.',
      brief: '> Fix login.\n>\n> It 500s on Safari.',
    });
    expect(taskDraftFromMessage('x'.repeat(30_000)).brief).toHaveLength(20_000);
  });
});

describe('what work cost', () => {
  it('says nothing for work no turn ran on', () => {
    expect(usageText({ turns: 0, inputTokens: 0, outputTokens: 0 })).toBeNull();
  });

  it('counts turns and tokens, short', () => {
    expect(usageText({ turns: 1, inputTokens: 940, outputTokens: 12 })).toBe(
      '1 turn · 940 tokens in, 12 out',
    );
    expect(usageText({ turns: 3, inputTokens: 12_400, outputTokens: 1_850 })).toBe(
      '3 turns · 12k tokens in, 1.9k out',
    );
    expect(usageText({ turns: 40, inputTokens: 1_234_567, outputTokens: 5_000 })).toBe(
      '40 turns · 1.2M tokens in, 5k out',
    );
  });
});
