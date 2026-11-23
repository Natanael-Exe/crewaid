import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INCLUDED_MODEL,
  INCLUDED_MODEL_LIST,
} from '../../src/ee/billing/included-models.js';
import { costMicroUsd } from '../../src/ee/billing/included-models.service.js';
import { crossedLevel } from '../../src/ee/billing/usage-notice.js';
import { ModelAllowanceExhaustedError } from '../../src/models/included-models.port.js';
import { normalizeModelError } from '../../src/models/normalize-error.js';
import { catalogPriceForModel, modelKeyOf } from '../../src/telemetry/ai-telemetry.js';

/** D-157 — the included models' list, their charge, and the notices. */
const usage = (input: number, output: number) => ({
  inputTokens: { total: input },
  outputTokens: { total: output },
});

describe('D-157 — the included model list', () => {
  it('prices every included model, so no call is ever free when OpenRouter reports no cost', () => {
    for (const model of INCLUDED_MODEL_LIST) {
      expect(
        catalogPriceForModel(modelKeyOf('openrouter', model.upstreamModelId)),
        model.upstreamModelId,
      ).toBeDefined();
    }
  });

  it('names a default that is on the list, and lists no model twice', () => {
    const ids = INCLUDED_MODEL_LIST.map((model) => model.upstreamModelId);
    expect(ids).toContain(DEFAULT_INCLUDED_MODEL);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('D-157 — what one call costs', () => {
  it('charges OpenRouter’s own figure when it reports one, rounded up to a micro-dollar', () => {
    const metadata = { openrouter: { usage: { cost: 0.0123451 } } };
    expect(costMicroUsd('google/gemini-3.8-flash', usage(1, 1), metadata)).toBe(12346);
  });

  it('falls back to the price table from the call’s tokens', () => {
    // 1000 in at $0.75/M + 1000 out at $3.75/M = $0.0045.
    expect(costMicroUsd('google/gemini-3.8-flash', usage(1000, 1000), undefined)).toBe(4500);
    expect(
      costMicroUsd('google/gemini-3.8-flash', usage(1000, 1000), { openrouter: { usage: {} } }),
    ).toBe(4500);
  });

  it('ignores a reported cost that is not a real amount', () => {
    for (const cost of [Number.NaN, -1, '0.5']) {
      expect(
        costMicroUsd('google/gemini-3.8-flash', usage(1000, 1000), {
          openrouter: { usage: { cost } },
        }),
      ).toBe(4500);
    }
  });
});

describe('D-157 — notices at 80% and 100%', () => {
  it('says 80% once, when the line is crossed', () => {
    expect(crossedLevel(70, 85, 100)).toBe(80);
    expect(crossedLevel(85, 90, 100)).toBeNull();
    expect(crossedLevel(70, 79, 100)).toBeNull();
  });

  it('says used up when the limit is reached, even from below 80% in one step', () => {
    expect(crossedLevel(95, 100, 100)).toBe(100);
    expect(crossedLevel(50, 120, 100)).toBe(100);
    expect(crossedLevel(100, 110, 100)).toBeNull();
  });

  it('says nothing for a meter with no limit', () => {
    expect(crossedLevel(0, 1_000_000, null)).toBeNull();
    expect(crossedLevel(0, 10, 0)).toBeNull();
  });
});

describe('D-157 — the allowance refusal reaches the transcript as ours', () => {
  it('normalises to ALLOWANCE_EXHAUSTED, naming both ways forward', () => {
    const normalized = normalizeModelError(new ModelAllowanceExhaustedError());
    expect(normalized.code).toBe('ALLOWANCE_EXHAUSTED');
    expect(normalized.retryable).toBe(false);
    expect(normalized.message).toContain('Settings → Models');
    expect(normalized.message).toContain('Plan & usage');
  });

  it('does not tell an account with no plan that it used something up', () => {
    const { message } = normalizeModelError(new ModelAllowanceExhaustedError());
    expect(message).toContain('not chosen one yet');
  });

  it('is recognised when the SDK wraps it', () => {
    const wrapped = new Error('stream failed', { cause: new ModelAllowanceExhaustedError() });
    expect(normalizeModelError(wrapped).code).toBe('ALLOWANCE_EXHAUSTED');
  });
});
