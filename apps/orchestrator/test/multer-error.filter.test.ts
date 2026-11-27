import { describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  PayloadTooLargeException,
  type ArgumentsHost,
  type HttpServer,
} from '@nestjs/common';
import {
  D022_FILE_SIZE_BYTES,
  D022_MAX_FILES,
  multerErrorToHttp,
} from '../src/attachments/d022-limits.js';
import { MulterErrorFilter } from '../src/attachments/multer-error.filter.js';

function multerCause(code: string, message = 'renamed upstream message'): Error {
  return Object.assign(new Error(message), { name: 'MulterError', code });
}

function createHarness() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const response = { status };
  const reply = vi.fn();
  const adapter = {
    reply,
    isHeadersSent: () => false,
  } as unknown as HttpServer;
  const host = {
    getType: () => 'http',
    getArgByIndex: (index: number) => (index === 1 ? response : undefined),
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  const filter = new MulterErrorFilter(adapter);
  return { filter, host, status, json, reply };
}

describe('MulterErrorFilter', () => {
  const fileLimitMessage = `Upload exceeds ${D022_MAX_FILES} files per request (limit ${D022_FILE_SIZE_BYTES} bytes per file)`;
  const fieldLimitMessage = 'Upload carries more form fields than a file needs';

  it.each(['LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE'])(
    'remaps Nest 12 MulterError cause %s to 413 regardless of upstream message text',
    (code) => {
      const { filter, host, status, json, reply } = createHarness();
      const exception = new BadRequestException('renamed', { cause: multerCause(code) });

      filter.catch(exception, host);

      expect(status).toHaveBeenCalledWith(413);
      expect(json).toHaveBeenCalledWith({
        statusCode: 413,
        error: 'Payload Too Large',
        message: fileLimitMessage,
      });
      expect(reply).not.toHaveBeenCalled();
    },
  );

  it.each([
    'LIMIT_PART_COUNT',
    'LIMIT_FIELD_COUNT',
    'LIMIT_FIELD_KEY',
    'LIMIT_FIELD_VALUE',
    'LIMIT_FIELD_NESTING',
    'LIMIT_FIELD_ARRAY_INDEX',
  ])('remaps Nest 12 MulterError field/part cause %s to 413', (code) => {
    const { filter, host, status, json, reply } = createHarness();
    const exception = new BadRequestException('renamed', { cause: multerCause(code) });

    filter.catch(exception, host);

    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({
      statusCode: 413,
      error: 'Payload Too Large',
      message: fieldLimitMessage,
    });
    expect(reply).not.toHaveBeenCalled();
  });

  it.each([
    ['Too many files', fileLimitMessage],
    ['Unexpected file field - extra', fileLimitMessage],
    ['Unexpected field', fileLimitMessage],
    ['Too many parts', fieldLimitMessage],
    ['Too many fields', fieldLimitMessage],
    ['Field name too long', fieldLimitMessage],
    ['Field value too long', fieldLimitMessage],
  ])('falls back to message prefix matching without cause for %s', (message, expectedMessage) => {
    const { filter, host, status, json, reply } = createHarness();

    filter.catch(new BadRequestException(message), host);

    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({
      statusCode: 413,
      error: 'Payload Too Large',
      message: expectedMessage,
    });
    expect(reply).not.toHaveBeenCalled();
  });

  it.each([
    [
      'INVALID_FIELD_NAME (__proto__[x])',
      new BadRequestException('Invalid field name', {
        cause: multerCause('INVALID_FIELD_NAME', '__proto__[x]'),
      }),
    ],
    ['ordinary BadRequestException without cause', new BadRequestException('Invalid bot name')],
    [
      'non-MulterError cause carrying a matching code property',
      new BadRequestException('Bad input', {
        cause: Object.assign(new Error('not multer'), { code: 'LIMIT_FILE_COUNT' }),
      }),
    ],
  ])('leaves %s as HTTP 400 via BaseExceptionFilter', (_label, exception) => {
    const { filter, host, status, reply } = createHarness();

    filter.catch(exception, host);

    expect(status).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(expect.anything(), expect.anything(), 400);
  });
});

describe('multerErrorToHttp', () => {
  it.each(['LIMIT_FILE_SIZE', 'LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE'])(
    'maps %s to PayloadTooLargeException (413)',
    (code) => {
      const result = multerErrorToHttp(multerCause(code));
      expect(result).toBeInstanceOf(PayloadTooLargeException);
      expect((result as PayloadTooLargeException).getStatus()).toBe(413);
    },
  );

  it.each([
    'LIMIT_PART_COUNT',
    'LIMIT_FIELD_COUNT',
    'LIMIT_FIELD_KEY',
    'LIMIT_FIELD_VALUE',
    'LIMIT_FIELD_NESTING',
    'LIMIT_FIELD_ARRAY_INDEX',
  ])('maps field/part limit %s to PayloadTooLargeException (413)', (code) => {
    const result = multerErrorToHttp(multerCause(code));
    expect(result).toBeInstanceOf(PayloadTooLargeException);
    expect((result as PayloadTooLargeException).getStatus()).toBe(413);
    expect(result.message).toBe('Upload carries more form fields than a file needs');
  });

  it('keeps INVALID_FIELD_NAME as BadRequestException (400)', () => {
    const result = multerErrorToHttp(multerCause('INVALID_FIELD_NAME', '__proto__[x]'));
    expect(result).toBeInstanceOf(BadRequestException);
    expect((result as BadRequestException).getStatus()).toBe(400);
  });
});
