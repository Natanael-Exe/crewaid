import {
  API_ROUTES,
  AttachmentUploadResponseSchema,
  type AttachmentUploadResponse,
} from '@crewaid/shared';
import type { ApiClient } from './apiClient';

/**
 * REST / D-019 attachment routes.
 *
 * The upload response is the attachment row minus `messageId` — an unclaimed
 * upload has no message yet, and the controller omits the field rather than
 * sending null. Deriving it from `AttachmentSchema` keeps it contractual: a
 * column added in §3 cannot silently bypass the client's validation, which a
 * hand-written interface here previously allowed.
 */
export type UploadResult = AttachmentUploadResponse;

/** POST /attachments — multipart. The field name MUST be `file` (FileInterceptor('file')). */
export function uploadAttachment(
  client: ApiClient,
  file: File,
  signal?: AbortSignal,
): Promise<UploadResult> {
  const form = new FormData();
  form.append('file', file, file.name);
  return client.request(API_ROUTES.attachmentUpload, {
    body: form,
    schema: AttachmentUploadResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

/**
 * DELETE /attachments/:id — unclaimed rows only.
 * 204 ok · 404 unknown/foreign · 409 claimed · 410 past the 24h TTL.
 */
export function deleteAttachment(client: ApiClient, id: string): Promise<void> {
  return client.request(API_ROUTES.attachmentRemove, { params: { id } });
}

/**
 * GET /attachments/:id/download — the file's bytes, fetched with the bearer.
 *
 * There is deliberately no URL-returning variant. Handing this route to an
 * `<a download>` cannot work: the anchor's request is performed by Electron's
 * download manager rather than `fetch`, so it carries no Authorization header
 * and AuthGuard answers 401. Anything that needs these bytes — a save to disk,
 * an inline preview — fetches them here and works from the Blob.
 *
 * What this route actually answers, which is not what the fence list suggests:
 *
 * - 404 — unknown or foreign id (non-leaking by design, D-010).
 * - 500 — the row exists but its file does not. `resolveForDownload` stats
 * the path and lets ENOENT through deliberately, so a vanished artifact is
 * loud in the log; it reaches the client as UNKNOWN, not NOT_FOUND. This
 * is the failure a transcript is most likely to hit.
 * - 410 — NOT reachable here. The expiry fence applies only while
 * `messageId === null`, and every attachment on a message is claimed by
 * definition. Unclaimed rows expire on the upload tray's routes instead.
 *
 * All of them arrive as a normalized `ApiFailure`, so the card states the
 * outcome without reading a server string.
 */
export function downloadAttachment(
  client: ApiClient,
  id: string,
  signal?: AbortSignal,
): Promise<Blob> {
  return client.download(API_ROUTES.attachmentDownload, {
    params: { id },
    ...(signal === undefined ? {} : { signal }),
  });
}
