import { ArgumentsHost, BadRequestException, Catch, HttpStatus } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { D022_MAX_FILES, D022_FILE_SIZE_BYTES } from './d022-limits.js';

/**
 * Multer limit violations must answer 413, never the library-default
 * 400.
 *
 * Nest's platform-express maps Multer errors to HttpExceptions BEFORE any
 * user filter runs (multer.utils.transformException): LIMIT_FILE_SIZE becomes
 * PayloadTooLargeException (already 413), but LIMIT_FILE_COUNT and
 * LIMIT_UNEXPECTED_FILE become BadRequestException (400). When Multer attaches
 * a field name, the message gains a ` - <field>` suffix, so match on prefix.
 * This filter re-maps those to 413 per the D-022 ruling: an over-limit upload
 * is a payload problem, whatever the limit that caught it.
 *
 * Matching on the message is forced — the code is gone by the time a filter
 * sees the exception — and the messages are NOT stable: multer 2.4 renamed
 * "Unexpected field" to "Unexpected file field", which silently turned a
 * sixth file back into a 400. `d022-multer-limits.test.ts` is what notices.
 */
const D022_REMAP_400_PREFIXES = [
  'Too many files', // Multer LIMIT_FILE_COUNT
  'Unexpected file field', // Multer LIMIT_UNEXPECTED_FILE, multer >= 2.4
  'Unexpected field', // Multer LIMIT_UNEXPECTED_FILE, multer < 2.4
];

/** The text-field bounds (`MULTIPART_TEXT_LIMITS`) — the same payload problem. */
const FIELD_REMAP_400_PREFIXES = [
  'Too many parts', // Multer LIMIT_PART_COUNT
  'Too many fields', // Multer LIMIT_FIELD_COUNT
  'Field name too long', // Multer LIMIT_FIELD_KEY
  'Field value too long', // Multer LIMIT_FIELD_VALUE
];

function matches(prefixes: readonly string[], message: string): boolean {
  return prefixes.some((prefix) => message === prefix || message.startsWith(`${prefix} -`));
}

@Catch(BadRequestException)
export class MulterErrorFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof BadRequestException) {
      const message = matches(D022_REMAP_400_PREFIXES, exception.message)
        ? `Upload exceeds ${D022_MAX_FILES} files per request (limit ${D022_FILE_SIZE_BYTES} bytes per file)`
        : matches(FIELD_REMAP_400_PREFIXES, exception.message)
          ? 'Upload carries more form fields than a file needs'
          : null;
      if (message !== null) {
        const response = host
          .switchToHttp()
          .getResponse<{ status: (code: number) => { json: (body: unknown) => void } }>();
        response.status(HttpStatus.PAYLOAD_TOO_LARGE).json({
          message,
          error: 'Payload Too Large',
          statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
        });
        return;
      }
    }
    super.catch(exception, host);
  }
}
