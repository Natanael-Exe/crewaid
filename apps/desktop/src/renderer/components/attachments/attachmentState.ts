import { normalizeApiFailure, type ApiFailure } from '../../api/apiError';
import { t } from '../../i18n/i18n';

/**
 * attachment upload state (pure, unit-tested).
 *
 * Mirrors the orchestrator contract at the // head:
 * POST /attachments → { id, filename, mimeType, sizeBytes, storageKey }
 * DELETE /attachments/:id → 204 | 404 foreign/unknown | 409 claimed | 410 past TTL
 * POST /bots/:id/messages → claims via attachmentIds (server-side, transactional)
 *
 * Error handling rule: the UI NEVER renders raw vendor/server strings (the
 * principle applied to our own REST layer). Every failure normalizes to
 * an AttachmentErrorCode with operator-facing copy; the raw body only rides
 * along for logs (never rendered).
 */

// Server limits, mirrored for fast-fail (server stays source of truth)

/** AttachmentsService.MAX_BYTES at the PR #9 head. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** AttachmentsService.ALLOWED_MIME at the PR #9 head. */
export const ALLOWED_MIME = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/zip',
]);

// Normalized errors

/**
 * One code per user-visible failure mode. 404/409/410 are the /
 * fences; 400/413 are the upload guards; the rest are transport-level.
 */
export type AttachmentErrorCode =
  | 'INVALID_FILE' // 400: empty / no content / unsupported MIME
  | 'TOO_LARGE' // 413
  | 'STORAGE_FULL' // 507: the account's file storage is full
  | 'NOT_FOUND' // 404: unknown or foreign id (non-leaking by design)
  | 'ALREADY_CLAIMED' // 409: claimed rows are not deletable ( addendum)
  | 'EXPIRED' // 410: unclaimed past the 24h interim TTL ( ratified)
  | 'NETWORK' // fetch failed / offline / server unreachable
  | 'CONFIGURATION' // no orchestrator URL/token configured ( store empty)
  | 'UNKNOWN'; // anything else — message stays operator-neutral

export interface AttachmentError {
  code: AttachmentErrorCode;
  /** Operator-facing, provider-neutral. Safe to render. */
  message: string;
  /** Raw response body, if any. For logs only — never rendered. */
  detail?: string | undefined;
}

/**
 * Re-word a transport-level failure in attachment terms.
 *
 * The status→code decision lives once, in `normalizeApiFailure`; this only
 * supplies upload-specific copy where the generic wording would be wrong
 * ("The server rejected that request" for a bad file type). Codes that mean
 * the same thing in both vocabularies pass through with their message intact.
 */
export function toAttachmentError(failure: ApiFailure): AttachmentError {
  switch (failure.code) {
    case 'INVALID_REQUEST':
      return {
        code: 'INVALID_FILE',
        message: t('attachments.error.rejected'),
        detail: failure.detail,
      };
    case 'TOO_LARGE':
      return {
        code: 'TOO_LARGE',
        message: t('attachments.error.tooLarge'),
        detail: failure.detail,
      };
    case 'STORAGE_FULL':
      return { code: 'STORAGE_FULL', message: failure.message, detail: failure.detail };
    case 'NOT_FOUND':
      return {
        code: 'NOT_FOUND',
        message: t('attachments.error.notFound'),
        detail: failure.detail,
      };
    case 'CONFLICT':
      return {
        code: 'ALREADY_CLAIMED',
        message: t('attachments.error.claimed'),
        detail: failure.detail,
      };
    case 'GONE':
      return {
        code: 'EXPIRED',
        message: t('attachments.error.expired'),
        detail: failure.detail,
      };
    case 'NETWORK':
      return { code: 'NETWORK', message: failure.message, detail: failure.detail };
    case 'CONFIGURATION':
      return { code: 'CONFIGURATION', message: failure.message, detail: failure.detail };
    // UNAUTHORIZED and CONTRACT are real distinctions to an operator reading
    // logs, but neither is something they can act on from an upload chip.
    default:
      return {
        code: 'UNKNOWN',
        message: t('attachments.error.unknown'),
        detail: failure.detail,
      };
  }
}

/** Map a REST failure to the normalized error. Status is the truth; body text is decoration. */
export function normalizeAttachmentError(
  status: number | undefined,
  rawBody?: string,
): AttachmentError {
  return toAttachmentError(normalizeApiFailure(status, rawBody));
}

/** Pre-flight the same guards the server enforces, so obvious failures never leave the client. */
export function validateFile(file: { size: number; type: string }): AttachmentError | null {
  if (file.size <= 0) {
    return { code: 'INVALID_FILE', message: t('attachments.error.empty') };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { code: 'TOO_LARGE', message: t('attachments.error.tooLarge') };
  }
  // Browsers synthesize '' for unknown extensions — let the server make the
  // final call on those rather than blocking a legitimate file locally.
  if (file.type !== '' && !ALLOWED_MIME.has(file.type)) {
    return { code: 'INVALID_FILE', message: t('attachments.error.unsupported') };
  }
  return null;
}

// Pending-attachment state machine

/**
 * A file staged in the composer. Lifecycle:
 * queued → uploading → ready (id assigned; claimable by send)
 * ↘ error (retryable: re-run upload; remove always available)
 * On send the ready ids go into attachmentIds; the message claims them
 * server-side and the chips leave the composer.
 */
export interface PendingAttachment {
  /** Client-local id (crypto.randomUUID) — NOT the server id. */
  localId: string;
  file: File;
  /** Server-assigned id once ready. */
  remoteId?: string | undefined;
  status: 'queued' | 'uploading' | 'ready' | 'error';
  error?: AttachmentError | undefined;
}

export type PendingMap = Record<string, PendingAttachment>;

export function pendingAdded(list: PendingMap, item: PendingAttachment): PendingMap {
  return { ...list, [item.localId]: item };
}

export function pendingStatus(
  list: PendingMap,
  localId: string,
  status: PendingAttachment['status'],
  fields?: Partial<Pick<PendingAttachment, 'remoteId' | 'error'>>,
): PendingMap {
  const current = list[localId];
  if (!current) return list;
  return { ...list, [localId]: { ...current, status, ...fields } };
}

export function pendingRemoved(list: PendingMap, localId: string): PendingMap {
  const next = { ...list };
  delete next[localId];
  return next;
}

/** The ids a send may claim: ready rows only (uploading/error stay behind). */
export function claimableIds(list: PendingMap): string[] {
  return Object.values(list)
    .filter((p) => p.status === 'ready' && typeof p.remoteId === 'string')
    .map((p) => p.remoteId as string);
}

// Chip/card tone mapping (PO acceptance note, )

/**
 * HeroUI Chip color/variant for each state. The PO mapping:
 * pending upload → accent/soft · uploaded → default/secondary ·
 * download action → accent/primary · error states → danger/warning.
 * The error split is by recoverability: 404/409 are HARD failures (danger);
 * 410/413 are recoverable by re-attaching (warning). 400/NETWORK/UNKNOWN
 * land on danger (retry rarely fixes a rejected file silently).
 */
export function attachmentErrorTone(code: AttachmentErrorCode): {
  color: 'danger' | 'warning';
  variant: 'soft';
} {
  switch (code) {
    case 'EXPIRED': // 410 — re-attach the file
    case 'TOO_LARGE': // 413 — shrink/re-export the file
      return { color: 'warning', variant: 'soft' };
    default: // INVALID_FILE 400, NOT_FOUND 404, ALREADY_CLAIMED 409, NETWORK, UNKNOWN
      return { color: 'danger', variant: 'soft' };
  }
}

/**
 * Send gate: text is allowed empty only when attachments exist? — NO. The
 * shared SendMessageBodySchema requires content.min(1) unconditionally,
 * so the UI enforces the contract as written.
 */
export function canSendWithAttachments(draft: string, _list: PendingMap): boolean {
  return draft.trim().length > 0;
}

/** True when at least one upload is in flight (drives the composer's busy state). */
export function hasInFlight(list: PendingMap): boolean {
  return Object.values(list).some((p) => p.status === 'uploading' || p.status === 'queued');
}
