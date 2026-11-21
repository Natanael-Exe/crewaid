import type { AuthStatus, SignInResult } from '../../preload';
import { t } from '../i18n/i18n';

/**
 * The Account row's copy, as pure functions.
 *
 * Here rather than in the component for the reason `connectionForm.ts` exists:
 * the interesting states are the failures, and a failure that only appears
 * when a real browser refuses a real custom scheme is a failure nothing tests.
 *
 * The copy is about THIS MACHINE'S credentials, never about the request that
 * discovered them. "Could not reach the server" is the right sentence in a
 * transcript; on this screen it hides the thing being diagnosed, which is
 * whether this install is signed in.
 */

export type AccountTone = 'ok' | 'muted' | 'danger';

export type AccountSummary = {
  readonly line: string;
  readonly tone: AccountTone;
};

/**
 * What to say about the stored credentials.
 *
 * `unconfigured` is deliberately NOT an error. It is the first-run state and
 * the state after someone clears the address — there is no orchestrator to
 * sign in to yet, and saying "signed out" about a server that was never named
 * sends people looking for a password.
 */
export function accountSummary(status: AuthStatus): AccountSummary {
  switch (status.status) {
    case 'signed-in':
      return {
        line: t('settings.account.signedInAs', {
          who: status.user.email === '' ? status.user.name : status.user.email,
        }),
        tone: 'ok',
      };
    case 'signed-out':
      return { line: t('settings.account.signedOut'), tone: 'muted' };
    case 'unconfigured':
      return { line: t('settings.account.unconfigured'), tone: 'muted' };
    case 'error':
      return { line: accountErrorLine(status.code), tone: 'danger' };
  }
}

function accountErrorLine(
  code: 'NETWORK' | 'REFUSED' | 'STORAGE' | 'IPC_ERROR' | 'UNAUTHORIZED',
): string {
  switch (code) {
    case 'NETWORK':
      return t('settings.account.error.network');
    case 'REFUSED':
      // The code is one-shot and expires in five minutes, and the verifier is
      // held in memory — so a restart mid-flow lands here too. All of them
      // mean the same thing to the person: that attempt is spent, start again.
      return t('settings.account.error.refused');
    case 'STORAGE':
      return t('settings.account.error.storage');
    case 'UNAUTHORIZED':
      return t('settings.account.error.unauthorized');
    case 'IPC_ERROR':
      return t('settings.account.error.ipc');
  }
}

/** Signing in needs somewhere to sign in to, and nothing else. */
export function canSignIn(status: AuthStatus): boolean {
  return status.status !== 'unconfigured';
}

export function canSignOut(status: AuthStatus): boolean {
  return status.status === 'signed-in';
}

/**
 * What went wrong when the browser did not open.
 *
 * `null` means it did — which is NOT the same as signed in. The browser round
 * trip finishes outside this app entirely, so the only honest thing to say at
 * this point is that it is now the browser's turn.
 */
export function signInProblem(result: SignInResult): string | null {
  switch (result.status) {
    case 'opened':
      return null;
    case 'unconfigured':
      return t('settings.account.unconfigured');
    case 'error':
      switch (result.code) {
        case 'NETWORK':
          return t('settings.account.signIn.noBrowser');
        case 'REFUSED':
          return t('settings.account.error.refused');
        case 'UNAUTHORIZED':
          return t('settings.account.signIn.unauthorized');
        case 'IPC_ERROR':
          return t('settings.account.signIn.ipc');
      }
  }
}

/**
 * The code the sign-in page prints, as pasted by a person.
 *
 * Trimmed because a copied code arrives with whitespace more often than not,
 * and checked for shape only so an obviously-wrong paste is refused without a
 * round trip. What makes a code VALID is the orchestrator's business: it is
 * bound to a PKCE challenge this app never sent, single use, and expires. A
 * client that tried to decide more than "this could be a code" would be
 * guessing at a question it cannot answer.
 */
export function readPastedCode(raw: string): string | null {
  const code = raw.trim();
  if (code === '' || code.length > 1024) return null;
  return /^[A-Za-z0-9_-]+={0,2}$/.test(code) ? code : null;
}
