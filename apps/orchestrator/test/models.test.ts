import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { normalizeModelError } from '../src/models/normalize-error.js';
import { NormalizedModelErrorSchema, type ModelErrorCode } from '@crewaid/shared';
import { APICallError } from './model-resolution-fake.js';

/**
 * M1-BE-11 error normalization (D-006).
 *
 * ⚠️ THE M1-BE-05 REGISTRY AND M1-BE-10 CATALOG CASES THAT LIVED HERE ARE
 * GONE (V1-06, D-086). They exercised `resolveModel()` against a boot-cached
 * registry built from `OPENROUTER_API_KEY`/`OPENAI_API_KEY`/
 * `ANTHROPIC_API_KEY`, and a static catalog compiled into the process. Both
 * were removed: whichever key such a registry held belonged to ONE user, and
 * on an install with two, every turn billed it.
 *
 * Owner-scoped resolution is asserted in `model-resolution.integration.test.ts`
 * against a real database, because the thing worth testing is now which ROWS a
 * caller can reach — which no amount of environment juggling can stand in for.
 *
 * What remains here is pure and needs no environment at all: mapping three
 * providers' error shapes onto one vocabulary.
 */

describe('M1-BE-11 error normalization (D-006)', () => {
  const CASES: {
    name: string;
    status?: number;
    message: string;
    url?: string;
    expected: ModelErrorCode;
  }[] = [
    {
      name: '429 → RATE_LIMITED',
      status: 429,
      message: 'Too many requests',
      expected: 'RATE_LIMITED',
    },
    { name: '401 → AUTH_FAILED', status: 401, message: 'invalid api key', expected: 'AUTH_FAILED' },
    { name: '402 → QUOTA_EXCEEDED', status: 402, message: 'billing', expected: 'QUOTA_EXCEEDED' },
    { name: '408 → TIMEOUT', status: 408, message: 'timed out', expected: 'TIMEOUT' },
    {
      name: '503 → PROVIDER_UNAVAILABLE',
      status: 503,
      message: 'overloaded',
      expected: 'PROVIDER_UNAVAILABLE',
    },
    {
      name: '400 + context text → CONTEXT_OVERFLOW',
      status: 400,
      message: 'prompt is too long: 210000 tokens > 200000 maximum context',
      expected: 'CONTEXT_OVERFLOW',
    },
    {
      name: '400 + refusal text → CONTENT_REFUSED',
      status: 400,
      message: 'I refuse this request per the content policy',
      expected: 'CONTENT_REFUSED',
    },
    {
      name: '400 plain → INVALID_REQUEST',
      status: 400,
      message: 'bad parameter',
      expected: 'INVALID_REQUEST',
    },
  ];

  for (const c of CASES) {
    it(c.name, () => {
      const err = new APICallError({
        message: c.message,
        url: c.url ?? 'https://api.anthropic.com/v1/messages',
        statusCode: c.status,
        requestBodyValues: {},
        isRetryable: false,
      });
      const normalized = normalizeModelError(err, { modelId: 'anthropic:claude-opus-4-5' });
      expect(normalized.code).toBe(c.expected);
      // D-006: every normalized error validates against the shared schema.
      expect(NormalizedModelErrorSchema.safeParse(normalized).success).toBe(true);
      // D-006: message is operator-facing, not the vendor string.
      expect(normalized.message).not.toBe(c.message);
      // Vendor string is preserved for LOGS only.
      expect(normalized.detail).toBe(c.message);
    });
  }

  it('classifies a refusal arriving as a generic AISDKError', () => {
    const normalized = normalizeModelError(
      new Error('The model declined this request due to the safety system'),
    );
    expect(normalized.code).toBe('CONTENT_REFUSED');
    expect(normalized.retryable).toBe(false);
  });

  it('maps non-Error throwables onto the vocabulary (UNKNOWN floor)', () => {
    const normalized = normalizeModelError('something exploded');
    expect(normalized.code).toBe('UNKNOWN');
    expect(NormalizedModelErrorSchema.safeParse(normalized).success).toBe(true);
  });

  it('never leaks the vendor message into the operator-facing text', () => {
    const vendorText = 'Anthropic: your organization has exceeded its quota of tokens';
    const normalized = normalizeModelError(
      new APICallError({
        message: vendorText,
        url: 'https://api.anthropic.com/v1/messages',
        statusCode: 402,
        requestBodyValues: {},
        isRetryable: false,
      }),
    );
    expect(normalized.message).not.toContain('Anthropic');
    expect(normalized.message).not.toContain(vendorText);
  });
});

describe('a dry provider account tells the operator what to DO', () => {
  it('names switching model, because v1 has no automatic fallback', () => {
    // The product's answer to "out of credit" is to pick another model in the
    // composer and tell the bot to carry on — a bot's history is legitimately
    // mixed-model (CC-12), and automatic fallback is V2-BE-01's. "Check
    // billing" alone leaves an operator who already has a second provider
    // configured waiting on a top-up they did not need.
    //
    // Pinned because copy drifts back: nothing else in the tree asserts this
    // string, and the diagnosis reads complete without the action.
    const failure = normalizeModelError(
      Object.assign(new Error('insufficient credit'), { statusCode: 402 }),
    );
    expect(failure.code).toBe('QUOTA_EXCEEDED');
    expect(failure.message).toMatch(/switch to another model/i);
    expect(failure.message).toMatch(/continue/i);
  });
});
