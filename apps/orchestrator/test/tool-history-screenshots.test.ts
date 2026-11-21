import { describe, expect, it } from 'vitest';
import type { ContentPart, ModelMessage } from '@tanstack/ai';
import type { ToolSet } from '../src/agent/tool-contract.js';
import {
  projectToolHistory,
  stubOlderScreenshots,
} from '../src/agent/execution/tool-history-projection.js';

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
