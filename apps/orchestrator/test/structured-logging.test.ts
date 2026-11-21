import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { APICallError } from './model-resolution-fake.js';
import {
  CORRELATION_FIELDS,
  StructuredLogger,
  createStructuredLogger,
} from '../src/logging/structured-logger.js';
import { RequestLoggingMiddleware } from '../src/logging/request-logging.middleware.js';

class MemoryDestination extends Writable {
  readonly chunks: string[] = [];

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  records(): Array<Record<string, unknown>> {
    return this.chunks.filter(Boolean).map((chunk) => JSON.parse(chunk) as Record<string, unknown>);
  }
}

function loggerWithDestination(logLevel?: string): {
  logger: StructuredLogger;
  destination: MemoryDestination;
} {
  const previousLogLevel = process.env['LOG_LEVEL'];
  if (logLevel !== undefined) {
    process.env['LOG_LEVEL'] = logLevel;
  }
  const destination = new MemoryDestination();
  const logger = createStructuredLogger(destination);
  if (previousLogLevel === undefined) {
    delete process.env['LOG_LEVEL'];
  } else {
    process.env['LOG_LEVEL'] = previousLogLevel;
  }
  return { logger, destination };
}

const SENTINELS = {
  deep: 'cc01-deep-provider-sentinel',
  uppercaseAuthorization: 'cc01-uppercase-authorization-sentinel',
  arbitraryText: 'cc01-arbitrary-detail-sentinel',
  connectionString: 'cc01-connection-string-sentinel',
  warning: 'cc01-warning-bearer-sentinel',
  providerBody: 'cc01-provider-body-sentinel',
  providerHeader: 'cc01-provider-header-sentinel',
  requestBody: 'cc01-request-body-sentinel',
} as const;

function providerErrorFixture(): APICallError {
  const error = new APICallError({
    message: `provider response failed; Authorization: Bearer ${SENTINELS.providerHeader}`,
    url: 'https://provider.example/v1/chat/completions',
    statusCode: 401,
    requestBodyValues: {
      nested: { API_KEY: SENTINELS.requestBody },
    },
    responseHeaders: {
      Authorization: `Bearer ${SENTINELS.providerHeader}`,
      'X-Client-Secret': SENTINELS.deep,
    },
    responseBody: JSON.stringify({
      detail: `connectionString=postgresql://cc01:${SENTINELS.providerBody}@provider.example/db`,
    }),
    isRetryable: false,
  });
  Object.assign(error, {
    response: {
      envelope: {
        headers: { aUtHoRiZaTiOn: `Bearer ${SENTINELS.uppercaseAuthorization}` },
        body: { detail: `provider detail token=${SENTINELS.deep}` },
      },
    },
    cause: {
      request: {
        headers: { AUTHORIZATION: `Bearer ${SENTINELS.providerHeader}` },
      },
    },
  });
  return error;
}

/**
 * The two `error` overloads are not interchangeable, and the wrong one loses
 * everything the line was written to carry.
 *
 * `error(message: unknown, stackOrFields?)` accepts a single object, so
 * `error({ event, ...fields })` type-checks — and then falls through to the
 * Nest-compat path, which emits `event: "nest.error"` and drops the fields.
 * That shipped once, on the R9 checkpoint-failure line, where it meant the
 * one log that says WHICH step failed and WHY carried neither.
 */
describe('CC-01 logger.error overloads', () => {
  it('keeps the event name and fields only in the (event, fields) form', () => {
    const destination = new MemoryDestination();
    const logger = createStructuredLogger(destination);

    logger.error('turn.step.checkpoint.failed', { stepNumber: 3, detail: 'db down' });
    logger.error({ event: 'turn.step.checkpoint.failed', stepNumber: 3, detail: 'db down' });

    const [idiom, objectForm] = destination.records();
    expect(idiom).toMatchObject({
      event: 'turn.step.checkpoint.failed',
      stepNumber: 3,
      detail: 'db down',
    });
    // The trap, pinned so the loose signature cannot quietly invite it back.
    expect(objectForm).toMatchObject({ event: 'nest.error' });
    expect(objectForm?.['stepNumber']).toBeUndefined();
    expect(objectForm?.['detail']).toBeUndefined();
  });
});

describe('CC-01 structured logging', () => {
  it('emits all required correlation fields, using null when unavailable', () => {
    const { logger, destination } = loggerWithDestination();

    logger.info('request.test', { botId: 'bot-1', turnId: 'turn-1' });

    const record = destination.records()[0]!;
    expect(record['time']).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(CORRELATION_FIELDS.every((field) => field in record)).toBe(true);
    expect(record).toMatchObject({
      event: 'request.test',
      botId: 'bot-1',
      conversationId: null,
      chainId: null,
      turnId: 'turn-1',
      runId: null,
    });
  });

  it('redacts credential-shaped fields and bearer values', () => {
    const { logger, destination } = loggerWithDestination();

    logger.info('security.test', {
      authorization: 'Bearer super-secret-token',
      token: 'token-secret',
      password: 'password-secret',
      nested: {
        apiKey: 'api-key-secret',
        clientSecret: 'client-secret',
        accessToken: 'access-token-secret',
        refreshToken: 'refresh-token-secret',
        connectionString: 'postgres-secret',
      },
      cookie: 'session-cookie-secret',
      safe: 'kept',
    });
    logger.log('Bearer another-secret', 'Security');

    const serialized = destination.chunks.join('');
    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).not.toContain('token-secret');
    expect(serialized).not.toContain('password-secret');
    expect(serialized).not.toContain('api-key-secret');
    expect(serialized).not.toContain('postgres-secret');
    expect(serialized).not.toContain('client-secret');
    expect(serialized).not.toContain('access-token-secret');
    expect(serialized).not.toContain('refresh-token-secret');
    expect(serialized).not.toContain('session-cookie-secret');
    expect(serialized).not.toContain('another-secret');
    expect(serialized).toContain('[REDACTED]');
  });

  it('redacts deeply nested, case-varied, freeform, Nest, and provider error credentials', () => {
    const { logger, destination } = loggerWithDestination('debug');
    const structuredFields = {
      provider: {
        client: {
          response: {
            headers: {
              Authorization: `Bearer ${SENTINELS.uppercaseAuthorization}`,
              connection_STRING: SENTINELS.connectionString,
            },
            body: {
              credentials: { access_token: SENTINELS.deep },
            },
          },
        },
      },
      request: {
        payload: { API_KEY: SENTINELS.requestBody },
      },
      detail: `provider detail Authorization: Bearer ${SENTINELS.arbitraryText} connectionString=postgresql://cc01:${SENTINELS.connectionString}@provider.example/db`,
    };

    logger.info('structured.info', structuredFields);
    logger.debug('structured.debug', structuredFields);
    logger.warn('structured.warn', { detail: `Bearer ${SENTINELS.warning}` });
    logger.error('structured.error', structuredFields);
    logger.fatal('structured.fatal', structuredFields);
    logger.log(`Nest log Authorization: Bearer ${SENTINELS.warning}`);
    logger.verbose(`Nest verbose connectionString=${SENTINELS.connectionString}`, 'NestContext');
    logger.error(
      `Nest error Authorization: Bearer ${SENTINELS.warning}`,
      `stack connection_string=${SENTINELS.connectionString}`,
      `NestContext token=${SENTINELS.deep}`,
    );
    logger.error('provider.error', { error: providerErrorFixture() });

    const serialized = destination.chunks.join('');
    const records = destination.records();
    expect(records).toHaveLength(9);
    expect(records.filter((record) => record.level === 20)).toHaveLength(2);
    for (const sentinel of Object.values(SENTINELS)) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(serialized).toContain('[REDACTED]');
  });

  it('redacts complete multi-token authorization and compound environment credentials at every entry point', () => {
    const { logger, destination } = loggerWithDestination('debug');
    const sentinels = {
      basic: 'cc01-basic-auth-sentinel',
      digest: 'cc01-digest-auth-sentinel',
      aws: 'cc01-aws-secret-access-sentinel',
    } as const;
    const credentialText = [
      `Authorization: Basic basic-user ${sentinels.basic}`,
      `authorization=Digest username=alice, response=${sentinels.digest}`,
      `AWS_SECRET_ACCESS_KEY=${sentinels.aws}`,
    ].join('; ');
    const providerError = new APICallError({
      message: credentialText,
      url: 'https://provider.example/v1/chat/completions',
      statusCode: 401,
      requestBodyValues: { detail: credentialText },
      responseHeaders: { 'x-provider-detail': credentialText },
      responseBody: credentialText,
      isRetryable: false,
    });
    Object.assign(providerError, {
      response: { detail: credentialText },
      cause: { detail: credentialText },
    });

    logger.info('credential.info', { detail: credentialText });
    logger.debug('credential.debug', { detail: credentialText });
    logger.warn('credential.warn', { detail: credentialText });
    logger.error('credential.error', { detail: credentialText });
    logger.fatal('credential.fatal', { detail: credentialText });
    logger.log(credentialText);
    logger.verbose(credentialText);
    logger.error(credentialText, credentialText, credentialText);
    logger.error('credential.provider-error', { error: providerError });

    const serialized = destination.chunks.join('');
    expect(destination.records()).toHaveLength(9);
    for (const sentinel of Object.values(sentinels)) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(serialized).toContain('[REDACTED]');
  });

  it('redacts credential token keys while preserving token usage metrics', () => {
    const { logger, destination } = loggerWithDestination();
    const secretSentinels = {
      token: 'cc01-token-secret-sentinel',
      accessToken: 'cc01-access-token-secret-sentinel',
      apiToken: 'cc01-api-token-secret-sentinel',
      tokenValue: 'cc01-token-value-secret-sentinel',
    } as const;

    logger.info('token-classification', {
      token: secretSentinels.token,
      accessToken: secretSentinels.accessToken,
      apiToken: secretSentinels.apiToken,
      tokenValue: secretSentinels.tokenValue,
      inputTokens: 123,
      outputTokens: 45,
      cachedInputTokens: 6,
      cacheCreationTokens: 7,
    });

    const serialized = destination.chunks.join('');
    const record = destination.records()[0]!;
    for (const sentinel of Object.values(secretSentinels)) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(record).toMatchObject({
      token: '[REDACTED]',
      accessToken: '[REDACTED]',
      apiToken: '[REDACTED]',
      tokenValue: '[REDACTED]',
      inputTokens: 123,
      outputTokens: 45,
      cachedInputTokens: 6,
      cacheCreationTokens: 7,
    });
  });

  it('seeds request correlation from the route alone, never from headers, and excludes the query string', () => {
    const { logger, destination } = loggerWithDestination();
    const middleware = new RequestLoggingMiddleware(logger);
    let finish: (() => void) | undefined;
    let nextCalled = false;

    middleware.use(
      {
        method: 'POST',
        originalUrl: '/api/v1/bots/bot-1/messages?token=do-not-log',
        headers: {
          'x-conversation-id': 'conversation-1',
          'x-chain-id': 'chain-1',
          'x-turn-id': 'turn-1',
          'x-run-id': 'run-1',
        },
      },
      {
        statusCode: 201,
        on: (event: string, callback: () => void) => {
          if (event === 'finish') finish = callback;
        },
      },
      () => {
        nextCalled = true;
      },
    );
    finish?.();

    const records = destination.records();
    expect(nextCalled).toBe(true);
    expect(records.map((record) => record.event)).toEqual(['request.start', 'request.complete']);
    for (const record of records) {
      expect(record).toMatchObject({ botId: 'bot-1', path: '/api/v1/bots/bot-1/messages' });
    }
    // A caller's headers name no run, turn or conversation of their choosing.
    const written = destination.chunks.join('');
    for (const claimed of ['conversation-1', 'chain-1', 'turn-1', 'run-1']) {
      expect(written).not.toContain(claimed);
    }
    // ...and the two records of one request pair up on an id the server made.
    expect(records[0]?.requestId).toEqual(expect.any(String));
    expect(records[1]?.requestId).toBe(records[0]?.requestId);
    expect(written).not.toContain('do-not-log');
  });
});
