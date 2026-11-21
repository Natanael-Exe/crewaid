import type Stripe from 'stripe';

type StripeEventHandler = (event: Stripe.Event) => Promise<void>;

let registered: StripeEventHandler | null = null;

/**
 * Where a verified Stripe event goes.
 *
 * The webhook is verified by Better Auth's Stripe plugin, which is built when
 * `better-auth.ts` is imported — before Nest exists. The handler that syncs a
 * subscription needs Nest's services, so the billing module registers it here
 * when it starts and the plugin's `onEvent` calls through.
 *
 * Unregistered means an event arrived before the module was up, or on a server
 * that should not have a webhook at all. Throwing is right in both cases: the
 * plugin answers 400 and Stripe delivers the event again later.
 */
export function handleStripeEvent(event: Stripe.Event): Promise<void> {
  if (registered === null) {
    return Promise.reject(new Error(`no Stripe event handler is registered for ${event.type}`));
  }
  return registered(event);
}

export function registerStripeEventHandler(handler: StripeEventHandler | null): void {
  registered = handler;
}
