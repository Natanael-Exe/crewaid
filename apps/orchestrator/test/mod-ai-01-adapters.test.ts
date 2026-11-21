/**
 * MOD-AI-01 (D-167) — each provider's TanStack adapter, built the way the
 * product builds it, against its API's own wire format on a loopback stub.
 *
 * One table of cases runs for OpenAI (Responses), Anthropic (Messages),
 * OpenRouter and an OpenAI-compatible custom endpoint: text, a tool round,
 * reasoning, an image, a cancel, and the provider errors a person is told
 * about. What is not supported is said in the table, not skipped silently.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  chat,
  toSpecTokenUsage,
  toolDefinition,
  type ModelMessage,
  type StreamChunk,
} from '@tanstack/ai';
import { z } from 'zod';
import { normalizeRunError } from '../src/models/normalize-error.js';
import { buildTextAdapter, type TextAdapterDeps } from '../src/models/tanstack/text-adapter.js';
import { normalizeUsage, type NormalizedUsage } from '../src/models/tanstack/usage.js';
import type { ProviderBinding } from '../src/models/provider-factory.js';
import { startProviderStub, type ProviderStub } from './fixtures/mod-ai-01/provider-stub.js';
import {
  anthropicMessages,
  chatCompletions,
  openaiResponses,
  type Usage,
  type Wire,
} from './fixtures/mod-ai-01/wire.js';

const KEY = 'sk-test-0123456789abcdef-NEVER-LEAK';
const USAGE: Usage = { fresh: 100, cacheWrite: 200, cacheRead: 300, output: 5 };
/** A 1×1 PNG. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PUBLIC_IP = async () => ['93.184.216.34'];

type Kind = 'openai' | 'anthropic' | 'openrouter' | 'custom';

type Case = {
  readonly kind: Kind;
  readonly wire: Wire;
  /** Where the adapter sends a chat request. */
  readonly path: string;
  readonly model: string;
  /** What D-009(3) says this usage is: all input, with the cache as parts of it. */
  readonly usage: NormalizedUsage;
  /** How the key reaches the provider. */
  readonly auth: (headers: Record<string, unknown>) => unknown;
  /** The provider's own error body for a status. */
  readonly errorBody: (status: number) => unknown;
};

const CASES: readonly Case[] = [
  {
    kind: 'openai',
    wire: openaiResponses,
    path: '/v1/responses',
    model: 'gpt-4.1-mini',
    // OpenAI has no cache writes; a cached read is inside its input count.
    usage: { inputTokens: 400, outputTokens: 5, cachedInputTokens: 300, cacheCreationTokens: 0 },
    auth: (h) => h['authorization'],
    errorBody: (status) => ({
      error: { message: `vendor says ${status}`, type: 'requests', code: null },
    }),
  },
  {
    kind: 'anthropic',
    wire: anthropicMessages,
    // The adapter calls the SDK's beta Messages client.
    path: '/v1/messages?beta=true',
    model: 'claude-sonnet-4-5',
    // fresh 100 + written 200 + read 300 is 600 input, not Anthropic's 100.
    usage: { inputTokens: 600, outputTokens: 5, cachedInputTokens: 300, cacheCreationTokens: 200 },
    auth: (h) => h['x-api-key'],
    errorBody: (status) => ({
      type: 'error',
      error: {
        type: status === 429 ? 'rate_limit_error' : 'authentication_error',
        message: `vendor says ${status}`,
      },
    }),
  },
  {
    kind: 'openrouter',
    wire: chatCompletions,
    path: '/api/v1/chat/completions',
    model: 'z-ai/glm-5.3-flash',
    usage: { inputTokens: 600, outputTokens: 5, cachedInputTokens: 300, cacheCreationTokens: 200 },
    auth: (h) => h['authorization'],
    errorBody: (status) => ({ error: { code: status, message: `vendor says ${status}` } }),
  },
  {
    kind: 'custom',
    wire: chatCompletions,
    path: '/v1/chat/completions',
    model: 'local-model',
    usage: { inputTokens: 600, outputTokens: 5, cachedInputTokens: 300, cacheCreationTokens: 200 },
    auth: (h) => h['authorization'],
    errorBody: (status) => ({ error: { message: `vendor says ${status}`, type: 'server' } }),
  },
];

let stub: ProviderStub;

beforeAll(async () => {
  stub = await startProviderStub();
});
afterEach(() => {
  stub.requests.length = 0;
});
afterAll(async () => {
  await stub.close();
});

function build(c: Case, overrides: Partial<ProviderBinding> = {}, deps: TextAdapterDeps = {}) {
  const binding: ProviderBinding = {
    kind: c.kind,
    apiKey: KEY,
    endpoint: c.kind === 'custom' ? 'https://custom.test/v1' : null,
    upstreamModelId: c.model,
    ...overrides,
  };
  const transport: TextAdapterDeps =
    c.kind === 'custom'
      ? {
          resolve: PUBLIC_IP,
          // The guard checks the name the user configured; the stub stands in
          // for the server it resolves to.
          fetch: (input, init) =>
            fetch(
              String(input instanceof Request ? input.url : input).replace(
                'https://custom.test',
                stub.origin,
              ),
              init,
            ),
        }
      : {
          baseURL:
            c.kind === 'openrouter'
              ? `${stub.origin}/api/v1`
              : c.kind === 'openai'
                ? `${stub.origin}/v1`
                : stub.origin,
        };
  return buildTextAdapter(binding, { ...transport, ...deps });
}

async function run(
  c: Case,
  messages: ModelMessage[],
  options: {
    tools?: Parameters<typeof chat>[0]['tools'];
    abortOn?: (chunk: StreamChunk) => boolean;
    build?: ReturnType<typeof build>;
  } = {},
): Promise<StreamChunk[]> {
  const built = options.build ?? build(c);
  const abort = new AbortController();
  const chunks: StreamChunk[] = [];
  for await (const chunk of chat({
    adapter: built.adapter,
    messages,
    threadId: 'thread',
    runId: 'run',
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    abortController: abort,
  })) {
    chunks.push(chunk);
    if (options.abortOn?.(chunk) === true) abort.abort();
  }
  return chunks;
}

const text = (chunks: StreamChunk[]) =>
  chunks.flatMap((c) => (c.type === 'TEXT_MESSAGE_CONTENT' ? [c.delta] : [])).join('');

const finished = (chunks: StreamChunk[]) =>
  chunks.filter(
    (c): c is Extract<StreamChunk, { type: 'RUN_FINISHED' }> => c.type === 'RUN_FINISHED',
  );

const errors = (chunks: StreamChunk[]) =>
  chunks.filter((c): c is Extract<StreamChunk, { type: 'RUN_ERROR' }> => c.type === 'RUN_ERROR');

const ask = (content: ModelMessage['content']): ModelMessage[] => [{ role: 'user', content }];

describe.each(CASES)('MOD-AI-01 $kind adapter', (c) => {
  it('streams text, and reads its usage as all input with the cache as parts', async () => {
    stub.answer({ kind: 'sse', frames: c.wire.text(['Hel', 'lo'], USAGE) });
    const chunks = await run(c, ask('Say hello.'));

    expect(errors(chunks)).toEqual([]);
    expect(text(chunks)).toBe('Hello');
    expect(normalizeUsage(build(c).kind, finished(chunks).at(-1)?.usage)).toEqual(c.usage);
    const request = stub.requests[0];
    expect(request?.path).toBe(c.path);
    expect(JSON.stringify(c.auth(request?.headers ?? {}))).toContain(KEY);
    expect(request?.body).toMatchObject({ model: c.model, stream: true });
    // The key reaches the provider and nothing else.
    expect(JSON.stringify(chunks)).not.toContain(KEY);
  });

  it('runs a tool round: the call, its result sent back, and the answer', async () => {
    const calls: unknown[] = [];
    const weather = toolDefinition({
      name: 'get_weather',
      description: 'The weather in a city.',
      inputSchema: z.object({ city: z.string() }),
    }).server((args) => {
      calls.push(args);
      return Promise.resolve({ sky: 'sunny-and-mild' });
    });
    stub.answer(
      { kind: 'sse', frames: c.wire.toolCall('get_weather', '{"city":"Paris"}', USAGE) },
      { kind: 'sse', frames: c.wire.text(['Sunny.'], USAGE) },
    );

    const chunks = await run(c, ask('Weather in Paris?'), { tools: [weather] });

    expect(errors(chunks)).toEqual([]);
    expect(calls).toEqual([{ city: 'Paris' }]);
    expect(text(chunks)).toBe('Sunny.');
    expect(stub.requests).toHaveLength(2);
    // The first request offered the tool; the second carried its result back.
    expect(JSON.stringify(stub.requests[0]?.body)).toContain('get_weather');
    expect(JSON.stringify(stub.requests[1]?.body)).toContain('sunny-and-mild');
  });

  it('streams reasoning apart from the answer', async () => {
    stub.answer({ kind: 'sse', frames: c.wire.reasoning('Paris is in France.', 'France.', USAGE) });
    const chunks = await run(c, ask('Where is Paris?'));

    expect(errors(chunks)).toEqual([]);
    expect(text(chunks)).toBe('France.');
    const reasoning = chunks
      .flatMap((chunk) =>
        chunk.type === 'REASONING_MESSAGE_CONTENT' || chunk.type === 'STEP_FINISHED'
          ? [JSON.stringify(chunk)]
          : [],
      )
      .join('');
    expect(reasoning).toContain('Paris is in France.');
  });

  it('sends an image the user attached', async () => {
    stub.answer({ kind: 'sse', frames: c.wire.text(['A pixel.'], USAGE) });
    const chunks = await run(
      c,
      ask([
        { type: 'text', content: 'What is this?' },
        { type: 'image', source: { type: 'data', value: PIXEL, mimeType: 'image/png' } },
      ]),
    );

    expect(errors(chunks)).toEqual([]);
    expect(JSON.stringify(stub.requests[0]?.body)).toContain(PIXEL);
  });

  it('stops the request when the turn is cancelled', async () => {
    const frames = c.wire.text(['Once ', 'upon'], USAGE);
    // Everything up to the first text delta, then the connection is held.
    const firstText = frames.findIndex((f) => f.includes('Once'));
    stub.answer({ kind: 'hang', frames: frames.slice(0, firstText + 1) });

    const chunks = await run(c, ask('Tell me a long story.'), {
      abortOn: (chunk) => chunk.type === 'TEXT_MESSAGE_CONTENT',
    });

    await expect(
      Promise.race([
        stub.closed.then(() => 'closed'),
        new Promise((resolve) => setTimeout(() => resolve('still open'), 2_000)),
      ]),
    ).resolves.toBe('closed');
    expect(text(chunks)).toBe('Once ');
    expect(stub.requests).toHaveLength(1);
  });

  it.each([
    [429, 'RATE_LIMITED'],
    [401, 'AUTH_FAILED'],
  ] as const)('reports a %i as %s, with no vendor text and no key', async (status, code) => {
    stub.answer({ kind: 'error', status, body: c.errorBody(status) });
    const chunks = await run(c, ask('hello'), {
      build: build(c, {}, {}),
    });

    const failure = errors(chunks)[0];
    expect(failure).toBeDefined();
    const normalized = normalizeRunError({ message: failure?.message, code: failure?.code });
    expect(normalized.code).toBe(code);
    expect(normalized.message).not.toContain('vendor says');
    expect(JSON.stringify(chunks)).not.toContain(KEY);
  });
});

describe('MOD-AI-01 a custom endpoint is guarded (D-085)', () => {
  const custom = CASES.find((c) => c.kind === 'custom');
  if (custom === undefined) throw new Error('fixture');

  it('refuses an endpoint that resolves to a private address, before any request', async () => {
    const chunks = await run(custom, ask('hello'), {
      build: build(custom, {}, { resolve: async () => ['10.0.0.5'] }),
    });
    expect(errors(chunks)).toHaveLength(1);
    expect(stub.requests).toHaveLength(0);
  });

  it('refuses a plaintext endpoint, so the key never crosses the wire in the clear', async () => {
    const chunks = await run(custom, ask('hello'), {
      build: build(custom, { endpoint: 'http://custom.test/v1' }),
    });
    expect(errors(chunks)).toHaveLength(1);
    expect(stub.requests).toHaveLength(0);
  });

  it('does not follow a redirect', async () => {
    stub.answer({ kind: 'redirect', status: 307, location: '/elsewhere' });
    const chunks = await run(custom, ask('hello'));
    expect(errors(chunks)).toHaveLength(1);
    expect(stub.requests.length).toBeGreaterThan(0);
    expect(stub.requests.every((request) => request.path === '/v1/chat/completions')).toBe(true);
  });

  it('refuses a binding with no endpoint rather than defaulting to OpenAI', () => {
    expect(() => build(custom, { endpoint: null })).toThrow(/needs an endpoint/);
  });
});

describe('MOD-AI-01 a dynamic model id is checked at runtime', () => {
  const openrouter = CASES.find((c) => c.kind === 'openrouter');
  if (openrouter === undefined) throw new Error('fixture');

  it('accepts a model the adapter package has never heard of', () => {
    expect(() =>
      build(openrouter, { upstreamModelId: 'vendor/model-from-next-week' }),
    ).not.toThrow();
  });

  it.each(['', 'model with spaces', 'a'.repeat(201), 'x\ny'])('refuses %j', (id) => {
    expect(() => build(openrouter, { upstreamModelId: id })).toThrow(/not a model id/);
  });

  it('refuses an included model, which only the billing module builds', () => {
    expect(() => build(openrouter, { kind: 'crewaid' })).toThrow(/IncludedModels/);
  });
});

describe('MOD-AI-01 usage', () => {
  it('reads the AG-UI spec form a run event takes on the wire', () => {
    const { usage } = toSpecTokenUsage({ promptTokens: 40, completionTokens: 6, totalTokens: 46 });
    expect(normalizeUsage('openai', usage)).toMatchObject({ inputTokens: 40, outputTokens: 6 });
  });

  it('keeps unknown apart from zero', () => {
    expect(normalizeUsage('openai', undefined)).toBeNull();
    expect(
      normalizeUsage('openai', { promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
    ).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0 });
  });
});

/**
 * @skip-reason: @slow on demand — spends real tokens; needs a provider key.
 * The same adapter against the real provider: a text answer and one
 * tool round, with usage read through the same normalization.
 *
 *   MOD_AI01_LIVE=openrouter:z-ai/glm-5.3-flash EVAL_API_KEY_OPENROUTER=… \
 *   pnpm --filter @crewaid/orchestrator exec vitest run test/mod-ai-01-adapters.test.ts -t live
 */
const LIVE = process.env['MOD_AI01_LIVE'] ?? '';
describe.skipIf(LIVE === '')('MOD-AI-01 live provider', () => {
  const separator = LIVE.indexOf(':');
  const kind = LIVE.slice(0, separator) as Kind;
  const binding: ProviderBinding = {
    kind,
    apiKey: process.env[`EVAL_API_KEY_${kind.toUpperCase()}`] ?? '',
    endpoint: null,
    upstreamModelId: LIVE.slice(separator + 1),
  };

  it('answers live, and runs a tool round live', async () => {
    const built = buildTextAdapter(binding);
    const live = { ...CASES[0]!, kind };
    const answer = await run(live, ask('Reply with exactly the word: ready'), { build: built });
    expect(errors(answer)).toEqual([]);
    expect(text(answer).toLowerCase()).toContain('ready');
    expect(normalizeUsage(built.kind, finished(answer).at(-1)?.usage)?.inputTokens).toBeGreaterThan(
      0,
    );

    const calls: unknown[] = [];
    const weather = toolDefinition({
      name: 'get_weather',
      description: 'The current weather in a city. Always call this for weather questions.',
      inputSchema: z.object({ city: z.string() }),
    }).server((args) => {
      calls.push(args);
      return Promise.resolve({ sky: 'sunny', celsius: 21 });
    });
    const round = await run(live, ask('What is the weather in Paris right now?'), {
      build: built,
      tools: [weather],
    });
    expect(errors(round)).toEqual([]);
    expect(calls.length).toBeGreaterThan(0);
    expect(text(round)).toMatch(/21|sunny/i);
  }, 120_000);
});
