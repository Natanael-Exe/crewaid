import {
  BILLING_PLANS,
  BILLING_TRIAL_DAYS,
  type BillingResponse,
  type UsageNoticePayload,
} from '@crewaid/shared';
import type { ApiFailure } from '../api/apiError';
import { currentLocale, t } from '../i18n/i18n';

/**
 * Plan & usage's copy, as pure functions.
 *
 * The states worth getting right are the ones a person reaches when money is
 * involved and something is off — a failed renewal, a cancelled plan running
 * out, an exhausted allowance — and none of those is reachable from a test
 * that needs a real Stripe account. So the sentences are decided here and the
 * pane only lays them out.
 */

export type Meter = {
  readonly label: string;
  /** What is left, as a person reads it: "7.5 h of 10 h left", or "Unlimited". */
  readonly remaining: string;
  /** Under the label: when the allowance resets, or what was used of an unlimited one. */
  readonly detail: string | null;
  /** 0–1 of the allowance LEFT, for the bar; `null` for a meter with no limit, which draws no bar. */
  readonly fraction: number | null;
};

export type PlanSummary = {
  readonly title: string;
  readonly line: string;
  readonly tone: 'ok' | 'muted' | 'danger';
};

/** Whole hours below ten are shown with one decimal: "2.5 h" means something on a 10 h trial. */
function hours(seconds: number): string {
  const value = seconds / 3600;
  return t('settings.plan.hours', {
    value: value < 10 ? Math.round(value * 10) / 10 : Math.round(value),
  });
}

/** Voice time: minutes under two hours, where a minute is what a person counts in. */
function voiceTime(seconds: number): string {
  return seconds < 2 * 3600
    ? t('settings.plan.minutes', { value: Math.round(seconds / 60) })
    : hours(seconds);
}

function usd(value: number): string {
  return new Intl.NumberFormat(currentLocale(), { style: 'currency', currency: 'USD' }).format(
    value,
  );
}

/** A plan's price: whole dollars stay whole ("$20"), cents are shown when there are some. */
function price(value: number): string {
  return new Intl.NumberFormat(currentLocale(), {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(currentLocale(), { month: 'short', day: 'numeric' });
}

/** "6d 19h", "3h 20m", "14m" — the two largest units, the way a countdown is read. */
function until(iso: string, now: Date): string | null {
  const minutes = Math.floor((Date.parse(iso) - now.getTime()) / 60_000);
  if (minutes < 1) return null;
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0)
    return h > 0
      ? t('settings.plan.duration.dayHour', { d, h })
      : t('settings.plan.duration.day', { d });
  if (h > 0)
    return m > 0
      ? t('settings.plan.duration.hourMinute', { h, m })
      : t('settings.plan.duration.hour', { h });
  return t('settings.plan.duration.minute', { m });
}

export function planSummary(billing: BillingResponse): PlanSummary {
  const end = billing.period === null ? null : day(billing.period.end);
  switch (billing.plan) {
    case 'internal':
      return {
        title: BILLING_PLANS.internal.label,
        line: t('settings.plan.internal.line'),
        tone: 'ok',
      };
    case 'trial':
      return {
        title: t('settings.plan.trial.title'),
        line: t('settings.plan.trial.line', {
          end: end ?? t('settings.plan.soon'),
          price: price(BILLING_PLANS.starter.monthlyUsd),
        }),
        tone: 'ok',
      };
    case 'starter':
    case 'pro': {
      const plan = BILLING_PLANS[billing.plan];
      return {
        title: plan.label,
        line: billing.cancelAtPeriodEnd
          ? t('settings.plan.cancelled', { end: end ?? t('settings.plan.endOfPeriod') })
          : end === null
            ? t('settings.plan.monthly', { price: price(plan.monthlyUsd) })
            : t('settings.plan.monthlyRenews', { price: price(plan.monthlyUsd), end }),
        tone: billing.cancelAtPeriodEnd ? 'muted' : 'ok',
      };
    }
    case 'none':
      return {
        title: noPlanTitle(billing),
        line: noPlanLine(billing),
        tone: billing.status === null ? 'muted' : 'danger',
      };
  }
}

function noPlanTitle(billing: BillingResponse): string {
  switch (billing.status) {
    case 'past_due':
    case 'unpaid':
      return t('settings.plan.paymentFailed');
    case 'incomplete':
      return t('settings.plan.paymentUnfinished');
    case 'paused':
      return t('settings.plan.paused');
    case 'canceled':
    case 'incomplete_expired':
      return t('settings.plan.ended');
    default:
      return t('settings.plan.none');
  }
}

/** Why there is no plan, which decides which button helps. */
function noPlanLine(billing: BillingResponse): string {
  switch (billing.status) {
    case 'past_due':
    case 'unpaid':
      return t('settings.plan.line.paymentFailed');
    case 'canceled':
    case 'incomplete_expired':
      return t('settings.plan.line.ended');
    case 'incomplete':
      return t('settings.plan.line.unfinished');
    case 'paused':
      return t('settings.plan.line.paused');
    default:
      return t('settings.plan.line.none');
  }
}

/**
 * What is left of each allowance. Left, not used, because "can I keep going"
 * is the question a person opens this to answer.
 *
 * A trial's allowances do not reset — the trial ends and Starter's begin — so
 * its countdown says that instead.
 */
export function meters(billing: BillingResponse, now: Date = new Date()): readonly Meter[] {
  const { usedSeconds, limitSeconds } = billing.compute;
  const { usedUsd, allowanceUsd } = billing.model;
  const left = billing.period === null ? null : until(billing.period.end, now);
  const countdown =
    billing.plan === 'trial'
      ? left === null
        ? t('settings.plan.trialEndsSoon')
        : t('settings.plan.trialEndsIn', { left })
      : left === null
        ? null
        : t('settings.plan.resetsIn', { left });
  return [
    meter({
      label: t('settings.meter.compute'),
      used: usedSeconds,
      limit: limitSeconds,
      format: hours,
      countdown,
    }),
    meter({
      label: t('settings.meter.model'),
      used: usedUsd,
      limit: allowanceUsd,
      format: usd,
      countdown,
    }),
    // Voice has its own allowance, so talking never spends a bot's.
    meter({
      label: t('settings.meter.listen'),
      used: billing.voice.listen.usedSeconds,
      limit: billing.voice.listen.limitSeconds,
      format: voiceTime,
      countdown,
    }),
    meter({
      label: t('settings.meter.speak'),
      used: billing.voice.speak.usedSeconds,
      limit: billing.voice.speak.limitSeconds,
      format: voiceTime,
      countdown,
    }),
  ];
}

function meter({
  label,
  used,
  limit,
  format,
  countdown,
}: {
  label: string;
  used: number;
  limit: number | null;
  format: (value: number) => string;
  countdown: string | null;
}): Meter {
  if (limit === null) {
    return {
      label,
      remaining: t('settings.meter.unlimited'),
      detail: t('settings.meter.used', { amount: format(used) }),
      fraction: null,
    };
  }
  const rest = Math.max(0, limit - used);
  return {
    label,
    remaining:
      rest === 0
        ? t('settings.meter.usedUp')
        : t('settings.meter.left', { rest: format(rest), limit: format(limit) }),
    detail: countdown,
    fraction: limit === 0 ? 0 : rest / limit,
  };
}

export type UsageGlance = {
  readonly label: string;
  /** What is left as a share: "56%", or "Unlimited". */
  readonly left: string;
  /** When it resets — a time within the day, a date beyond it — or `null`. */
  readonly resets: string | null;
  readonly exhausted: boolean;
};

/**
 * The account menu's version of the meters: a share and a reset time, read
 * at a glance on the way to something else. The pane has the hours and
 * dollars for the person who stops to look.
 */
export function usageGlance(
  billing: BillingResponse,
  now: Date = new Date(),
): readonly UsageGlance[] {
  if (billing.plan === 'none') return [];
  const resets = billing.period === null ? null : resetMoment(billing.period.end, now);
  // The menu is a glance: the two allowances that stop a bot. Voice has its
  // own rows in the plan pane, one click away.
  // The first two meters are computer time and included model use, in that
  // order; picked by position because their labels are translated.
  return meters(billing, now)
    .slice(0, 2)
    .map((meter, index) => ({
      label: index === 1 ? t('settings.glance.model') : meter.label,
      left:
        meter.fraction === null
          ? t('settings.meter.unlimited')
          : new Intl.NumberFormat(currentLocale(), { style: 'percent' }).format(
              Math.round(meter.fraction * 100) / 100,
            ),
      resets: meter.fraction === null ? null : resets,
      exhausted: meter.fraction === 0,
    }));
}

/** "1:58 PM" when the reset is within a day, "Oct 20" beyond it. */
function resetMoment(iso: string, now: Date): string {
  const at = new Date(iso);
  return at.getTime() - now.getTime() < 86_400_000
    ? at.toLocaleTimeString(currentLocale(), { hour: 'numeric', minute: '2-digit' })
    : day(iso);
}

export type PlanActions = {
  /** Plans a checkout can start from here; empty while a plan is in force. */
  readonly choose: readonly ('starter' | 'pro')[];
  /** Whether Stripe's portal has anything to show this account. */
  readonly manage: boolean;
};

/**
 * What the pane offers. A plan in force is changed in the portal, never by a
 * second checkout (the server refuses one with 409). So is a subscription
 * Stripe is still collecting on — past due, unpaid, paused, or waiting on its
 * first payment: buying another would bill twice, and the fix is the card.
 * Only an account whose subscriptions have all ended, or that never had one,
 * chooses a plan; it still gets the portal when Stripe has its history. An
 * admin has nothing to buy.
 */
export function planActions(billing: BillingResponse): PlanActions {
  switch (billing.plan) {
    case 'internal':
      return { choose: [], manage: false };
    case 'none':
      if (billing.status === null) return { choose: ['starter', 'pro'], manage: false };
      if (billing.status === 'canceled' || billing.status === 'incomplete_expired') {
        return { choose: ['starter', 'pro'], manage: true };
      }
      return { choose: [], manage: true };
    default:
      return { choose: [], manage: true };
  }
}

export type PlanOffer = {
  readonly plan: 'starter' | 'pro';
  readonly title: string;
  /** The first charge, in the card's large type. */
  readonly price: string;
  /** What follows the first charge, or the cadence of a plain monthly one. */
  readonly then: string;
  readonly points: readonly string[];
  readonly cta: string;
  /** The one drawn with an outline and the primary button. */
  readonly recommended: boolean;
};

/**
 * The plans offered to an account that has none, as cards. The same
 * numbers as the pricing page, from the same table, so the first screen after
 * sign-up cannot quote a different plan from the one the site sold.
 *
 * Starter leads with the trial when the account can still have one: $1 is the
 * charge the person is about to see in Stripe, and $20 a month is what follows.
 */
export function planOffers(billing: BillingResponse): readonly PlanOffer[] {
  const { trial, starter, pro } = BILLING_PLANS;
  const offered = planActions(billing).choose;
  const offers: PlanOffer[] = [];
  if (offered.includes('starter')) {
    offers.push({
      plan: 'starter',
      title: starter.label,
      price: billing.trialEligible ? price(trial.monthlyUsd) : price(starter.monthlyUsd),
      then: billing.trialEligible
        ? t('settings.offer.starter.then.trial', {
            days: BILLING_TRIAL_DAYS,
            price: price(starter.monthlyUsd),
          })
        : t('settings.offer.aMonth'),
      points: [
        billing.trialEligible
          ? t('settings.offer.starter.compute.trial', {
              trial: trial.computeHours,
              starter: starter.computeHours,
            })
          : t('settings.offer.starter.compute', { hours: starter.computeHours }),
        billing.trialEligible
          ? t('settings.offer.starter.model.trial', {
              trial: price(trial.modelAllowanceUsd),
              starter: price(starter.modelAllowanceUsd),
            })
          : t('settings.offer.model', { amount: price(starter.modelAllowanceUsd) }),
        t('settings.offer.ownKeys'),
      ],
      cta: billing.trialEligible
        ? t('settings.offer.startTrial', { days: BILLING_TRIAL_DAYS })
        : t('settings.offer.chooseStarter'),
      recommended: true,
    });
  }
  if (offered.includes('pro')) {
    offers.push({
      plan: 'pro',
      title: pro.label,
      price: price(pro.monthlyUsd),
      then: t('settings.offer.aMonth'),
      points: [
        t('settings.offer.pro.alwaysOn'),
        t('settings.offer.model', { amount: price(pro.modelAllowanceUsd) }),
        t('settings.offer.ownKeys'),
      ],
      cta: t('settings.offer.choosePro'),
      recommended: false,
    });
  }
  return offers;
}

/** What to say when `GET /billing` fails. A 404 is a server that does not bill. */
export function billingProblem(failure: ApiFailure): string {
  switch (failure.code) {
    case 'NOT_FOUND':
      return t('settings.billing.notFound');
    case 'NETWORK':
      return t('settings.billing.network');
    case 'UNAUTHORIZED':
      return t('settings.billing.unauthorized');
    default:
      return t('settings.billing.failed');
  }
}

/**
 * The sidebar's line for a plan-use notice. At 100% it says what
 * stopped and what still works, because the two meters stop different things:
 * used-up computer time stops the computer, used-up included model use stops
 * only the included models — the person's own keys keep working.
 */
export function usageNoticeText(notice: UsageNoticePayload): string {
  const resets = day(notice.resetsAt);
  if (notice.kind === 'compute') {
    return notice.level === 100
      ? t('settings.notice.computeSpent', { resets })
      : t('settings.notice.computeWarning', { resets });
  }
  return notice.level === 100
    ? t('settings.notice.modelSpent', { resets })
    : t('settings.notice.modelWarning', { resets });
}
