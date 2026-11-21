import Stripe from 'stripe';
import type { BillingConfig } from './billing.config.js';

/**
 * The one way a Stripe client is built, so the webhook plugin and the billing
 * service talk to the same account with the same API version — the SDK's
 * pinned one, which moves only with the `stripe` dependency.
 */
export function createStripeClient(config: BillingConfig): Stripe {
  return new Stripe(config.secretKey, { appInfo: { name: 'Crewaid' }, maxNetworkRetries: 2 });
}
