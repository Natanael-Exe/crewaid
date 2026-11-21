import {
  BILLING_PLANS,
  SubscriptionStatusSchema,
  type BillingPlan,
  type SubscriptionStatus,
} from '@crewaid/shared';

/** The columns of a `Subscription` row an entitlement is decided from. */
export type SubscriptionFacts = {
  readonly plan: string;
  readonly status: string;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  readonly trialStart: Date | null;
  readonly trialEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean | null;
  readonly cancelAt: Date | null;
};

/** The account columns an entitlement depends on besides its subscriptions. */
export type AccountFacts = {
  /** Better Auth's admin role; `admin` is the internal plan. */
  readonly role: string | null;
};

/** What one account may use right now. */
export type Entitlement = {
  readonly plan: BillingPlan;
  /** Stripe's status for the subscription this was decided from; null when there is none. */
  readonly status: SubscriptionStatus | null;
  /** The billing period usage is counted in; null when no plan is in force. */
  readonly period: { readonly start: Date; readonly end: Date } | null;
  readonly cancelAtPeriodEnd: boolean;
  /** `null`: no limit. `0`: the computer does not start. */
  readonly computeLimitSeconds: number | null;
  /** `null`: no limit. */
  readonly modelAllowanceMicroUsd: number | null;
  /** Call time this period. `null`: no limit. `0`: no calls. */
  readonly callLimitSeconds: number | null;
  /** Audio heard (dictation, voice messages) this period. `null`: no limit. */
  readonly listenLimitSeconds: number | null;
  /** Audio made (spoken replies) this period. `null`: no limit. */
  readonly speakLimitSeconds: number | null;
  readonly idleStop: boolean;
};

/**
 * The statuses that keep a plan in force.
 *
 * `active` includes a subscription cancelled at period end — Stripe keeps it
 * active until then, which is what "cancel any time, keep it to the end of the
 * month" means. `past_due` does NOT: a failed renewal stops new use until the
 * card is fixed in the portal, rather than running up a period nobody may pay
 * for. Stripe retries the card meanwhile and the plan returns with the payment.
 */
const IN_FORCE: readonly SubscriptionStatus[] = ['active', 'trialing'];

export const NO_PLAN: Entitlement = {
  plan: 'none',
  status: null,
  period: null,
  cancelAtPeriodEnd: false,
  computeLimitSeconds: 0,
  modelAllowanceMicroUsd: 0,
  callLimitSeconds: 0,
  listenLimitSeconds: 0,
  speakLimitSeconds: 0,
  idleStop: true,
};

/**
 * Decide an account's entitlement from its subscriptions.
 *
 * Pure, so every status Stripe can report is a unit case rather than a test
 * clock. One plan in force at a time: the newest subscription that is active
 * or trialing wins, and a row with an unknown plan or status grants nothing —
 * money is never assumed.
 */
export function entitlementFrom(
  subscriptions: readonly SubscriptionFacts[],
  account: AccountFacts,
  now: Date,
): Entitlement {
  // An admin is on the internal plan whatever they have bought: an operator
  // testing the hosted service must not be stopped by its limits, or by a
  // card. Usage is still counted, by calendar month (UTC), so an admin's
  // spend shows up like anyone's.
  if (account.role === 'admin') {
    const limits = BILLING_PLANS.internal;
    return {
      plan: 'internal',
      status: null,
      period: utcMonthOf(now),
      cancelAtPeriodEnd: false,
      computeLimitSeconds: limits.computeHours,
      modelAllowanceMicroUsd: limits.modelAllowanceUsd,
      callLimitSeconds: limits.callMinutes === null ? null : limits.callMinutes * 60,
      listenLimitSeconds: limits.listenMinutes === null ? null : limits.listenMinutes * 60,
      speakLimitSeconds: limits.speakMinutes === null ? null : limits.speakMinutes * 60,
      idleStop: limits.idleStop,
    };
  }

  const newestFirst = [...subscriptions].sort(
    (a, b) => (b.periodStart?.getTime() ?? 0) - (a.periodStart?.getTime() ?? 0),
  );
  const newest = newestFirst[0];

  for (const row of newestFirst) {
    const status = SubscriptionStatusSchema.safeParse(row.status);
    if (!status.success || !IN_FORCE.includes(status.data)) continue;
    if (row.periodStart === null || row.periodEnd === null) continue;
    const plan = planOf(row.plan, status.data);
    if (plan === null) continue;

    const limits = BILLING_PLANS[plan];
    return {
      plan,
      status: status.data,
      period: { start: row.periodStart, end: row.periodEnd },
      // Recent Stripe API versions record a portal cancellation as a
      // `cancel_at` date rather than `cancel_at_period_end`; either means the
      // plan runs out on its own, and Stripe keeps it active until then.
      cancelAtPeriodEnd: row.cancelAtPeriodEnd === true || row.cancelAt !== null,
      computeLimitSeconds: limits.computeHours === null ? null : limits.computeHours * 3600,
      modelAllowanceMicroUsd: limits.modelAllowanceUsd * 1_000_000,
      callLimitSeconds: limits.callMinutes * 60,
      listenLimitSeconds: limits.listenMinutes * 60,
      speakLimitSeconds: limits.speakMinutes * 60,
      idleStop: limits.idleStop,
    };
  }

  // Nothing in force. The status still says why — `past_due` and `canceled`
  // send the operator to different buttons.
  const status = SubscriptionStatusSchema.safeParse(newest?.status);
  return { ...NO_PLAN, status: status.success ? status.data : null };
}

/** The UTC calendar month holding `now`. */
function utcMonthOf(now: Date): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

/** A Starter subscription in its trial is the trial; anything else is its plan. */
function planOf(
  name: string,
  status: SubscriptionStatus,
): Exclude<BillingPlan, 'none' | 'internal'> | null {
  if (name === 'starter') return status === 'trialing' ? 'trial' : 'starter';
  if (name === 'pro') return 'pro';
  return null;
}

/**
 * Whether a Starter checkout would open the $1 trial: once per account, ever.
 *
 * The same test `@better-auth/stripe` applies to its own trials, so the two
 * can never disagree about an account: any subscription that ever had a trial
 * — whatever became of it — has used it.
 */
export function trialEligible(subscriptions: readonly SubscriptionFacts[]): boolean {
  return !subscriptions.some(
    (row) => row.trialStart !== null || row.trialEnd !== null || row.status === 'trialing',
  );
}
