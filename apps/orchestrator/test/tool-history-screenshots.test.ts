import { describe, expect, it } from 'vitest';
import type { ContentPart, ModelMessage } from '@tanstack/ai';
import type { ToolSet } from '../src/agent/tool-contract.js';
import {
  placeToolImages,
  projectToolHistory,
  stubOlderScreenshots,
  toolImagePlacement,
} from '../src/agent/execution/tool-history-projection.js';
import { providerContext } from '../src/agent/execution/provider-context.js';

/**
 * The provider copy's screenshot budget. A computer-use turn takes a picture
 * every step, and the six results the compaction keeps verbatim made each
 * later call re-send every recent one — tens of thousands of tokens per step,
 * and provider timeouts as the reward. The newest screenshot is what the next
 * action targets and stays; older ones become a note. The canonical rows keep
 * every image — these are assertions about the PROVIDER copy only.
 */

function image(value: string): ContentPart {
  return { type: 'image', source: { type: 'data', mimeType: 'image/png', value } };
}

function screenshotResult(id: string, png: string): ModelMessage {
  return {
    role: 'tool',
    toolCallId: id,
    content: JSON.stringify({ bytes: png.length, base64: png }),
  };
}

const shotTool = {
  toModelOutput: async ({ output }: { output: unknown }) => {
    const decoded = output as { base64?: string };
    return {
      type: 'content' as const,
      value: [
        {
          type: 'file' as const,
          data: { type: 'data' as const, data: decoded.base64 ?? '' },
          mediaType: 'image/png',
        },
      ],
    };
  },
};

describe('stubOlderScreenshots', () => {
  it('the newest screenshot stays and older ones become the note', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'look at the screen' },
      {
        role: 'tool',
        toolCallId: 'a',
        content: [image('older-png')] as ContentPart[],
      },
      {
        role: 'tool',
        toolCallId: 'b',
        content: [image('newest-png')] as ContentPart[],
      },
    ];
    const projected = stubOlderScreenshots(messages);
    const older = projected[1];
    const newest = projected[2];
    expect(Array.isArray(older?.content)).toBe(true);
    expect(older?.content).toContainEqual({
      type: 'text',
      content: expect.stringContaining('an earlier screenshot was removed'),
    });
    expect(Array.isArray(newest?.content)).toBe(true);
    expect(newest?.content).toContainEqual(image('newest-png'));
  });

  it('text parts beside the images survive the stub', () => {
    const messages: ModelMessage[] = [
      {
        role: 'tool',
        toolCallId: 'a',
        content: [{ type: 'text', content: 'the reading' }, image('old')] as ContentPart[],
      },
      {
        role: 'tool',
        toolCallId: 'b',
        content: [image('new')] as ContentPart[],
      },
    ];
    const projected = stubOlderScreenshots(messages);
    const older = projected[0];
    expect(Array.isArray(older?.content)).toBe(true);
    expect(older?.content).toContainEqual({ type: 'text', content: 'the reading' });
    expect(older?.content).not.toContainEqual(image('old'));
  });

  it('the operator-attached images are never stubbed', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: [image('user-attachment')] as ContentPart[] },
      { role: 'tool', toolCallId: 'b', content: [image('newest')] as ContentPart[] },
    ];
    const projected = stubOlderScreenshots(messages);
    expect(projected[0]?.content).toContainEqual(image('user-attachment'));
  });

  it('a thread with no images passes through unchanged', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'tool', toolCallId: 'a', content: '{"ok":true}' },
    ];
    expect(stubOlderScreenshots(messages)).toEqual(messages);
  });
});

describe('projectToolHistory screenshots', () => {
  it('keeps image results from other tools beside the newest screenshot', async () => {
    const tools = { screenshot: shotTool, render_diagram: shotTool } as unknown as ToolSet;
    const messages: ModelMessage[] = [];
    for (const [id, name, png] of [
      ['c1', 'render_diagram', 'diagram'],
      ['c2', 'screenshot', 'screen'],
    ]) {
      messages.push(
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: id!, type: 'function', function: { name: name!, arguments: '{}' } }],
        },
        screenshotResult(id!, png!),
      );
    }
    const projected = await projectToolHistory(messages, tools);
    expect(projected[1]?.content).toContainEqual(image('diagram'));
    expect(projected[3]?.content).toContainEqual(image('screen'));
  });
  it('projected screenshots obey the same budget end to end', async () => {
    const tools = { screenshot: shotTool } as unknown as ToolSet;
    const messages: ModelMessage[] = [
      { role: 'user', content: 'look' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'screenshot', arguments: '{}' } },
        ],
      },
      screenshotResult('c1', 'first-png'),
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c2', type: 'function', function: { name: 'screenshot', arguments: '{}' } },
        ],
      },
      screenshotResult('c2', 'second-png'),
    ];
    const projected = await projectToolHistory(messages, tools);
    // The older projected image is stubbed; the newest survives verbatim.
    expect(projected[2]?.content).toContainEqual({
      type: 'text',
      content: expect.stringContaining('an earlier screenshot was removed'),
    });
    expect(projected[4]?.content).toContainEqual(expect.objectContaining({ type: 'image' }));
  });
});

/**
 * Chat Completions tool messages are text only. TanStack's adapter
 * `JSON.stringify`s an array there, so one screenshot became ~170k tokens of
 * base64 and every later request in that conversation failed. The image moves
 * to a user message after the tool results, or becomes a note.
 */
describe('placeToolImages', () => {
  const call = (id: string): ModelMessage => ({
    role: 'assistant',
    content: '',
    toolCalls: [{ id, type: 'function', function: { name: 'capture_screen', arguments: '{}' } }],
  });
  const thread = (): ModelMessage[] => [
    { role: 'user', content: 'what is on screen?' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'a', type: 'function', function: { name: 'capture_screen', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'fs_read', arguments: '{}' } },
      ],
    },
    {
      role: 'tool',
      toolCallId: 'a',
      content: [image('screen-png'), { type: 'text', content: 'The screen is 1920x1080px.' }],
    },
    { role: 'tool', toolCallId: 'b', content: 'file text' },
    { role: 'assistant', content: 'I see a login page.' },
  ];

  it('picks the placement from the adapter family and vision', () => {
    expect(toolImagePlacement('anthropic', true)).toBe('tool-result');
    expect(toolImagePlacement('openai', true)).toBe('tool-result');
    expect(toolImagePlacement('custom', true)).toBe('follow-up');
    expect(toolImagePlacement('openrouter', true)).toBe('follow-up');
    expect(toolImagePlacement('anthropic', false)).toBe('none');
    expect(toolImagePlacement('custom', false)).toBe('none');
  });

  it('leaves images inside the tool result where the provider accepts them', () => {
    const messages = thread();
    expect(placeToolImages(messages, 'tool-result')).toEqual(messages);
  });

  it('moves images after the whole run of tool results as a user message', () => {
    const placed = placeToolImages(thread(), 'follow-up');
    expect(placed.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
      'assistant',
    ]);
    expect(placed[2]?.content).toBe(
      '[screenshot attached in the next message]\nThe screen is 1920x1080px.',
    );
    expect(placed[4]?.content).toContainEqual(image('screen-png'));
    // No tool message carries an array, and so no base64 as text.
    for (const message of placed.filter((m) => m.role === 'tool')) {
      expect(typeof message.content).toBe('string');
      expect(String(message.content)).not.toContain('screen-png');
    }
  });

  it('flushes images at the end of the thread too', () => {
    const placed = placeToolImages(
      [call('a'), { role: 'tool', toolCallId: 'a', content: [image('last')] }],
      'follow-up',
    );
    expect(placed).toHaveLength(3);
    expect(placed[2]?.role).toBe('user');
    expect(placed[2]?.content).toContainEqual(image('last'));
  });

  it('describes images to a model without vision and sends none', () => {
    const placed = placeToolImages(thread(), 'none');
    expect(placed).toHaveLength(5);
    expect(placed[2]?.content).toEqual(
      expect.stringContaining('this model does not accept images'),
    );
    expect(JSON.stringify(placed)).not.toContain('screen-png');
  });

  it('flattens the older-screenshot stub to text for these adapters', async () => {
    const tools = { capture_screen: shotTool } as unknown as ToolSet;
    const projected = await projectToolHistory(
      [
        { role: 'user', content: 'look' },
        call('c1'),
        screenshotResult('c1', 'first-png'),
        call('c2'),
        screenshotResult('c2', 'second-png'),
      ],
      tools,
    );
    const placed = placeToolImages(projected, 'follow-up');
    expect(placed[2]?.content).toEqual(
      expect.stringContaining('an earlier screenshot was removed'),
    );
    expect(placed[4]?.content).toBe('[screenshot attached in the next message]');
    expect(placed[5]?.content).toContainEqual(image('second-png'));
    expect(JSON.stringify(placed)).not.toContain('first-png');
  });
});

describe('providerContext tool images', () => {
  it('sends a Chat Completions provider the screenshot as a user image, never as text', async () => {
    const middleware = providerContext(
      { tools: { capture_screen: shotTool } } as never,
      { kind: 'custom', vision: true },
      async (_request, ids) => new Map(ids.map((id) => [id, []])),
    );
    const messages: ModelMessage[] = [
      { id: 'u1', role: 'user', content: 'what is on screen?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'capture_screen', arguments: '{}' } },
        ],
      },
      screenshotResult('c1', 'raw-base64-png'),
    ];
    const result = await middleware.onConfig?.(
      { phase: 'beforeModel' } as never,
      { messages } as never,
    );
    const sent = (result as { providerMessages: ModelMessage[] }).providerMessages;
    expect(sent.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(sent[2]?.content).toBe('[screenshot attached in the next message]');
    expect(sent[3]?.content).toContainEqual(image('raw-base64-png'));
  });
});
