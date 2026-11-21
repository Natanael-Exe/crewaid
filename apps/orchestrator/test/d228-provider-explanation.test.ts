import { describe, expect, it } from 'vitest';
import { NormalizedModelErrorSchema } from '@crewaid/shared';
import { normalizeModelError, normalizeRunError } from '../src/models/normalize-error.js';
import {
  DefaultModelUnsetError,
  ModelNeedsCredentialError,
  UnknownModelError,
} from '../src/models/model-resolution.service.js';
import { ContextBudgetError } from '../src/models/context-budget.js';

/**
 * D-228 — a model failure tells the person the provider's own reason, when it
 * gave one they can act on, and nothing technical.
 *
 * The case that prompted it: a custom connection to OpenCode answered 403
 * "OpenCode's free tier can only be used from within OpenCode", and the app
 * said "Something went wrong" — while the one sentence that said what to do
 * sat in a log nobody using the app can open.
 */

const OPENCODE =
  "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.";
const context = { modelId: 'model-1', source: 'OpenCode' };

/** An OpenAI-SDK-shaped HTTP failure: status prefix on the message, the body on `error`. */
function apiError(status: number, message: string, body?: unknown): Error {
  return Object.assign(new Error(`${String(status)} ${message}`), {
    status,
    ...(body === undefined ? {} : { error: body }),
  });
}

describe('the provider’s reason reaches the person (D-228)', () => {
  it('quotes a 403’s reason under the normalized sentence, attributed to the connection', () => {
    const failure = normalizeModelError(
      apiError(403, OPENCODE, { message: OPENCODE, type: 'AuthError' }),
      context,
    );
    expect(failure.code).toBe('AUTH_FAILED');
    expect(failure.message).not.toContain('OpenCode');
    expect(failure.explanation).toEqual({ source: 'OpenCode', text: OPENCODE });
    expect(NormalizedModelErrorSchema.safeParse(failure).success).toBe(true);
  });

  it('reads a streamed RUN_ERROR the same way, without its status prefix', () => {
    const failure = normalizeRunError({ message: `403 ${OPENCODE}`, code: '403' }, context);
    expect(failure.code).toBe('AUTH_FAILED');
    expect(failure.explanation?.text).toBe(OPENCODE);
  });

  it('prefers the upstream provider’s words when OpenRouter only says it failed', () => {
    const failure = normalizeRunError(
      {
        message: 'Provider returned error',
        code: '400',
        rawEvent: {
          code: 400,
          message: 'Provider returned error',
          metadata: {
            provider_name: 'Upstream',
            raw: JSON.stringify({ error: { message: 'This model does not support image input.' } }),
          },
        },
      },
      context,
    );
    expect(failure.explanation?.text).toBe('This model does not support image input.');
  });

  it('keeps a sentence that names a dotted model version', () => {
    const text = 'The model claude-3.5.1 was retired last month; choose a newer one.';
    expect(normalizeRunError({ message: text, code: '404' }, context).explanation?.text).toBe(text);
  });

  it('reads an unbounded provider text in bounded time', () => {
    const started = Date.now();
    // Four words first, so the text reaches the key shapes — the costly part.
    const failure = normalizeRunError(
      { message: `This account was refused ${'a'.repeat(200_000)}`, code: '403' },
      context,
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(failure.explanation?.text.length).toBeLessThanOrEqual(400);
  });

  it('keeps an actionable rate limit, which the sentence alone cannot name', () => {
    const text =
      'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day';
    const failure = normalizeRunError({ message: text, code: '429' }, context);
    expect(failure.code).toBe('RATE_LIMITED');
    expect(failure.explanation?.text).toBe(text);
  });

  it('hides key-shaped strings and bounds the length', () => {
    const keyed = normalizeRunError(
      {
        message: '401 Incorrect API key provided: sk-proj-abcdef1234567890. Find yours online.',
        code: '401',
      },
      context,
    );
    expect(keyed.explanation?.text).toBe(
      'Incorrect API key provided: [hidden]. Find yours online.',
    );
    const bearer = normalizeRunError(
      { message: 'The header Bearer abc.def.ghi was refused by this gateway', code: '401' },
      context,
    );
    expect(bearer.explanation?.text).not.toContain('abc.def.ghi');
    const long = normalizeRunError(
      { message: `This account is paused. ${'more '.repeat(200)}`, code: '403' },
      context,
    );
    expect(long.explanation?.text.length).toBeLessThanOrEqual(400);
    expect(long.explanation?.text.endsWith('…')).toBe(true);
    expect(NormalizedModelErrorSchema.safeParse(long).success).toBe(true);
  });
});

describe('nothing technical reaches the person (D-228)', () => {
  it.each([
    ['a bare reason phrase', { message: '401 Unauthorized', code: '401' }],
    ['an SDK placeholder', { message: '403 status code (no body)', code: '403' }],
    ['a JSON body', { message: '{"error":{"code":"x"}}', code: '500' }],
    ['an HTML page', { message: '<html><body>Bad gateway</body></html>', code: '502' }],
    [
      'a socket error',
      { message: 'connect ECONNREFUSED 127.0.0.1:443 while calling the model', code: '503' },
    ],
    [
      'a request-shape complaint',
      { message: "messages.1.content.0.type: Expected 'text' or 'image'", code: '400' },
    ],
    [
      'a quoted field name',
      { message: "Invalid value for 'tool_choice': only allowed with tools", code: '400' },
    ],
    [
      'a stack trace',
      { message: 'TypeError: x is undefined\n    at run (file.js:1:1)', code: '500' },
    ],
    // An adapter's own failure is this stack talking, not the provider.
    [
      'an adapter’s own code',
      { message: 'Failed to parse structured output as JSON at all', code: 'parse-error' },
    ],
  ])('says nothing for %s', (_name, error) => {
    expect(normalizeRunError(error, context).explanation).toBeUndefined();
  });

  it('quotes nothing when there is no one to attribute it to', () => {
    // An included model, or a caller such as skill compile.
    expect(
      normalizeModelError(apiError(403, OPENCODE, { message: OPENCODE })).explanation,
    ).toBeUndefined();
  });

  it('quotes nothing from an error that is not a provider’s', () => {
    expect(
      normalizeModelError(new Error('the database closed the connection unexpectedly'), context)
        .explanation,
    ).toBeUndefined();
  });
});

describe('a setup problem is said in its own words (D-228)', () => {
  it.each([
    [new DefaultModelUnsetError(), /Pick a model in the composer/],
    [new UnknownModelError('row-id-the-person-never-saw'), /no longer set up/],
    [new ModelNeedsCredentialError('OpenCode'), /^OpenCode has no API key yet/],
    [new ContextBudgetError(0), /no context window set/],
  ])('forwards %s', (error, sentence) => {
    const failure = normalizeModelError(error, context);
    expect(failure.message).toMatch(sentence);
    expect(failure.message).not.toContain('row-id-the-person-never-saw');
    expect(failure.explanation).toBeUndefined();
    expect(NormalizedModelErrorSchema.safeParse(failure).success).toBe(true);
  });
});
