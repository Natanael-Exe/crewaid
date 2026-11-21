import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Bot } from '@crewaid/shared';
import type { Message, ToolCall } from '@ag-ui/core';
import { toTranscript } from '../src/renderer/chat/uiMessage';
import { Transcript } from '../src/renderer/components/Transcript';

/**
 * M5-FE-03 — an interrupted TURN reads as interrupted.
 *
 * `incompleteReason.test.tsx` covers the note itself: the vocabulary, and a
 * row that carries `stopReason: 'interrupted'`. What M5 adds is the two ways a
 * turn ends without finishing — R9's boot recovery (M5-BE-10) and a cancel
 * landing on a turn that had already run TOOLS — and neither of them is a
 * frame the window can count on seeing. The reason is a COLUMN, projected
 * onto every hydrated message as `metadata.crewaid.stopReason`, which is why
 * a turn whose process died mid-stream still reads as unfinished when the
 * thread is next read.
 *
 * So these cases drive the projection (`toTranscript`) and render its output,
 * not a hand-built view: what is proven is that the marker survives the path
 * a stored message actually takes, rather than that the component can render
 * a field. The clock-side half — a reply that has not ended yet carries no
 * reason, so the note cannot appear early — is proven on the same projection
 * by the absence of a stop reason while the thread is still generating.
 */

const BOT_ID = 'clx1a2b3c4d5e6f7g8h9i0j1';
const MSG = 'clxaaaaaaaaaaaaaaaaaaaa1';

const BOT: Bot = {
  id: BOT_ID,
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

const NOTE = 'Interrupted — this reply is incomplete.';

/** A stored tool call with its original arguments. */
const toolCall = (name: string, input: Record<string, unknown>): ToolCall => ({
  id: 'tc-1',
  type: 'function',
  function: { name, arguments: JSON.stringify(input) },
});

/**
 * This bot's reply as the server's operator view hands it over: the parts the
 * run produced, and the §3.4 projection beside them. `stopReason` is the one
 * field under test — `null` for a reply that has not ended.
 */
function reply(content: string, stopReason: string | null, toolCalls: ToolCall[] = []): Message {
  return {
    id: MSG,
    role: 'assistant',
    content,
    toolCalls,
    metadata: {
      tanstack: {
        createdAt: '2026-09-01T12:00:00.000Z',
        toolCallMetadata: { 'tc-1': { approval: { id: 'ap-1', needsApproval: true } } },
      },
      crewaid: {
        author: 'BOT',
        fromBotId: BOT_ID,
        runId: 'run-m5-fe-03',
        sequence: 1,
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

/**
 * The transcript as the operator sees it. `generating` is what the shell knows
 * about the thread, and it is the only thing that distinguishes a reply still
 * being written from one that stopped — the parts are the same either way.
 *
 * `approvals` is passed empty on purpose: the live prompt is the chat client's
 * own interrupt, and these cases are about what a STORED turn renders.
 */
function transcript(messages: readonly Message[], generating = false): string {
  return renderToStaticMarkup(
    <Transcript
      bot={BOT}
      connection={{ status: 'connected', attempt: 0, retryDelayMs: null }}
      messages={toTranscript(messages, BOT_ID, generating)}
      pending={[]}
      approvals={[]}
      onApprovalRespond={() => undefined}
      onSend={() => undefined}
      onStop={() => undefined}
      onFiles={() => undefined}
      onRemovePending={() => undefined}
      onRetryPending={() => undefined}
    />,
  );
}

describe('M5-FE-03 a cancelled turn', () => {
  it('says so once the turn ended, and not while it is still being written', () => {
    // `bot.cancel` deliberately does not drop the text the server already
    // kept, so the note has to arrive with the reply's own ending rather than
    // replace what was said. While the run is live there is no reason on the
    // message at all, which is what keeps the note off a reply that is merely
    // slow.
    const live = transcript([reply('A partial answ', null)], true);
    expect(live).not.toContain(NOTE);
    expect(live).toContain('A partial answ');

    const ended = transcript([reply('A partial answ', 'interrupted')]);
    expect(ended).toContain(NOTE);
    // M1-BE-08: the partial STAYS. The note explains it, never replaces it.
    expect(ended).toContain('A partial answ');
  });

  it('marks a reply that was interrupted before it said anything', () => {
    // A turn cancelled during its first model call persists an EMPTY partial.
    // The bubble is then nothing but the note, which is the honest render: a
    // reply that is silently absent is indistinguishable from one never asked
    // for.
    expect(transcript([reply('', 'interrupted')])).toContain(NOTE);
  });

  it('keeps the tool record beside the note when the turn ran tools first', () => {
    // The M5 shape: a turn that acted, then was stopped. M5-FE-01's tool parts
    // and this note describe different things — what the bot DID, and that it
    // did not finish — so the note must not displace them.
    const html = transcript([
      reply('', 'interrupted', [toolCall('browser_navigate', { url: 'https://example.com' })]),
    ]);
    expect(html).toContain(NOTE);
    expect(html).toContain('browser_navigate');
  });
});

describe('M5-FE-03 a turn interrupted by an orchestrator restart (R9 / M5-BE-10)', () => {
  it('reads as interrupted on a turn whose ending no live signal announced', () => {
    // The case a cancel cannot produce. The process died mid-stream, so
    // nothing was ever sent to say the turn had ended — recovery marked the
    // row INTERRUPTED durably, and the next read of the thread is the only
    // thing that can tell this window. Without the reason travelling on the
    // message, the operator watches a reply spin forever for a turn that
    // ended before they reconnected.
    const html = transcript([reply('Half an answer', 'interrupted')]);
    expect(html).toContain(NOTE);
    expect(html).toContain('Half an answer');
    // Exactly once. One stored message is one row: the recovered reply takes
    // the place of the one that was streaming rather than joining it, so a
    // reader never sees the same half-answer twice.
    expect(html.split(NOTE)).toHaveLength(2);
  });

  it('leaves no answerable question behind on a turn that will never answer it', () => {
    // M5-FE-02 leaves a live prompt on screen while a turn is suspended. A
    // turn that ended interrupted is not going to run that tool, so a prompt
    // left up is a button that does nothing — and D-032 says nothing resumes
    // it on its own.
    //
    // The prompt has exactly one source: the thread's live interrupts, which
    // an ended run has none of. So the fence is that a STORED approval
    // exchange cannot draw one — the message's copy of the question is a
    // record of what the bot asked, not a control.
    const html = transcript([reply('', 'interrupted', [toolCall('shell', { command: 'ls' })])]);
    expect(html).toContain(NOTE);
    expect(html).not.toContain('aria-label="Approve shell"');
    expect(html).not.toContain('aria-label="Decline shell"');
    // The record itself stays: what the bot was asking about is part of what
    // it did, and dropping it would leave the note unexplained.
    expect(html).toContain('shell');
  });
});
