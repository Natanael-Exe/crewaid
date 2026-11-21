import { describe, expect, it } from 'vitest';
import {
  entitlementFrom,
  trialEligible,
  type SubscriptionFacts,
} from '../src/billing/entitlement.js';

/**
 * D-156 — what an account may use, decided from its Stripe subscriptions.
 *
 * Pure cases, one per status Stripe can report, because the alternative is a
 * test clock per case and the property under test is the mapping, not Stripe.
 */
const NOW = new Date('2026-10-15T12:00:00.000Z');
const USER = { role: null };

function row(overrides: Partial<SubscriptionFacts>): SubscriptionFacts {
  return {
    plan: 'starter',
    status: 'active',
    periodStart: new Date('2026-10-01T00:00:00.000Z'),
    periodEnd: new Date('2026-11-01T00:00:00.000Z'),
    trialStart: null,
    trialEnd: null,
    cancelAtPeriodEnd: false,
    cancelAt: null,
    ...overrides,
  };
}

describe('D-156 — entitlementFrom', () => {
  it('gives an account with no subscription nothing: the computer does not start', () => {
    const entitlement = entitlementFrom([], USER, NOW);
    expect(entitlement).toMatchObject({
      plan: 'none',
      status: null,
      period: null,
      computeLimitSeconds: 0,
      modelAllowanceMicroUsd: 0,
    });
  });

  it('reads a trialing Starter subscription as the trial: 10 hours and $1', () => {
    const entitlement = entitlementFrom(
      [
        row({
          status: 'trialing',
          trialStart: new Date('2026-10-14T00:00:00.000Z'),
          trialEnd: new Date('2026-10-21T00:00:00.000Z'),
          periodStart: new Date('2026-10-14T00:00:00.000Z'),
          periodEnd: new Date('2026-10-21T00:00:00.000Z'),
        }),
      ],
      USER,
      NOW,
    );
    expect(entitlement).toMatchObject({
      plan: 'trial',
      status: 'trialing',
      computeLimitSeconds: 10 * 3600,
      modelAllowanceMicroUsd: 1_000_000,
      callLimitSeconds: 0,
      // D-223: half an hour of listening and five minutes of speaking.
      listenLimitSeconds: 30 * 60,
      speakLimitSeconds: 5 * 60,
      idleStop: true,
    });
    expect(entitlement.period?.end.toISOString()).toBe('2026-10-21T00:00:00.000Z');
  });

  it('gives active Starter 100 hours and $5, and Pro no hour limit and no idle stop', () => {
    expect(entitlementFrom([row({})], USER, NOW)).toMatchObject({
      plan: 'starter',
      computeLimitSeconds: 100 * 3600,
      modelAllowanceMicroUsd: 5_000_000,
      callLimitSeconds: 0,
      listenLimitSeconds: 5 * 3600,
      speakLimitSeconds: 30 * 60,
      idleStop: true,
    });
    expect(entitlementFrom([row({ plan: 'pro' })], USER, NOW)).toMatchObject({
      plan: 'pro',
      computeLimitSeconds: null,
      modelAllowanceMicroUsd: 10_000_000,
      // D-222: Pro's 30 call minutes a period.
      callLimitSeconds: 30 * 60,
      // D-223: twenty hours of listening, two of speaking.
      listenLimitSeconds: 20 * 3600,
      speakLimitSeconds: 2 * 3600,
      idleStop: false,
    });
  });

  it('keeps a plan cancelled at period end in force until Stripe ends it', () => {
    const entitlement = entitlementFrom([row({ cancelAtPeriodEnd: true })], USER, NOW);
    expect(entitlement.plan).toBe('starter');
    expect(entitlement.cancelAtPeriodEnd).toBe(true);
  });

  it('reads a cancellation recorded as a cancel_at date the same way', () => {
    const entitlement = entitlementFrom(
      [row({ cancelAt: new Date('2026-11-01T00:00:00.000Z') })],
      USER,
      NOW,
    );
    expect(entitlement.plan).toBe('starter');
    expect(entitlement.cancelAtPeriodEnd).toBe(true);
  });

  it.each(['past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'])(
    'grants nothing while the subscription is %s, and says which',
    (status) => {
      const entitlement = entitlementFrom([row({ status })], USER, NOW);
      expect(entitlement.plan).toBe('none');
      expect(entitlement.computeLimitSeconds).toBe(0);
      expect(entitlement.status).toBe(status);
    },
  );

  it('grants nothing for a plan or status it does not know: money is never assumed', () => {
    expect(entitlementFrom([row({ plan: 'enterprise' })], USER, NOW).plan).toBe('none');
    expect(entitlementFrom([row({ status: 'mystery' })], USER, NOW)).toMatchObject({
      plan: 'none',
      status: null,
    });
  });

  it('takes the newest subscription in force when an account has had several', () => {
    const entitlement = entitlementFrom(
      [
        row({
          status: 'canceled',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          periodEnd: new Date('2026-09-01T00:00:00.000Z'),
        }),
        row({ plan: 'pro' }),
      ],
      USER,
      NOW,
    );
    expect(entitlement.plan).toBe('pro');
  });

  it('puts an admin on the internal plan, with no limits, whatever they bought', () => {
    const entitlement = entitlementFrom([row({ status: 'past_due' })], { role: 'admin' }, NOW);
    expect(entitlement).toMatchObject({
      plan: 'internal',
      status: null,
      computeLimitSeconds: null,
      modelAllowanceMicroUsd: null,
      callLimitSeconds: null,
      listenLimitSeconds: null,
      speakLimitSeconds: null,
      idleStop: true,
    });
    // Counted by calendar month, so an admin's usage shows like anyone's.
    expect(entitlement.period?.start.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(entitlement.period?.end.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('treats only the admin role as admin', () => {
    expect(entitlementFrom([], { role: 'user' }, NOW).plan).toBe('none');
    expect(entitlementFrom([], { role: 'Admin' }, NOW).plan).toBe('none');
  });
});

describe('D-156 — trialEligible: one trial per account, ever', () => {
  it('offers the trial to an account that never subscribed', () => {
    expect(trialEligible([])).toBe(true);
  });

  it('offers it to an account whose only subscriptions never trialled', () => {
    expect(trialEligible([row({ status: 'canceled' })])).toBe(true);
  });

  it('refuses it once any subscription has had a trial, however it ended', () => {
    expect(trialEligible([row({ status: 'trialing' })])).toBe(false);
    expect(
      trialEligible([row({ status: 'canceled', trialStart: new Date('2026-09-01T00:00:00Z') })]),
    ).toBe(false);
    expect(
      trialEligible([
        row({ status: 'incomplete_expired', trialEnd: new Date('2026-09-08T00:00:00Z') }),
      ]),
    ).toBe(false);
  });
});
