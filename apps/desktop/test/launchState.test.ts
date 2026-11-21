import { describe, expect, it } from 'vitest';
import type { AuthStatus, SignInUser } from '../src/preload';
import {
  accountLabel,
  addressVerdict,
  isReady,
  launchCopy,
  resolveLaunchState,
  type LaunchState,
} from '../src/renderer/launch/launchState';

/**
 * V1-18 — what the app shows before it shows the app.
 *
 * The interesting cases are the ones nobody sees during development, because a
 * developer's machine has an address, a reachable server and a live session on
 * the first run of the day. Every state below is one somebody else's machine
 * reaches on their first run.
 */

const USER: SignInUser = { id: 'u1', email: 'ada@example.com', name: 'Ada Lovelace' };

describe('V1-18 — resolveLaunchState', () => {
  it('separates "no address" from "not signed in"', () => {
    // The distinction the whole gate rests on. Both leave the app unusable and
    // they are fixed in different places — one in a text field, one in a
    // browser — so a screen that merges them sends people to the wrong one.
    expect(resolveLaunchState({ status: 'unconfigured' })).toEqual({ kind: 'needs-address' });
    expect(resolveLaunchState({ status: 'signed-out' })).toEqual({ kind: 'signed-out' });
  });

  it('separates a server that did not answer from a machine that cannot store credentials', () => {
    expect(resolveLaunchState({ status: 'error', code: 'NETWORK' })).toEqual({
      kind: 'unreachable',
    });
    expect(resolveLaunchState({ status: 'error', code: 'STORAGE' })).toEqual({
      kind: 'blocked',
      reason: 'storage',
    });
    expect(resolveLaunchState({ status: 'error', code: 'IPC_ERROR' })).toEqual({
      kind: 'blocked',
      reason: 'ipc',
    });
  });

  it('carries the account through, because the shell needs a name to render', () => {
    expect(resolveLaunchState({ status: 'signed-in', user: USER })).toEqual({
      kind: 'ready',
      user: USER,
    });
  });

  it('maps every AuthStatus the bridge can return', () => {
    // A status added later must not fall through to whichever branch is last.
    // The compiler catches that in the switch; this catches a new code being
    // added to the union and quietly inheriting the REFUSED sentence.
    const codes = ['NETWORK', 'REFUSED', 'STORAGE', 'IPC_ERROR', 'UNAUTHORIZED'] as const;
    const statuses: AuthStatus[] = [
      { status: 'signed-in', user: USER },
      { status: 'signed-out' },
      { status: 'unconfigured' },
      ...codes.map((code) => ({ status: 'error', code }) as const),
    ];
    for (const status of statuses) {
      expect(resolveLaunchState(status)).toBeDefined();
    }
  });
});

describe('V1-18 — launchCopy', () => {
  const states: LaunchState[] = [
    { kind: 'checking' },
    { kind: 'needs-address' },
    { kind: 'unreachable' },
    { kind: 'signed-out' },
    { kind: 'blocked', reason: 'storage' },
    { kind: 'blocked', reason: 'ipc' },
    { kind: 'blocked', reason: 'refused' },
  ];

  it('offers exactly one action per state, and none while checking', () => {
    // A screen offering sign-in, an address field and a retry at once has not
    // worked out what is wrong, and the operator then tries all three in the
    // wrong order.
    expect(launchCopy({ kind: 'checking' }).action).toBeNull();
    expect(launchCopy({ kind: 'needs-address' }).action).toBe('set-address');
    expect(launchCopy({ kind: 'signed-out' }).action).toBe('sign-in');
    expect(launchCopy({ kind: 'unreachable' }).action).toBe('retry');
  });

  it('never tells someone to sign in when there is nowhere to sign in to', () => {
    const copy = launchCopy({ kind: 'needs-address' });
    expect(copy.title.toLowerCase()).not.toContain('sign in');
    expect(copy.action).not.toBe('sign-in');
  });

  it('says something different in every state', () => {
    // Distinct sentences are the deliverable. Identical copy across states is
    // the failure this module exists to prevent, and it passes a "is there a
    // title" check perfectly.
    const bodies = states.map((state) => launchCopy(state).body);
    expect(new Set(bodies).size).toBe(states.length);
    for (const body of bodies) expect(body.length).toBeGreaterThan(20);
  });

  it('never blames the person for a machine-level failure', () => {
    for (const reason of ['storage', 'ipc'] as const) {
      const copy = launchCopy({ kind: 'blocked', reason });
      expect(copy.body).not.toMatch(/password|credentials are wrong|incorrect/i);
    }
  });
});

describe('V1-18 — isReady', () => {
  it('is the only gate, and it is closed for every non-ready state', () => {
    expect(isReady({ kind: 'ready', user: USER })).toBe(true);
    for (const state of [
      { kind: 'checking' },
      { kind: 'needs-address' },
      { kind: 'unreachable' },
      { kind: 'signed-out' },
      { kind: 'blocked', reason: 'storage' },
    ] satisfies LaunchState[]) {
      expect(isReady(state)).toBe(false);
    }
  });
});

describe('V1-18 — accountLabel', () => {
  it('uses the signed-in account rather than a build-time constant', () => {
    expect(accountLabel(USER)).toEqual({ name: 'Ada Lovelace', initials: 'AL' });
  });

  it('falls back to the email when the account has no name', () => {
    // Better Auth allows an empty name — a magic-link sign-up never asks for
    // one — and an avatar reading "?" beside a blank row is what that produced.
    expect(accountLabel({ id: 'u2', email: 'ada@example.com', name: '' })).toEqual({
      name: 'ada@example.com',
      initials: 'AE',
    });
  });

  it('never renders an empty label, whatever the orchestrator returned', () => {
    const blank = accountLabel({ id: 'u3', email: '', name: '   ' });
    expect(blank.name).not.toBe('');
    expect(blank.initials).not.toBe('');
  });
});

describe('V1-18 — addressVerdict', () => {
  it('names the scheme when https to a loopback host fails, not the port', () => {
    // The mistake an operator actually makes on first run, and the one the
    // generic sentence handles worst: a TLS handshake against a plain-HTTP
    // server reaches fetch as an ordinary network failure, so "check the
    // orchestrator is running and the port is right" sends them to verify two
    // things that are already correct.
    const verdict = addressVerdict('unreachable', 'https://localhost:3000');
    expect(verdict).toContain('http://localhost:3000');
    expect(verdict).not.toContain('port is right');
  });

  it('does not suggest downgrading a remote address to plain http', () => {
    // Over the public internet that is advice to send a session token in the
    // clear because TLS did not work. Only loopback, where there is no
    // transport to downgrade, gets the hint.
    const remote = addressVerdict('unreachable', 'https://crewaid.example.com');
    expect(remote).not.toContain('http://crewaid.example.com');
    expect(remote).toContain('port is right');
  });

  it('separates nothing listening from something that is not an orchestrator', () => {
    // A first run gets one of these far more often than a working address,
    // and they are fixed differently: start the server, versus fix the URL.
    expect(addressVerdict('unreachable')).toContain('Nothing answered');
    expect(addressVerdict(404)).toContain('no orchestrator');
  });

  it('accepts a 401, because being turned away proves something is there', () => {
    // The probe is unauthenticated by design. Treating its 401 as a bad
    // address would reject the one case that proves the address is right.
    expect(addressVerdict(401)).toBeNull();
    expect(addressVerdict(200)).toBeNull();
  });

  it('says a 5xx may be a server still starting, not a wrong address', () => {
    expect(addressVerdict(503)).toContain('starting up');
  });
});
