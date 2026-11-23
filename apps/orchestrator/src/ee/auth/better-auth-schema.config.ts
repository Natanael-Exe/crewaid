import { createAuth } from '../../auth/better-auth.js';
import type { BillingConfig } from '../billing/billing.config.js';
import { cloudAuthPlugins } from './cloud-auth-plugins.js';

/**
 * The config `@better-auth/cli generate` reads to write the auth block of
 * `prisma/schema.prisma` (D-238).
 *
 * The core's `auth` carries only the plugins registered when it was built, and
 * a process without Stripe keys registers no billing plugin. Generating from
 * that would drop `stripeCustomerId`, `role`, `banned` and the other columns
 * the cloud plugins own. This builds the full set explicitly, with a config no
 * code path ever sends to Stripe, so the schema does not depend on the
 * environment of whoever runs the generator.
 *
 * Passing the plugins rather than registering them keeps this file free of
 * side effects: importing it never touches the core's registry.
 */
const SCHEMA_ONLY_BILLING: BillingConfig = {
  secretKey: 'sk_test_schema_generation_only',
  webhookSecret: 'whsec_schema_generation_only',
  prices: { starter: 'price_schema_only', pro: 'price_schema_only' },
  automaticTax: false,
  returnUrl: 'https://crewaid.io',
  openrouterKey: null,
  elevenlabsKey: null,
  elevenlabsAgentId: null,
};

export const auth = createAuth('cloud', cloudAuthPlugins(SCHEMA_ONLY_BILLING));
