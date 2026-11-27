import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { ATTACHMENT_MAX_BYTES } from '@crewaid/shared';

/**
 * Multer upload limits as DELIBERATE CONFIG, not library defaults.
 *
 * Upload limits: { fileSize: 25 MiB, files: 5 } per request.
 * Overflow answers 413 (Payload Too Large), never a raw Multer error code —
 * a 400 LIMIT_UNEXPECTED_FILE leaks the library boundary to the client.
 *
 * Rationale: unbounded uploads can balloon a 2GB sandbox disk and
 * starve ARTIFACT_DIR within the six-sandbox capacity budget; the
 * 25 MiB file cap also aligns with AttachmentsService.MAX_BYTES, which
 * enforces the same ceiling post-buffer (defense in depth: multer caps the
 * stream before it buffers, the service re-checks what arrived).
 */
export const D022_FILE_SIZE_BYTES = ATTACHMENT_MAX_BYTES; // 25 MiB = 26_214_400
export const D022_MAX_FILES = 5;

/**
 * The text half of a multipart body, which Multer bounds at nothing by
 * default: unlimited fields of up to 1 MB each, all buffered in memory before
 * the handler runs. No upload route reads a text field — the desktop sends one
 * `file` part — so a handful of small ones is generous, and anything past
 * that is a body built to cost memory rather than to deliver a file.
 */
export const MULTIPART_TEXT_LIMITS = {
  fields: 8,
  fieldSize: 1024,
  fieldNameSize: 100,
} as const;

export const D022_MULTER_LIMITS = {
  fileSize: D022_FILE_SIZE_BYTES,
  files: D022_MAX_FILES,
  ...MULTIPART_TEXT_LIMITS,
  parts: D022_MAX_FILES + MULTIPART_TEXT_LIMITS.fields,
} as const;

/**
 * Shared Multer limit error-code sets, consumed by both `multerErrorToHttp`
 * (direct upload controllers) and `MulterErrorFilter` (Nest's transformed
 * `BadRequestException` with preserved `cause`) so the two cannot drift.
 *
 * `INVALID_FIELD_NAME` is intentionally omitted: a malformed field name such as
 * `__proto__[x]` is a client bad request (400), not an oversized payload (413).
 */
export const D022_FILE_LIMIT_CODES: ReadonlySet<string> = new Set([
  'LIMIT_FILE_COUNT',
  'LIMIT_UNEXPECTED_FILE',
]);

export const D022_FIELD_LIMIT_CODES: ReadonlySet<string> = new Set([
  'LIMIT_PART_COUNT',
  'LIMIT_FIELD_COUNT',
  'LIMIT_FIELD_KEY',
  'LIMIT_FIELD_VALUE',
  'LIMIT_FIELD_NESTING',
  'LIMIT_FIELD_ARRAY_INDEX',
]);

/**
 * Map Multer error codes onto the ratified HTTP semantics: anything the
 * limits layer rejects is a payload problem → 413. Unknown codes fall
 * through as a bad request.
 */
export function multerErrorToHttp(error: unknown): Error {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === 'LIMIT_FILE_SIZE' || D022_FILE_LIMIT_CODES.has(code)) {
    return new PayloadTooLargeException(
      code === 'LIMIT_FILE_SIZE'
        ? `Attachment exceeds ${D022_FILE_SIZE_BYTES} bytes`
        : `Upload exceeds ${D022_MAX_FILES} files per request`,
    );
  }
  if (D022_FIELD_LIMIT_CODES.has(code)) {
    return new PayloadTooLargeException('Upload carries more form fields than a file needs');
  }
  return new BadRequestException('Malformed multipart payload');
}
