import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Bot } from '@crewaid/shared';
import type { ChatError } from '../src/renderer/state/chatReducer';
import { Transcript } from '../src/renderer/components/Transcript';

/**
 * D-228 — the failure banner above the composer says what happened and what
 * to do, and, when the provider gave its own reason, quotes it attributed.
 */

const BOT: Bot = {
  id: 'clx1a2b3c4d5e6f7g8h9i0j1',
  userId: 'usr_crewaid_singleton_v1',
  name: 'Ben',
  role: 'CTO',
  avatarColor: '#8B6F47',
  systemPrompt: '',
  modelId: 'default',
  status: 'IDLE',
  autoReviewRules: [],
  hiddenFromSidebar: false,
  createdAt: new Date('2026-09-01T12:00:00.000Z'),
  updatedAt: new Date('2026-09-01T12:00:00.000Z'),
};

function banner(error: ChatError): string {
  const html = renderToStaticMarkup(
    <Transcript
      bot={BOT}
      connection={{ status: 'connected', attempt: 0, retryDelayMs: null }}
      messages={[]}
      pending={[]}
      error={error}
      onSend={() => undefined}
      onStop={() => undefined}
      onFiles={() => undefined}
      onRemovePending={() => undefined}
      onRetryPending={() => undefined}
    />,
  );
  const start = html.indexOf('data-transcript-error');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</div></div>', start));
}

describe('the failure banner (D-228)', () => {
  const SENTENCE = 'The provider would not let the bot use this model.';

  it('quotes the provider’s reason under the sentence, attributed', () => {
    const html = banner({
      code: 'AUTH_FAILED',
      message: SENTENCE,
      explanation: {
        source: 'OpenCode',
        text: "OpenCode's free tier can only be used from within OpenCode.",
      },
    });
    expect(html).toContain(SENTENCE);
    expect(html).toContain('data-provider-explanation');
    expect(html).toContain(
      'OpenCode says: “OpenCode&#x27;s free tier can only be used from within OpenCode.”',
    );
    expect(html.indexOf(SENTENCE)).toBeLessThan(html.indexOf('OpenCode says'));
  });

  it('shows the sentence alone when the provider said nothing usable', () => {
    const html = banner({ code: 'RATE_LIMITED', message: SENTENCE });
    expect(html).toContain(SENTENCE);
    expect(html).not.toContain('data-provider-explanation');
    expect(html).not.toContain('says:');
  });

  it('renders a Try again button beside the error message when onRetryError is supplied', () => {
    const html = renderToStaticMarkup(
      <Transcript
        bot={BOT}
        connection={{ status: 'connected', attempt: 0, retryDelayMs: null }}
        messages={[]}
        pending={[]}
        error={{ code: 'SEND_FAILED', message: 'Your message could not be sent. Try again.' }}
        onRetryError={() => undefined}
        onSend={() => undefined}
        onStop={() => undefined}
        onFiles={() => undefined}
        onRemovePending={() => undefined}
        onRetryPending={() => undefined}
      />,
    );
    expect(html).toContain('data-transcript-retry="true"');
    expect(html).toContain('>Try again<');
  });
});
