import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Bot } from '@crewaid/shared';
import type { Message } from '@ag-ui/core';
import { toTranscript } from '../src/renderer/chat/uiMessage';
import { QueuedMessageList } from '../src/renderer/components/composer/QueuedMessageRow';
import { Transcript } from '../src/renderer/components/Transcript';
import { VisualCard } from '../src/renderer/components/visuals/VisualCard';
import { liveWorkPhase, WorkingIndicator } from '../src/renderer/components/WorkingIndicator';
import {
  coalesceDeliveryReceipts,
  findExchangeMessageId,
} from '../src/renderer/state/transcriptRows';
import {
  readPersistedQueues,
  setQueuedNotice,
  writePersistedQueues,
  type MessageQueues,
} from '../src/renderer/state/messageQueue';
import type { TranscriptMessage } from '../src/renderer/state/viewTypes';

const SELF = 'clx1a2b3c4d5e6f7g8h9i0j1';
const DIANA = 'clx2b3c4d5e6f7g8h9i0j1k2';

const BOT: Bot = {
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

const PEERS = [
  { id: SELF, name: 'Gideon', role: 'PM', avatarColor: '#8b6f47' },
  { id: DIANA, name: 'Diana', role: 'Researcher', avatarColor: '#1d9bf0' },
];

function msg(over: Partial<TranscriptMessage>): TranscriptMessage {
  return {
    id: 'm1',
    author: 'BOT',
    parts: [],
    timeLabel: '11:32 AM',
    dateLabel: 'Today',
    createdAt: Date.parse('2026-11-25T11:32:00.000Z'),
    ...over,
  };
}

describe('Phase 1 — calm transcript, peer handoffs, receipts, and Stop and send', () => {
  it('folds pre-tool assistant narration out of speech bubbles', () => {
    const raw: Message[] = [
      {
        id: 'step-1',
        role: 'assistant',
        content: 'Let me check the audit file first.',
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'fs_read', arguments: '{"path":"a.md"}' } },
        ],
      } as Message,
      { id: 'res-1', role: 'tool', toolCallId: 'c1', content: 'ok' } as Message,
      { id: 'final', role: 'assistant', content: 'The audit is ready for Gate 1.' } as Message,
    ];
    const projected = toTranscript(raw, SELF, false);

    const calm = renderToStaticMarkup(
      <Transcript
        bot={BOT}
        peers={PEERS}
        historyLoaded
        showBotWork={false}
        connection={{ status: 'connected', attempt: 0, retryDelayMs: null }}
        messages={projected}
        pending={[]}
        onSend={() => {}}
        onStop={() => {}}
        onFiles={() => {}}
        onRemovePending={() => {}}
        onRetryPending={() => {}}
      />,
    );
    expect(calm).toContain('The audit is ready for Gate 1.');
    expect(calm).not.toContain('Let me check the audit file first.');
    expect(calm.match(/data-message-bubble="bot"/g)).toHaveLength(1);

    const verbose = renderToStaticMarkup(
      <Transcript
        bot={BOT}
        peers={PEERS}
        historyLoaded
        showBotWork={true}
        connection={{ status: 'connected', attempt: 0, retryDelayMs: null }}
        messages={projected}
        pending={[]}
        onSend={() => {}}
        onStop={() => {}}
        onFiles={() => {}}
        onRemovePending={() => {}}
        onRetryPending={() => {}}
      />,
    );
    expect(verbose).toContain('data-work-note');
    expect(verbose).toContain('Let me check the audit file first.');
    expect(verbose.match(/data-message-bubble="bot"/g)).toHaveLength(1);
  });

  it('derives trusted live status labels from active tools rather than pre-tool prose', () => {
    const live = msg({
      live: true,
      parts: [
        { type: 'work-note', text: 'I am about to inspect the board and some files...' },
        {
          type: 'tool-activity',
          calls: [
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'fs_read',
              input: { path: '/home/bot/shared/audit.md' },
              status: 'running',
            },
          ],
        },
      ],
    });
    const phase = liveWorkPhase([live], 'ACTING');
    expect(phase).toBe('Reviewing files');
    const html = renderToStaticMarkup(
      <WorkingIndicator
        bot={{ name: 'Gideon', avatarColor: '#8b6f47' }}
        startedAt={Date.now() - 4000}
        status="ACTING"
        phase={phase}
      />,
    );
    expect(html).toContain('Reviewing files for');
    expect(html).not.toContain('I am about to inspect');
  });

  it('collapses long incoming peer handoffs to 2-line preview with Show full message and return pill', () => {
    const longMemo =
      'Competitor research is locked to draft and ready for positioning.\n\n' +
      'File: /home/bot/groups/cmww0x3x30000zq3blkyzxvz0/00-research/competitor-claims.md.\n\n' +
      '1. White space: no competitor shows a multi-agent handoff completing end to end. ' +
      '2. Pricing: zero cost-per-task or time-saved proof points appear on any competitor homepage.';
    const html = renderToStaticMarkup(
      <Transcript
        bot={BOT}
        peers={PEERS}
        historyLoaded
        showBotWork={false}
        returnTo={{ botName: 'Gideon', onReturn: () => {} }}
        connection={{ status: 'connected', attempt: 0, retryDelayMs: null }}
        messages={[
          msg({
            id: 'peer-1',
            fromBotId: DIANA,
            parts: [{ type: 'text', text: longMemo }],
          }),
        ]}
        pending={[]}
        onSend={() => {}}
        onStop={() => {}}
        onFiles={() => {}}
        onRemovePending={() => {}}
        onRetryPending={() => {}}
      />,
    );
    expect(html).toContain('data-peer-preview');
    expect(html).toContain('Show full message');
    expect(html).toContain('11:32 AM');
    expect(html).toContain('competitor-claims.md');
    expect(html).not.toContain('/home/bot/groups/cmww0x3x30000zq3blkyzxvz0');
    expect(html).toContain('data-return-to-bot');
    expect(html).toContain('Back to Gideon');
  });

  it('groups consecutive successful delivery receipts while keeping delivery failures visible', () => {
    const rows = [
      msg({
        id: 'r1',
        author: 'SYSTEM',
        parts: [{ type: 'text', text: 'Your message to Diana was delivered to their conversation.' }],
      }),
      msg({
        id: 'r2',
        author: 'SYSTEM',
        parts: [{ type: 'text', text: 'Your message to Julian was delivered to their conversation.' }],
      }),
      msg({
        id: 'fail',
        author: 'SYSTEM',
        parts: [
          {
            type: 'text',
            text: 'Your message to Kira could not be delivered (timeout), so it never reached their conversation.',
          },
        ],
      }),
    ];
    const grouped = coalesceDeliveryReceipts(rows);
    expect(grouped).toHaveLength(2);
    const html = renderToStaticMarkup(
      <Transcript
        bot={BOT}
        peers={PEERS}
        historyLoaded
        showBotWork={false}
        connection={{ status: 'connected', attempt: 0, retryDelayMs: null }}
        messages={rows}
        pending={[]}
        onSend={() => {}}
        onStop={() => {}}
        onFiles={() => {}}
        onRemovePending={() => {}}
        onRetryPending={() => {}}
      />,
    );
    expect(html).toContain('data-delivery-receipts="2"');
    expect(html).toContain('Delivered to 2 teammates');
    expect(html).toContain('could not be delivered');
  });

  it('finds the exact peer exchange message from send_message tool call or chain fallback', () => {
    const senderMsgs = [
      msg({
        id: 'send-step',
        chainId: 'chain-1',
        createdAt: 1000,
        parts: [
          {
            type: 'tool-activity',
            calls: [
              {
                type: 'tool-call',
                toolCallId: 'c1',
                toolName: 'send_message',
                input: {
                  to: 'Gideon',
                  message: 'Competitor research is locked and ready for Gate 1 review.',
                },
                status: 'ok',
              },
            ],
          },
        ],
      }),
      msg({ id: 'later', chainId: 'chain-2', createdAt: 900_000, parts: [{ type: 'text', text: 'Later' }] }),
    ];
    expect(
      findExchangeMessageId(senderMsgs, {
        chainId: 'chain-1',
        timestamp: 1500,
        excerpt: 'Competitor research is locked and ready for Gate 1 review.',
      }),
    ).toBe('send-step');
  });

  it('masks internal sandbox paths in VisualCard titles, subtitles, sources, and notes', () => {
    const html = renderToStaticMarkup(
      <VisualCard
        status="ok"
        row={{
          type: 'tool-call',
          toolCallId: 'v1',
          toolName: 'present_visual',
          status: 'ok',
          input: {
            title: 'Audit for /home/bot/groups/cmww0x3x30000zq3blkyzxvz0/00-research/claims.md',
            subtitle: 'Generated from /home/bot/shared/BOARD.md',
            blocks: [
              {
                kind: 'table',
                source: { file: '/home/bot/groups/cmww0x3x30000zq3blkyzxvz0/evidence/summary.csv' },
              },
            ],
          },
          output: JSON.stringify({
            version: 1,
            resolved: {
              '0': {
                kind: 'table',
                cols: ['Artifact', 'Status'],
                rows: [['claims.md', 'Ready']],
              },
            },
            sources: ['/home/bot/groups/cmww0x3x30000zq3blkyzxvz0/evidence/summary.csv'],
            notes: ['Saved under /home/bot/agents/cmww0x3x30000zq3blkyzxvz0/notes.md'],
          }),
        }}
      />,
    );
    expect(html).toContain('claims.md');
    expect(html).toContain('BOARD.md');
    expect(html).toContain('summary.csv');
    expect(html).toContain('notes.md');
    expect(html).not.toContain('/home/bot/');
  });

  it('renders Queued badge, Stop and send action, target-changed notice, and persists targetRunId', () => {
    const store = new Map<string, string>();
    const fakeStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
    const queues: MessageQueues = {
      [SELF]: [
        {
          localId: 'q1',
          messageId: 'msg-uuid-1',
          targetRunId: 'run-1',
          text: 'Wrap up now and send me the links',
          attachmentIds: [],
        },
      ],
    };
    writePersistedQueues(fakeStorage, 'k', queues);
    expect(readPersistedQueues(fakeStorage, 'k')[SELF]?.[0]).toEqual({
      localId: 'q1',
      messageId: 'msg-uuid-1',
      targetRunId: 'run-1',
      text: 'Wrap up now and send me the links',
      attachmentIds: [],
    });

    const withNotice = setQueuedNotice(
      queues,
      SELF,
      'q1',
      'The bot moved to a new step. Press Stop and send again to interrupt it.',
      'run-2',
    );
    expect(withNotice[SELF]?.[0]?.targetRunId).toBe('run-2');

    const html = renderToStaticMarkup(
      <QueuedMessageList
        items={withNotice[SELF] ?? []}
        streaming={true}
        onEdit={() => {}}
        onRemove={() => {}}
        onSendNow={() => {}}
        onMove={() => {}}
      />,
    );
    expect(html).toContain('data-queued-badge');
    expect(html).toContain('Queued');
    expect(html).toContain('data-stop-and-send');
    expect(html).toContain('Stop and send');
    expect(html).toContain('data-queued-notice');
    expect(html).toContain('Press Stop and send again');
  });
});
