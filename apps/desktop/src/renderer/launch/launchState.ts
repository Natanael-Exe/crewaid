import type { Edition } from '@crewaid/shared';
import type { AuthStatus, SignInUser } from '../../preload';
import { t } from '../i18n/i18n';

/**
 * What the app should show before it shows the app.
 *
 * Why there is a gate at all
 *
 * V1 made an account mandatory: every REST route resolves a session, the WebSocket
 * socket refuses a handshake without one, and a bot with no owner cannot
 * exist. So the shell — a bot list, a composer, a details rail — is furniture
 * for something you cannot do yet.
 *
 * It shipped without this, and the result was an app that opened onto "No bots
 * yet" beside "The orchestrator rejected this token": two true statements that
 * together tell you something is broken, and neither of which says "sign in".
 *
 * Why the states are separate
 *
 * Four of these look identical from the outside — the app is not usable — and
 * each has a different next action. Collapsing them is what produces a screen
 * that says "something went wrong" and leaves the operator to guess which of
 * an address, a network, a session or a keychain is at fault.
 */
export type LaunchState =
  /** Reading the store and asking the orchestrator who we are. */
  | { readonly kind: 'checking' }
  /** First run: no orchestrator address has been set, so there is nothing to ask. */
  | { readonly kind: 'needs-address' }
  /** An address is set and nothing answered. The address or the server is wrong. */
  | { readonly kind: 'unreachable' }
  /** The orchestrator answered and does not know this client. Sign in. */
  | { readonly kind: 'signed-out' }
  /** Something on THIS machine is broken — the keychain, the bridge. */
  | { readonly kind: 'blocked'; readonly reason: 'storage' | 'ipc' | 'refused' }
  /** Through. */
  | { readonly kind: 'ready'; readonly user: SignInUser };

/**
 * Map the account status onto what to render.
 *
 * Deliberately total over `AuthStatus` rather than defaulting: a status added
 * later should be a compile error here, not a silent fall-through into
 * whichever branch happens to be last.
 */
export function resolveLaunchState(status: AuthStatus): LaunchState {
  switch (status.status) {
    case 'signed-in':
      return { kind: 'ready', user: status.user };
    case 'signed-out':
      return { kind: 'signed-out' };
    case 'unconfigured':
      return { kind: 'needs-address' };
    case 'error':
      switch (status.code) {
        case 'NETWORK':
          return { kind: 'unreachable' };
        case 'STORAGE':
          return { kind: 'blocked', reason: 'storage' };
        case 'IPC_ERROR':
          return { kind: 'blocked', reason: 'ipc' };
        case 'UNAUTHORIZED':
        case 'REFUSED':
          // The app's own credential request was refused, or a sign-in did
          // not complete. Both are "start again", not "your server is down".
          return { kind: 'blocked', reason: 'refused' };
      }
  }
}

export type LaunchCopy = {
  readonly title: string;
  readonly body: string;
  /** The button that resolves it, or null when the only move is to wait. */
  readonly action: 'sign-in' | 'set-address' | 'retry' | null;
};

/**
 * What the gate says, and the ONE thing it offers.
 *
 * One action per state on purpose. A screen that offers sign-in, an address
 * field and a retry at once is a screen that has not worked out what is wrong
 * — and the operator then tries all three in the wrong order.
 */
export function launchCopy(state: LaunchState, edition: Edition | null = null): LaunchCopy {
  switch (state.kind) {
    case 'checking':
      return {
        title: t('launch.launchGate.connecting'),
        body: t('launch.launchGate.checkingYourOrchestratorAndWho'),
        action: null,
      };
    case 'needs-address':
      return {
        title: t('launch.launchGate.pointThisAppAtAn'),
        body: t('launch.launchState.getStartedYouCanChangeFull'),
        action: 'set-address',
      };
    case 'unreachable':
      // A hosted build's address is compiled in: the person never typed
      // it, so "the address may be wrong" would send them looking for a
      // setting that does not exist.
      if (edition === 'cloud') {
        return {
          title: t('launch.launchState.crewaidIsNotAnswering'),
          body: t('launch.launchState.unavailableNothingOnThisMachineFull'),
          action: 'retry',
        };
      }
      return {
        title: t('launch.launchState.nothingAnsweredAtThatAddress'),
        body: t('launch.launchState.machineHasBeenChangedFull'),
        action: 'retry',
      };
    case 'signed-out':
      return {
        title: t('launch.launchState.signInToCrewaid'),
        body: t('launch.launchState.inOpensYourBrowserThisFull'),
        action: 'sign-in',
      };
    case 'blocked':
      return {
        title: t('launch.launchState.cannotSignInOnThis'),
        body: blockedBody(state.reason),
        action: 'retry',
      };
    case 'ready':
      // Unreachable — the gate renders the app instead. Kept total so that a
      // future state cannot silently inherit somebody else's sentence.
      return { title: '', body: '', action: null };
  }
}

function blockedBody(reason: 'storage' | 'ipc' | 'refused'): string {
  switch (reason) {
    case 'storage':
      return t('launch.launchState.toSignInWithOnFull');
    case 'ipc':
      return t('launch.launchState.theAppCouldNotReach');
    case 'refused':
      return t('launch.launchState.thatSignInDidNot');
  }
}

/** Whether the shell may render. The only place that decision is made. */
export function isReady(state: LaunchState): state is Extract<LaunchState, { kind: 'ready' }> {
  return state.kind === 'ready';
}

/**
 * The initials for an avatar, from whoever is actually signed in.
 *
 * ⚠️ THIS REPLACES A HARDCODED NAME. `BotSidebar` carried
 * `const ACCOUNT_NAME = 'Natanael Exe'` — a design-mock placeholder from M1,
 * defensible while there were no accounts and wrong the moment V1 created
 * them. It showed one developer's name to every person who ran the app.
 */
export function accountLabel(user: SignInUser): { name: string; initials: string } {
  const name = user.name.trim() !== '' ? user.name.trim() : user.email.trim();
  const display = name === '' ? t('launch.launchState.account') : name;
  const initials = display
    .split(/[\s@._-]+/)
    .filter((part) => part !== '')
    .slice(0, 2)
    .map((part) => (part[0] ?? '').toUpperCase())
    .join('');
  return { name: display, initials: initials === '' ? '?' : initials };
}

/**
 * What is wrong with a typed address, before anything is sent.
 *
 * Address-only on purpose. `connectionForm.draftIssue` demands a token
 * alongside it, which is right in Settings — that form edits a stored pair —
 * and wrong here, where the token is the thing signing in is about to
 * produce. Asking a first-run operator for a token they have no way to obtain
 * yet is how the old Settings-only path dead-ended.
 */
export function addressIssue(raw: string): string | null {
  const address = raw.trim();
  if (address === '') return t('launch.launchState.enterTheAddressYourOrchestrator');
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return t('launch.launchState.thatIsNotAValid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return t('launch.launchState.theAddressHasToBe');
  }
  return null;
}

/** Hosts where a plain-HTTP orchestrator is the overwhelmingly likely case. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

/**
 * The same address over http, when that is the probable fix; otherwise null.
 *
 * `https://localhost:3000` against a server listening for plain HTTP fails at
 * the TLS handshake, which reaches `fetch` as an ordinary network failure —
 * indistinguishable, from here, from nothing listening at all. So the generic
 * sentence sends someone to check a port and a process that are both already
 * correct.
 *
 * Narrowed to loopback deliberately. Over the public internet an https failure
 * should NOT be answered with "try it unencrypted": that is advice to downgrade
 * a connection because it did not work, which is how a client ends up sending
 * a session token in the clear. On a loopback address there is no transport to
 * downgrade, and serving the orchestrator over plain http is the documented
 * local setup.
 */
function httpAlternative(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !LOOPBACK_HOSTS.has(url.hostname)) return null;
  url.protocol = 'http:';
  return url.toString().replace(/\/$/, '');
}

/**
 * Whether an address is worth saving, from one unauthenticated round trip.
 *
 * `'unreachable'` is a thrown fetch; a number is an HTTP status. The split
 * matters because "nothing is listening" and "something is listening and it is
 * not an orchestrator" are fixed differently, and a first run gets one of them
 * far more often than a working address.
 *
 * `address` is what was tried, so the sentence can name the likeliest cause
 * rather than the most general one.
 */
export function addressVerdict(outcome: 'unreachable' | number, address = ''): string | null {
  if (outcome === 'unreachable') {
    const overHttp = httpAlternative(address);
    if (overHttp !== null) {
      return t('launch.launchState.nothingAnsweredOverHttps', { address: overHttp });
    }
    return t('launch.launchState.nothingAnsweredAtThatAddress2');
  }
  if (outcome === 404) {
    return t('launch.launchState.somethingAnsweredAtThatAddress');
  }
  if (outcome >= 500) {
    return t('launch.launchState.theOrchestratorAnsweredWithAn');
  }
  // Anything else — including a 401 — means an orchestrator is there and
  // talking. Whether THIS app may use it is what signing in decides next.
  return null;
}
