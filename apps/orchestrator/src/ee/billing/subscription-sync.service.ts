import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type Stripe from 'stripe';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { BillingConfig } from './billing.config.js';
import { BILLING_CONFIG, STRIPE_CLIENT } from './billing.tokens.js';
import { registerStripeEventHandler } from './stripe-events.js';

/**
 * Keeps the `Subscription` table in step with Stripe.
 *
 * Every event re-reads the subscription, and that is the whole design
 *
 * Stripe does not deliver events in order, and redelivers them. Applying each
 * payload as it arrives lets the order decide the row: a cancellation that
 * lands before its creation is overwritten by the creation, and the account
 * keeps a plan it no longer pays for. So an event is only a nudge — it names a
 * subscription, and the row is written from that subscription as Stripe has
 * it NOW. Any order, any number of repeats, the row ends as Stripe's current
 * state.
 *
 * A failure throws. The webhook then answers 400 and Stripe delivers the event
 * again, with backoff, for days — a write the database refused is retried
 * rather than acknowledged and lost.
 */
@Injectable()
export class SubscriptionSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SubscriptionSyncService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
  ) {}

  onModuleInit(): void {
    registerStripeEventHandler((event) => this.handle(event));
  }

  onModuleDestroy(): void {
    registerStripeEventHandler(null);
  }

  /** One verified Stripe event. Events that name no subscription are acknowledged and ignored. */
  async handle(event: Stripe.Event): Promise<void> {
    const subscriptionId = subscriptionNamedBy(event);
    if (subscriptionId === null) return;
    await this.sync(subscriptionId);
  }

  /** Write one subscription's row from Stripe's current state. */
  async sync(subscriptionId: string): Promise<void> {
    const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
    const item = subscription.items.data.find((candidate) =>
      [this.config.prices.starter, this.config.prices.pro].includes(candidate.price.id),
    );
    if (item === undefined) {
      // Not one of our plans — something sold from the dashboard, say. Nothing
      // here entitles anyone to it, so there is nothing to record.
      this.logger.warn(`Stripe subscription ${subscription.id} has no Crewaid plan price; ignored`);
      return;
    }

    const customer =
      typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
    const userId = await this.ownerOf(subscription, customer);
    if (userId === null) {
      // Thrown, not ignored: the checkout that made this subscription wrote
      // the customer to its user first, so a miss is a race with that write or
      // a real fault, and either way a later delivery should try again.
      throw new Error(`no user for Stripe subscription ${subscription.id} (customer ${customer})`);
    }

    const fields = {
      plan: item.price.id === this.config.prices.pro ? 'pro' : 'starter',
      referenceId: userId,
      stripeCustomerId: customer,
      status: subscription.status,
      periodStart: fromUnix(item.current_period_start),
      periodEnd: fromUnix(item.current_period_end),
      trialStart: fromUnix(subscription.trial_start),
      trialEnd: fromUnix(subscription.trial_end),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      cancelAt: fromUnix(subscription.cancel_at),
      canceledAt: fromUnix(subscription.canceled_at),
      endedAt: fromUnix(subscription.ended_at),
      billingInterval: item.price.recurring?.interval ?? null,
    };
    // Keyed by Stripe's id, which is unique in the table, so two deliveries
    // racing for a new subscription make one row.
    await this.prisma.subscription.upsert({
      where: { stripeSubscriptionId: subscription.id },
      create: { id: subscription.id, stripeSubscriptionId: subscription.id, ...fields },
      update: fields,
    });
  }

  /** The checkout puts the user in the metadata; the customer is the fallback. */
  private async ownerOf(
    subscription: Stripe.Subscription,
    customer: string,
  ): Promise<string | null> {
    const fromMetadata = subscription.metadata['userId'];
    const user = await this.prisma.user.findFirst({
      where:
        fromMetadata !== undefined && fromMetadata !== ''
          ? { id: fromMetadata, stripeCustomerId: customer }
          : { stripeCustomerId: customer },
      select: { id: true },
    });
    return user?.id ?? null;
  }
}

/** The subscription an event is about, or null for one that is about none. */
function subscriptionNamedBy(event: Stripe.Event): string | null {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
    case 'customer.subscription.trial_will_end':
      return event.data.object.id;
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.mode !== 'subscription' || session.subscription === null) return null;
      return typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription.id;
    }
    default:
      return null;
  }
}

function fromUnix(seconds: number | null | undefined): Date | null {
  return seconds === null || seconds === undefined ? null : new Date(seconds * 1000);
}
