import { ProviderExplanationSchema } from '@crewaid/shared';
import { bodyCode, normalizeApiFailure } from '../api/apiError';
import type { ChatError } from '../state/chatReducer';
import { t } from '../i18n/i18n';

/**
 * What a person reads when the chat fails.
 *
 * A run's failure is the server's to word. Its `RUN_ERROR` carries the
 * normalized sentence and, when the provider gave a reason someone can
 * act on, that reason and who gave it. Nothing here reads a vendor's words:
 * the server already decided which ones are fit to show, so this only
 * checks the shape.
 *
 * The round trips this window makes itself (sending, loading history,
 * following a run) are worded here, each with the one move that helps.
 */

/**
 * Endings that are not failures: the server's for a run a person stopped,
 * here or in another window, and the AG-UI client's own for a request this
 * window aborted (its message is the browser's, "Request aborted").
 */
const NOT_FAILURES: ReadonlySet<unknown> = new Set(['RUN_CANCELLED', 'abort']);

/**
 * A `RUN_ERROR` as the banner shows it, or null for one that is not a
 * failure. Typed loosely because the AG-UI event is a loose object and the
 * explanation rides in its `metadata`, which the protocol's type omits.
 */
export function runFailure(event: {
  readonly message?: unknown;
  readonly code?: unknown;
  readonly metadata?: unknown;
}): ChatError | null {
  if (NOT_FAILURES.has(event.code)) return null;
  const explanation = ProviderExplanationSchema.safeParse(
    field(field(event.metadata, 'crewaid'), 'explanation'),
  );
  return {
    code: typeof event.code === 'string' ? event.code : 'RUN_FAILED',
    message:
      typeof event.message === 'string' && event.message.trim() !== ''
        ? event.message
        : t('chat.chatFailure.runFailed'),
    ...(explanation.success ? { explanation: explanation.data } : {}),
  };
}

/**
 * Why this window's own send or approval answer was refused. The status
 * decides, as everywhere in the REST layer (`apiError.ts`); the body's code
 * only picks the sentence for the two refusals a person can do something
 * about.
 */
export function admissionFailure(
  status: number | undefined,
  rawBody: string | undefined,
  sending: 'message' | 'answer',
): ChatError {
  switch (status) {
    case undefined:
      return {
        code: 'NETWORK',
        message:
          sending === 'message'
            ? t('chat.chatFailure.messageUnreachable')
            : t('chat.chatFailure.answerUnreachable'),
      };
    // The plan, storage and size sentences are already the right ones.
    case 402:
    case 413:
    case 507: {
      const { code, message } = normalizeApiFailure(status, rawBody);
      return { code, message };
    }
    case 404:
      return {
        code: 'NOT_FOUND',
        message: t('chat.chatFailure.thisConversationOrAFile'),
      };
    case 409:
      switch (bodyCode(rawBody)) {
        case 'THREAD_AWAITING_APPROVAL':
          return {
            code: 'THREAD_AWAITING_APPROVAL',
            message: t('chat.chatFailure.theBotIsWaitingFor'),
          };
        case 'RUN_BUSY':
          return {
            code: 'RUN_BUSY',
            message: t('chat.chatFailure.theBotIsStillWorking'),
          };
        case 'INTERRUPT_NOT_PENDING':
          return {
            code: 'INTERRUPT_NOT_PENDING',
            message: t('chat.chatFailure.thatRequestWasAlreadyAnswered'),
          };
        case 'TARGET_RUN_CHANGED':
          return {
            code: 'TARGET_RUN_CHANGED',
            message: t('composer.queue.targetChanged'),
          };
      }
  }
  return {
    code: 'SEND_FAILED',
    message:
      sending === 'message'
        ? t('chat.chatFailure.messageNotSent')
        : t('chat.chatFailure.answerNotSent'),
  };
}

/** Reads `activeRunId` from a 409 `TARGET_RUN_CHANGED` response body, if present. */
export function conflictActiveRunId(rawBody: string | undefined): string | null {
  if (rawBody === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    const id = field(parsed, 'activeRunId');
    return typeof id === 'string' && id !== '' ? id : null;
  } catch {
    return null;
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
