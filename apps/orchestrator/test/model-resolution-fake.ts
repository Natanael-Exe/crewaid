import { randomUUID } from 'node:crypto';
import { EventType, type ModelMessage, type StreamChunk, type TextOptions } from '@tanstack/ai';
import { BaseTextAdapter } from '@tanstack/ai/adapters';
import { vi } from 'vitest';
import {
  ModelResolutionService,
  type ResolvedTextModel,
} from '../src/models/model-resolution.service.js';

/**
 * Scripted models for the suites, served through the run engine's adapter.
 *
 * The suites were written against the AI SDK's `MockLanguageModelV4`: a model
 * scripted as `doGenerate` (one answer) or `doStream` (a stream of parts —
 * `text-delta`, `tool-call`, `finish` …), which reads the prompt it was sent.
 * D-199 removed the AI SDK, and the scripts are the valuable part of those
 * suites, so this keeps their shape: `MockLanguageModelV4` here is a plain
 * object with the same constructor, and `resolvedTextModelOf` puts it behind
 * a TanStack text adapter that hands it the prompt in the shape the scripts
 * read and turns its parts into the AG-UI events a real adapter emits.
 */

/** One stream part, as the scripts write them. */
export type ScriptPart = { readonly type: string } & Record<string, unknown>;

/** A prompt message, as the scripts read them. */
export type ScriptPromptMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: Array<Record<string, unknown>> }
  | { role: 'assistant'; content: Array<Record<string, unknown>> }
  | { role: 'tool'; content: Array<Record<string, unknown>> };

export type ScriptCall = {
  readonly prompt: ScriptPromptMessage[];
  readonly tools: Array<{
    type: 'function';
    name: string;
    description?: string;
    inputSchema: unknown;
  }>;
  readonly abortSignal?: AbortSignal | undefined;
};

type Generated = {
  content: ReadonlyArray<{ type: string; text?: string } & Record<string, unknown>>;
  finishReason?: unknown;
  usage?: unknown;
};
type Streamed = { stream: ReadableStream<ScriptPart> };
type Script<T> = T | PromiseLike<T> | ((options: ScriptCall) => T | PromiseLike<T>);

export class MockLanguageModelV4 {
  readonly provider: string;
  readonly modelId: string;
  readonly doGenerateCalls: ScriptCall[] = [];
  readonly doStreamCalls: ScriptCall[] = [];
  private readonly generate: Script<Generated> | undefined;
  private readonly stream: Script<Streamed> | undefined;

  constructor(
    options: {
      provider?: string;
      modelId?: string;
      doGenerate?: Script<Generated>;
      doStream?: Script<Streamed>;
    } = {},
  ) {
    this.provider = options.provider ?? 'mock-provider';
    this.modelId = options.modelId ?? 'mock-model-id';
    this.generate = options.doGenerate;
    this.stream = options.doStream;
  }

  get streams(): boolean {
    return this.stream !== undefined;
  }

  async doGenerate(options: ScriptCall): Promise<Generated> {
    this.doGenerateCalls.push(options);
    if (this.generate === undefined) throw new Error('this mock has no doGenerate script');
    return typeof this.generate === 'function' ? this.generate(options) : this.generate;
  }

  async doStream(options: ScriptCall): Promise<Streamed> {
    this.doStreamCalls.push(options);
    if (this.stream === undefined) throw new Error('this mock has no doStream script');
    return typeof this.stream === 'function' ? this.stream(options) : this.stream;
  }
}

/** The parts, one after another, with the delays the scripts ask for. */
export function simulateReadableStream<T>(options: {
  chunks: readonly T[];
  initialDelayInMs?: number | null;
  chunkDelayInMs?: number | null;
}): ReadableStream<T> {
  const wait = (ms: number | null | undefined) =>
    ms === null || ms === undefined || ms <= 0
      ? Promise.resolve()
      : new Promise((resolve) => setTimeout(resolve, ms));
  let index = 0;
  return new ReadableStream<T>({
    async pull(controller) {
      await wait(index === 0 ? options.initialDelayInMs : options.chunkDelayInMs);
      if (index >= options.chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(options.chunks[index++]!);
    },
  });
}

/** A provider's HTTP failure, as a script throws it: the adapter reports its status. */
export class APICallError extends Error {
  readonly statusCode: number | undefined;
  readonly url: string;
  constructor(options: {
    message: string;
    url?: string;
    requestBodyValues?: unknown;
    statusCode?: number;
    responseBody?: string;
    isRetryable?: boolean;
  }) {
    super(options.message);
    this.name = 'AI_APICallError';
    this.statusCode = options.statusCode;
    this.url = options.url ?? '';
  }
}

function promptOf(options: TextOptions<Record<string, never>>): ScriptPromptMessage[] {
  const system: ScriptPromptMessage[] = (options.systemPrompts ?? []).map((prompt) => ({
    role: 'system',
    content: typeof prompt === 'string' ? prompt : prompt.content,
  }));
  // A tool result names its tool, as the scripts read it: the call that asked.
  const names = new Map(
    options.messages.flatMap((message) =>
      message.role === 'assistant'
        ? (message.toolCalls ?? []).map((call) => [call.id, call.function.name] as const)
        : [],
    ),
  );
  return [...system, ...options.messages.map((message) => messageOf(message, names))];
}

function partsOf(content: ModelMessage['content']): Array<Record<string, unknown>> {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  if (content === null) return [];
  return content.map((part) =>
    part.type === 'image' && part.source.type === 'data'
      ? {
          type: 'file',
          mediaType: part.source.mimeType,
          data: new Uint8Array(Buffer.from(part.source.value, 'base64')),
        }
      : { type: 'text', text: part.type === 'text' ? part.content : '' },
  );
}

function messageOf(message: ModelMessage, names: ReadonlyMap<string, string>): ScriptPromptMessage {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: message.toolCallId,
          toolName: names.get(message.toolCallId ?? '') ?? '',
          output: {
            type: 'text',
            value:
              typeof message.content === 'string'
                ? message.content
                : JSON.stringify(message.content),
          },
        },
      ],
    };
  }
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: [
        ...partsOf(message.content),
        ...(message.toolCalls ?? []).map((call) => ({
          type: 'tool-call',
          toolCallId: call.id,
          toolName: call.function.name,
          input: parsed(call.function.arguments),
        })),
      ],
    };
  }
  return { role: 'user', content: partsOf(message.content) };
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text === '' ? '{}' : text) as unknown;
  } catch {
    return text;
  }
}

function finishReasonOf(reason: unknown): string {
  const unified =
    typeof reason === 'string'
      ? reason
      : typeof reason === 'object' && reason !== null
        ? String((reason as { unified?: unknown }).unified ?? 'stop')
        : 'stop';
  return unified === 'tool-calls'
    ? 'tool_calls'
    : unified === 'content-filter'
      ? 'content_filter'
      : unified;
}

function usageOf(usage: unknown) {
  if (typeof usage !== 'object' || usage === null) return undefined;
  const count = (value: unknown, key: string): number | undefined => {
    if (typeof value === 'number') return value;
    if (typeof value === 'object' && value !== null) {
      const inner = (value as Record<string, unknown>)[key];
      return typeof inner === 'number' ? inner : undefined;
    }
    return undefined;
  };
  const record = usage as Record<string, unknown>;
  const input = count(record['inputTokens'], 'total');
  const output = count(record['outputTokens'], 'total');
  if (input === undefined && output === undefined) return undefined;
  const cached = count(record['inputTokens'], 'cacheRead');
  const written = count(record['inputTokens'], 'cacheWrite');
  return {
    promptTokens: input ?? 0,
    completionTokens: output ?? 0,
    totalTokens: (input ?? 0) + (output ?? 0),
    ...(cached === undefined && written === undefined
      ? {}
      : {
          promptTokensDetails: {
            ...(cached === undefined ? {} : { cachedTokens: cached }),
            ...(written === undefined ? {} : { cacheWriteTokens: written }),
          },
        }),
  };
}

function errorCodeOf(error: unknown): string | undefined {
  if (error instanceof APICallError && error.statusCode !== undefined)
    return String(error.statusCode);
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

class ScriptedModelAdapter extends BaseTextAdapter<
  'mock',
  Record<string, never>,
  readonly ['text', 'image'],
  never
> {
  readonly name = 'mock';

  constructor(private readonly model: MockLanguageModelV4) {
    super({}, 'fake-model');
  }

  async *chatStream(options: TextOptions<Record<string, never>>): AsyncIterable<StreamChunk> {
    const runId = options.runId ?? randomUUID();
    const threadId = options.threadId ?? randomUUID();
    const messageId = `asst-${randomUUID()}`;
    const reasoningId = `reasoning-${randomUUID()}`;
    const now = () => Date.now();
    const call: ScriptCall = {
      prompt: promptOf(options),
      tools: (options.tools ?? []).map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
      abortSignal: options.abortController?.signal,
    };
    yield { type: EventType.RUN_STARTED, runId, threadId, timestamp: now() } as StreamChunk;

    let parts: ScriptPart[] | AsyncIterable<ScriptPart>;
    try {
      if (this.model.streams) {
        const reader = (await this.model.doStream(call)).stream.getReader();
        parts = {
          async *[Symbol.asyncIterator]() {
            for (;;) {
              const next = await reader.read();
              if (next.done) return;
              yield next.value;
            }
          },
        };
      } else {
        const result = await this.model.doGenerate(call);
        parts = [
          ...result.content.flatMap((part): ScriptPart[] =>
            part.type === 'text'
              ? [{ type: 'text-delta', delta: part.text ?? '' }]
              : part.type === 'tool-call'
                ? [{ ...part, type: 'tool-call' }]
                : [],
          ),
          { type: 'finish', finishReason: result.finishReason ?? 'stop', usage: result.usage },
        ];
      }
    } catch (error: unknown) {
      const code = errorCodeOf(error);
      yield {
        type: EventType.RUN_ERROR,
        timestamp: now(),
        message: error instanceof Error ? error.message : String(error),
        ...(code === undefined ? {} : { code }),
      } as StreamChunk;
      return;
    }

    let textOpen = false;
    let reasoningOpen = false;
    let toolIndex = 0;
    const closeText = function* () {
      if (!textOpen) return;
      textOpen = false;
      yield { type: EventType.TEXT_MESSAGE_END, messageId, timestamp: now() } as StreamChunk;
    };
    const closeReasoning = function* () {
      if (!reasoningOpen) return;
      reasoningOpen = false;
      yield {
        type: EventType.REASONING_MESSAGE_END,
        messageId: reasoningId,
        timestamp: now(),
      } as StreamChunk;
      yield {
        type: EventType.REASONING_END,
        messageId: reasoningId,
        timestamp: now(),
      } as StreamChunk;
    };
    try {
      for await (const part of parts) {
        if (options.abortController?.signal.aborted === true) return;
        switch (part.type) {
          case 'text-delta': {
            yield* closeReasoning();
            if (!textOpen) {
              textOpen = true;
              yield {
                type: EventType.TEXT_MESSAGE_START,
                messageId,
                role: 'assistant',
                timestamp: now(),
              } as StreamChunk;
            }
            const delta = part['delta'] ?? part['text'];
            yield {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId,
              delta: typeof delta === 'string' ? delta : '',
              timestamp: now(),
            } as StreamChunk;
            break;
          }
          case 'reasoning-delta': {
            if (!reasoningOpen) {
              reasoningOpen = true;
              yield {
                type: EventType.REASONING_START,
                messageId: reasoningId,
                timestamp: now(),
              } as StreamChunk;
              yield {
                type: EventType.REASONING_MESSAGE_START,
                messageId: reasoningId,
                role: 'reasoning',
                timestamp: now(),
              } as StreamChunk;
            }
            const delta = part['delta'] ?? part['text'];
            yield {
              type: EventType.REASONING_MESSAGE_CONTENT,
              messageId: reasoningId,
              delta: typeof delta === 'string' ? delta : '',
              timestamp: now(),
            } as StreamChunk;
            break;
          }
          case 'tool-call': {
            yield* closeReasoning();
            yield* closeText();
            const toolCallId = String(part['toolCallId'] ?? `call-${randomUUID()}`);
            const input = part['input'];
            yield {
              type: EventType.TOOL_CALL_START,
              toolCallId,
              toolCallName: String(part['toolName']),
              parentMessageId: messageId,
              index: toolIndex++,
              timestamp: now(),
            } as StreamChunk;
            yield {
              type: EventType.TOOL_CALL_ARGS,
              toolCallId,
              delta: typeof input === 'string' ? input : JSON.stringify(input ?? {}),
              timestamp: now(),
            } as StreamChunk;
            yield { type: EventType.TOOL_CALL_END, toolCallId, timestamp: now() } as StreamChunk;
            break;
          }
          case 'error': {
            const error = part['error'];
            const code = errorCodeOf(error);
            yield {
              type: EventType.RUN_ERROR,
              timestamp: now(),
              message: error instanceof Error ? error.message : String(error),
              ...(code === undefined ? {} : { code }),
            } as StreamChunk;
            return;
          }
          case 'finish': {
            yield* closeReasoning();
            yield* closeText();
            const usage = usageOf(part['usage']);
            yield {
              type: EventType.RUN_FINISHED,
              runId,
              threadId,
              finishReason: finishReasonOf(part['finishReason']),
              ...(usage === undefined ? {} : { usage }),
              timestamp: now(),
            } as StreamChunk;
            return;
          }
          default:
            // stream-start, text-start/end, reasoning-start/end, response-metadata, raw:
            // the events above open and close their own blocks.
            break;
        }
      }
    } catch (error: unknown) {
      const code = errorCodeOf(error);
      yield {
        type: EventType.RUN_ERROR,
        timestamp: now(),
        message: error instanceof Error ? error.message : String(error),
        ...(code === undefined ? {} : { code }),
      } as StreamChunk;
      return;
    }
    // A script that ends without `finish` ends its step as a stop.
    yield* closeReasoning();
    yield* closeText();
    yield {
      type: EventType.RUN_FINISHED,
      runId,
      threadId,
      finishReason: 'stop',
      timestamp: now(),
    } as StreamChunk;
  }

  structuredOutput(): Promise<never> {
    return Promise.reject(new Error('the scripted adapter has no structured output'));
  }
}

/**
 * A scripted model in the envelope `ModelResolutionService.resolveText`
 * returns. The metadata is fixed on purpose: none of these suites asserts a
 * context window or a connection name, and a fake with knobs nobody turns is
 * a fake people start trusting for things it does not model.
 */
export function resolvedTextModelOf(model: MockLanguageModelV4): ResolvedTextModel {
  return {
    modelId: 'pm_fake_model',
    connectionId: 'conn_fake',
    connectionName: 'Fake',
    upstreamModelId: 'fake-model',
    label: 'Fake model',
    contextWindow: 200_000,
    capabilities: { tools: true, vision: true, reasoning: false },
    kind: 'openai',
    adapter: new ScriptedModelAdapter(model) as never,
  };
}

/**
 * Script the model every run in `app` resolves, the way the suites used to
 * hand the AI SDK backend a model: `model` is called per resolution, so a
 * suite can swap the script between cases.
 */
export function scriptModel(
  app: { get: (token: typeof ModelResolutionService) => ModelResolutionService },
  model: () => MockLanguageModelV4,
) {
  return vi
    .spyOn(app.get(ModelResolutionService), 'resolveText')
    .mockImplementation(() => Promise.resolve(resolvedTextModelOf(model())));
}

/**
 * The part of a prompt this run added: from the newest user message on.
 *
 * A run's prompt carries the thread's whole history, earlier tool results
 * included, so a script that asks "has this turn already called the tool?"
 * reads this rather than the whole prompt.
 */
export function currentTurn(prompt: unknown): unknown[] {
  if (!Array.isArray(prompt)) return [];
  const last = prompt.findLastIndex(
    (message) => (message as { role?: unknown } | null)?.role === 'user',
  );
  return prompt.slice(Math.max(0, last));
}
