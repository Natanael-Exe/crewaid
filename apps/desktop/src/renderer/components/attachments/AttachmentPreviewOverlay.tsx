import { lazy, Suspense, useEffect, useState } from 'react';
import { Button, Chip, Modal, Spinner, useOverlayState } from '@heroui/react';
import { IconDownload, IconX } from '@tabler/icons-react';
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
import { IconButtonTooltip } from '../ui';
import { type PlainKey, useT } from '../../i18n/i18n';

/**
 * Loaded LAZY, on first open of a PDF preview: react-pdf's own module top
 * level reaches for `document`, which the desktop suites' static markup
 * render does not have. Nothing here should load PDF.js until an operator is
 * actually looking at a PDF.
 */
const PdfPreview = lazy(() => import('./pdfPreview'));

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

const PREVIEW_KIND_KEY: Record<'image' | 'video' | 'pdf' | 'markdown' | 'text', PlainKey> = {
  image: 'attachments.kind.image',
  video: 'attachments.kind.video',
  pdf: 'attachments.kind.pdf',
  markdown: 'attachments.kind.markdown',
  text: 'attachments.kind.text',
};

/** Label beside the spinner while bytes are in flight. */
function Loading({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 text-sm text-muted">
      <Spinner size="sm" color="current" aria-hidden />
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
  // and the object URL is always created so Save works across all preview kinds
  // (including markdown and text files).
  const [blob, setBlob] = useState<Blob | null>(null);
  const overlay = useOverlayState({
    isOpen: kind !== null,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
  });

  useEffect(() => {
    if (kind === null) return undefined;
    const mounted = { current: true };
    const controller = new AbortController();
    void (async () => {
      try {
        const fetched = await downloadAttachment(client, attachment.id, controller.signal);
        if (!mounted.current) return;
        const objectUrl = URL.createObjectURL(fetched);
        setUrl(objectUrl);
        setBlob(fetched);
        if (kind === 'markdown' || kind === 'text') {
          const full = await fetched.text();
          if (!mounted.current) return;
          // A preview that renders 40 MB of log is a frozen window; say it is
          // cut instead. The download still carries the whole file.
          setText(full.length > MAX_TEXT_CHARS ? full.slice(0, MAX_TEXT_CHARS) : full);
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

  const saveAttachment = () => {
    if (url === null) return;
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = attachment.filename;
    anchor.rel = 'noopener';
    anchor.click();
  };

  return (
    <Modal state={overlay}>
      <Modal.Backdrop variant="blur">
        <Modal.Container size="lg" placement="center" scroll="inside">
          <Modal.Dialog
            aria-label={t('attachments.previewOf', { name: attachment.filename })}
            className="w-fit max-w-[92vw] min-w-[min(420px,92vw)] overflow-hidden p-4"
          >
            <Modal.Header className="flex-row items-center gap-2 pb-3">
              <Modal.Heading className="min-w-0 flex-1 truncate text-callout font-semibold">
                {attachment.filename}
              </Modal.Heading>
              <Chip color="default" variant="soft" size="sm">
                <Chip.Label>{t(PREVIEW_KIND_KEY[kind])}</Chip.Label>
              </Chip>
              <Button
                variant="primary"
                size="sm"
                isDisabled={url === null}
                onPress={saveAttachment}
                className="h-7 gap-1.5 rounded-lg px-2.5 text-caption"
              >
                <IconDownload className="size-3.5" stroke={1.8} aria-hidden />
                {t('attachments.save')}
              </Button>
              <IconButtonTooltip
                label={t('attachments.closePreview')}
                onPress={onClose}
                className="size-7 rounded-lg text-muted"
              >
                <IconX className="size-4" stroke={1.8} />
              </IconButtonTooltip>
            </Modal.Header>

            <Modal.Body className="p-0">
              {failure !== null ? (
                <div className="flex min-h-24 flex-col items-center justify-center gap-2 py-6 text-sm text-muted">
                  <span>
                    {isRetryable(failure.code)
                      ? t('attachments.previewFailed')
                      : t('attachments.gone')}
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
                <div className="max-h-[75vh] w-[min(720px,85vw)] overflow-y-auto rounded-xl border border-separator bg-background p-4 text-sm">
                  {text === null ? (
                    <Loading label={t('attachments.loadingPreview')} />
                  ) : (
                    <StreamingMarkdown source={text} />
                  )}
                </div>
              ) : kind === 'text' ? (
                <div className="max-h-[75vh] w-[min(720px,85vw)] overflow-y-auto rounded-xl border border-separator bg-background p-4">
                  <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground">
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
                  <video
                    controls
                    className="max-h-[75vh] w-[min(860px,85vw)] rounded-xl"
                    src={url}
                  />
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
                  className="max-h-[75vh] max-w-[85vw] rounded-xl object-contain"
                />
              )}
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
