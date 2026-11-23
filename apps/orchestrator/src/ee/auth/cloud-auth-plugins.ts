import { stripe } from '@better-auth/stripe';
import type { BetterAuthPlugin } from 'better-auth';
import { admin } from 'better-auth/plugins/admin';
import type { BillingConfig } from '../billing/billing.config.js';
import { createStripeClient } from '../billing/stripe-client.js';
import { handleStripeEvent } from '../billing/stripe-events.js';

/**
 * Operator accounts for the hosted service.
 *
 * An admin is a user whose `role` is `admin`, set by hand in the database —
 * there is no route that grants it to yourself, and the plugin's own routes
 * that change roles answer only to an existing admin. The billing module puts
 * an admin on the `internal` plan: no Stripe, no limits, for running and
 * testing production without paying it. The plugin also brings banning and
 * impersonation, both admin-only; nothing in Crewaid calls either yet.
 */
export const adminPlugin: BetterAuthPlugin = admin({ defaultRole: 'user', adminRoles: ['admin'] });

/**
 * Stripe's webhook, verified.
 *
 * The plugin is here for one thing: `POST /api/v1/auth/stripe/webhook`, which
 * checks Stripe's signature over the raw body and hands each event on. Its own
 * subscription handling is OFF, and that is deliberate. Its handlers trust each
 * event's payload in the order events arrive — which Stripe does not guarantee
 * — so a cancellation delivered before its creation was lost, and an update
 * arriving first could overwrite an older subscription's row with a newer
 * one's. They also log a failed write and answer 200, so Stripe never retried
 * it. The billing module syncs instead (`handleStripeEvent`): it re-reads the
 * subscription from Stripe on every event, so order stops mattering, and a
 * failure throws, which the plugin answers with 400 and Stripe retries.
 *
 * With subscriptions off the plugin adds no table and none of its checkout,
 * cancel or portal routes work; checkout and the portal are the billing
 * module's, because the $1 trial is a charge added to an account's first
 * Starter checkout only.
 */
export function billingPlugin(config: BillingConfig): BetterAuthPlugin {
  return stripe({
    stripeClient: createStripeClient(config),
    stripeWebhookSecret: config.webhookSecret,
    createCustomerOnSignUp: false,
    onEvent: handleStripeEvent,
  });
}

/** The cloud edition's plugins: operator accounts, then billing once Stripe is configured. */
export function cloudAuthPlugins(billing: BillingConfig | null): BetterAuthPlugin[] {
  return [adminPlugin, ...(billing === null ? [] : [billingPlugin(billing)])];
}
