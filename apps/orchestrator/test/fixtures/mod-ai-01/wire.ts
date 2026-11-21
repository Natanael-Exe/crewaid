/**
 * MOD-AI-01 — what each provider's API streams, written from its published
 * wire format: OpenAI's Responses events, Anthropic's Messages events, and
 * the Chat Completions chunks OpenRouter and OpenAI-compatible servers send.
 *
 * Every builder takes the same three shapes (a text answer, a tool call, a
 * reasoning answer), so one table of cases drives all four adapters and a
 * difference in what an adapter makes of them is a difference in the
 * adapter, not in the fixture.
 */
import { frame } from './provider-stub.js';

export type Usage = {
  /** Fresh input, the part no cache served or wrote. */
  readonly fresh: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly output: number;
};

export type Wire = {
  readonly text: (text: readonly string[], usage: Usage) => string[];
  readonly toolCall: (name: string, args: string, usage: Usage) => string[];
  readonly reasoning: (thought: string, text: string, usage: Usage) => string[];
};

// ── OpenAI Responses ───────────────────────────────────────────────────────

const responsesUsage = (u: Usage) => ({
  // OpenAI counts a cached read inside the input; it has no cache writes.
  input_tokens: u.fresh + u.cacheRead,
  input_tokens_details: { cached_tokens: u.cacheRead },
  output_tokens: u.output,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: u.fresh + u.cacheRead + u.output,
});

const response = (status: string, output: unknown[], usage?: Usage) => ({
  id: 'resp_1',
  object: 'response',
  created_at: 1_790_000_000,
  status,
  model: 'gpt-4.1-mini',
  output,
  ...(usage === undefined ? {} : { usage: responsesUsage(usage) }),
});

const responses = (type: string, data: object) => frame({ type, ...data }, type);

export const openaiResponses: Wire = {
  text: (text, usage) => {
    const message = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed' };
    return [
      responses('response.created', { response: response('in_progress', []) }),
      responses('response.output_item.added', {
        output_index: 0,
        item: { ...message, status: 'in_progress', content: [] },
      }),
      responses('response.content_part.added', {
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }),
      ...text.map((delta) =>
        responses('response.output_text.delta', {
          item_id: 'msg_1',
          output_index: 0,
          content_index: 0,
          delta,
        }),
      ),
      responses('response.output_item.done', {
        output_index: 0,
        item: {
          ...message,
          content: [{ type: 'output_text', text: text.join(''), annotations: [] }],
        },
      }),
      responses('response.completed', {
        response: response(
          'completed',
          [
            {
              ...message,
              content: [{ type: 'output_text', text: text.join(''), annotations: [] }],
            },
          ],
          usage,
        ),
      }),
    ];
  },
  toolCall: (name, args, usage) => {
    const item = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name };
    return [
      responses('response.created', { response: response('in_progress', []) }),
      responses('response.output_item.added', {
        output_index: 0,
        item: { ...item, status: 'in_progress', arguments: '' },
      }),
      responses('response.function_call_arguments.delta', {
        item_id: 'fc_1',
        output_index: 0,
        delta: args,
      }),
      responses('response.function_call_arguments.done', {
        item_id: 'fc_1',
        output_index: 0,
        arguments: args,
      }),
      responses('response.output_item.done', {
        output_index: 0,
        item: { ...item, status: 'completed', arguments: args },
      }),
      responses('response.completed', {
        response: response('completed', [{ ...item, status: 'completed', arguments: args }], usage),
      }),
    ];
  },
  reasoning: (thought, text, usage) => [
    responses('response.created', { response: response('in_progress', []) }),
    responses('response.output_item.added', {
      output_index: 0,
      item: { id: 'rs_1', type: 'reasoning', summary: [] },
    }),
    responses('response.reasoning_summary_text.delta', {
      item_id: 'rs_1',
      output_index: 0,
      summary_index: 0,
      delta: thought,
    }),
    responses('response.output_item.done', {
      output_index: 0,
      item: { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: thought }] },
    }),
    ...openaiResponses.text([text], usage).slice(1),
  ],
};

// ── Anthropic Messages ─────────────────────────────────────────────────────

const anthropic = (type: string, data: object) => frame({ type, ...data }, type);

const messageStart = (u: Usage) =>
  anthropic('message_start', {
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      // Anthropic's input_tokens is the FRESH part only.
      usage: {
        input_tokens: u.fresh,
        cache_creation_input_tokens: u.cacheWrite,
        cache_read_input_tokens: u.cacheRead,
        output_tokens: 1,
      },
    },
  });

const messageEnd = (u: Usage, stop: string) => [
  anthropic('message_delta', {
    delta: { stop_reason: stop, stop_sequence: null },
    // Cumulative, as the API reports it: the adapter reads usage from here.
    usage: {
      input_tokens: u.fresh,
      cache_creation_input_tokens: u.cacheWrite,
      cache_read_input_tokens: u.cacheRead,
      output_tokens: u.output,
    },
  }),
  anthropic('message_stop', {}),
];

export const anthropicMessages: Wire = {
  text: (text, usage) => [
    messageStart(usage),
    anthropic('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ...text.map((t) =>
      anthropic('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } }),
    ),
    anthropic('content_block_stop', { index: 0 }),
    ...messageEnd(usage, 'end_turn'),
  ],
  toolCall: (name, args, usage) => [
    messageStart(usage),
    anthropic('content_block_start', {
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name, input: {} },
    }),
    anthropic('content_block_delta', {
      index: 0,
      delta: { type: 'input_json_delta', partial_json: args },
    }),
    anthropic('content_block_stop', { index: 0 }),
    ...messageEnd(usage, 'tool_use'),
  ],
  reasoning: (thought, text, usage) => [
    messageStart(usage),
    anthropic('content_block_start', {
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    }),
    anthropic('content_block_delta', {
      index: 0,
      delta: { type: 'thinking_delta', thinking: thought },
    }),
    anthropic('content_block_delta', {
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig-anthropic' },
    }),
    anthropic('content_block_stop', { index: 0 }),
    anthropic('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
    anthropic('content_block_delta', { index: 1, delta: { type: 'text_delta', text } }),
    anthropic('content_block_stop', { index: 1 }),
    ...messageEnd(usage, 'end_turn'),
  ],
};

// ── Chat Completions (OpenRouter, OpenAI-compatible) ───────────────────────

const completionsUsage = (u: Usage) => ({
  // Chat Completions count cached reads and writes inside prompt_tokens.
  prompt_tokens: u.fresh + u.cacheRead + u.cacheWrite,
  completion_tokens: u.output,
  total_tokens: u.fresh + u.cacheRead + u.cacheWrite + u.output,
  prompt_tokens_details: { cached_tokens: u.cacheRead, cache_write_tokens: u.cacheWrite },
});

const chunk = (delta: object, finish: string | null = null) =>
  frame({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1_790_000_000,
    model: 'upstream-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

const usageChunk = (u: Usage) =>
  frame({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1_790_000_000,
    model: 'upstream-model',
    choices: [],
    usage: completionsUsage(u),
  });

export const chatCompletions: Wire = {
  text: (text, usage) => [
    ...text.map((t, i) => chunk(i === 0 ? { role: 'assistant', content: t } : { content: t })),
    chunk({}, 'stop'),
    usageChunk(usage),
    frame('[DONE]'),
  ],
  toolCall: (name, args, usage) => [
    chunk({
      role: 'assistant',
      content: null,
      tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: '' } }],
    }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }),
    chunk({}, 'tool_calls'),
    usageChunk(usage),
    frame('[DONE]'),
  ],
  reasoning: (thought, text, usage) => [
    // OpenRouter sends `reasoning` and its structured `reasoning_details`;
    // DeepSeek-style and vLLM servers send `reasoning_content`.
    chunk({
      role: 'assistant',
      content: '',
      reasoning: thought,
      reasoning_details: [{ type: 'reasoning.text', text: thought, format: 'unknown', index: 0 }],
      reasoning_content: thought,
    }),
    chunk({ content: text }),
    chunk({}, 'stop'),
    usageChunk(usage),
    frame('[DONE]'),
  ],
};
