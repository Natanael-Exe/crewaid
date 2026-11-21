import { describe, expect, it } from 'vitest';
import type { ModelMessage } from '@tanstack/ai';
import { fromFirstUserTurn, providerContext } from '../src/agent/execution/provider-context.js';

const question: ModelMessage = {
  id: 'opening',
  role: 'assistant',
  content: 'What task would you like me to help you with?',
};
const task: ModelMessage = { id: 'task', role: 'user', content: 'Draft a client update' };
const reply: ModelMessage = { id: 'reply', role: 'assistant', content: 'Here is a draft.' };

// D-231: a thread may open on a question the app stored for its bot, and a
// provider may refuse a conversation that opens on the assistant.
describe('D-231 the provider copy opens on the person', () => {
  it('leaves out assistant messages before the first user turn, and only those', () => {
    expect(fromFirstUserTurn([question, task, reply])).toEqual([task, reply]);
    expect(fromFirstUserTurn([task, reply])).toEqual([task, reply]);
  });

  it('keeps an opening tool call, whose results would otherwise be orphaned', () => {
    const call: ModelMessage = {
      id: 'call',
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }],
    };
    expect(fromFirstUserTurn([call, task])).toEqual([call, task]);
  });

  it('is what the run middleware hands the provider, without touching the stored list', async () => {
    const middleware = providerContext(
      { tools: {} } as never,
      false,
      async (_request, ids) => new Map(ids.map((id) => [id, []])),
    );
    const messages = [question, task];
    const result = await middleware.onConfig?.(
      { phase: 'beforeModel' } as never,
      { messages } as never,
    );
    const sent = (result as { providerMessages: ModelMessage[] }).providerMessages;
    expect(sent.map((message) => message.id)).toEqual(['task']);
    expect(messages).toEqual([question, task]);
  });
});
