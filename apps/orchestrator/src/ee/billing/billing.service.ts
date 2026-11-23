import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import type Stripe from 'stripe';
import {
  BILLING_PLANS,
  BILLING_TRIAL_DAYS,
  type BillingRedirectResponse,
  type BillingResponse,
  type PurchasablePlan,
} from '@crewaid/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { BillingConfig } from './billing.config.js';
import { BILLING_CONFIG, STRIPE_CLIENT } from './billing.tokens.js';
import { entitlementFrom, trialEligible, type Entitlement } from './entitlement.js';

/** The `code` a checkout refused because a plan is already in force carries. */
export const BILLING_PLAN_ACTIVE_CODE = 'BILLING_PLAN_ACTIVE';
/** The `code` the portal refused because the account never checked out carries. */
export const BILLING_NO_CUSTOMER_CODE = 'BILLING_NO_CUSTOMER';

/**
 * The hosted service's plans: what an account is entitled to, and the
 * two Stripe pages it buys and manages them on.
 *
 * Registered only on a cloud server with Stripe configured. The subscription
 * rows themselves are written by `@better-auth/stripe`'s webhook, never here —
 * this service reads them, and Stripe is the only thing that changes them.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
  ) {}

  /** What this account may use right now. The one read every limit goes through. */
  async entitlementFor(userId: string, now: Date = new Date()): Promise<Entitlement> {
    return (await this.accountOf(userId, now)).entitlement;
  }

  /** `GET /billing`. */
  async status(userId: string): Promise<BillingResponse> {
    const { subscriptions, entitlement } = await this.accountOf(userId, new Date());
    const usage =
      entitlement.period === null
        ? null
        : await this.prisma.usageLedger.findUnique({
            where: { userId_periodStart: { userId, periodStart: entitlement.period.start } },
            select: {
              computeSeconds: true,
              modelMicroUsd: true,
              listenSeconds: true,
              speakSeconds: true,
            },
          });

    return {
      plan: entitlement.plan,
      status: entitlement.status,
      period:
        entitlement.period === null
          ? null
          : {
              start: entitlement.period.start.toISOString(),
              end: entitlement.period.end.toISOString(),
            },
      cancelAtPeriodEnd: entitlement.cancelAtPeriodEnd,
      trialEligible: trialEligible(subscriptions),
      compute: {
        usedSeconds: usage?.computeSeconds ?? 0,
        limitSeconds: entitlement.computeLimitSeconds,
      },
      model: {
        usedUsd: Number(usage?.modelMicroUsd ?? 0n) / 1_000_000,
        allowanceUsd:
          entitlement.modelAllowanceMicroUsd === null
            ? null
            : entitlement.modelAllowanceMicroUsd / 1_000_000,
      },
      voice: {
        listen: {
          usedSeconds: usage?.listenSeconds ?? 0,
          limitSeconds: entitlement.listenLimitSeconds,
        },
        speak: {
          usedSeconds: usage?.speakSeconds ?? 0,
          limitSeconds: entitlement.speakLimitSeconds,
        },
      },
    };
  }

  /** Computer seconds this account has used in the period starting at `periodStart`. */
  async computeSecondsUsed(userId: string, periodStart: Date): Promise<number> {
    const row = await this.prisma.usageLedger.findUnique({
      where: { userId_periodStart: { userId, periodStart } },
      select: { computeSeconds: true },
    });
    return row?.computeSeconds ?? 0;
  }

  /**
   * Add computer time to this account's period and answer the new total.
   *
   * One upsert, so the first minute of a period creates its row and every
   * later one increments it atomically — two computers of one account metered
   * in the same pass both land.
   */
  async addComputeSeconds(
    userId: string,
    period: { readonly start: Date; readonly end: Date },
    seconds: number,
  ): Promise<number> {
    const row = await this.prisma.usageLedger.upsert({
      where: { userId_periodStart: { userId, periodStart: period.start } },
      create: { userId, periodStart: period.start, periodEnd: period.end, computeSeconds: seconds },
      update: { computeSeconds: { increment: seconds } },
      select: { computeSeconds: true },
    });
    return row.computeSeconds;
  }

  /** Included-model spend, in micro-dollars, in the period starting at `periodStart`. */
  async modelMicroUsdUsed(userId: string, periodStart: Date): Promise<number> {
    const row = await this.prisma.usageLedger.findUnique({
      where: { userId_periodStart: { userId, periodStart } },
      select: { modelMicroUsd: true },
    });
    return Number(row?.modelMicroUsd ?? 0n);
  }

  /**
   * Reserve an included-model call's estimated cost before it runs.
   *
   * One conditional UPDATE adds the estimate to the period's total, and only
   * while the total is under the allowance. Its row lock is what serialises an
   * account's calls: a second call arriving while the first is in flight sees
   * the first one's reservation already counted, so N concurrent calls cannot
   * all slip in under the same remaining balance. `null`: refused, nothing
   * reserved. A `null` allowance is no limit, and the call is still reserved
   * so it is itemised the same way.
   */
  async reserveModelCharge(
    userId: string,
    period: { readonly start: Date; readonly end: Date },
    allowanceMicroUsd: number | null,
    upstreamModelId: string,
    estimateMicroUsd: number,
  ): Promise<string | null> {
    const estimate = BigInt(estimateMicroUsd);
    return this.prisma.$transaction(async (tx) => {
      await tx.usageLedger.upsert({
        where: { userId_periodStart: { userId, periodStart: period.start } },
        create: { userId, periodStart: period.start, periodEnd: period.end },
        update: {},
      });
      const admitted = await tx.usageLedger.updateMany({
        where: {
          userId,
          periodStart: period.start,
          ...(allowanceMicroUsd === null
            ? {}
            : { modelMicroUsd: { lt: BigInt(allowanceMicroUsd) } }),
        },
        data: { modelMicroUsd: { increment: estimate } },
      });
      if (admitted.count === 0) return null;
      const charge = await tx.modelCharge.create({
        data: { userId, periodStart: period.start, upstreamModelId, costMicroUsd: estimate },
        select: { id: true },
      });
      return charge.id;
    });
  }

  /**
   * Settle a reservation to what the call actually cost, and answer the
   * period's total without it and with it — the two the notice compares.
   *
   * Idempotent: only an unsettled row is settled, so a retry after a write that
   * did land changes nothing. `null` when there was nothing left to settle.
   */
  async settleModelCharge(
    userId: string,
    chargeId: string,
    actualMicroUsd: number,
  ): Promise<{ readonly before: number; readonly after: number } | null> {
    const actual = BigInt(actualMicroUsd);
    return this.prisma.$transaction(async (tx) => {
      const charge = await tx.modelCharge.findFirst({
        where: { id: chargeId, userId, settledAt: null },
        select: { costMicroUsd: true, periodStart: true },
      });
      if (charge === null) return null;
      const claimed = await tx.modelCharge.updateMany({
        where: { id: chargeId, userId, settledAt: null },
        data: { costMicroUsd: actual, settledAt: new Date() },
      });
      if (claimed.count === 0) return null;
      const ledger = await tx.usageLedger.update({
        where: { userId_periodStart: { userId, periodStart: charge.periodStart } },
        data: { modelMicroUsd: { increment: actual - charge.costMicroUsd } },
        select: { modelMicroUsd: true },
      });
      const after = Number(ledger.modelMicroUsd);
      return { before: after - actualMicroUsd, after };
    });
  }

  /**
   * `POST /billing/checkout` — a Stripe Checkout page for a plan.
   *
   * A Starter checkout from an account that has never had a trial opens one:
   * seven days at Starter's price, with the one-time $1 billed at once. Stripe
   * Checkout charges a one-off price in a subscription checkout on its first
   * invoice, which in a trial is the one issued when it starts, so the card is
   * proven and the account pays its dollar before any computer runs.
   *
   * An account with a live subscription is sent to the portal instead (409):
   * a second subscription would bill twice for one account. "Live" is anything
   * Stripe has not ended — a plan in force, and also one that is past due,
   * unpaid, paused or waiting on its first payment, each of which Stripe is
   * still trying to collect on and the portal is where it gets fixed. Asked of
   * our rows AND of Stripe, because a subscription paid a moment ago may not
   * have reached us through its webhook yet.
   *
   * Only one checkout can be paid. After creating this one, every older open
   * checkout of the account is expired — two tabs, or Starter then Pro, would
   * otherwise each make a subscription when paid, and each would carry the
   * trial. "Older" rather than "other", so two requests racing each expire only
   * the one before them and the newest survives.
   */
  async checkout(userId: string, plan: PurchasablePlan): Promise<BillingRedirectResponse> {
    const subscriptions = await this.subscriptionsOf(userId);
    if (subscriptions.some((row) => isLive(row.status))) throw planActive();

    const customer = await this.customerFor(userId);
    const fromStripe = await this.stripe.subscriptions.list({
      customer,
      status: 'all',
      limit: 100,
    });
    if (fromStripe.data.some((row) => isLive(row.status))) throw planActive();

    const trial =
      plan === 'starter' &&
      trialEligible(subscriptions) &&
      !fromStripe.data.some((row) => row.trial_start !== null || row.trial_end !== null);
    const planPrice = plan === 'starter' ? this.config.prices.starter : this.config.prices.pro;
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer,
      client_reference_id: userId,
      line_items: [
        { price: planPrice, quantity: 1 },
        ...(trial ? [await this.trialFeeItem(planPrice)] : []),
      ],
      // The owner rides on the subscription, so the sync knows whose it is
      // even before the customer is matched.
      subscription_data: {
        metadata: { userId },
        ...(trial ? { trial_period_days: BILLING_TRIAL_DAYS } : {}),
      },
      ...(this.config.automaticTax
        ? {
            automatic_tax: { enabled: true },
            billing_address_collection: 'required' as const,
            customer_update: { address: 'auto' as const, name: 'auto' as const },
          }
        : {}),
      success_url: `${this.config.returnUrl}?checkout=success`,
      cancel_url: `${this.config.returnUrl}?checkout=cancelled`,
    });
    await this.expireOlderCheckouts(customer, session);
    if (session.url === null) {
      // Stripe documents `url` as present for a hosted checkout in this mode;
      // a null here is Stripe's contract breaking, not the operator's input.
      throw new Error(`Stripe returned checkout session ${session.id} without a url`);
    }
    return { url: session.url };
  }

  /**
   * The $1 that opens the trial, as an inline one-time price rather than a
   * price id kept in the dashboard: `BILLING_PLANS.trial` is then the charge,
   * with nothing to keep in step with it. Stripe archives an inline price as
   * it creates it and adds no product to the catalogue, so nothing piles up
   * per checkout. It takes the plan's currency because Checkout refuses a
   * session that mixes two.
   */
  private async trialFeeItem(
    planPrice: string,
  ): Promise<Stripe.Checkout.SessionCreateParams.LineItem> {
    const { currency } = await this.stripe.prices.retrieve(planPrice);
    return {
      quantity: 1,
      price_data: {
        currency,
        unit_amount: BILLING_PLANS.trial.monthlyUsd * 100,
        product_data: { name: `${String(BILLING_TRIAL_DAYS)}-day trial` },
      },
    };
  }

  /** `POST /billing/portal` — Stripe's page for changing plan, card and invoices, or cancelling. */
  async portal(userId: string): Promise<BillingRedirectResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { stripeCustomerId: true },
    });
    if (user.stripeCustomerId === null) {
      throw new ConflictException({
        statusCode: 409,
        code: BILLING_NO_CUSTOMER_CODE,
        message: 'There is nothing to manage yet: choose a plan first.',
      });
    }
    const session = await this.stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${this.config.returnUrl}?portal=done`,
    });
    return { url: session.url };
  }

  /** Expire this customer's open checkouts created before `newest`. */
  private async expireOlderCheckouts(
    customer: string,
    newest: Stripe.Checkout.Session,
  ): Promise<void> {
    const open = await this.stripe.checkout.sessions.list({ customer, status: 'open', limit: 100 });
    const older = open.data.filter(
      (session) =>
        session.id !== newest.id &&
        (session.created < newest.created ||
          (session.created === newest.created && session.id < newest.id)),
    );
    for (const session of older) {
      try {
        await this.stripe.checkout.sessions.expire(session.id);
      } catch (error: unknown) {
        // Completed or expired between the list and now. Completed is the one
        // that matters, and the live-subscription check refuses the next
        // checkout once its webhook lands.
        this.logger.warn(
          `checkout ${session.id} could not be expired: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async accountOf(userId: string, now: Date) {
    const [subscriptions, user] = await Promise.all([
      this.subscriptionsOf(userId),
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { role: true } }),
    ]);
    return { subscriptions, entitlement: entitlementFrom(subscriptions, user, now) };
  }

  private subscriptionsOf(userId: string) {
    // `referenceId` is the plugin's name for a subscription's owner.
    return this.prisma.subscription.findMany({
      where: { referenceId: userId },
      select: {
        plan: true,
        status: true,
        periodStart: true,
        periodEnd: true,
        trialStart: true,
        trialEnd: true,
        cancelAtPeriodEnd: true,
        cancelAt: true,
      },
    });
  }

  /**
   * This account's Stripe customer, created at its first checkout.
   *
   * The idempotency key makes two checkouts racing from one account create one
   * customer: Stripe answers the second request with the first's result. The
   * write is conditional for the same race on our side — whichever lands
   * first is the customer, and it is the same one either way.
   */
  private async customerFor(userId: string): Promise<string> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, name: true, stripeCustomerId: true },
    });
    if (user.stripeCustomerId !== null) return user.stripeCustomerId;

    const customer = await this.stripe.customers.create(
      { email: user.email, name: user.name, metadata: { userId } },
      { idempotencyKey: `crewaid-customer-${userId}` },
    );
    await this.prisma.user.updateMany({
      where: { id: userId, stripeCustomerId: null },
      data: { stripeCustomerId: customer.id },
    });
    return customer.id;
  }
}

/**
 * Whether Stripe still treats a subscription as one it may charge. Only these
 * two statuses are ended; anything else — including a status this code does
 * not know — blocks a second subscription, because billing twice is the
 * failure that cannot be taken back.
 */
function isLive(status: string): boolean {
  return status !== 'canceled' && status !== 'incomplete_expired';
}

function planActive(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: BILLING_PLAN_ACTIVE_CODE,
    message:
      'This account already has a subscription, or one waiting on a payment. Manage it from Manage billing.',
  });
}
