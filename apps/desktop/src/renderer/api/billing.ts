import {
  API_ROUTES,
  BillingRedirectResponseSchema,
  BillingResponseSchema,
  type BillingRedirectResponse,
  type BillingResponse,
  type PurchasablePlan,
} from '@crewaid/shared';
import type { ApiClient } from './apiClient';

/**
 * REST billing routes. Hosted servers with Stripe only; anywhere else
 * they answer 404, which the pane reads as "this server does not bill".
 *
 * The two writes answer with a Stripe page for the system browser, never a
 * change to the plan: Stripe's webhook is what changes a plan, so the pane
 * refetches when the window is focused again rather than assuming the result.
 */

export function getBilling(client: ApiClient): Promise<BillingResponse> {
  return client.request(API_ROUTES.billing.get, { schema: BillingResponseSchema });
}

export function startCheckout(
  client: ApiClient,
  plan: PurchasablePlan,
): Promise<BillingRedirectResponse> {
  return client.request(API_ROUTES.billing.checkout, {
    body: { plan },
    schema: BillingRedirectResponseSchema,
  });
}

export function openBillingPortal(client: ApiClient): Promise<BillingRedirectResponse> {
  return client.request(API_ROUTES.billing.portal, { schema: BillingRedirectResponseSchema });
}
