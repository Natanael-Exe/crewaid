import {
  CALL_ALLOWANCE_USED_CODE,
  CALL_PLAN_REQUIRED_CODE,
  VOICE_ALLOWANCE_EXHAUSTED_CODE,
  COMPUTE_ALLOWANCE_EXHAUSTED_CODE,
  MODEL_ALLOWANCE_EXHAUSTED_CODE,
  SANDBOX_CAPACITY_CODE,
  SERVER_MISCONFIGURED_CODE,
} from '@crewaid/shared';
import { t } from '../i18n/i18n';

/**
 * Normalized REST failures for the renderer.
 *
 * The UI never renders a raw status line or response body — the D-006
 * principle (no vendor string reaches the transcript) applied to our own
 * REST layer. Every failure becomes an `ApiFailureCode` plus operator-facing
 * copy; the raw body rides along in `detail` for logs only.
 *
 * Status is the source of truth, not the body. The orchestrator's error body
 * (`ApiErrorSchema`) carries its own `code`, but that field is an open string
 * in the contract, so switching on it would mean the client silently degrades
 * to UNKNOWN the moment a handler invents a new one. Status codes are finite
 * and already load-bearing in the REST fences (404/409/410/413).
 *
 * The 503 below is the single, deliberate exception, and it reads the body
 * only to REFINE a code the status already decided. D-039 §7 ratifies the
 * exact string; §16.1 requires a full host to be shown separately from a
 * broken sandbox. The status cannot carry that on its own, because workspace
 * readiness answers 503 too — so a body that does not name capacity keeps the
 * neutral UNKNOWN wording rather than inheriting it. The failure mode this
 * file warns about is a client that DEPENDS on the open string; this one can
 * only ever add precision to a classification that already stands.
 */

/**
 * One code per user-visible failure mode.
 *
 * CONTRACT is the one that does not come from the network: a 2xx whose body
 * fails the shared schema. It is a defect on one side of the contract, never
 * something the operator can retry away, so it must not be folded into
 * UNKNOWN where it would read as a transient blip.
 */
export type ApiFailureCode =
  | 'INVALID_REQUEST' // 400
  | 'UNAUTHORIZED' // 401/403: token missing, wrong, revoked, or not permitted
  | 'PLAN_REQUIRED' // 402: the account's plan does not cover this
  | 'NOT_FOUND' // 404: unknown or foreign id (non-leaking by design, D-010)
  | 'CONFLICT' // 409
  | 'GONE' // 410
  | 'TOO_LARGE' // 413
  | 'STORAGE_FULL' // 507: the account's file storage is full
  | 'SANDBOX_CAPACITY' // 503 + D-039 §7's code: the host is full, and it is temporary
  | 'SERVER_MISCONFIGURED' // 503 + the server naming its own missing configuration
  | 'NETWORK' // fetch rejected — offline, DNS, connection refused
  | 'CONFIGURATION' // no orchestrator URL/token in the CC-07 store
  | 'CONTRACT' // 2xx body failed the @crewaid/shared schema
  | 'UNKNOWN'; // anything else, including 5xx — copy stays neutral

export interface ApiFailure {
  code: ApiFailureCode;
  /** Operator-facing, provider-neutral. Safe to render. */
  message: string;
  /** Raw response body or parse issue. For logs only — never rendered. */
  detail?: string | undefined;
}

/** Map a REST failure to the normalized error. `undefined` status means fetch itself rejected. */
export function normalizeApiFailure(status: number | undefined, rawBody?: string): ApiFailure {
  switch (status) {
    case 400:
      return {
        code: 'INVALID_REQUEST',
        message: t('api.apiError.thatWasNotAcceptedCheck'),
        detail: rawBody,
      };
    // 403 joins 401 rather than falling through to UNKNOWN: a proxy or a
    // hardened deployment answers it for a token that will never be accepted,
    // and "try again" is the one instruction that cannot help there.
    case 401:
    case 403:
      return {
        code: 'UNAUTHORIZED',
        message: t('api.apiError.yourSessionHasEndedSign'),
        detail: rawBody,
      };
    // D-156. The status alone decides the code; the body only picks which of
    // the two sentences is true, and an unrecognised body gets the general one.
    case 402:
      return {
        code: 'PLAN_REQUIRED',
        message:
          bodyCode(rawBody) === COMPUTE_ALLOWANCE_EXHAUSTED_CODE
            ? t('api.apiError.thisPeriodSComputerTime')
            : bodyCode(rawBody) === MODEL_ALLOWANCE_EXHAUSTED_CODE
              ? t('api.apiError.thisPeriodSUsageAllowance')
              : bodyCode(rawBody) === CALL_PLAN_REQUIRED_CODE
                ? t('api.apiError.callsComeWithProUpgrade')
                : bodyCode(rawBody) === CALL_ALLOWANCE_USED_CODE
                  ? t('api.apiError.thisPeriodSCallMinutes')
                  : bodyCode(rawBody) === VOICE_ALLOWANCE_EXHAUSTED_CODE
                    ? bodyField(rawBody, 'usage') === 'speak'
                      ? t('api.apiError.thisPeriodSSpokenReply')
                      : t('api.apiError.thisPeriodSDictationAnd')
                    : t('api.apiError.chooseAPlanInSettings'),
        detail: rawBody,
      };
    case 404:
      return {
        code: 'NOT_FOUND',
        message: t('api.apiError.thatIsNoLongerHere'),
        detail: rawBody,
      };
    case 409:
      return {
        code: 'CONFLICT',
        message: t('api.apiError.thatChangedInTheMeantime'),
        detail: rawBody,
      };
    case 410:
      return { code: 'GONE', message: t('api.apiError.thatIsNoLongerAvailable'), detail: rawBody };
    case 413:
      return { code: 'TOO_LARGE', message: t('api.apiError.thatIsTooLargeTo'), detail: rawBody };
    // D-220. Not UNKNOWN: "try again" cannot help until something is deleted.
    case 507:
      return {
        code: 'STORAGE_FULL',
        message: t('api.apiError.fileStorageIsFullDelete'),
        detail: rawBody,
      };
    case 503:
      // Only when the server actually says so; see the note at the top.
      if (namesCapacity(rawBody)) {
        return {
          code: 'SANDBOX_CAPACITY',
          message: t('api.apiError.thisHostIsAlreadyRunning'),
          detail: rawBody,
        };
      }
      // The server named its own misconfiguration. Its message is forwarded
      // rather than replaced: it says which variable and what shape, which is
      // the whole point, and `KeyringConfigError` never quotes a value.
      {
        const misconfigured = serverMisconfiguration(rawBody);
        if (misconfigured !== null) {
          return { code: 'SERVER_MISCONFIGURED', message: misconfigured, detail: rawBody };
        }
      }
      return {
        code: 'UNKNOWN',
        message: t('api.apiError.somethingWentWrongTryAgain'),
        detail: rawBody,
      };
    default:
      if (status === undefined) {
        return {
          code: 'NETWORK',
          message: t('api.apiError.couldNotReachTheServer'),
          detail: rawBody,
        };
      }
      return {
        code: 'UNKNOWN',
        message: t('api.apiError.somethingWentWrongTryAgain'),
        detail: rawBody,
      };
  }
}

/**
 * Whether a 503 body is D-039 §7's capacity refusal.
 *
 * Parsed defensively rather than matched as a substring: the raw text of an
 * unrelated 503 — a proxy's HTML, a stack trace — could contain the word by
 * coincidence, and "the host is full" is a specific instruction to the
 * operator about a specific remedy. A body that is not JSON, or is JSON
 * without that exact code, is not a capacity refusal.
 */
/** The server's own sentence about its configuration, or null. */
function serverMisconfiguration(rawBody: string | undefined): string | null {
  if (rawBody === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const body = parsed as { code?: unknown; message?: unknown };
    if (body.code !== SERVER_MISCONFIGURED_CODE) return null;
    return typeof body.message === 'string' && body.message.trim() !== '' ? body.message : null;
  } catch {
    return null;
  }
}

function namesCapacity(rawBody: string | undefined): boolean {
  return bodyCode(rawBody) === SANDBOX_CAPACITY_CODE;
}

/** An error body's `code`, or null when the body is not JSON or has none. */
export function bodyCode(rawBody: string | undefined): string | null {
  return bodyField(rawBody, 'code');
}

/** One string field of an error body, or null. */
function bodyField(rawBody: string | undefined, field: string): string | null {
  if (rawBody === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const value = (parsed as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * A real Error object (lint: only-throw-error) carrying the normalized failure.
 * Callers read `.failure`; the Error message stays neutral so an accidental
 * `${err}` in a log cannot leak a body.
 */
export class ApiRequestError extends Error {
  readonly failure: ApiFailure;
  constructor(failure: ApiFailure) {
    super(failure.message);
    this.name = 'ApiRequestError';
    this.failure = failure;
  }
}

/** Narrowing helper — `instanceof` across a bundle boundary is the usual footgun. */
export function isApiRequestError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError;
}

/**
 * A cancel the caller asked for, not a failure to report.
 *
 * `DOMException` is not an `Error` in every runtime this code runs under, so
 * the name is what is checked rather than the constructor.
 */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * Anything thrown by the api layer as the one normalized failure shape.
 *
 * The transport normalizes every failure it raises, so the narrowing is a real
 * check rather than a cast; anything else reaching here came from outside it
 * and gets the same neutral copy a dead connection would. One implementation,
 * so two call sites cannot disagree about what a network failure says.
 */
export function failureOf(error: unknown): ApiFailure {
  return isApiRequestError(error) ? error.failure : normalizeApiFailure(undefined);
}

/**
 * Whether another attempt could plausibly land.
 *
 * A retry offer is a claim about the server, so the permanent set is the one
 * enumerated: a row the server cannot find or has expired, a token it refuses,
 * a file too large to hold. NETWORK and UNKNOWN stay retryable because the
 * client genuinely cannot tell a dropped connection or a 502 from a 500 the
 * next attempt would hit again.
 */
const PERMANENT_FAILURES: ReadonlySet<ApiFailureCode> = new Set<ApiFailureCode>([
  'INVALID_REQUEST',
  'UNAUTHORIZED',
  // Not until the account pays or its period renews — another attempt now
  // gets the same answer.
  'PLAN_REQUIRED',
  'NOT_FOUND',
  'CONFLICT',
  'GONE',
  'TOO_LARGE',
  // Not until something is deleted.
  'STORAGE_FULL',
  'CONFIGURATION',
  'CONTRACT',
]);

export function isRetryable(code: ApiFailureCode): boolean {
  return !PERMANENT_FAILURES.has(code);
}
