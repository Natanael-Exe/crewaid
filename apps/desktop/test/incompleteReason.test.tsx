import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Bot } from '@crewaid/shared';
import { incompleteReason, type TranscriptMessage } from '../src/renderer/state/viewTypes';
import { Transcript } from '../src/renderer/components/Transcript';

/**
 * M1 acceptance: a reply that was interrupted must READ as interrupted.
 *
 * The orchestrator half of that criterion has always worked — the partial is
 * persisted at `stopReason: 'interrupted'`. The renderer dropped the field at
 * the wire-to-view boundary, so finished, interrupted and failed replies were
 * one silent stop on screen and a truncated answer looked like a short one.
 */

describe('incompleteReason', () => {
  it('says nothing about a reply that finished', () => {
    // The AI SDK's ordinary endings. `tool-calls` is a normal stop too — the
    // turn continues — and treating it as a failure would put a warning under
    // every tool-using reply from M5 onwards.
    expect(incompleteReason('stop')).toBeNull();
    expect(incompleteReason('tool-calls')).toBeNull();
  });

  it('says nothing while the reply is still arriving', () => {
    // A draft row and a USER message both reach here with no ending yet.
    expect(incompleteReason(null)).toBeNull();
    expect(incompleteReason(undefined)).toBeNull();
    expect(incompleteReason('')).toBeNull();
  });

  it('names an interrupted reply, however it was interrupted', () => {
    // The server writes this one value for BOTH an orchestrator restart
    // (M1-BE-07 recovery) and an operator cancel, so the copy must be true of
    // both: it reports the reply is incomplete, not why.
    expect(incompleteReason('interrupted')).toBe('Interrupted — this reply is incomplete.');
  });

  it('distinguishes the model-side endings a user can act on', () => {
    expect(incompleteReason('length')).toBe("Cut off at the model's length limit.");
    expect(incompleteReason('content-filter')).toBe("Stopped by the model's content filter.");
  });

  it('treats an unrecognised ending as unfinished and never prints it', () => {
    // A D-006 error code lands here — it is written for logs, so the note
    // must not quote it. Anything unknown fails towards "incomplete": passing
    // a half-written reply off as whole is the worse error.
    const note = incompleteReason('RATE_LIMITED');
    expect(note).toBe('This reply did not finish.');
    expect(note).not.toContain('RATE_LIMITED');
    expect(incompleteReason('something-a-future-sdk-invents')).toBe('This reply did not finish.');
  });
});

const BOT: Bot = {
  id: 'clx1a2b3c4d5e6f7g8h9i0j1',
  userId: 'usr_crewaid_singleton_v1',
  name: 'Quill',
  role: 'Outbound Writer',
  avatarColor: '#8B6F47',
  systemPrompt: 'You write outbound email.',
  modelId: 'default',
  status: 'IDLE',
  autoReviewRules: [],
  hiddenFromSidebar: false,
  createdAt: new Date('2026-09-01T12:00:00.000Z'),
  updatedAt: new Date('2026-09-01T12:00:00.000Z'),
};

function transcript(messages: readonly TranscriptMessage[]): string {
  return renderToStaticMarkup(
    <Transcript
      bot={BOT}
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

function reply(stopReason: string | null): TranscriptMessage {
  return {
    id: 'clxaaaaaaaaaaaaaaaaaaaa1',
    author: 'BOT',
    parts: [{ type: 'text', text: 'A partial answer' }],
    timeLabel: '12:00',
    stopReason,
  };
}

describe('the transcript marks an unfinished reply', () => {
  it('shows the note under an interrupted reply', () => {
    const html = transcript([reply('interrupted')]);
    expect(html).toContain('Interrupted — this reply is incomplete.');
    expect(html).toContain('data-incomplete-reason');
  });

  it('leaves a completed reply unmarked', () => {
    const html = transcript([reply('stop')]);
    expect(html).not.toContain('data-incomplete-reason');
  });

  it('still renders the partial text it did receive', () => {
    // M1-BE-08: the partial STAYS. The note explains it; it never replaces it.
    expect(transcript([reply('interrupted')])).toContain('A partial answer');
  });

  it('has one transcript scroller instead of a nested overflow container', () => {
    const html = transcript([reply('stop')]);
    expect(html).toContain('data-transcript-scroll="true"');
    const content = html.match(/<div data-transcript-content="true"[^>]*>/)?.[0];
    expect(content).toBeDefined();
    expect(content).not.toContain('overflow-y-auto');
  });
});
