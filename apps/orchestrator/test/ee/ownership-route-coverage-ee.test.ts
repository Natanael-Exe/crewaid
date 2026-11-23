import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { BillingConfig } from '../../src/ee/billing/billing.config.js';
import { BillingModule } from '../../src/ee/billing/billing.module.js';
import {
  routeKey,
  routesOf,
  mismatched,
  pointless,
  unfenced,
  type Exemption,
} from '../route-coverage-walker.js';

/**
 * D-010's fence over the cloud edition's routes (D-238).
 *
 * `BillingModule.register` returns its controllers in a plain object, and a
 * process without Stripe keys does not register it at all, so the core
 * suite's walk from `AppModule` never sees them. This registers the module
 * with every feature on (calls need the ElevenLabs key and agent) and fences
 * the controllers it declares itself — not its imports, which are core
 * modules the core suite already covers.
 */
const EVERYTHING_ON: BillingConfig = {
  secretKey: 'sk_test_route_coverage',
  webhookSecret: 'whsec_route_coverage',
  prices: { starter: 'price_a', pro: 'price_b' },
  automaticTax: false,
  returnUrl: 'https://crewaid.io/billing/done',
  openrouterKey: 'sk-or-route-coverage',
  elevenlabsKey: 'sk_el_route_coverage',
  elevenlabsAgentId: 'agent_route_coverage',
};

const discoverRoutes = () => routesOf(BillingModule.register(EVERYTHING_ON).controllers ?? []);

/** None yet: every parameterised cloud route carries a marker. */
const EXEMPT: readonly Exemption[] = [];

describe('D-010/D-238 — every direct-by-id cloud route is fenced', () => {
  it('discovers the billing and call routes', () => {
    const routes = discoverRoutes().map(routeKey);
    expect(routes).toContain('GET /billing');
    expect(routes).toContain('PATCH /calls/:callId');
  });

  it('leaves no parameterised route unmarked and unexempted', () => {
    expect(unfenced(discoverRoutes(), EXEMPT)).toEqual([]);
  });

  it('names a parameter the route actually declares', () => {
    expect(mismatched(discoverRoutes())).toEqual([]);
  });

  it('does not mark routes that carry no parameter at all', () => {
    expect(pointless(discoverRoutes())).toEqual([]);
  });

  it('fails closed when a marker is dropped', () => {
    const withoutMarkers = discoverRoutes().map((route) => ({ ...route, spec: undefined }));
    expect(unfenced(withoutMarkers, EXEMPT)).toContainEqual(
      expect.stringMatching(/^PATCH \/calls\/:callId /),
    );
  });
});
