import { ArgumentsHost, BadRequestException, Catch, HttpStatus } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import {
  D022_FIELD_LIMIT_CODES,
  D022_FILE_LIMIT_CODES,
  D022_FILE_SIZE_BYTES,
  D022_MAX_FILES,
} from './d022-limits.js';

/**
 * Multer limit violations must answer 413, never the library-default
 * 400.
 *
 * Nest's platform-express maps Multer errors to HttpExceptions BEFORE any
 * user filter runs (multer.utils.transformException): LIMIT_FILE_SIZE becomes
 * PayloadTooLargeException (already 413), while file-count and text-field limit
 * codes become BadRequestException (400). This filter re-maps those to 413 per
 * the D-022 ruling: an over-limit upload is a payload problem, whatever the
 * limit that caught it.
 *
 * NestJS 12 preserves the original MulterError as `exception.cause`, so
 * matching on the shared code sets from `d022-limits.ts` (gated on
 * `cause.name === 'MulterError'`) is primary and immune to upstream message
 * rewording (e.g. multer 2.4's "Unexpected field" -> "Unexpected file field").
 * Prefix matching stays as a fallback when no cause is attached.
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

function multerCauseCode(exception: BadRequestException): string | undefined {
  const cause: unknown = exception.cause;
  if (typeof cause !== 'object' || cause === null) return undefined;
  const name: unknown = Reflect.get(cause, 'name');
  const code: unknown = Reflect.get(cause, 'code');
  return name === 'MulterError' && typeof code === 'string' ? code : undefined;
}

@Catch(BadRequestException)
export class MulterErrorFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() === 'http' && exception instanceof BadRequestException) {
      const code = multerCauseCode(exception);
      const isFileLimit =
        (code !== undefined && D022_FILE_LIMIT_CODES.has(code)) ||
        matches(D022_REMAP_400_PREFIXES, exception.message);
      const isFieldLimit =
        !isFileLimit &&
        ((code !== undefined && D022_FIELD_LIMIT_CODES.has(code)) ||
          matches(FIELD_REMAP_400_PREFIXES, exception.message));
      const message = isFileLimit
        ? `Upload exceeds ${D022_MAX_FILES} files per request (limit ${D022_FILE_SIZE_BYTES} bytes per file)`
        : isFieldLimit
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
