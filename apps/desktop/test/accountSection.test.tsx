import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import type { AuthStatus } from '../src/preload';
import { AccountSection } from '../src/renderer/settings/AccountSection';

/**
 * V1-11 — the Account section as it actually renders.
 *
 * `accountState.test.ts` holds the sentences; this holds the controls, because
 * the two can be right separately and still produce a pane that offers a
 * button which cannot work. React Aria renders `isDisabled` as a real
 * attribute in static markup, so "offered" and "live" are distinguishable here.
 */
function render(status: AuthStatus, busy = false, problem: string | null = null) {
  return renderToStaticMarkup(
    <I18nProvider>
      <AccountSection
        status={status}
        busy={busy}
        problem={problem}
        onSignIn={() => undefined}
        onSignOut={() => undefined}
        onPasteCode={() => undefined}
      />
    </I18nProvider>,
  );
}

const SIGNED_IN: AuthStatus = {
  status: 'signed-in',
  user: { id: 'u1', email: 'someone@example.com', name: 'Someone' },
};

describe('V1-11 — the Account section', () => {
  it('offers one sign-in button and never a provider menu', () => {
    // Which providers exist is the ORCHESTRATOR's answer — it is the only side
    // that knows whether GOOGLE_CLIENT_ID is set. A menu here would be this
    // app guessing at another machine's environment, and a wrong guess is a
    // button that redirects into a 500.
    const html = render({ status: 'signed-out' });
    expect(html).toContain('Sign in with browser');
    expect(html).not.toContain('Google');
    expect(html).not.toContain('GitHub');
  });

  it('shows sign-out only when there is a session', () => {
    expect(render(SIGNED_IN)).toContain('Sign out');
    expect(render({ status: 'signed-out' })).not.toContain('Sign out');
  });

  it('names the account that is signed in', () => {
    expect(render(SIGNED_IN)).toContain('someone@example.com');
  });

  it('does not offer to sign in to a server that has not been named', () => {
    const html = render({ status: 'unconfigured' });
    expect(html).toContain('Sign in with browser');
    // Offered but not live: hiding it entirely would leave someone on a fresh
    // install with no sign of where sign-in lives.
    expect(html).toContain('disabled');
    // Against the presence, so this cannot pass on markup that is disabled in
    // every state — which is how a `disabled` assertion usually goes wrong.
    expect(render({ status: 'signed-out' })).not.toContain('disabled');
  });

  it('keeps the paste field out of the way until it is asked for', () => {
    // It only matters after the browser has failed to hand back, which is the
    // uncommon case — on screen by default it reads as a second, manual way to
    // sign in and invites people to go looking for a code they do not need.
    expect(render({ status: 'signed-out' })).not.toContain('id="settings-auth-code"');
    expect(render({ status: 'signed-out' })).toContain('Paste a code instead');
  });

  it('shows a problem when there is one', () => {
    expect(render({ status: 'signed-out' }, false, 'This machine has no browser.')).toContain(
      'This machine has no browser.',
    );
  });

  it('disables its actions while a sign-in is in flight', () => {
    // The browser round trip happens outside this app and takes as long as a
    // person takes. A second press would start a second flow with a second
    // PKCE challenge, and the first callback to arrive would be refused.
    expect(render(SIGNED_IN, true)).toContain('disabled');
    expect(render(SIGNED_IN, false)).not.toContain('disabled');
  });
});
