import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import type { Edition } from '@crewaid/shared';
import type { AuthStatus } from '../src/preload';
import type { AuthPort } from '../src/renderer/bridge';
import { LaunchGate } from '../src/renderer/launch/LaunchGate';
import type { LaunchState } from '../src/renderer/launch/launchState';

/**
 * V1-18 — the gate, as it actually renders.
 *
 * `launchState.test.ts` holds the sentences; this holds the one thing that
 * cannot be asserted about a pure function: that the shell is NOT THERE. A
 * gate whose copy is perfect and whose children render anyway is the bug this
 * task exists to fix, and it passes every copy test.
 */

const SHELL = 'CREWAID-SHELL-SENTINEL';

function render(initialState: LaunchState, edition: Edition | null = 'selfhosted') {
  return renderToStaticMarkup(
    <I18nProvider>
      <LaunchGate initialState={initialState} edition={edition}>
        {() => <div>{SHELL}</div>}
      </LaunchGate>
    </I18nProvider>,
  );
}

const CLOSED: LaunchState[] = [
  { kind: 'checking' },
  { kind: 'needs-address' },
  { kind: 'unreachable' },
  { kind: 'signed-out' },
  { kind: 'blocked', reason: 'storage' },
  { kind: 'blocked', reason: 'ipc' },
  { kind: 'blocked', reason: 'refused' },
];

describe('V1-18 — the launch gate', () => {
  it('renders the shell only once there is an account', () => {
    // The assertion the whole task is for. Asserted against a PRESENCE — the
    // ready case below proves the sentinel is reachable at all, so the
    // absences above cannot pass because the child was never wired up.
    for (const state of CLOSED) {
      expect(render(state), `${state.kind} rendered the shell`).not.toContain(SHELL);
    }
    expect(
      render({
        kind: 'ready',
        user: { id: 'u1', email: 'ada@example.com', name: 'Ada Lovelace' },
      }),
    ).toContain(SHELL);
  });

  it('shows a loading state rather than a blank frame while it checks', () => {
    const html = render({ kind: 'checking' });
    expect(html).toContain('Connecting');
    // Announced, because a spinner alone says nothing to a screen reader.
    expect(html).toContain('aria-live="polite"');
    // And no action, because there is nothing to do but wait.
    expect(html).not.toContain('Sign in with browser');
    expect(html).not.toContain('Try again');
  });

  it('asks for an address before it asks for a sign-in', () => {
    const html = render({ kind: 'needs-address' });
    expect(html).toContain('launch-base-url');
    expect(html).not.toContain('Sign in with browser');
  });

  it('offers a sign-in, and the paste fallback, once an address exists', () => {
    const html = render({ kind: 'signed-out' });
    expect(html).toContain('Sign in with browser');
    expect(html).toContain('Paste a code instead');
    expect(html).not.toContain('launch-base-url');
  });

  it('gives a hosted build nothing to correct, only to retry (D-152)', () => {
    // Its address is compiled in and the person never typed it, so neither the
    // button nor a sentence blaming "the address" belongs on this screen.
    const unreachable = render({ kind: 'unreachable' }, 'cloud');
    expect(unreachable).toContain('Try again');
    expect(unreachable).toContain('Crewaid is not answering');
    expect(unreachable).not.toContain('Change orchestrator address');
    expect(unreachable).not.toContain('address may be wrong');

    const signedOut = render({ kind: 'signed-out' }, 'cloud');
    expect(signedOut).toContain('Sign in with browser');
    expect(signedOut).not.toContain('Change orchestrator address');
  });

  it('lets an unreachable address be corrected, not only retried', () => {
    // Retry alone is a trap when the address is the thing that is wrong: it
    // loops on the same failure with no way out of the gate.
    const html = render({ kind: 'unreachable' });
    expect(html).toContain('Try again');
    expect(html).toContain('Change orchestrator address');
  });

  it('keeps the window draggable, since the shell that carries the title bars is behind it', () => {
    for (const state of CLOSED) expect(render(state)).toContain('window-drag');
  });

  it('never shows a bot list, a composer or a details rail', () => {
    // The specific screen this replaces: an empty shell beside a red banner,
    // which reads as a broken product rather than an unconfigured one.
    for (const state of CLOSED) {
      const html = render(state);
      expect(html).not.toContain('No bots yet');
      expect(html).not.toContain('data-pane-rail-state');
    }
  });
});

describe('V1-18 — the gate asks the orchestrator, and listens', () => {
  function portReturning(status: AuthStatus): AuthPort & { unsubscribe: ReturnType<typeof vi.fn> } {
    const unsubscribe = vi.fn();
    return {
      unsubscribe,
      status: vi.fn(() => Promise.resolve(status)),
      start: vi.fn(() => Promise.resolve({ status: 'opened' } as const)),
      complete: vi.fn(() => Promise.resolve(status)),
      signOut: vi.fn(() => Promise.resolve({ status: 'signed-out' } as const)),
      onChanged: vi.fn(() => unsubscribe),
    };
  }

  it('starts closed, before any answer has arrived', () => {
    // `renderToStaticMarkup` runs no effects, so this is the very first frame:
    // what somebody sees in the instant before the orchestrator answers. It
    // must not be the shell, and it must not be a sign-in prompt either —
    // neither is known to be true yet.
    const port = portReturning({ status: 'signed-out' });
    const html = renderToStaticMarkup(
      <I18nProvider>
        <LaunchGate auth={port}>{() => <div>{SHELL}</div>}</LaunchGate>
      </I18nProvider>,
    );
    expect(html).not.toContain(SHELL);
    expect(html).toContain('Connecting');
    expect(html).not.toContain('Sign in with browser');
  });
});
