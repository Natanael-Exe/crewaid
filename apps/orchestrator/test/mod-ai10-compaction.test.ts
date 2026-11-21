/** D-195: what one call is sent of a long TanStack thread, and what is never touched. */
import { describe, expect, it } from 'vitest';
import type { ChatMiddlewareConfig, ModelMessage } from '@tanstack/ai';
import { estimateTokens, providerCompaction } from '../src/agent/execution/context-compaction.js';
import { ContextBudgetError, historyBudget } from '../src/models/context-budget.js';
import { normalizeModelError } from '../src/models/normalize-error.js';

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${String(i)}`).join(' ');

/** A long mixed history: talk, tool calls with bulky output, an image, and a call still waiting. */
function history(exchanges: number): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (let i = 0; i < exchanges; i += 1) {
    messages.push({ role: 'user', content: `question ${String(i)} ${words(40)}` });
    messages.push({
      role: 'assistant',
      content: null,
      toolCalls: [
        { id: `c${String(i)}`, type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ],
    });
    messages.push({ role: 'tool', toolCallId: `c${String(i)}`, content: words(400) });
    messages.push({ role: 'assistant', content: `answer ${String(i)}` });
  }
  messages.push({
    role: 'user',
    content: [
      { type: 'text', content: 'look at this' },
      {
        type: 'image',
        source: { type: 'data', mimeType: 'image/png', value: 'A'.repeat(400_000) },
      },
    ],
  });
  messages.push({
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 'pending', type: 'function', function: { name: 'send', arguments: '{}' } }],
  });
  return messages;
}

async function compact(messages: ModelMessage[], maxTokens: number) {
  const middleware = providerCompaction({ maxTokens });
  const config: ChatMiddlewareConfig = { messages, systemPrompts: [], tools: [] };
  const ctx = {
    phase: 'beforeModel',
    threadId: 't',
    emitCustomEvent: () => undefined,
    capability: () => undefined,
  };
  const out = (await middleware.onConfig?.(ctx as never, config)) as
    Partial<ChatMiddlewareConfig> | undefined;
  return out?.providerMessages ?? messages;
}

/** Every tool result follows its call, and every call before the last message has its result. */
function pairsIntact(messages: ModelMessage[]): boolean {
  const open = new Set<string>();
  for (const [index, message] of messages.entries()) {
    if (message.role === 'tool') {
      if (message.toolCallId === undefined || !open.has(message.toolCallId)) return false;
      open.delete(message.toolCallId);
    }
    for (const call of message.toolCalls ?? []) open.add(call.id);
    if (message.role === 'user' && open.size > 0 && index > 0) return false;
  }
  return true;
}

const total = (messages: ModelMessage[]) =>
  messages.reduce((sum, message) => sum + estimateTokens(message), 0);

describe('the history budget', () => {
  it('is half the window, never above the operator’s trim number', () => {
    expect(historyBudget(200_000, 100_000)).toBe(100_000);
    expect(historyBudget(32_000, 100_000)).toBe(16_000);
  });

  it('fails clearly for a model with no usable window', () => {
    for (const window of [0, -1, Number.NaN, 1.5])
      expect(() => historyBudget(window, 100_000)).toThrow(ContextBudgetError);
    const normalized = normalizeModelError(new ContextBudgetError(0));
    expect(normalized.code).toBe('INVALID_REQUEST');
    expect(normalized.detail).toContain('context window');
  });

  it('prices an image as an image, not as its bytes', () => {
    const image = history(0)[0]!;
    expect(estimateTokens(image)).toBeLessThan(2_000);
  });
});

describe('provider compaction', () => {
  it('leaves a history within budget alone', async () => {
    const short = history(1);
    expect(await compact(short, 100_000)).toBe(short);
  });

  it('brings a long history under budget without splitting a call from its result', async () => {
    const long = history(60);
    const canonical = JSON.stringify(long);
    const before = total(long);
    const sent = await compact(long, 8_000);

    expect(before).toBeGreaterThan(8_000 * 4);
    expect(total(sent)).toBeLessThanOrEqual(8_000);
    expect(pairsIntact(sent)).toBe(true);
    // The newest — the image and the call still waiting — are kept as they were.
    expect(sent.slice(-2)).toEqual(long.slice(-2));
    // The canonical history is not touched.
    expect(JSON.stringify(long)).toBe(canonical);
  });

  it('clears old tool output before it drops a single message', async () => {
    const long = history(12);
    const sent = await compact(long, total(long) - 1_000);
    expect(sent).toHaveLength(long.length);
    expect(
      sent.filter(
        (message) => message.role === 'tool' && String(message.content).includes('cleared'),
      ),
    ).not.toHaveLength(0);
    expect(pairsIntact(sent)).toBe(true);
  });

  it('is stable when applied again, as every later step does', async () => {
    const long = history(60);
    const once = await compact(long, 8_000);
    const twice = await compact(once, 8_000);
    expect(total(twice)).toBeLessThanOrEqual(8_000);
    expect(pairsIntact(twice)).toBe(true);
    expect(twice.slice(-2)).toEqual(long.slice(-2));
  });
});
