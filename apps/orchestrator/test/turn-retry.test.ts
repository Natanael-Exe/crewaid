import { describe, expect, it } from 'vitest';
import { retryContinuationInstruction, retryOperatorCopy } from '../src/agent/turn-retry.js';
import { isRetryableModelCode } from '../src/models/normalize-error.js';

/**
 * The transient-failure handoff's two sentences and its one decision. The
 * decision is the one `normalize-error` already made for its operator copy —
 * the same three codes — exported so the settle path cannot drift from it.
 */

describe('isRetryableModelCode', () => {
  it('the transient codes retry', () => {
    expect(isRetryableModelCode('TIMEOUT')).toBe(true);
    expect(isRetryableModelCode('RATE_LIMITED')).toBe(true);
    expect(isRetryableModelCode('PROVIDER_UNAVAILABLE')).toBe(true);
  });

  it('everything else does not', () => {
    expect(isRetryableModelCode('UNKNOWN')).toBe(false);
    expect(isRetryableModelCode('INVALID_REQUEST')).toBe(false);
    expect(isRetryableModelCode('ALLOWANCE_EXHAUSTED')).toBe(false);
    expect(isRetryableModelCode('AUTH_FAILED')).toBe(false);
    expect(isRetryableModelCode('CONTEXT_OVERFLOW')).toBe(false);
  });
});

describe('retry copy', () => {
  it('the model is told nothing was lost and not to start over', () => {
    const copy = retryContinuationInstruction('TIMEOUT');
    expect(copy).toContain('TIMEOUT');
    expect(copy).toContain('The work above is saved');
    expect(copy).toContain('do not start over');
  });

  it('the operator is told a retry is happening without counters', () => {
    expect(retryOperatorCopy()).toContain('Retrying automatically');
    expect(retryOperatorCopy()).not.toMatch(/\d|left|rounds/);
  });
});
