import { describe, expect, it, vi } from 'vitest';
import * as i18n from '../src/renderer/i18n/i18n';
import type { Message } from '@ag-ui/core';
import {
  crewaidMetadataIn,
  createTranscriptProjection,
  toTranscript,
  toTranscriptMessage,
} from '../src/renderer/chat/uiMessage';
const SELF = 'clx1a2b3c4d5e6f7g8h9i0j1';
const PEER = 'clx2b3c4d5e6f7g8h9i0j1k2';
const TASK = 'clx3c4d5e6f7g8h9i0j1k2l3';
const AT = '2026-09-01T12:00:00.000Z';
const metadata = (over = {}) => ({
  tanstack: { createdAt: AT },
  crewaid: {
    author: 'BOT',
    fromBotId: SELF,
    runId: 'run',
    sequence: 0,
    stopReason: null,
    taskId: null,
    routineId: null,
    chainId: null,
    hopCount: 0,
    startsTopic: false,
    attachments: [],
    ...over,
  },
});
const message = (over: Partial<Message> = {}): Message =>
  ({ id: 'anchor', role: 'assistant', content: 'Hello', metadata: metadata(), ...over }) as Message;
const call = (args = '{"path":"a.md"}') =>
  message({
    toolCalls: [{ id: 'call', type: 'function', function: { name: 'read_file', arguments: args } }],
  });
const folded = (messages: Message[]) => {
  const rows = toTranscript(messages, SELF, false);
  const activity = rows[0]?.parts.find((part) => part.type === 'tool-activity') as {
    calls?: unknown[];
  };
  return activity.calls?.[0];
};
describe('native AG-UI transcript projection', () => {
  it('refreshes cached dates after a language change without rewriting the message', () => {
    const locale = vi.spyOn(i18n, 'currentLocale');
    try {
      const project = createTranscriptProjection(SELF);
      const original = message();
      locale.mockReturnValue('en');
      const english = project([original], false)[0];
      locale.mockReturnValue('fr');
      const french = project([original], false)[0];
      expect(french?.dateLabel).toBe(
        new Date(AT).toLocaleDateString('fr', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
      );
      expect(french?.dateLabel).not.toBe(english?.dateLabel);
      expect(french?.parts).toEqual(english?.parts);
      expect(french?.createdAt).toBe(english?.createdAt);
      expect(project([original], false)[0]).toBe(french);
    } finally {
      locale.mockRestore();
    }
  });

  it('omits stored automatic continuation counters while keeping stops and ordinary messages', () => {
    const notice =
      'Paused after 25 steps of work. Still working — carrying on for up to 3 more rounds.';
    const rows = toTranscript(
      [
        message({ id: 'internal', content: notice, metadata: metadata({ author: 'SYSTEM' }) }),
        message({
          id: 'user',
          role: 'user',
          content: notice,
          metadata: metadata({ author: 'USER' }),
        }),
        message({
          id: 'stop',
          content: 'The bot paused before finishing. Send a message to continue.',
          metadata: metadata({ author: 'SYSTEM' }),
        }),
      ],
      SELF,
      false,
    );
    expect(rows.map((row) => row.id)).toEqual(['user', 'stop']);
  });
  it('keeps settled rows stable even when the SDK clones unchanged messages', () => {
    const project = createTranscriptProjection(SELF);
    const old = message({ id: 'old' });
    const live = message({ id: 'live', content: 'Writing' });
    const first = project([old, live], true);
    const next = project([{ ...old }, { ...live, content: 'Writing more' }], true);
    expect(next[0]).toBe(first[0]);
    expect(next[1]).not.toBe(first[1]);
    const finished = project([old, live], false);
    expect(finished[1]?.live).toBeUndefined();
    expect(project([old, live], false)[1]).toBe(finished[1]);
    expect(project([message({ id: 'old', content: 'Edited' }), live], false)[0]).not.toBe(first[0]);
    expect(project([live], false)).toHaveLength(1);
  });
  it('uses product authors and sender ids, including teammate user-role messages', () => {
    const peer = toTranscriptMessage(
      message({ role: 'user', metadata: metadata({ author: 'BOT', fromBotId: PEER }) }),
      SELF,
    );
    expect(peer).toMatchObject({ author: 'BOT', fromBotId: PEER });
    expect(toTranscriptMessage(message(), SELF).fromBotId).toBeUndefined();
    expect(
      toTranscriptMessage(message({ metadata: metadata({ author: 'SYSTEM' }) }), SELF).author,
    ).toBe('SYSTEM');
    expect(
      toTranscriptMessage(message({ metadata: metadata({ author: 'TOOL' }) }), SELF).author,
    ).toBe('BOT');
  });
  it('falls back to the protocol role for unprojected or invalid metadata', () => {
    expect(crewaidMetadataIn({ id: 'u', role: 'user', content: '' }).author).toBe('USER');
    expect(crewaidMetadataIn({ id: 'a', role: 'assistant', content: '' }).author).toBe('BOT');
    expect(
      crewaidMetadataIn({
        id: 'bad',
        role: 'user',
        content: '',
        metadata: { crewaid: { author: 7 } },
      }).author,
    ).toBe('USER');
  });
  it('preserves dates, attachments, topic dividers, stop reasons and Work links', () => {
    expect(
      toTranscriptMessage(
        message({
          metadata: metadata({
            stopReason: 'MODEL_LIMIT',
            taskId: TASK,
            startsTopic: true,
            attachments: [
              { id: 'att', filename: 'notes.md', mimeType: 'text/markdown', sizeBytes: 12 },
            ],
          }),
        }),
        SELF,
      ),
    ).toMatchObject({
      createdAt: new Date(AT).getTime(),
      stopReason: 'MODEL_LIMIT',
      taskId: TASK,
      startsTopic: true,
      attachments: [{ filename: 'notes.md' }],
    });
    const empty = toTranscriptMessage(message(), SELF);
    expect('attachments' in empty).toBe(false);
    expect('taskId' in empty).toBe(false);
    expect('startsTopic' in empty).toBe(false);
  });
  it('renders string and multipart text, retaining unknown media for the fallback', () => {
    expect(toTranscriptMessage(message(), SELF).parts).toEqual([{ type: 'text', text: 'Hello' }]);
    const row = toTranscriptMessage(
      {
        id: 'u',
        role: 'user',
        content: [
          { type: 'text', text: 'Here' },
          { type: 'image', url: 'https://fixture/image.png' },
        ],
      } as Message,
      SELF,
    );
    expect(row.parts.map((part) => part.type)).toEqual(['text', 'image']);
  });
  it('folds reasoning and canonical tool results into their assistant anchor', () => {
    const rows = toTranscript(
      [
        { id: 'r', role: 'reasoning', content: 'Checking' },
        call(),
        { id: 'result', role: 'tool', toolCallId: 'call', content: 'Found' },
      ],
      SELF,
      false,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('anchor');
    expect(JSON.stringify(rows[0]?.parts)).toContain('Checking');
    expect(
      folded([call(), { id: 'result', role: 'tool', toolCallId: 'call', content: 'Found' }]),
    ).toMatchObject({ status: 'ok', output: 'Found' });
  });
  it('shows live reasoning before an assistant anchor exists and collapses it afterwards', () => {
    const reasoning: Message = { id: 'r', role: 'reasoning', content: 'Thinking' };
    expect(toTranscript([reasoning], SELF, true)[0]?.parts).toMatchObject([{ state: 'streaming' }]);
    expect(toTranscript([reasoning, message()], SELF, false)).toHaveLength(1);
    expect(
      toTranscript([reasoning, message()], SELF, false)[0]?.parts.some(
        (part) => (part as { state?: string }).state === 'streaming',
      ),
    ).toBe(false);
  });
  it('parses completed tool args and survives incomplete JSON', () => {
    expect(JSON.stringify(folded([call()]))).toContain('a.md');
    expect(folded([call('{"pa')])).toMatchObject({ toolName: 'read_file', status: 'running' });
  });
  it('distinguishes denied outputs from failed tool results', () => {
    expect(
      folded([
        call(),
        {
          id: 'denied',
          role: 'tool',
          toolCallId: 'call',
          content: '',
          metadata: { tanstack: { toolResultOutcome: 'denied' } },
        },
      ]),
    ).toMatchObject({ status: 'denied' });
    expect(
      folded([
        call(),
        { id: 'failed', role: 'tool', toolCallId: 'call', content: '', error: 'File missing' },
      ]),
    ).toMatchObject({ status: 'error', detail: 'File missing' });
  });
  it('renders rich stored tool text and structured output metadata', () => {
    expect(
      folded([
        call(),
        {
          id: 'rich',
          role: 'tool',
          toolCallId: 'call',
          content: 'serialized',
          metadata: {
            tanstack: {
              toolResult: {
                content: [
                  { type: 'text', content: 'one ' },
                  { type: 'text', content: 'two' },
                ],
              },
            },
          },
        },
      ]),
    ).toMatchObject({ output: 'one two' });
    const row = toTranscriptMessage(
      message({
        metadata: {
          tanstack: {
            structuredOutput: { status: 'complete', raw: '{"ok":true}' },
            uiResources: [{ type: 'ui-resource' }],
          },
        },
      }),
      SELF,
    );
    expect(row.parts.map((part) => part.type)).toContain('structured-output');
    expect(row.parts.map((part) => part.type)).toContain('ui-resource');
  });
  it('keeps server ordering and marks only the current assistant live', () => {
    const rows = toTranscript(
      [message({ id: 'first' }), { id: 'u', role: 'user', content: 'new' }],
      SELF,
      true,
    );
    expect(rows.map((row) => row.id)).toEqual(['first', 'u']);
    expect(rows.some((row) => row.live)).toBe(false);
  });
});
