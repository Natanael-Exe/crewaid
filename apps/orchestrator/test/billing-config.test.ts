import { describe, expect, it } from 'vitest';
import { readBillingConfig } from '../src/billing/billing.config.js';

/** D-156 — when a server bills, and what it refuses to boot without. */
const STRIPE = {
  STRIPE_SECRET_KEY: 'sk_test_123',
  STRIPE_WEBHOOK_SECRET: 'whsec_123',
  STRIPE_PRICE_STARTER: 'price_starter',
  STRIPE_PRICE_PRO: 'price_pro',
};

describe('D-156 — readBillingConfig', () => {
  it('never bills on a self-hosted server, even with a hosted .env copied in', () => {
    expect(readBillingConfig('selfhosted', STRIPE)).toBeNull();
  });

  it('runs a cloud server without Stripe unbilled', () => {
    expect(readBillingConfig('cloud', {})).toBeNull();
  });

  it('requires billing before a production cloud server can allocate compute', () => {
    expect(() => readBillingConfig('cloud', { NODE_ENV: 'production' })).toThrow(
      'STRIPE_SECRET_KEY',
    );
    expect(readBillingConfig('selfhosted', { NODE_ENV: 'production' })).toBeNull();
  });

  it('bills a cloud server with Stripe configured', () => {
    expect(readBillingConfig('cloud', STRIPE)).toEqual({
      secretKey: 'sk_test_123',
      webhookSecret: 'whsec_123',
      prices: { starter: 'price_starter', pro: 'price_pro' },
      automaticTax: false,
      returnUrl: 'https://crewaid.io/billing/done',
      openrouterKey: null,
      elevenlabsKey: null,
      elevenlabsAgentId: null,
    });
  });

  it('reads the call agent alongside the ElevenLabs key (D-222)', () => {
    expect(
      readBillingConfig('cloud', {
        ...STRIPE,
        CREWAID_ELEVENLABS_API_KEY: 'sk_el_1',
        CREWAID_ELEVENLABS_AGENT_ID: 'agent_1',
      })?.elevenlabsAgentId,
    ).toBe('agent_1');
  });

  it('refuses to boot with a call agent and no ElevenLabs key to reach it', () => {
    expect(() =>
      readBillingConfig('cloud', { ...STRIPE, CREWAID_ELEVENLABS_AGENT_ID: 'agent_1' }),
    ).toThrow(/CREWAID_ELEVENLABS_API_KEY is required/);
  });

  it('reads Crewaid’s own ElevenLabs key for voice (D-221)', () => {
    expect(
      readBillingConfig('cloud', { ...STRIPE, CREWAID_ELEVENLABS_API_KEY: 'sk_el_1' })
        ?.elevenlabsKey,
    ).toBe('sk_el_1');
  });

  it('reads Crewaid’s own OpenRouter key for the included models (D-157)', () => {
    expect(
      readBillingConfig('cloud', { ...STRIPE, CREWAID_OPENROUTER_API_KEY: 'sk-or-1' })
        ?.openrouterKey,
    ).toBe('sk-or-1');
  });

  it('refuses to boot half-configured, naming every missing variable', () => {
    expect(() =>
      readBillingConfig('cloud', {
        STRIPE_SECRET_KEY: 'sk_test_123',
        STRIPE_PRICE_STARTER: 'price_starter',
      }),
    ).toThrow(/STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_PRO are required/);
  });

  it('reads Stripe Tax and the return page when set', () => {
    const config = readBillingConfig('cloud', {
      ...STRIPE,
      STRIPE_AUTOMATIC_TAX: 'true',
      BILLING_RETURN_URL: 'https://example.test/done',
    });
    expect(config?.automaticTax).toBe(true);
    expect(config?.returnUrl).toBe('https://example.test/done');
  });
});
