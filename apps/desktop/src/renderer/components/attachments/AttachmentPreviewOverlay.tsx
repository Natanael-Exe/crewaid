import { lazy, Suspense, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Chip, Surface } from '@heroui/react';
import {
  downloadAttachment,
  failureOf,
  isAbortError,
  isRetryable,
  useApiClient,
  type ApiFailure,
} from '../../api';
import { StreamingMarkdown } from '../markdown/StreamingMarkdown';
import type { MessageAttachment } from './AttachmentCard';
import { PdfPreviewLoading } from './PdfPreviewLoading';
import { useT } from '../../i18n/i18n';

/**
 * Loaded LAZY, on first open of a PDF preview: react-pdf's own module top
 * level reaches for `document`, which the desktop suites' static markup
 * render does not have. Nothing here should load PDF.js until an operator is
 * actually looking at a PDF.
 */
const PdfPreview = lazy(() => import('./pdfPreview'));

/**
 * The inline preview of an attachment — the part that makes a file legible
 * WITHOUT a trip to the downloads folder.
 *
 * The download card tells the operator what a file IS; this is what it SAYS.
 * An image renders as an image, a recording as a video with controls, a
 * markdown note as formatted text — all from bytes fetched with the bearer
 * token into a Blob (the same channel `downloadAttachment` uses for saving;
 * an `<iframe src>` to the route directly would drop the Authorization header
 * and answer 401, which is exactly why no URL variant exists, see
 * `api/attachments.ts`).
 *
 * A PDF renders through PDF.js (`pdfPreview.tsx`): Electron ships no PDF
 * viewer plugin, so the bytes the overlay already fetched are drawn to a
 * canvas page by page instead of handed to an embed that would stay blank.
 *
 * What opens where
 *
 * Images preview INLINE on the card itself (a screenshot's whole point is
 * being seen in the conversation), and everything else opens this OVERLAY —
 * a fixed layer, not an expanded card row. A transcript is one long flow of
 * short rows: growing a row to 80vh to fit a video would scroll every other
 * message out of place and make the reading position a casualty of the
 * preview. The overlay keeps the transcript exactly as it was underneath.
 *
 * The overlay is PORTALLED to `document.body`. It mounts inside the
 * transcript's ScrollShadow, which wears a `mask-image` while the list can
 * scroll in both directions. A mask is a paint-time effect on the WHOLE
 * subtree: the fixed backdrop and panel were clipped to the scroll box, and
 * the stacking context the mask creates kept their `z-50` below the sidebar's
 * own paint — so opening a preview blacked out the transcript column instead
 * of laying a layer over the window. Body has nothing of the kind between it
 * and the viewport, so the layer is window-sized wherever the card that
 * opened it lives.
 */

/** Which renderer a preview uses, from the wire mime type. */
export function previewKindOf(attachment: {
  mimeType: string;
  filename: string;
}): 'image' | 'video' | 'pdf' | 'markdown' | 'text' | null {
  const mime = attachment.mimeType;
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'video/mp4' || mime === 'video/webm') return 'video';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'text/markdown') return 'markdown';
  if (mime.startsWith('text/') || mime === 'application/json') return 'text';
  return null;
}

/** How much of a text file the overlay will render before it says it cut. */
const MAX_TEXT_CHARS = 200_000;

/** Label under the spinner while bytes are in flight. */
function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 text-sm text-white/70">
      <span
        aria-hidden
        className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white/80"
      />
      {label}…
    </div>
  );
}

export function AttachmentPreviewOverlay({
  attachment,
  onClose,
}: {
  attachment: MessageAttachment;
  onClose: () => void;
}) {
  const t = useT();
  const client = useApiClient();
  const kind = previewKindOf(attachment);
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  // Kept for the PDF branch, which draws from BYTES rather than from a URL —
  // the object URL is for the media kinds; PDF.js wants the blob itself.
  const [blob, setBlob] = useState<Blob | null>(null);

  // Escape is the close an operator reaches for without looking; the backdrop
  // click below is the mouse-shaped twin. Nothing else closes the overlay, so
  // a stray click on the CONTENT (pausing a video, selecting text) does not
  // throw the preview away.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const mounted = { current: true };
    const controller = new AbortController();
    void (async () => {
      try {
        const blob = await downloadAttachment(client, attachment.id, controller.signal);
        if (!mounted.current) return;
        if (kind === 'markdown' || kind === 'text') {
          const full = await blob.text();
          if (!mounted.current) return;
          // A preview that renders 40 MB of log is a frozen window; say it is
          // cut instead. The download still carries the whole file.
          setText(full.length > MAX_TEXT_CHARS ? full.slice(0, MAX_TEXT_CHARS) : full);
        } else {
          setUrl(URL.createObjectURL(blob));
          setBlob(blob);
        }
      } catch (caught: unknown) {
        if (!mounted.current || isAbortError(caught)) return;
        setFailure(failureOf(caught));
      }
    })();
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [client, attachment.id, kind]);

  // The blob URL outlives the fetch that made it and must not outlive the
  // overlay: revoked here, on unmount, where the overlay's lifetime is the
  // URL's.
  useEffect(() => {
    return () => {
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [url]);

  if (kind === null) return null;

  const overlay = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('attachments.previewOf', { name: attachment.filename })}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <Surface
        variant="secondary"
        className="flex max-h-full w-fit max-w-full min-w-80 flex-col gap-2 overflow-hidden rounded-card p-3"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
            {attachment.filename}
          </span>
          <Chip
            color="default"
            variant="soft"
            size="sm"
            className="h-7 rounded-md text-[11px] text-foreground-faint"
          >
            {previewBadge(kind)}
          </Chip>
          <Chip
            color="accent"
            variant="primary"
            size="sm"
            className="justify-center h-7 items-center px-2 cursor-pointer"
            render={(chipProps) => {
              const { ref: _ref, ...rest } = chipProps;
              return (
                <button
                  {...rest}
                  style={{ alignSelf: 'center' }}
                  type="button"
                  onClick={() => {
                    // The bytes are already here — saving reuses the same blob
                    // rather than a second download, so "I previewed it and
                    // want it anyway" costs nothing.
                    if (url !== null) {
                      const anchor = document.createElement('a');
                      anchor.href = url;
                      anchor.download = attachment.filename;
                      anchor.rel = 'noopener';
                      anchor.click();
                    }
                  }}
                  aria-disabled={url === null}
                >
                  {t('attachments.save')}
                </button>
              );
            }}
          >
            {t('attachments.save')}
          </Chip>
          <Chip
            color="warning"
            variant="soft"
            size="sm"
            className="h-7 cursor-pointer rounded-md px-2 text-[12px]"
            render={(chipProps) => {
              const { ref: _ref, ...rest } = chipProps;
              return (
                <button
                  {...rest}
                  type="button"
                  onClick={onClose}
                  aria-label={t('attachments.closePreview')}
                >
                  ✕
                </button>
              );
            }}
          >
            ✕
          </Chip>
        </div>
        {failure !== null ? (
          <div className="flex min-h-24 flex-col items-center justify-center gap-2 py-6 text-sm text-foreground-faint">
            <span>
              {isRetryable(failure.code) ? t('attachments.previewFailed') : t('attachments.gone')}
            </span>
            <span className="text-xs">{failure.message}</span>
          </div>
        ) : kind === 'pdf' ? (
          blob === null ? (
            <PdfPreviewLoading label={t('attachments.openingPdf')} />
          ) : (
            <Suspense fallback={<PdfPreviewLoading label={t('attachments.openingPdf')} />}>
              <PdfPreview file={blob} />
            </Suspense>
          )
        ) : kind === 'markdown' ? (
          <div className="max-h-[75vh] w-[min(720px,85vw)] overflow-y-auto rounded-lg bg-background p-4 text-sm">
            {text === null ? (
              <Loading label={t('attachments.loadingPreview')} />
            ) : (
              <StreamingMarkdown source={text} />
            )}
          </div>
        ) : kind === 'text' ? (
          <div className="max-h-[75vh] w-[min(720px,85vw)] overflow-y-auto rounded-lg bg-background p-4">
            <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">
              {text === null ? t('attachments.loading') : text}
              {text !== null && text.length >= MAX_TEXT_CHARS
                ? `\n\n${t('attachments.truncated')}`
                : null}
            </pre>
          </div>
        ) : kind === 'video' ? (
          url === null ? (
            <div className="flex h-64 items-center justify-center">
              <Loading label={t('attachments.loadingPreview')} />
            </div>
          ) : (
            <video controls className="max-h-[75vh] w-[min(860px,85vw)] rounded-lg" src={url} />
          )
        ) : url === null ? (
          <div className="flex h-64 items-center justify-center">
            <Loading label={t('attachments.loadingPreview')} />
          </div>
        ) : (
          // The image kind: full-bleed inside the overlay, contained by the
          // viewport so even a 1280px machine capture fits without scrolling.
          <img
            alt={attachment.filename}
            src={url}
            className="max-h-[75vh] max-w-[85vw] rounded-lg object-contain"
          />
        )}
      </Surface>
    </div>
  );

  // See the file header for why this cannot stay in the transcript's tree.
  // The static-markup suites render with no DOM at all, where the portal has
  // nowhere to go and the layer renders in place.
  if (typeof document === 'undefined') return overlay;
  return createPortal(overlay, document.body);
}

function previewBadge(kind: 'image' | 'video' | 'pdf' | 'markdown' | 'text'): string {
  switch (kind) {
    case 'image':
      return 'IMAGE';
    case 'video':
      return 'VIDEO';
    case 'pdf':
      return 'PDF';
    case 'markdown':
      return 'MARKDOWN';
    case 'text':
      return 'TEXT';
  }
}
