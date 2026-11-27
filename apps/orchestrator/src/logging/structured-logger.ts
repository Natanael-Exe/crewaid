import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, type LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger as PinoLogger } from 'pino';

export const CORRELATION_FIELDS = [
  'botId',
  'conversationId',
  'chainId',
  'turnId',
  'runId',
] as const;

export type CorrelationField = (typeof CORRELATION_FIELDS)[number];
export type CorrelationFields = Partial<Record<CorrelationField, string | null>>;
type LogFields = Record<string, unknown>;
type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const EMPTY_CORRELATION: Record<CorrelationField, string | null> = {
  botId: null,
  conversationId: null,
  chainId: null,
  turnId: null,
  runId: null,
};

const REDACT_PATHS = [
  'authorization',
  'headers.authorization',
  'req.headers.authorization',
  'request.headers.authorization',
  'token',
  'password',
  'secret',
  'apiKey',
  'api_key',
  'databaseUrl',
  'connectionString',
  'clientSecret',
  'accessToken',
  'refreshToken',
  'privateKey',
  'cookie',
  'set-cookie',
  '*.authorization',
  '*.token',
  '*.password',
  '*.secret',
  '*.apiKey',
  '*.api_key',
  '*.databaseUrl',
  '*.connectionString',
  '*.clientSecret',
  '*.accessToken',
  '*.refreshToken',
  '*.privateKey',
  '*.cookie',
  '*.set-cookie',
  'credentials.*',
];

const SENSITIVE_KEY_WORDS = new Set([
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'password',
  'secret',
  'token',
  'tokens',
]);
const SENSITIVE_KEY_PAIRS = new Set([
  'accesskey',
  'apikey',
  'applicationcredentials',
  'connectionstring',
  'databaseurl',
  'encryptionkey',
  'privatekey',
  'serviceaccountkey',
  'signingkey',
]);
const TOKEN_USAGE_KEYS = new Set([
  'inputtokens',
  'outputtokens',
  'cachedinputtokens',
  'cachecreationtokens',
]);

const AUTHORIZATION_ASSIGNMENT = /(["']?\bauthorization["']?[ \t]*[:=][ \t]*)/gi;
const BEARER_TEXT = /\bBearer\s+[^\s,;)}\]"'`]+/gi;
/**
 * `[REDACTED]` leads the alternation so this is IDEMPOTENT.
 *
 * `sanitizeText` runs twice on a Nest message — once in `log`/`error` and
 * again when `sanitizeFields` walks the payload — and without this the second
 * pass matched `[REDACTED` (the value alternative stops at `]`) and rebuilt it
 * as `[REDACTED]]`. Cosmetic, but it is also the shape of a redactor eating
 * its own output, which is worth not having.
 */
const KEY_ASSIGNMENT_TEXT =
  /(["']?\b[A-Za-z][A-Za-z0-9_-]*\b["']?)(\s*[:=]\s*)(?:\[REDACTED\]|"[^"]*"|'[^']*'|[^\s,;)}\]]+)/g;

/**
 * A provider key, wherever it appears — V1-16.
 *
 * THIS IS NOT A BACKSTOP FOR THE ASSIGNMENT RULE. It covers a case that
 * rule structurally cannot: a key with no key NAME beside it. The three
 * supported vendors all 401 in exactly that shape, and two of the three leaked
 * before this existed:
 *
 * OpenAI `Incorrect API key provided: sk-proj-…` ("provided" is not
 * a sensitive word)
 * OpenRouter `No auth credentials found (sk-or-v1-…)` (no assignment at all)
 * Anthropic `invalid x-api-key: sk-ant-…` (caught already)
 *
 * D-006 keeps vendor text out of the TRANSCRIPT and deliberately allows it in
 * the operator's log, because the operator-facing sentence says "check logs
 * for detail". That was written when this orchestrator had one user. V1 made
 * keys per-user, so the detail can now be somebody else's secret in a log a
 * different person reads — and the fix is to narrow what "detail" includes,
 * not to remove it: `invalid x-api-key: [REDACTED]` still says the key was
 * rejected.
 *
 * The same holds for the other services this server holds keys for: ElevenLabs
 * and Stripe secret keys are `sk_…` (Stripe's restricted keys `rk_…`, its
 * webhook secrets `whsec_…`), and a GitHub, Google or Slack token pasted
 * into a plugin or a connection has a prefix of its own.
 *
 * WHAT IT CANNOT DO. A CUSTOM connection's key format is whatever that
 * provider chose, and is not guessable from here. This catches the shapes the
 * built-ins issue; the row-level bar stays the primary defence.
 */
// A BotFather token is `<bot id>:<secret>`; Telegram's API URLs carry it right after `bot`,
// so it is matched by its digits rather than a word boundary.
const VENDOR_KEY_TEXT =
  /\b(?:sk[-_]|rk_(?:live|test)_|whsec_|gh[pousr]_|github_pat_|xox[abprs]-|crw_conn_)[A-Za-z0-9_-]{12,}|\bAIza[0-9A-Za-z_-]{30,}|(?<!\d)\d{5,20}:[A-Za-z0-9_-]{30,}/g;
const CONNECTION_URL_TEXT =
  /\b(?:jdbc:)?(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|mssql):\/\/[^\s,;)}\]"'`]+/gi;
const CREDENTIAL_URL_TEXT = /\b[a-z][a-z\d+.-]*:\/\/[^/\s:@]+:[^@\s]+@[^\s,;)}\]"'`]+/gi;

const correlationStorage = new AsyncLocalStorage<CorrelationFields>();

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^a-zA-Z\d]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function isSensitiveKey(key: string): boolean {
  const words = keyWords(key);
  const normalized = words.join('');
  if (TOKEN_USAGE_KEYS.has(normalized)) {
    return false;
  }
  if (words.some((word) => SENSITIVE_KEY_WORDS.has(word))) {
    return true;
  }
  return words.some((word, index) => {
    return SENSITIVE_KEY_PAIRS.has(`${word}${words[index + 1] ?? ''}`);
  });
}

function authorizationValueEnd(value: string, start: number): number {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ';' || character === '\r' || character === '\n') {
      return index;
    }
  }
  return value.length;
}

function sanitizeAuthorizationAssignments(value: string): string {
  let output = '';
  let cursor = 0;
  for (const match of value.matchAll(AUTHORIZATION_ASSIGNMENT)) {
    const start = match.index ?? 0;
    if (start < cursor) {
      continue;
    }
    const prefix = match[0];
    const valueStart = start + prefix.length;
    const valueEnd = authorizationValueEnd(value, valueStart);
    output += value.slice(cursor, start) + prefix + '[REDACTED]';
    cursor = valueEnd;
  }
  return output + value.slice(cursor);
}

function sanitizeKeyAssignment(match: string, key: string, separator: string): string {
  return isSensitiveKey(key) ? `${key}${separator}[REDACTED]` : match;
}

function sanitizeText(value: string): string {
  return sanitizeAuthorizationAssignments(value)
    .replace(BEARER_TEXT, '[REDACTED]')
    .replace(KEY_ASSIGNMENT_TEXT, sanitizeKeyAssignment)
    .replace(VENDOR_KEY_TEXT, '[REDACTED]')
    .replace(CONNECTION_URL_TEXT, '[REDACTED]')
    .replace(CREDENTIAL_URL_TEXT, '[REDACTED]');
}

function readProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return '[UNSERIALIZABLE]';
  }
}

function ownPropertyNames(value: object): string[] {
  try {
    return Object.getOwnPropertyNames(value);
  } catch {
    return [];
  }
}

function sanitizeError(error: Error, seen: WeakSet<object>): LogFields {
  const output: LogFields = Object.create(null) as LogFields;
  for (const key of ['name', 'message', 'stack']) {
    const property = readProperty(error, key);
    if (property !== undefined) {
      output[key] = sanitizeValue(property, seen);
    }
  }

  for (const key of ownPropertyNames(error)) {
    if (key === 'name' || key === 'message' || key === 'stack' || key === 'toJSON') {
      continue;
    }
    output[key] = isSensitiveKey(key)
      ? '[REDACTED]'
      : sanitizeValue(readProperty(error, key), seen);
  }
  return output;
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return sanitizeText(value);
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'function') {
    return '[Function]';
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);
  try {
    if (value instanceof Error) {
      return sanitizeError(value, seen);
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? '[Invalid Date]' : value.toISOString();
    }
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeValue(item, seen));
    }

    const output: LogFields = Object.create(null) as LogFields;
    for (const key of ownPropertyNames(value)) {
      if (key === 'toJSON') {
        continue;
      }
      output[key] = isSensitiveKey(key)
        ? '[REDACTED]'
        : sanitizeValue(readProperty(value, key), seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function sanitizeFields(fields: LogFields): LogFields {
  const sanitized = sanitizeValue(fields, new WeakSet<object>());
  return sanitized !== null && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? (sanitized as LogFields)
    : { value: sanitized };
}

function normalizedFields(fields: CorrelationFields): CorrelationFields {
  return Object.fromEntries(CORRELATION_FIELDS.map((field) => [field, fields[field] ?? null]));
}

function createPino(destination?: DestinationStream): PinoLogger {
  return pino(
    {
      level: process.env['LOG_LEVEL'] ?? 'info',
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    },
    destination,
  );
}

function isPlainRecord(value: unknown): value is LogFields {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Error) &&
    !(value instanceof Date)
  );
}

function extractNestParams(optionalParams: readonly unknown[]): {
  fields: LogFields;
  context?: string;
} {
  if (optionalParams.length === 0) {
    return { fields: {} };
  }
  const rest = [...optionalParams];
  let context: string | undefined;
  const last = rest[rest.length - 1];
  if (typeof last === 'string') {
    context = sanitizeText(last);
    rest.pop();
  }
  const fields: LogFields = {};
  const extra: unknown[] = [];
  for (const item of rest) {
    if (isPlainRecord(item)) {
      Object.assign(fields, item);
    } else if (item !== undefined) {
      extra.push(item);
    }
  }
  if (extra.length > 0) {
    fields['extra'] = extra;
  }
  return context === undefined ? { fields } : { fields, context };
}

/** Pino-backed Nest logger with a fixed, auditable correlation envelope. */
@Injectable()
export class StructuredLogger implements LoggerService {
  constructor(
    private readonly pinoLogger: PinoLogger = createPino(),
    private readonly fixedCorrelation: CorrelationFields = {},
  ) {}

  child(fields: CorrelationFields): StructuredLogger {
    return new StructuredLogger(this.pinoLogger, {
      ...this.fixedCorrelation,
      ...fields,
    });
  }

  withCorrelation<T>(fields: CorrelationFields, callback: () => T): T {
    return correlationStorage.run(
      {
        ...correlationStorage.getStore(),
        ...this.fixedCorrelation,
        ...fields,
      },
      callback,
    );
  }

  info(event: string, fields: LogFields = {}): void {
    this.write('info', event, fields);
  }

  debug(event: string, fields?: LogFields): void;
  debug(message: unknown, context: string): void;
  debug(message: unknown, fields: LogFields, context: string): void;
  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.writeNestLevel('debug', 'nest.debug', message, optionalParams);
  }

  warn(event: string, fields?: LogFields): void;
  warn(message: unknown, context: string): void;
  warn(message: unknown, fields: LogFields, context: string): void;
  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.writeNestLevel('warn', 'nest.warn', message, optionalParams);
  }

  error(message: unknown, stackOrFields?: string | LogFields, context?: string): void {
    if (typeof stackOrFields === 'object' && stackOrFields !== null) {
      this.write('error', typeof message === 'string' ? message : 'nest.error', {
        ...stackOrFields,
        ...(typeof context === 'string' && { context: sanitizeText(context) }),
      });
      return;
    }
    this.errorNest(message, stackOrFields, context);
  }

  fatal(event: string, fields?: LogFields): void;
  fatal(message: unknown, context: string): void;
  fatal(message: unknown, fields: LogFields, context: string): void;
  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.writeNestLevel('fatal', 'nest.fatal', message, optionalParams);
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    const { fields, context } = extractNestParams(optionalParams);
    this.write('info', 'nest.log', {
      ...fields,
      message: typeof message === 'string' ? sanitizeText(message) : message,
      ...(context !== undefined && { context }),
    });
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    const { fields, context } = extractNestParams(optionalParams);
    this.write('debug', typeof message === 'string' ? sanitizeText(message) : 'nest.verbose', {
      ...fields,
      ...(typeof message !== 'string' && { message }),
      ...(context !== undefined && { context }),
    });
  }

  errorNest(message: unknown, stack?: string, context?: string): void {
    this.write('error', 'nest.error', {
      message: typeof message === 'string' ? sanitizeText(message) : message,
      ...(stack !== undefined && { stack: sanitizeText(stack) }),
      ...(context !== undefined && { context: sanitizeText(context) }),
    });
  }

  private writeNestLevel(
    level: LogLevel,
    fallbackEvent: string,
    message: unknown,
    optionalParams: readonly unknown[],
  ): void {
    if (typeof message === 'string' && optionalParams.length === 1 && isPlainRecord(optionalParams[0])) {
      this.write(level, message, optionalParams[0]);
      return;
    }
    const { fields, context } = extractNestParams(optionalParams);
    if (typeof message === 'string') {
      this.write(level, message, {
        ...fields,
        ...(context !== undefined && { context }),
      });
      return;
    }
    this.write(level, fallbackEvent, {
      ...fields,
      message,
      ...(context !== undefined && { context }),
    });
  }

  private write(level: LogLevel, event: string, fields: LogFields): void {
    const active = correlationStorage.getStore() ?? {};
    const correlation = normalizedFields({
      ...active,
      ...this.fixedCorrelation,
    });
    const payload = sanitizeFields({
      ...EMPTY_CORRELATION,
      ...correlation,
      ...fields,
      event: sanitizeText(event),
    });
    this.pinoLogger[level](payload);
  }
}

export function createStructuredLogger(destination: DestinationStream): StructuredLogger {
  return new StructuredLogger(createPino(destination));
}
