import type {
  Locale,
  ModelCapabilities,
  ModelErrorCode,
  NormalizedModelError,
} from '@crewaid/shared';
import { ModelErrorCodeSchema } from '@crewaid/shared';
import {
  failureCopy,
  setupSentence,
  unsupportedCapabilitySentence,
  type ModelCapabilityName,
} from './failure-copy.js';
import { ModelAllowanceExhaustedError } from './included-models.port.js';
import { ModelSetupError } from './model-setup-error.js';

/**
 * Provider error normalization.
 *
 * Three providers, three error shapes, ONE vocabulary. Every model-originated
 * failure passes through `normalizeModelError` before it can reach a
 * transcript or a WS frame. The rule that gives this teeth: the UI
 * never renders a vendor error string — if a client is regexing a provider
 * message, the normalization happened in the wrong layer.
 *
 * `detail` carries the raw provider text for LOGS only. It is never rendered.
 * What a person may read of the provider's own words is `explanation`, which
 * this file alone decides on and cleans.
 */

/**
 * Heuristic classifiers for failures that carry only a message.
 * Ordered: each returns a code or undefined; the first hit wins.
 */
function classifyMessage(message: string): ModelErrorCode | undefined {
  const m = message.toLowerCase();
  if (m.includes('rate limit') || m.includes('too many requests') || m.includes('429')) {
    return 'RATE_LIMITED';
  }
  if (
    m.includes('context length') ||
    m.includes('context window') ||
    m.includes('maximum context') ||
    m.includes('too many tokens') ||
    m.includes('input length exceeds') ||
    m.includes('prompt is too long')
  ) {
    return 'CONTEXT_OVERFLOW';
  }
  if (
    m.includes('refus') ||
    m.includes('content policy') ||
    m.includes('content filter') ||
    m.includes('safety system')
  ) {
    return 'CONTENT_REFUSED';
  }
  if (
    m.includes('invalid api key') ||
    m.includes('incorrect api key') ||
    m.includes('unauthorized') ||
    m.includes('authentication') ||
    m.includes('401')
  ) {
    return 'AUTH_FAILED';
  }
  if (
    m.includes('insufficient') ||
    m.includes('quota') ||
    m.includes('billing') ||
    m.includes('credit')
  ) {
    return 'QUOTA_EXCEEDED';
  }
  if (m.includes('timeout') || m.includes('timed out')) {
    return 'TIMEOUT';
  }
  if (
    m.includes('overloaded') ||
    m.includes('unavailable') ||
    m.includes('bad gateway') ||
    m.includes('502') ||
    m.includes('503') ||
    m.includes('529')
  ) {
    return 'PROVIDER_UNAVAILABLE';
  }
  if (
    m.includes('invalid request') ||
    m.includes('invalid_parameter') ||
    m.includes('malformed') ||
    m.includes('unsupported') ||
    m.includes('400')
  ) {
    return 'INVALID_REQUEST';
  }
  return undefined;
}

const RETRYABLE: ReadonlySet<ModelErrorCode> = new Set([
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'TIMEOUT',
]);

/**
 * True for the codes a fresh attempt can plausibly survive. The turn's
 * automatic retry asks this — the classification already existed, but nothing
 * acted on it, so a transient timeout failed a whole run and left the
 * carrying-on to a person.
 */
export function isRetryableModelCode(code: ModelErrorCode): boolean {
  return RETRYABLE.has(code);
}

/**
 * What the caller knows about the call that failed.
 *
 * `source` is who the person would say they were talking to: the name they
 * gave the connection. Absent, nothing the provider said is shown — which is
 * right for a model the person does not hold the account for (an included
 * model's upstream refusing the platform's key is not theirs to act on), and
 * for any caller with no one to attribute the words to.
 */
export type ModelErrorContext = {
  modelId?: string;
  /** Human label for the selected model, used in capability mismatch banners. */
  modelLabel?: string;
  /** Capabilities currently configured on the model row. */
  capabilities?: ModelCapabilities;
  source?: string;
  /** The account's language, which the sentence a person reads is in. */
  language?: Locale | null;
};

const VISION_UNSUPPORTED_PATTERNS: readonly RegExp[] = [
  /\b(?:does not|doesn't|do not|don't|cannot|can't)\s+support\s+(?:image|images|vision|multimodal)\b/i,
  /\bno\s+endpoints?\s+found\s+that\s+support\s+(?:image|vision|multimodal)\b/i,
  /\b(?:image|images|image\s+input|image_url|vision|multimodal)\s+(?:is|are)?\s*(?:not\s+supported|unsupported)\b/i,
  /\bunsupported\s+(?:content\s+type|input|modality|parameter)[^.]{0,40}\b(?:image|image_url|vision)\b/i,
  /\b(?:cannot|can't|unable\s+to)\s+(?:read|process|accept|handle)\s+images?\b/i,
  /\bnot\s+a\s+(?:vision|multimodal)\s+model\b/i,
  /\bonly\s+supports?\s+text(?:\s+input)?\b/i,
];

const TOOLS_UNSUPPORTED_PATTERNS: readonly RegExp[] = [
  /\b(?:does not|doesn't|do not|don't|cannot|can't)\s+support\s+(?:tool|tools|tool\s+use|tool\s+calling|function|functions|function\s+calling)\b/i,
  /\bno\s+endpoints?\s+found\s+that\s+support\s+(?:tool|tools|tool\s+use|function)\b/i,
  /\b(?:tool|tools|tool\s+use|tool\s+calling|tool_choice|function|functions|function\s+calling)\s+(?:is|are)?\s*(?:not\s+supported|unsupported)\b/i,
  /\bunsupported\s+(?:parameter|field|feature)[^.]{0,40}\b(?:tool|tools|tool_choice|function|functions)\b/i,
];

const REASONING_UNSUPPORTED_PATTERNS: readonly RegExp[] = [
  /\b(?:does not|doesn't|do not|don't|cannot|can't)\s+support\s+(?:reasoning|thinking|extended\s+thinking)\b/i,
  /\bno\s+endpoints?\s+found\s+that\s+support\s+(?:reasoning|thinking)\b/i,
  /\b(?:reasoning|reasoning_effort|thinking|extended\s+thinking|thinking_budget|budget_tokens)\s+(?:is|are)?\s*(?:not\s+supported|unsupported)\b/i,
  /\bunsupported\s+(?:parameter|field|feature)[^.]{0,40}\b(?:reasoning|reasoning_effort|thinking|budget_tokens)\b/i,
];

function detectUnsupportedCapability(
  texts: readonly string[],
  capabilities: ModelCapabilities | undefined,
): ModelCapabilityName | undefined {
  const combined = texts
    .filter((entry) => entry.trim() !== '')
    .map((entry) => entry.slice(0, EXPLANATION_MAX * 4))
    .join('\n');
  if (combined === '') return undefined;
  if (
    capabilities?.vision !== false &&
    VISION_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(combined))
  ) {
    return 'vision';
  }
  if (
    capabilities?.tools !== false &&
    TOOLS_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(combined))
  ) {
    return 'tools';
  }
  if (
    capabilities?.reasoning !== false &&
    REASONING_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(combined))
  ) {
    return 'reasoning';
  }
  return undefined;
}

/**
 * The single place the normalized shape is assembled. Every branch below
 * differs only in how it DERIVES the code — never in what it returns. Keeping
 * the construction here is what stops a fourth provider's branch from
 * inventing a fifth, subtly different, result object.
 *
 * `said` is what the provider itself wrote, in order of preference; the first
 * one a person can act on becomes the explanation.
 */
function normalized(
  code: ModelErrorCode,
  detail: string,
  context?: ModelErrorContext,
  said: readonly string[] = [],
): NormalizedModelError {
  const unsupported =
    code === 'INVALID_REQUEST' || code === 'UNKNOWN'
      ? detectUnsupportedCapability([...said, detail], context?.capabilities)
      : undefined;
  const effectiveCode: ModelErrorCode = unsupported === undefined ? code : 'INVALID_REQUEST';
  const source = context?.source?.trim().slice(0, 80);
  const text = source ? firstReadable(said) : undefined;
  return {
    code: effectiveCode,
    message:
      unsupported === undefined
        ? failureCopy(context?.language).model[effectiveCode]
        : unsupportedCapabilitySentence(unsupported, context?.modelLabel),
    ...(context?.modelId !== undefined && { modelId: context.modelId }),
    retryable: RETRYABLE.has(effectiveCode),
    ...(source && text !== undefined && { explanation: { source, text } }),
    detail,
  };
}

export function normalizeModelError(
  error: unknown,
  context?: ModelErrorContext,
): NormalizedModelError {
  // Our own refusal, recognised however the SDK wrapped it on the way
  // out. Before every vendor branch, because it is not a vendor's.
  if (isAllowanceExhausted(error)) {
    return normalized('ALLOWANCE_EXHAUSTED', 'included model allowance exhausted', context);
  }
  // Also ours, and already written for the person — a setting
  // to change, named with where it lives. Forwarded rather than replaced by
  // a sentence guessing at the provider.
  if (error instanceof ModelSetupError) {
    const message = setupSentence(error.sentence, context?.language);
    return { ...normalized('INVALID_REQUEST', error.message, context), message };
  }

  // A TanStack run error, rethrown by a non-streaming call with the
  // provider's code on it: the same reading as a streamed `RUN_ERROR`.
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return normalizeRunError(
      { message: error.message, code: error.code, rawEvent: providerBody(error) },
      context,
    );
  }

  // A provider SDK's HTTP failure: its status is the most precise reading.
  const status = httpStatusOf(error);
  if (error instanceof Error && status !== undefined) {
    return normalized(codeForStatus(status, error.message), error.message, context, [
      ...bodySentences(providerBody(error)),
      error.message,
    ]);
  }

  if (error instanceof Error) {
    return normalized(classifyMessage(error.message) ?? 'UNKNOWN', error.message, context);
  }

  // Non-Error throwables (providers sometimes throw strings/objects).
  const detail = typeof error === 'string' ? error : JSON.stringify(error);
  return normalized(classifyMessage(detail) ?? 'UNKNOWN', detail, context);
}

/** `status` or `statusCode`, as the provider SDKs name an HTTP failure's status. */
export function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status: unknown = Reflect.get(error, 'status') ?? Reflect.get(error, 'statusCode');
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

/** An HTTP status, read with the provider's text where the status alone is ambiguous. */
function codeForStatus(status: number, messageText: string): ModelErrorCode {
  if (status === 429) return 'RATE_LIMITED';
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 402) return 'QUOTA_EXCEEDED';
  if (status === 408 || status === 504) return 'TIMEOUT';
  if (status === 409 || status === 502 || status === 503 || status === 529) {
    return 'PROVIDER_UNAVAILABLE';
  }
  if (status === 400) return classifyMessage(messageText) ?? 'INVALID_REQUEST';
  if (status === 413) return 'CONTEXT_OVERFLOW';
  return classifyMessage(messageText) ?? 'UNKNOWN';
}

/**
 * Provider error codes the TanStack adapters pass through on a `RUN_ERROR`,
 * where the SDK did not reduce them to a status. Anthropic's `type` names and
 * OpenAI's `code` names, the ones a person can be told something useful about.
 */
const PROVIDER_CODES: Readonly<Record<string, ModelErrorCode>> = {
  rate_limit_error: 'RATE_LIMITED',
  rate_limit_exceeded: 'RATE_LIMITED',
  overloaded_error: 'PROVIDER_UNAVAILABLE',
  api_error: 'PROVIDER_UNAVAILABLE',
  server_error: 'PROVIDER_UNAVAILABLE',
  authentication_error: 'AUTH_FAILED',
  permission_error: 'AUTH_FAILED',
  invalid_api_key: 'AUTH_FAILED',
  insufficient_quota: 'QUOTA_EXCEEDED',
  billing_error: 'QUOTA_EXCEEDED',
  context_length_exceeded: 'CONTEXT_OVERFLOW',
  request_too_large: 'CONTEXT_OVERFLOW',
  content_filter: 'CONTENT_REFUSED',
  invalid_request_error: 'INVALID_REQUEST',
  timeout: 'TIMEOUT',
};

/**
 * A TanStack `RUN_ERROR` (`{ message, code }`) in the same
 * vocabulary, through the same construction as every other model error.
 *
 * `code` is the provider's error code when the SDK had one and the HTTP
 * status as a string when it did not. `message` is the vendor's text: it goes
 * to `detail`, for the log. `rawEvent` is the provider's error body when the
 * adapter kept one. Either may become the explanation, but the
 * message only when the code shows the provider wrote it — an adapter's own
 * `parse-error` or `empty-response` is this stack talking, not the provider.
 */
export function normalizeRunError(
  error: {
    readonly message?: string | undefined;
    readonly code?: string | undefined;
    readonly rawEvent?: unknown;
  },
  context?: ModelErrorContext,
): NormalizedModelError {
  const messageText = error.message ?? '';
  const raw = error.code ?? '';
  if (raw === ALLOWANCE_EXHAUSTED_CODE) {
    return normalized('ALLOWANCE_EXHAUSTED', 'included model allowance exhausted', context);
  }
  const status = /^\d{3}$/.test(raw) ? Number(raw) : undefined;
  const known = ModelErrorCodeSchema.safeParse(raw);
  const code: ModelErrorCode = known.success
    ? known.data
    : status !== undefined
      ? codeForStatus(status, messageText)
      : (PROVIDER_CODES[raw] ?? classifyMessage(messageText) ?? 'UNKNOWN');
  const fromProvider =
    status !== undefined || Object.hasOwn(PROVIDER_CODES, raw) || error.rawEvent !== undefined;
  return normalized(code, messageText, context, [
    ...bodySentences(error.rawEvent),
    ...(fromProvider ? [messageText] : []),
  ]);
}

// What a person may read of the provider's own words

const EXPLANATION_MAX = 400;

/**
 * Things a provider says that are true and help nobody: an HTTP reason
 * phrase, an SDK placeholder, OpenRouter's wrapper around an upstream error
 * (whose own words are read instead).
 */
const SAYS_NOTHING: ReadonlySet<string> = new Set([
  'bad request',
  'unauthorized',
  'forbidden',
  'not found',
  'too many requests',
  'internal server error',
  'bad gateway',
  'service unavailable',
  'gateway timeout',
  'request timed out',
  'connection error',
  'status code (no body)',
  'provider returned error',
  'unknown error',
  'an error occurred',
  'error',
  'fetch failed',
  'terminated',
]);

/** Plumbing: a person can do nothing with a socket's name for a failure. */
const TRANSPORT =
  /\b(?:ECONN[A-Z]+|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_[A-Z_]+)\b|socket hang up/;

/**
 * A request-shape complaint names the field this app sent wrong
 * (`messages.1.content.0.type`, `'tool_choice'`). That is a bug to report,
 * which the INVALID_REQUEST sentence already says, not a sentence to quote.
 */
const REQUEST_SHAPE = /\b[a-z_]+\.\d+\.[a-z_]+|['"`][a-z]+_[a-z_]+['"`]/;

/**
 * Key-shaped strings. Providers mask a key they quote, but not all of them,
 * and a request id or a token is never something the person needs to read.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /\bBearer\s+\S+/gi,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g,
];

/** The first of `said` a person can read and act on, cleaned; undefined when none is. */
function firstReadable(said: readonly string[]): string | undefined {
  for (const candidate of said) {
    const text = readable(candidate);
    if (text !== undefined) return text;
  }
  return undefined;
}

function readable(raw: string): string | undefined {
  // Bounded before any pattern runs: a provider's text has no length limit,
  // and the key shapes below cost more than linear time over it. Anything
  // past this would be cut from the explanation anyway.
  const bounded = raw.slice(0, EXPLANATION_MAX * 5);
  // A stack trace is this side's failure, whatever else it says.
  if (/\n\s+at\s/.test(bounded)) return undefined;
  // OpenAI-compatible SDKs prefix the status ("403 OpenCode's free tier…").
  const text = bounded
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\d{3}\s+/, '');
  if (text === '' || /^[[{<]/.test(text)) return undefined;
  if (SAYS_NOTHING.has(text.toLowerCase().replace(/[.!]+$/, ''))) return undefined;
  if (TRANSPORT.test(text) || REQUEST_SHAPE.test(text)) return undefined;
  // Not a sentence: a code, an id, a word or two.
  if ((text.match(/[A-Za-z]{2,}/g) ?? []).length < 4) return undefined;
  const safe = SECRET_SHAPES.reduce((out, shape) => out.replace(shape, '[hidden]'), text);
  return safe.length <= EXPLANATION_MAX ? safe : `${safe.slice(0, EXPLANATION_MAX - 1).trimEnd()}…`;
}

/**
 * The provider's error body on a thrown SDK error: `rawEvent` when an adapter
 * attached one, else the parsed body the OpenAI and Anthropic SDKs keep on
 * `error`. Never the error object itself, which carries request metadata.
 */
function providerBody(error: Error): unknown {
  return Reflect.get(error, 'rawEvent') ?? Reflect.get(error, 'error');
}

/**
 * The sentences in a provider's error body: its own `message`, then — for
 * OpenRouter, whose `message` is often just "Provider returned error" — the
 * upstream provider's, from `metadata.raw`.
 */
function bodySentences(body: unknown): string[] {
  const fields = recordOf(body);
  if (fields === undefined) return [];
  const own = fields['message'];
  const upstream = recordOf(fields['metadata'])?.['raw'];
  return [
    ...(typeof own === 'string' ? [own] : []),
    ...(typeof upstream === 'string' ? [upstreamMessage(upstream)] : []),
  ];
}

function upstreamMessage(raw: string): string {
  try {
    const parsed = recordOf(JSON.parse(raw));
    const message = recordOf(parsed?.['error'])?.['message'] ?? parsed?.['message'];
    return typeof message === 'string' ? message : raw;
  } catch {
    return raw;
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The code a meter's refusal carries when it surfaces as a `RUN_ERROR`. */
export const ALLOWANCE_EXHAUSTED_CODE = 'crewaid_allowance_exhausted';

/** A `ModelAllowanceExhaustedError`, or one wrapped in `cause` by the SDK. */
function isAllowanceExhausted(error: unknown): boolean {
  for (let current = error, depth = 0; current !== undefined && depth < 5; depth += 1) {
    if (current instanceof ModelAllowanceExhaustedError) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}
