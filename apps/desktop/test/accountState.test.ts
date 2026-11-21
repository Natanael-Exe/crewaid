import { describe, expect, it } from 'vitest';
import {
  accountSummary,
  canSignIn,
  canSignOut,
  readPastedCode,
  signInProblem,
} from '../src/renderer/settings/accountState';

/**
 * V1-11 — what the Account row says, and when.
 *
 * Pure functions rather than assertions on a rendered pane, for the reason
 * `connectionForm.test.ts` exists: the states worth getting right are the ones
 * a person only reaches when something has gone wrong on their machine, and
 * those are unreachable from a test that drives the real bridge.
 *
 * The distinctions below are the whole point of the file. "No address yet",
 * "signed out", and "signed in but nothing could be written to disk" all look
 * like not-signed-in from the outside and need three different sentences,
 * because each one has a different next step.
 */

describe('V1-11 — the Account summary', () => {
  it('names who is signed in', () => {
    const summary = accountSummary({
      status: 'signed-in',
      user: { id: 'u1', email: 'someone@example.com', name: 'Someone' },
    });
    expect(summary.line).toContain('someone@example.com');
    expect(summary.tone).toBe('ok');
  });

  it('falls back to a name when the provider gave no address', () => {
    // A GitHub account with a private email signs in with no address at all,
    // and "Signed in as ." is how that would read otherwise.
    const summary = accountSummary({
      status: 'signed-in',
      user: { id: 'u1', email: '', name: 'Someone' },
    });
    expect(summary.line).toContain('Someone');
  });

  it('does not dress first run as a failure', () => {
    // Nobody is signed OUT of a server they have not named yet. Saying so
    // sends people looking for a password when they need an address.
    const fresh = accountSummary({ status: 'unconfigured' });
    expect(fresh.tone).toBe('muted');
    expect(fresh.line).toContain('address');

    const out = accountSummary({ status: 'signed-out' });
    expect(out.tone).toBe('muted');
    expect(out.line).not.toContain('address');
  });

  it('says plainly when a session exists that this machine cannot keep', () => {
    // The worst of the states: the row is live on the orchestrator and the
    // credential is nowhere on disk. Reporting it as "signed in" would be a
    // lie with a real session behind it.
    const summary = accountSummary({ status: 'error', code: 'STORAGE' });
    expect(summary.tone).toBe('danger');
    expect(summary.line).toContain('could not be written');
  });

  it('describes an unreachable orchestrator as unknown, not as signed out', () => {
    const summary = accountSummary({ status: 'error', code: 'NETWORK' });
    expect(summary.line).toContain('unknown');
  });
});

describe('V1-11 — which buttons are live', () => {
  it('offers sign-in for every state except the one with no server', () => {
    expect(canSignIn({ status: 'signed-out' })).toBe(true);
    // Signing in again is how someone switches account, and how they recover
    // from an error — so it stays available rather than being hidden.
    expect(canSignIn({ status: 'error', code: 'REFUSED' })).toBe(true);
    expect(canSignIn({ status: 'unconfigured' })).toBe(false);
  });

  it('offers sign-out only when there is a session to end', () => {
    expect(canSignOut({ status: 'signed-in', user: { id: 'u', email: 'a@b.c', name: 'A' } })).toBe(
      true,
    );
    expect(canSignOut({ status: 'signed-out' })).toBe(false);
    expect(canSignOut({ status: 'error', code: 'NETWORK' })).toBe(false);
  });
});

describe('V1-11 — what "the browser opened" does and does not mean', () => {
  it('reports no problem, and claims no success', () => {
    // `opened` is the browser's turn, not a sign-in. The only thing that makes
    // this app signed in is a code coming back.
    expect(signInProblem({ status: 'opened' })).toBeNull();
  });

  it('explains every way opening can fail', () => {
    expect(signInProblem({ status: 'unconfigured' })).toContain('address');
    expect(signInProblem({ status: 'error', code: 'NETWORK' })).toContain('browser');
    expect(signInProblem({ status: 'error', code: 'IPC_ERROR' })).not.toBeNull();
    expect(signInProblem({ status: 'error', code: 'UNAUTHORIZED' })).not.toBeNull();
  });
});

describe('V1-11 — the pasted code', () => {
  it('takes a code the way a person pastes it', () => {
    expect(readPastedCode('  eyJhIjoxfQ \n')).toBe('eyJhIjoxfQ');
  });

  it('refuses what is obviously not a code, without a round trip', () => {
    expect(readPastedCode('')).toBeNull();
    expect(readPastedCode('   ')).toBeNull();
    expect(readPastedCode('not a code')).toBeNull();
    expect(readPastedCode('a'.repeat(1025))).toBeNull();
  });

  it('does not try to decide whether a well-formed code is VALID', () => {
    // Shape only. Whether a code can be spent depends on a PKCE challenge this
    // app never sent, on single use, and on a five-minute expiry — all of them
    // facts the orchestrator holds. A client that guessed would refuse good
    // codes and accept dead ones with equal confidence.
    expect(readPastedCode('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).not.toBeNull();
  });
});
