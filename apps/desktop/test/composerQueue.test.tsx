import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import { Composer } from '../src/renderer/components/composer/Composer';
import { QueuedMessageList } from '../src/renderer/components/composer/QueuedMessageRow';
import type { QueuedMessage } from '../src/renderer/state/messageQueue';

/**
 * CC-45 — what the composer does with a draft typed while the bot is busy.
 *
 * Before this the keystroke was swallowed: Enter during a turn did nothing at
 * all, and the draft simply sat there until the reply landed.
 */

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
}

const QUEUED: QueuedMessage[] = [
  { localId: 'q1', text: 'and check the pricing page', attachmentIds: [] },
  { localId: 'q2', text: 'then write it up', attachmentIds: [] },
];

function composer(props: Partial<React.ComponentProps<typeof Composer>> = {}): string {
  return render(
    <Composer
      botId="clx1a2b3c4d5e6f7g8h9i0j1"
      botModelId="default"
      botName="Nathan Bot"
      streaming={false}
      pending={[]}
      onSend={() => {}}
      onStop={() => {}}
      onFiles={() => {}}
      onRemovePending={() => {}}
      onRetryPending={() => {}}
      {...props}
    />,
  );
}

describe('the composer while the bot is working', () => {
  it('invites the operator to keep typing instead of offering to send', () => {
    const busy = composer({ streaming: true, onQueue: () => {} });
    expect(busy).toContain('Keep typing');
    expect(busy).not.toContain('placeholder="Message Nathan Bot"');
    // The turn's own control stays: queueing is not a substitute for stopping.
    expect(busy).toContain('aria-label="Stop generating"');
  });

  it('says the ordinary thing when the bot is idle', () => {
    expect(composer()).toContain('placeholder="Message Nathan Bot"');
  });

  it('keeps queueing while anything is still waiting, even between turns', () => {
    // The drain posts one message per turn, so there is a moment when the bot
    // looks idle and two messages are outstanding. Sending directly in that
    // window would put the new message ahead of ones typed before it.
    const between = composer({ streaming: false, queued: QUEUED, onQueue: () => {} });
    expect(between).toContain('Keep typing');
  });
});

describe('the queue above the composer', () => {
  it('renders nothing at all when nothing is waiting', () => {
    expect(
      render(
        <QueuedMessageList
          items={[]}
          onEdit={() => {}}
          onRemove={() => {}}
          onSendNow={() => {}}
          onMove={() => {}}
        />,
      ),
    ).toBe('');
  });

  it('offers the three things that stop being possible once a message is sent', () => {
    const html = render(
      <QueuedMessageList
        items={QUEUED}
        onEdit={() => {}}
        onRemove={() => {}}
        onSendNow={() => {}}
        onMove={() => {}}
      />,
    );
    expect(html).toContain('data-queued-message="q1"');
    expect(html).toContain('data-queued-message="q2"');
    expect(html).toContain('aria-label="Edit &quot;and check the pricing page&quot;"');
    expect(html).toContain('aria-label="Remove &quot;and check the pricing page&quot;"');
    expect(html).toContain('aria-label="Send &quot;and check the pricing page&quot; now"');
    // Reordering is native drag and drop — no dependency, no pointer
    // bookkeeping, and the browser's drag image is the row itself.
    expect(html).toContain('draggable="true"');
  });

  it('counts what is waiting, and says when a single one will go', () => {
    const one = render(
      <QueuedMessageList
        items={[QUEUED[0]!]}
        onEdit={() => {}}
        onRemove={() => {}}
        onSendNow={() => {}}
        onMove={() => {}}
      />,
    );
    expect(one).toContain('sends when this turn ends');
    const two = render(
      <QueuedMessageList
        items={QUEUED}
        onEdit={() => {}}
        onRemove={() => {}}
        onSendNow={() => {}}
        onMove={() => {}}
      />,
    );
    expect(two).toContain('2 queued');
  });
});
