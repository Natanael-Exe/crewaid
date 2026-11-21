import { describe, expect, it } from 'vitest';
import { SANDBOX_CAPACITY_CODE, SERVER_MISCONFIGURED_CODE } from '@crewaid/shared';
import {
  ApiRequestError,
  failureOf,
  isAbortError,
  isRetryable,
  normalizeApiFailure,
} from '../src/renderer/api/apiError';

describe('API failure helpers', () => {
  it('recognizes AbortError by name across runtime constructor boundaries', () => {
    expect(isAbortError({ name: 'AbortError' })).toBe(true);
    expect(isAbortError(new Error('ordinary failure'))).toBe(false);
  });

  it('preserves normalized API failures and neutralizes unknown throws', () => {
    const failure = { code: 'GONE' as const, message: 'That is no longer available.' };
    expect(failureOf(new ApiRequestError(failure))).toBe(failure);
    expect(failureOf(new Error('private local detail'))).toEqual({
      code: 'NETWORK',
      message: 'Could not reach the server.',
      detail: undefined,
    });
  });

  it('only offers retry for failures another attempt could change', () => {
    expect(isRetryable('NETWORK')).toBe(true);
    expect(isRetryable('UNKNOWN')).toBe(true);
    expect(isRetryable('NOT_FOUND')).toBe(false);
    expect(isRetryable('GONE')).toBe(false);
    expect(isRetryable('TOO_LARGE')).toBe(false);
    expect(isRetryable('STORAGE_FULL')).toBe(false);
    // A full host is the definition of temporary (D-039 §7).
    expect(isRetryable('SANDBOX_CAPACITY')).toBe(true);
  });
});

describe('a full file store (D-220)', () => {
  it('answers 507 as STORAGE_FULL, not a retryable unknown', () => {
    const failure = normalizeApiFailure(507, '{"statusCode":507,"code":"ARTIFACT_CAPACITY"}');
    expect(failure.code).toBe('STORAGE_FULL');
    expect(failure.message).not.toMatch(/try again/i);
    expect(isRetryable(failure.code)).toBe(false);
  });
});

describe('the one 503 read from its body (CC-16, D-039 §16.1)', () => {
  const capacityBody = JSON.stringify({
    statusCode: 503,
    code: SANDBOX_CAPACITY_CODE,
    message: 'This host is already running 6 of 6 sandboxes.',
    detail: { running: 6, limit: 6 },
  });

  it('names a full host, so the screen can say so rather than "something went wrong"', () => {
    const failure = normalizeApiFailure(503, capacityBody);
    expect(failure.code).toBe('SANDBOX_CAPACITY');
    expect(failure.message).not.toMatch(/something went wrong/i);
  });

  it('leaves every other 503 neutral', () => {
    // Workspace readiness answers 503 too (D-039 §14/§15). Telling the
    // operator the host is full when their bot's storage is unreachable sends
    // them to stop a sandbox that would not have helped.
    const workspace = JSON.stringify({
      statusCode: 503,
      code: 'ServiceUnavailable',
      message: 'Workspace missing; storage will not be recreated automatically',
    });
    expect(normalizeApiFailure(503, workspace).code).toBe('UNKNOWN');
    expect(normalizeApiFailure(503, undefined).code).toBe('UNKNOWN');
  });

  it('will not read a coincidence as a capacity refusal', () => {
    // A proxy's HTML error page, or a stack trace that happens to contain the
    // word. The body is parsed, never scanned.
    expect(normalizeApiFailure(503, '<html>SANDBOX_CAPACITY</html>').code).toBe('UNKNOWN');
    expect(normalizeApiFailure(503, '"SANDBOX_CAPACITY"').code).toBe('UNKNOWN');
  });

  it('keeps the body out of the message, in `detail` where it is never rendered', () => {
    const failure = normalizeApiFailure(503, capacityBody);
    expect(failure.detail).toBe(capacityBody);
    expect(failure.message).not.toContain('statusCode');
  });
});

describe('a 503 the server explains', () => {
  it('forwards the server’s own sentence about its configuration', () => {
    // The provider vault reads its keyring lazily, so a misconfigured one
    // surfaces at a request. Without this it surfaced as "Something went
    // wrong. Try again." on the Connections pane — advice that can never work,
    // because nothing the operator does in the app changes an env var.
    const failure = normalizeApiFailure(
      503,
      JSON.stringify({
        statusCode: 503,
        code: SERVER_MISCONFIGURED_CODE,
        message:
          'CREWAID_CREDENTIAL_KEYRING is not valid JSON. Expected {"<version>":"<64 hex chars>"}.',
      }),
    );

    expect(failure.code).toBe('SERVER_MISCONFIGURED');
    expect(failure.message).toContain('CREWAID_CREDENTIAL_KEYRING');
    expect(failure.message).not.toBe('Something went wrong. Try again.');
  });

  it('keeps the neutral wording for a 503 that names nothing', () => {
    // Asserted against the presence above: a readiness probe answers 503 too,
    // and inheriting a configuration message there would be a lie.
    expect(normalizeApiFailure(503, JSON.stringify({ statusCode: 503 })).code).toBe('UNKNOWN');
    expect(normalizeApiFailure(503, 'not json').code).toBe('UNKNOWN');
  });

  it('does not trust a body that claims the code with no message', () => {
    const failure = normalizeApiFailure(503, JSON.stringify({ code: SERVER_MISCONFIGURED_CODE }));
    expect(failure.code).toBe('UNKNOWN');
  });

  it('turns a 402 into the plan, with the sentence the body names (D-156)', () => {
    const noPlan = normalizeApiFailure(
      402,
      JSON.stringify({ statusCode: 402, code: 'PLAN_REQUIRED', message: 'Choose a plan.' }),
    );
    expect(noPlan.code).toBe('PLAN_REQUIRED');
    expect(noPlan.message).toContain('Choose a plan in Settings → Plan & usage');

    const usedUp = normalizeApiFailure(
      402,
      JSON.stringify({ statusCode: 402, code: 'COMPUTE_ALLOWANCE_EXHAUSTED', message: 'Used up.' }),
    );
    expect(usedUp.code).toBe('PLAN_REQUIRED');
    expect(usedUp.message).toContain('computer time is used up');

    // A 402 that names nothing still gets the plan, never "try again".
    expect(normalizeApiFailure(402, 'not json').message).toContain('Choose a plan');
    expect(isRetryable('PLAN_REQUIRED')).toBe(false);
  });
});
