import { describe, expect, it } from 'vitest';

import {
  HARNESS_SANDBOX_SPECIFICATION_VERSION,
  HarnessCapabilityUnsupportedError,
  HarnessError,
  HarnessSandboxAuthenticationError,
  type HarnessV1CreateSessionOptions,
  type HarnessV1NetworkPolicy,
  type HarnessV1NetworkSandboxSession,
  type HarnessV1PortEndpoint,
  type HarnessV1PortEndpointOptions,
  type HarnessV1ResumeSessionOptions,
  type HarnessV1SandboxProvider,
  SANDBOX_INFRA_SURFACE,
  type ToolSandboxSession,
} from './types.js';

/**
 * These are compile-time assertions wearing runtime clothes.
 *
 * Each one declares a const whose ANNOTATION is computed from the harness types
 * and whose VALUE is what DECISIONS.md claims. When upstream churns, the
 * annotation stops matching the literal and `tsc` fails in the one file allowed
 * to know about `@ai-sdk/harness` — which is the whole point of the firewall.
 * The `expect` calls exist so the failure also has a name a human can read in a
 * test report, and so `vitest` reports the file as covered rather than empty.
 *
 * The prose in DECISIONS.md ("setNetworkPolicy is optional, so iptables is the
 * primary mechanism") is a claim about a type nobody re-reads. This is that
 * claim, enforced.
 */

/** Exact type equality — union order and mutual assignability both accounted for. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Keys the caller MUST reach with optional-call syntax (`x.foo?.()`). */
type OptionalMemberOf<T> = {
  [K in keyof T]-?: undefined extends T[K] ? K : never;
}[keyof T];

/** Keys the caller may call unconditionally. */
type RequiredMemberOf<T> = {
  [K in keyof T]-?: undefined extends T[K] ? never : K;
}[keyof T];

describe('the harness churn firewall', () => {
  it('pins the specification version to the interface, not to a loose literal', () => {
    expect(HARNESS_SANDBOX_SPECIFICATION_VERSION).toBe('harness-sandbox-v1');
  });

  it('exposes exactly three required provider members for every provider to implement', () => {
    const unchanged: Equals<
      RequiredMemberOf<HarnessV1SandboxProvider>,
      'specificationVersion' | 'providerId' | 'createSession'
    > = true;

    expect(unchanged).toBe(true);
  });

  it('keeps resumeSession optional, so M2-BE-03 needs a createSession fallback', () => {
    // DECISIONS.md "Upstream caveat · harness optional members" + D-012: the
    // member is `resumeSession?`, NOT `resume?` — upstream's own doc comment
    // says `resume?` and is wrong. If this equality breaks, read the .d.ts
    // declaration, not the doc comment above it.
    const providerCapabilities: Equals<
      OptionalMemberOf<HarnessV1SandboxProvider>,
      'resumeSession'
    > = true;

    expect(providerCapabilities).toBe(true);
  });

  it('keeps network policy optional, so iptables on agent-net stays the primary mechanism', () => {
    // §7.3 reads "prefer session.setNetworkPolicy()". That inverts the real
    // priority: an optional member cannot be the primary enforcement path for a
    // security requirement. M2-BE-09 implements iptables; this call is an
    // opportunistic upgrade behind a capability check.
    const sessionCapabilities: Equals<
      OptionalMemberOf<HarnessV1NetworkSandboxSession>,
      'setNetworkPolicy' | 'setPorts' | 'setRequestTransformations' | 'addRequestTransformations'
    > = true;

    expect(sessionCapabilities).toBe(true);
  });

  it('keeps getPortEndpoint and restricted callable unconditionally', () => {
    // D-012: getPortEndpoint carries the M2 port surface (5900 RFB, 9222 CDP,
    // 7070 bridge). R4: restricted() is what tool execute() calls receive.
    // Neither may become optional without every call site changing shape.
    const portResolution: undefined extends HarnessV1NetworkSandboxSession['getPortEndpoint']
      ? false
      : true = true;
    const reducedView: undefined extends HarnessV1NetworkSandboxSession['restricted']
      ? false
      : true = true;

    expect([portResolution, reducedView]).toEqual([true, true]);
  });

  it('carries the port headers that must travel with the connection (D-012)', () => {
    // Opening the RFB socket to endpoint.url while dropping endpoint.headers
    // fails in a way that reads as a sandbox or network fault. The headers are
    // scoped to that URL; they are not a general auth bag.
    const endpoint: HarnessV1PortEndpoint = {
      url: 'ws://127.0.0.1:32768',
      headers: { authorization: 'Bearer scoped-to-this-url' },
    };

    expect(endpoint.headers?.['authorization']).toBe('Bearer scoped-to-this-url');
  });

  it('names the option shapes upstream only declares inline', () => {
    const create: HarnessV1CreateSessionOptions = {
      sessionId: 'sandbox-for-bot-1',
      identity: 'crewaid-desktop-v1',
    };
    const resume: HarnessV1ResumeSessionOptions = { sessionId: 'sandbox-for-bot-1' };
    const rfbPort: HarnessV1PortEndpointOptions = { port: 5900 };

    expect([create.sessionId, resume.sessionId, rfbPort.port]).toEqual([
      'sandbox-for-bot-1',
      'sandbox-for-bot-1',
      5900,
    ]);
  });

  it('models the CIDR portion of the §7.3 egress policy', () => {
    // A 'custom' policy with only deniedCIDRs is rejected at compile time
    // upstream — deny-only is what 'deny-all' already means. So the M2-BE-09
    // shape has to be an allow-list with the private ranges denied on top.
    // This type has no port filter; iptables must enforce ports 80/443.
    const policy: HarnessV1NetworkPolicy = {
      mode: 'custom',
      allowedCIDRs: ['0.0.0.0/0'],
      deniedCIDRs: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'],
    };

    expect(policy.mode).toBe('custom');
  });
});

describe('the harness error classes', () => {
  it('signals a credential failure distinctly from a dead Docker daemon', () => {
    // createSession's contract: throw this when sandbox acquisition fails for
    // authorization reasons, so a caller can tell misconfiguration apart from
    // infrastructure trouble. A generic Error collapses that distinction.
    const error = new HarnessSandboxAuthenticationError({
      message: 'Docker daemon rejected the client credentials',
      sandboxProviderId: 'crewaid-docker',
    });

    expect(HarnessSandboxAuthenticationError.isInstance(error)).toBe(true);
    expect(error.sandboxProviderId).toBe('crewaid-docker');
  });

  it('signals an absent optional capability', () => {
    const error = new HarnessCapabilityUnsupportedError({
      message: 'resumeSession is not implemented by this provider',
    });

    expect(HarnessCapabilityUnsupportedError.isInstance(error)).toBe(true);
    expect(HarnessError.isInstance(error)).toBe(true);
  });

  it('narrows by isInstance rather than instanceof', () => {
    // Each class carries a private brand symbol and ships a static isInstance.
    // Two copies of @ai-sdk/harness in one dependency graph produce two class
    // identities, and instanceof answers false across them; the brand check
    // does not. Errors cross that boundary exactly where it is least visible.
    const thrown: unknown = new HarnessSandboxAuthenticationError({
      message: 'unauthorized',
      sandboxProviderId: 'crewaid-docker',
    });

    expect(HarnessError.isInstance(thrown)).toBe(true);
    expect(HarnessCapabilityUnsupportedError.isInstance(thrown)).toBe(false);
  });
});

/**
 * M5-BE-07 — R4 as a type, not a convention.
 *
 * These are the same compile-time assertions as above plus a kind the file did
 * not need before: `@ts-expect-error`, which fails the build when the line
 * under it STOPS being an error. That is what a probe does for a lint rule
 * (D-013 — "a guard that cannot be demonstrated failing is not evidence"), and
 * `tools/guard-probes` cannot host this one, because the runner asserts that a
 * named eslint rule fired and nothing here is an eslint rule. Weaken
 * `ToolSandboxSession` and `tsc` reports an unused directive on the exact line
 * that was supposed to be blocked.
 *
 * The subjects are declared at module scope because `declare` is not a modifier
 * a function body accepts, and these have to be types without values — the
 * fence is about what may be ASSIGNED, so constructing a real session would
 * prove nothing about it.
 */
declare const fullSession: HarnessV1NetworkSandboxSession;
declare const reducedSession: ReturnType<HarnessV1NetworkSandboxSession['restricted']>;
declare const toolSession: ToolSandboxSession;

describe('R4 the session a tool may hold (M5-BE-07)', () => {
  it('bans exactly the members the network session adds', () => {
    // The point of the list is that it IS the difference, not a hand-kept
    // selection of scary names. Upstream adding one member to
    // HarnessV1NetworkSandboxSession breaks this line — in the firewall's own
    // test — instead of quietly becoming something a tool can reach.
    const listIsTheDifference: Equals<
      Exclude<keyof HarnessV1NetworkSandboxSession, keyof typeof reducedSession>,
      (typeof SANDBOX_INFRA_SURFACE)[number]
    > = true;

    expect(listIsTheDifference).toBe(true);
    expect(SANDBOX_INFRA_SURFACE).toHaveLength(12);
  });

  it('still accepts what restricted() actually returns', () => {
    // The fence has to be one-directional. A reduced view that no longer fit
    // would make the type unusable, and the next person would widen it back.
    //
    // The subjects are `declare`d, so they exist for tsc and not at runtime —
    // hence an arrow nobody calls. The assignment inside it is checked all the
    // same, which is the only part that was ever the assertion.
    const accepts = (): ToolSandboxSession => reducedSession;

    expect(typeof accepts).toBe('function');
  });

  it('rejects the full network session at the boundary', () => {
    // THE case this type exists for. `HarnessV1NetworkSandboxSession` extends
    // the base session, so it is assignable to the reduced alias — which is why
    // `session: () => this.session` type-checked before this type existed, and
    // would have handed every tool destroy() and setNetworkPolicy().
    // @ts-expect-error R4: every infra member is declared `never` here, and a
    // function is not assignable to `never`.
    const leaks = (): ToolSandboxSession => fullSession;

    expect(typeof leaks).toBe('function');
  });

  it('blocks a call in both spellings, not just the plain one', () => {
    // These two hold with or without the brand — the reduced alias does not
    // declare either member, so removing the brand only changes WHICH error
    // tsc reports. They are here because the second spelling is the one this
    // repo's own idiom reaches for: every optional harness member is called as
    // `session.setNetworkPolicy?.(policy)`, and a tool author copying that
    // shape should get a compile error, not a silent no-op.
    const stop = (): void => {
      // @ts-expect-error R4: `destroy` is possibly undefined, so it cannot be
      // called outright.
      toolSession.destroy();
    };
    const repoint = (): void => {
      // @ts-expect-error R4: and `never` has no call signatures, so
      // optional-call is not the escape hatch it looks like.
      toolSession.setNetworkPolicy?.({ mode: 'deny-all' });
    };

    expect([typeof stop, typeof repoint]).toEqual(['function', 'function']);
  });
});
