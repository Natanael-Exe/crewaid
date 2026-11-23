import { Logger } from '@nestjs/common';
import type { Edition } from '@crewaid/shared';

/** What a billing server needs from its environment. */
export type BillingConfig = {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly prices: {
    readonly starter: string;
    readonly pro: string;
  };
  /** Stripe Tax on checkouts. Off until the account's tax registrations are set up in Stripe. */
  readonly automaticTax: boolean;
  /**
   * Where Stripe sends the browser back to after Checkout or the portal: a
   * page that says to return to the app. Not an orchestrator route, because it
   * is opened by a browser with no session and every route here needs one.
   */
  readonly returnUrl: string;
  /**
   * Crewaid's own OpenRouter key, which the included models run on.
   * Optional: without it, plans bill computer time and every account brings
   * its own model keys. Never read anywhere but the included-models service.
   */
  readonly openrouterKey: string | null;
  /**
   * Crewaid's own ElevenLabs key, which dictation, voice messages and
   * spoken replies run on, metered like the included models. Optional:
   * without it every account speaks on an ElevenLabs key of its own.
   */
  readonly elevenlabsKey: string | null;
  /**
   * The ElevenLabs agent that is the voice on a call. Calls exist only
   * with it and the key above; an agent with no key refuses to boot.
   */
  readonly elevenlabsAgentId: string | null;
};

const DEFAULT_RETURN_URL = 'https://crewaid.io/billing/done';

const PRICE_VARS = {
  starter: 'STRIPE_PRICE_STARTER',
  pro: 'STRIPE_PRICE_PRO',
} as const;

/**
 * Whether this server bills, read once at boot.
 *
 * Production cloud requires Stripe. Cloud development can run with billing
 * disabled and unlimited accounts. Self-hosted instances have no billing.
 *
 * Once the key is present the rest is required: a billing server that cannot
 * verify a webhook or name a price would take money it cannot account for, so
 * a half-configured one refuses to boot rather than failing at first checkout.
 */
export function readBillingConfig(
  edition: Edition,
  env: Readonly<Record<string, string | undefined>>,
): BillingConfig | null {
  const value = (name: string): string => (env[name] ?? '').trim();
  if (edition !== 'cloud') return null;

  const secretKey = value('STRIPE_SECRET_KEY');
  if (secretKey === '') {
    if (value('NODE_ENV') === 'production') {
      throw new Error('STRIPE_SECRET_KEY is required for a production cloud server');
    }
    new Logger('Billing').warn(
      'STRIPE_SECRET_KEY is not set: billing is off and every account is unlimited',
    );
    return null;
  }

  const missing = ['STRIPE_WEBHOOK_SECRET', ...Object.values(PRICE_VARS)].filter(
    (name) => value(name) === '',
  );
  if (missing.length > 0) {
    throw new Error(
      `STRIPE_SECRET_KEY is set, so billing is on and ${missing.join(', ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} required (see infra/compose/.env.example)`,
    );
  }

  const elevenlabsKey = value('CREWAID_ELEVENLABS_API_KEY') || null;
  const elevenlabsAgentId = value('CREWAID_ELEVENLABS_AGENT_ID') || null;
  if (elevenlabsAgentId !== null && elevenlabsKey === null) {
    throw new Error(
      'CREWAID_ELEVENLABS_AGENT_ID is set, so calls are on and CREWAID_ELEVENLABS_API_KEY ' +
        'is required (see infra/compose/.env.example)',
    );
  }

  return {
    secretKey,
    webhookSecret: value('STRIPE_WEBHOOK_SECRET'),
    prices: {
      starter: value(PRICE_VARS.starter),
      pro: value(PRICE_VARS.pro),
    },
    automaticTax: value('STRIPE_AUTOMATIC_TAX') === 'true',
    returnUrl: value('BILLING_RETURN_URL') || DEFAULT_RETURN_URL,
    openrouterKey: value('CREWAID_OPENROUTER_API_KEY') || null,
    elevenlabsKey,
    elevenlabsAgentId,
  };
}

let processConfig: { readonly value: BillingConfig | null } | undefined;

/**
 * This process's billing config, read from its environment once.
 *
 * The auth instance and `CloudAppModule` both need the answer at import time, and
 * reading twice would say "billing is off" twice at every boot.
 */
export function processBillingConfig(edition: Edition): BillingConfig | null {
  processConfig ??= { value: readBillingConfig(edition, process.env) };
  return processConfig.value;
}
