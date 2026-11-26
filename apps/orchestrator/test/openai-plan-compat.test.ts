/**
 * D-241 Step 4 — OpenAI "Sign in with ChatGPT" ("Use your ChatGPT plan")
 * Responses API compatibility contract.
 *
 * Verifies the wire payload `@tanstack/ai` + `@tanstack/ai-openai` send
 * through `buildTextAdapter` and `askModelText`, plus normalization of
 * plan-limit 429 errors (`subscription_sharing_usage_limit_exceeded`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chat, toolDefinition, type StreamChunk } from '@tanstack/ai';
import { z } from 'zod';
import { NormalizedModelErrorSchema } from '@crewaid/shared';
import { normalizeModelError, normalizeRunError } from '../src/models/normalize-error.js';
import type { ProviderBinding } from '../src/models/provider-factory.js';
import { buildTextAdapter } from '../src/models/tanstack/text-adapter.js';
import { askModelText } from '../src/models/text-call.js';
import { startProviderStub, type ProviderStub } from './fixtures/mod-ai-01/provider-stub.js';
import { openaiResponses, type Usage } from './fixtures/mod-ai-01/wire.js';

const USAGE: Usage = { fresh: 80, cacheWrite: 0, cacheRead: 20, output: 10 };
const PLAN_TOKEN = 'plan-token-test-0123456789abcdef';

const RequestBodySchema = z.record(z.string(), z.unknown());

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

function openaiBinding(upstreamModelId = 'gpt-5.2'): ProviderBinding {
  return {
    kind: 'openai',
    apiKey: PLAN_TOKEN,
    endpoint: null,
    upstreamModelId,
  };
}

function parseBody(index: number): Record<string, unknown> {
  const req = stub.requests[index];
  expect(req).toBeDefined();
  return RequestBodySchema.parse(req?.body);
}

describe('D-241 Step 4 OpenAI plan-token wire compatibility', () => {
  it('streams with store: false, instructions, function-only tools, and no rejected params across tool rounds', async () => {
    const readFile = toolDefinition({
      name: 'fs_read',
      description: 'Read a file in the workspace.',
      inputSchema: z.object({ path: z.string() }),
    }).server(({ path }) => Promise.resolve({ path, content: 'hello world' }));

    stub.answer(
      { kind: 'sse', frames: openaiResponses.toolCall('fs_read', '{"path":"README.md"}', USAGE) },
      { kind: 'sse', frames: openaiResponses.text(['Read README.md.'], USAGE) },
    );

    const built = buildTextAdapter(openaiBinding('gpt-5.2'), {
      baseURL: `${stub.origin}/v1`,
      store: false,
    });

    const chunks: StreamChunk[] = [];
    for await (const chunk of chat({
      adapter: built.adapter,
      systemPrompts: ['You are a coding assistant.'],
      messages: [{ role: 'user', content: 'Read README.md' }],
      tools: [readFile],
      threadId: 'thread-plan',
      runId: 'run-plan',
    })) {
      chunks.push(chunk);
    }

    expect(chunks.filter((c) => c.type === 'RUN_ERROR')).toEqual([]);
    const reply = chunks
      .flatMap((c) => (c.type === 'TEXT_MESSAGE_CONTENT' ? [c.delta] : []))
      .join('');
    expect(reply).toBe('Read README.md.');
    expect(stub.requests).toHaveLength(2);

    for (let i = 0; i < 2; i += 1) {
      expect(stub.requests[i]?.path).toBe('/v1/responses');
      const body = parseBody(i);
      expect(body['stream']).toBe(true);
      expect(body['store']).toBe(false);
      expect(body['instructions']).toBe('You are a coding assistant.');
      expect(body['temperature']).toBeUndefined();
      expect(body['top_p']).toBeUndefined();
      expect(body['max_output_tokens']).toBeUndefined();
      expect(body['metadata']).toBeUndefined();
      expect(body['previous_response_id']).toBeUndefined();
      expect(body['include']).toContain('reasoning.encrypted_content');

      const input = z.array(z.record(z.string(), z.unknown())).parse(body['input']);
      expect(input.some((item) => item['role'] === 'system')).toBe(false);

      const tools = z.array(z.record(z.string(), z.unknown())).parse(body['tools']);
      expect(tools).toHaveLength(1);
      expect(tools.every((tool) => tool['type'] === 'function')).toBe(true);
    }
  });

  it('overrides modelOptions store/metadata/previous_response_id when store: false is set', async () => {
    stub.answer({ kind: 'sse', frames: openaiResponses.text(['Stateless ok.'], USAGE) });

    const built = buildTextAdapter(openaiBinding('gpt-5.2'), {
      baseURL: `${stub.origin}/v1`,
      store: false,
    });

    const chunks: StreamChunk[] = [];
    for await (const chunk of chat({
      adapter: built.adapter,
      messages: [{ role: 'user', content: 'Ping' }],
      modelOptions: {
        store: true,
        metadata: { tenant: 'test' },
        previous_response_id: 'resp_prev_123',
      },
      threadId: 'thread-stateless',
      runId: 'run-stateless',
    })) {
      chunks.push(chunk);
    }

    expect(chunks.filter((c) => c.type === 'RUN_ERROR')).toEqual([]);
    const body = parseBody(0);
    expect(body['stream']).toBe(true);
    expect(body['store']).toBe(false);
    expect(body['metadata']).toBeUndefined();
    expect(body['previous_response_id']).toBeUndefined();
  });

  it('sends stream: true and store: false on the wire even through askModelText (stream: false)', async () => {
    stub.answer({ kind: 'sse', frames: openaiResponses.text(['Short ', 'summary.'], USAGE) });

    const built = buildTextAdapter(openaiBinding('gpt-5.2'), {
      baseURL: `${stub.origin}/v1`,
      store: false,
    });

    const text = await askModelText(
      { adapter: built.adapter },
      { system: 'Summarize briefly.', prompt: 'Hello' },
    );

    expect(text).toBe('Short summary.');
    expect(stub.requests).toHaveLength(1);
    const body = parseBody(0);
    expect(body['stream']).toBe(true);
    expect(body['store']).toBe(false);
    expect(body['instructions']).toBe('Summarize briefly.');
    expect(body['temperature']).toBeUndefined();
    expect(body['top_p']).toBeUndefined();
    expect(body['max_output_tokens']).toBeUndefined();
    expect(body['metadata']).toBeUndefined();
    expect(body['previous_response_id']).toBeUndefined();
  });

  it('leaves store unset for default BYOK OpenAI connections', async () => {
    stub.answer({ kind: 'sse', frames: openaiResponses.text(['BYOK ok.'], USAGE) });

    const built = buildTextAdapter(openaiBinding('gpt-4.1-mini'), {
      baseURL: `${stub.origin}/v1`,
    });

    const chunks: StreamChunk[] = [];
    for await (const chunk of chat({
      adapter: built.adapter,
      messages: [{ role: 'user', content: 'Hello' }],
      threadId: 'thread-byok',
      runId: 'run-byok',
    })) {
      chunks.push(chunk);
    }

    expect(chunks.filter((c) => c.type === 'RUN_ERROR')).toEqual([]);
    const body = parseBody(0);
    expect(body['stream']).toBe(true);
    expect('store' in body).toBe(false);
  });
});

describe('D-241 Step 4 OpenAI plan-limit error normalization', () => {
  it('maps a live 429 subscription_sharing_usage_limit_exceeded response to non-retryable QUOTA_EXCEEDED', async () => {
    stub.answer({
      kind: 'error',
      status: 429,
      body: {
        error: {
          message:
            'Your ChatGPT plan usage limit has been reached. Switch models or wait for your allowance to reset.',
          type: 'requests',
          code: 'subscription_sharing_usage_limit_exceeded',
        },
      },
    });

    const built = buildTextAdapter(openaiBinding('gpt-5.2'), {
      baseURL: `${stub.origin}/v1`,
      store: false,
    });

    const chunks: StreamChunk[] = [];
    for await (const chunk of chat({
      adapter: built.adapter,
      messages: [{ role: 'user', content: 'Hello' }],
      threadId: 'thread-limit',
      runId: 'run-limit',
    })) {
      chunks.push(chunk);
    }

    const runError = chunks.find(
      (c): c is Extract<StreamChunk, { type: 'RUN_ERROR' }> => c.type === 'RUN_ERROR',
    );
    expect(runError).toBeDefined();

    const normalized = normalizeRunError(
      { message: runError?.message, code: runError?.code },
      { modelId: 'openai:gpt-5.2', source: 'OpenAI' },
    );
    expect(normalized.code).toBe('QUOTA_EXCEEDED');
    expect(normalized.retryable).toBe(false);
    expect(NormalizedModelErrorSchema.safeParse(normalized).success).toBe(true);
  });

  it('maps subscription_sharing_usage_limit_exceeded and insufficient_quota 429s to non-retryable QUOTA_EXCEEDED', () => {
    const byCode = normalizeRunError(
      {
        code: 'subscription_sharing_usage_limit_exceeded',
        message: 'You have reached your ChatGPT subscription usage limit for this window.',
      },
      { source: 'OpenAI' },
    );
    expect(byCode.code).toBe('QUOTA_EXCEEDED');
    expect(byCode.retryable).toBe(false);
    expect(byCode.explanation).toEqual({
      source: 'OpenAI',
      text: 'You have reached your ChatGPT subscription usage limit for this window.',
    });

    const byStatus = normalizeModelError(
      Object.assign(
        new Error('429 subscription_sharing_usage_limit_exceeded: plan limit reached'),
        { status: 429 },
      ),
    );
    expect(byStatus.code).toBe('QUOTA_EXCEEDED');
    expect(byStatus.retryable).toBe(false);

    const byQuota = normalizeModelError(
      Object.assign(new Error('429 insufficient_quota: You exceeded your current quota'), {
        status: 429,
      }),
    );
    expect(byQuota.code).toBe('QUOTA_EXCEEDED');
    expect(byQuota.retryable).toBe(false);

    const genericRateLimit = normalizeModelError(
      Object.assign(new Error('429 Rate limit reached for requests'), { status: 429 }),
    );
    expect(genericRateLimit.code).toBe('RATE_LIMITED');
    expect(genericRateLimit.retryable).toBe(true);
  });
});
