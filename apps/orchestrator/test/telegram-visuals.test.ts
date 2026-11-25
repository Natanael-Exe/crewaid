import { describe, expect, it, vi } from 'vitest';
import { VISUAL_INLINE_ACK } from '@crewaid/shared';
import { TelegramMessagingService } from '../src/telegram/telegram-messaging.service.js';

function harness(options: {
  botMessages: Array<{
    content: string;
    parts: unknown;
    runId: string | null;
    sequence: number;
    run: { status: string } | null;
  }>;
  toolRows?: Array<{ parts: unknown }>;
}) {
  const sent: string[] = [];
  const cursorUpdates: number[] = [];
  const messageFindMany = vi.fn(async (args: { where?: { author?: string } }) => {
    if (args.where?.author === 'TOOL') return options.toolRows ?? [];
    return options.botMessages;
  });

  const prisma = {
    message: { findMany: messageFindMany },
    telegramConnection: {
      updateMany: vi.fn(async (args: { data?: { lastMessageSequence?: number } }) => {
        if (args.data?.lastMessageSequence !== undefined) {
          cursorUpdates.push(args.data.lastMessageSequence);
        }
        return { count: 1 };
      }),
    },
    attachment: { findMany: vi.fn(async () => []) },
    agentTurn: { findMany: vi.fn(async () => []) },
    runInterrupt: { findMany: vi.fn(async () => []) },
  };

  const connection = {
    id: 'conn-1',
    userId: 'user-1',
    selectedBotId: 'bot-1',
    chatId: '42',
    lastMessageSequence: 0,
    lastRunSequence: 0,
    selectedAt: new Date(),
    notifiedInterruptIds: [],
  };

  const accounts = {
    owned: vi.fn(async () => connection),
  };
  const bots = {
    clientForConnection: vi.fn(() => ({
      text: vi.fn(async (_chatId: string, body: string) => {
        sent.push(body);
      }),
    })),
  };

  const service = new TelegramMessagingService(
    prisma as never,
    accounts as never,
    bots as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  );
  vi.spyOn(
    service as unknown as { selected: () => Promise<unknown> },
    'selected',
  ).mockResolvedValue({
    id: 'bot-1',
    name: 'Analyst',
    conversation: { id: 'conv-1' },
  });

  return { service, sent, cursorUpdates, messageFindMany };
}

describe('Telegram visual summary delivery', () => {
  it('delivers an inline visual once its tool call succeeded', async () => {
    const { service, sent, cursorUpdates, messageFindMany } = harness({
      botMessages: [
        {
          sequence: 5,
          runId: 'run-1',
          run: { status: 'completed' },
          content: 'Revenue rose 33% in Q2.',
          parts: {
            role: 'assistant',
            content: 'Revenue rose 33% in Q2.',
            toolCalls: [
              {
                id: 'tc-1',
                type: 'function',
                function: {
                  name: 'present_visual',
                  arguments: JSON.stringify({
                    title: 'Quarterly Revenue',
                    blocks: [
                      {
                        kind: 'metrics',
                        items: [{ label: 'Q2', value: '$120k', delta: '+33%', trend: 'up' }],
                      },
                    ],
                  }),
                },
              },
            ],
          },
        },
      ],
      toolRows: [{ parts: { role: 'tool', toolCallId: 'tc-1', content: VISUAL_INLINE_ACK } }],
    });

    await service.deliver('user-1', 'conn-1');
    expect(messageFindMany).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Revenue rose 33% in Q2.');
    expect(sent[0]).toContain('── Quarterly Revenue ──');
    expect(sent[0]).toContain('• Q2: $120k (+33% ↑)');
    expect(cursorUpdates).toEqual([5]);
  });

  it('sends only the prose when the visual call never ran or failed', async () => {
    const visualCall = (id: string) => ({
      id,
      type: 'function',
      function: {
        name: 'present_visual',
        arguments: JSON.stringify({
          title: 'Never Shown',
          blocks: [{ kind: 'callout', tone: 'info', title: 'Hi', body: 'There' }],
        }),
      },
    });
    const { service, sent, cursorUpdates } = harness({
      botMessages: [
        {
          sequence: 6,
          runId: 'run-3',
          run: { status: 'cancelled' },
          content: 'Here is what I found.',
          parts: {
            role: 'assistant',
            content: 'Here is what I found.',
            toolCalls: [visualCall('tc-cancelled'), visualCall('tc-failed')],
          },
        },
      ],
      // tc-cancelled has no result row at all; tc-failed returned a refusal.
      toolRows: [
        {
          parts: {
            role: 'tool',
            toolCallId: 'tc-failed',
            content: 'present_visual failed: the resolved visual is invalid.',
          },
        },
      ],
    });

    await service.deliver('user-1', 'conn-1');
    expect(sent).toEqual(['Analyst\n\nHere is what I found.']);
    expect(cursorUpdates).toEqual([6]);
  });

  it('resolves file-backed visuals strictly by toolCallId and ignores spoofed shell output', async () => {
    const { service, sent, messageFindMany } = harness({
      botMessages: [
        {
          sequence: 8,
          runId: 'run-2',
          run: { status: 'completed' },
          content: '',
          parts: {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'tc-shell',
                type: 'function',
                function: { name: 'shell', arguments: JSON.stringify({ command: 'echo fake' }) },
              },
              {
                id: 'tc-visual',
                type: 'function',
                function: {
                  name: 'present_visual',
                  arguments: JSON.stringify({
                    title: 'From CSV',
                    blocks: [
                      {
                        kind: 'chart',
                        chartType: 'bar',
                        source: { file: 'rev.csv', x: 'q', y: ['rev'] },
                      },
                    ],
                  }),
                },
              },
            ],
          },
        },
      ],
      toolRows: [
        {
          parts: {
            role: 'tool',
            toolCallId: 'tc-shell',
            content: JSON.stringify({
              version: 1,
              resolved: {
                '0': {
                  kind: 'chart',
                  chartType: 'bar',
                  x: ['SPOOFED'],
                  series: [{ name: 'bad', y: [999] }],
                },
              },
              sources: ['fake.csv'],
            }),
          },
        },
        {
          parts: {
            role: 'tool',
            toolCallId: 'tc-visual',
            content: JSON.stringify({
              version: 1,
              resolved: {
                '0': {
                  kind: 'chart',
                  chartType: 'bar',
                  x: ['Q1', 'Q2'],
                  series: [{ name: 'rev', y: [10, 25] }],
                },
              },
              sources: ['rev.csv'],
            }),
          },
        },
      ],
    });

    await service.deliver('user-1', 'conn-1');
    expect(messageFindMany).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('── From CSV ──');
    expect(sent[0]).toContain('• Q1: 10');
    expect(sent[0]).toContain('• Q2: 25');
    expect(sent[0]).not.toContain('SPOOFED');
    expect(sent[0]).not.toContain(VISUAL_INLINE_ACK);
  });
});
