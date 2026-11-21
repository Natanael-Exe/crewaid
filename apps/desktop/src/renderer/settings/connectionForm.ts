import type { TokenStoreReadResult, TokenStoreWriteResult } from '../../preload';
import type { ApiFailure } from '../api';
import { t } from '../i18n/i18n';

/**
 * The General pane's connection form, as pure functions.
 *
 * Everything the operator can be told about their own configuration is decided
 * here rather than in the component, for the reason `chatReducer` exists: the
 * interesting cases are the failures, and a failure that only appears when a
 * real orchestrator refuses a real token is a failure nothing tests.
 *
 * The copy is deliberately about CONFIGURATION, not about requests. The api
 * layer's normalized messages ("Could not reach the server.") are right in a
 * transcript, where the operator did not just type an address; on this screen
 * they hide the one thing being diagnosed, which is what they typed.
 */

export type ConnectionDraft = {
  readonly baseUrl: string;
  readonly token: string;
};

export const EMPTY_DRAFT: ConnectionDraft = { baseUrl: '', token: '' };

/**
 * The result of the one authenticated round trip the pane makes.
 *
 * `checking` is a state and not a boolean beside the result so a stale success
 * cannot render underneath a new check — the two are the same slot.
 */
export type ConnectionCheck =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'ok'; readonly modelCount: number }
  /**
   * An orchestrator answered, but this install has no session to ask it
   * anything with. Distinct from `ok` because the two licence different
   * claims: `ok` means the catalog was read, this means only that something
   * is listening. Reporting the weaker result as the stronger one is how an
   * address gets "verified" and then 401s on the first real request.
   */
  | { readonly kind: 'reachable' }
  | { readonly kind: 'failed'; readonly message: string };

/** Pre-fill from the CC-07 store so changing the URL does not mean retyping the token. */
export function draftFromStore(result: TokenStoreReadResult): ConnectionDraft {
  if (result.status !== 'configured') return EMPTY_DRAFT;
  return {
    baseUrl: result.credentials.orchestratorBaseUrl ?? '',
    token: result.credentials.orchestratorToken ?? '',
  };
}

/**
 * What is wrong with the store itself, as opposed to with what is in it.
 *
 * `missing` is first run, which is not a problem — it is the state this pane
 * exists to leave. The rest are machine-level and worth saying out loud,
 * because every one of them makes a later save fail the same way.
 */
export function storeIssue(result: TokenStoreReadResult): string | null {
  switch (result.status) {
    case 'configured':
    case 'missing':
      return null;
    case 'unavailable':
      return t('settings.store.unavailable');
    case 'error':
      return result.code === 'STORAGE_ERROR'
        ? t('settings.store.readFailed')
        : t('settings.account.error.ipc');
  }
}

/**
 * A failed probe, said in terms of the address and the token.
 *
 * NOT_FOUND is the interesting one: the REST routes live under /api/v1, so a
 * host that answers but 404s that path is a real server at the wrong address —
 * a proxy, another app, or an orchestrator behind a subpath the base URL omits.
 * Reporting that as "not found" would send the operator looking for a model.
 */
export function checkFailureMessage(failure: ApiFailure): string {
  switch (failure.code) {
    case 'CONFIGURATION':
      return t('settings.check.configuration');
    case 'NETWORK':
      return t('settings.check.network');
    case 'UNAUTHORIZED':
      return t('settings.check.unauthorized');
    case 'NOT_FOUND':
      return t('settings.check.notFound');
    case 'CONTRACT':
      return t('settings.check.contract');
    default:
      return failure.message;
  }
}

/** `null` once the write landed; a sentence when it did not. */
export function saveFailureMessage(result: TokenStoreWriteResult): string | null {
  switch (result.status) {
    case 'saved':
    case 'cleared':
      return null;
    case 'unavailable':
      return t('settings.save.unavailable');
    case 'invalid':
      return t('settings.save.invalid');
    case 'error':
      return result.code === 'STORAGE_ERROR'
        ? t('settings.save.writeFailed')
        : t('settings.account.error.ipc');
  }
}

/** Whether the draft differs from what is stored — drives the Save button. */
export function draftChanged(draft: ConnectionDraft, saved: ConnectionDraft): boolean {
  return draft.baseUrl.trim() !== saved.baseUrl.trim() || draft.token.trim() !== saved.token.trim();
}

/** What actually gets written: trimmed, because a trailing space in a URL is invisible. */
export function toTokenBag(draft: ConnectionDraft): {
  orchestratorBaseUrl: string;
  orchestratorToken: string;
} {
  return { orchestratorBaseUrl: draft.baseUrl.trim(), orchestratorToken: draft.token.trim() };
}
