import { useEffect, useRef, useState } from 'react';
import { Spinner } from '@heroui/react';
import { IconDownload } from '@tabler/icons-react';
import { fileMark } from './artifactMarks';
import { artifactIdentity } from './artifactIdentity';
import {
  downloadAttachment,
  failureOf,
  isAbortError,
  isRetryable,
  useApiClient,
  type ApiFailure,
} from '../../api';
import { saveBlobAs } from './saveBlob';
import { AttachmentPreviewOverlay, previewKindOf } from './AttachmentPreviewOverlay';
import { useT } from '../../i18n/i18n';
import { formatFileSize } from '../../i18n/fileSize';
import { DocumentPreviewCard } from '../reader/DocumentPreviewCard';
import { documentTitle } from '../reader/documentText';
import { IconButtonTooltip } from '../ui';

/**
 * Text documents up to this size show their opening as a preview card; a
 * bigger one is fetched only when someone opens it.
 */
const DOCUMENT_PREVIEW_MAX_BYTES = 512 * 1024;

/** Type-aware attachment identity over the existing authenticated preview/download lifecycle. */

export interface MessageAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** A voice note plays inline instead of showing as a file. */
  kind?: 'FILE' | 'VOICE_NOTE';
  durationMs?: number | null;
}

/**
 * Fetches an image attachment's blob URL on mount and revokes it on unmount so
 * the image can render full-bleed without a heavy card wrapper around it.
 */
function useAttachmentImageUrl(attachmentId: string, enabled: boolean): string | null {
  const client = useApiClient();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setUrl(null);
      return undefined;
    }
    const mounted = { current: true };
    const controller = new AbortController();
    void (async () => {
      try {
        const blob = await downloadAttachment(client, attachmentId, controller.signal);
        if (mounted.current) setUrl(URL.createObjectURL(blob));
      } catch {
        // Fallback file pill remains interactive when inline image fetch fails.
      }
    })();
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [client, attachmentId, enabled]);

  // The blob URL must not outlive the element that shows it.
  useEffect(() => {
    return () => {
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [url]);

  return url;
}

/** A Markdown or text attachment as a page with its title and opening lines. */
function DocumentAttachment({
  attachment,
  kind,
  meta,
  onOpen,
}: {
  attachment: MessageAttachment;
  kind: 'markdown' | 'text';
  meta: string;
  onOpen: () => void;
}) {
  const client = useApiClient();
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    const mounted = { current: true };
    const controller = new AbortController();
    void (async () => {
      try {
        const blob = await downloadAttachment(client, attachment.id, controller.signal);
        const text = await blob.slice(0, 16 * 1024).text();
        if (mounted.current) setSource(text);
      } catch {
        // The card still opens the reader, which reports the failure itself.
      }
    })();
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [client, attachment.id]);

  return (
    <DocumentPreviewCard
      title={
        kind === 'markdown' && source !== null
          ? documentTitle(source, attachment.filename)
          : attachment.filename
      }
      format={kind}
      source={source}
      meta={meta}
      onOpen={onOpen}
    />
  );
}

export function AttachmentCard({ attachment }: { attachment: MessageAttachment }) {
  const t = useT();
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  const kind = previewKindOf(attachment);
  const identity = artifactIdentity(attachment);
  const mark = fileMark(attachment);
  const imageUrl = useAttachmentImageUrl(attachment.id, kind === 'image');

  // A transcript re-renders under the operator — a reconnect resync, a page of
  // older history, switching bots. Without this the fetch keeps buffering a
  // whole file into the heap for a card nobody can see, then saves it.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      inFlight.current?.abort();
    };
  }, []);

  async function handleDownload(): Promise<void> {
    // The button stays focusable while busy, so it can still be activated;
    // the in-flight ref is what makes that safe even before React re-renders.
    if (inFlight.current !== null) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setBusy(true);
    setFailure(null);
    try {
      const blob = await downloadAttachment(client, attachment.id, controller.signal);
      // Abort is cooperative. A cached/small response can settle just before
      // cleanup calls abort, so gate the side effect as well as state writes.
      if (!mounted.current) return;
      saveBlobAs(blob, attachment.filename);
    } catch (caught: unknown) {
      // An abort is this card unmounting, not something to report — and a
      // component that is gone must not be told about it either way.
      if (!mounted.current || isAbortError(caught)) return;
      setFailure(failureOf(caught));
    } finally {
      if (mounted.current) setBusy(false);
      if (inFlight.current === controller) inFlight.current = null;
    }
  }

  const permanent = failure !== null && !isRetryable(failure.code);
  const sizeLabel = formatFileSize(attachment.sizeBytes);
  const downloadLabel = failure
    ? t('attachments.retryDownloadNamed', { name: attachment.filename })
    : t('attachments.downloadNamed', { name: attachment.filename });
  const downloadTooltip = busy
    ? t('attachments.downloading')
    : failure
      ? t('attachments.retryDownload')
      : t('attachments.download');

  // Prose reads as a page; CSV, JSON and logs are data, and keep the compact file card.
  const prose =
    kind === 'markdown' || (kind === 'text' && attachment.mimeType.startsWith('text/plain'));
  if (prose && attachment.sizeBytes <= DOCUMENT_PREVIEW_MAX_BYTES) {
    return (
      <div className="flex max-w-full flex-col gap-1" data-attachment-card={attachment.id}>
        <DocumentAttachment
          attachment={attachment}
          kind={kind === 'markdown' ? 'markdown' : 'text'}
          meta={`${identity.label} · ${sizeLabel}`}
          onOpen={() => setPreviewing(true)}
        />
        {failure === null ? null : (
          <p role="alert" className="px-1 text-caption text-danger">
            {failure.message}
          </p>
        )}
        {permanent ? null : (
          <button
            type="button"
            className="crewaid-artifact-action self-start"
            aria-disabled={busy}
            aria-busy={busy}
            aria-label={downloadLabel}
            onClick={() => void handleDownload()}
          >
            <IconDownload aria-hidden className="size-3.5" />
            {busy ? t('attachments.downloading') : t('attachments.download')}
          </button>
        )}
        {previewing ? (
          <AttachmentPreviewOverlay attachment={attachment} onClose={() => setPreviewing(false)} />
        ) : null}
      </div>
    );
  }

  // Loaded images render edge-to-edge as clean media rather than inside a
  // padded file card with a duplicate image icon and divider footer.
  if (kind === 'image' && imageUrl !== null) {
    return (
      <div
        className="flex w-fit max-w-full flex-col gap-1"
        data-attachment-card={attachment.id}
        data-image-attachment
      >
        <div
          className="crewaid-image-attachment group/media relative inline-flex w-fit max-w-[min(100%,340px)] overflow-hidden rounded-[20px]"
          aria-label={t('attachments.label', { name: attachment.filename })}
        >
          <button
            type="button"
            onClick={() => setPreviewing(true)}
            aria-label={t('attachments.showFullSize', { name: attachment.filename })}
            className="relative block cursor-zoom-in overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-focus/60"
          >
            <img
              alt={attachment.filename}
              src={imageUrl}
              // Bounded, not intrinsic: a full desktop screenshot keeps the
              // conversation scannable while clicking opens the full lightbox.
              className="block max-h-[280px] max-w-full object-contain"
            />
            <span
              aria-hidden
              className="crewaid-image-attachment-ring pointer-events-none absolute inset-0 rounded-[20px]"
            />
          </button>

          {permanent ? null : (
            <div
              className={`absolute top-2.5 end-2.5 z-10 transition-opacity duration-150 ${
                busy || failure !== null
                  ? 'opacity-100'
                  : 'opacity-0 group-hover/media:opacity-100 group-focus-within/media:opacity-100'
              }`}
            >
              <IconButtonTooltip
                label={downloadLabel}
                tooltip={downloadTooltip}
                placement="top"
                aria-disabled={busy}
                aria-busy={busy}
                onPress={() => void handleDownload()}
                className="crewaid-media-overlay-btn size-8 min-w-8 rounded-full p-0"
              >
                {busy ? (
                  <Spinner size="sm" color="current" aria-hidden className="size-3.5" />
                ) : (
                  <IconDownload aria-hidden className="size-4" stroke={1.8} />
                )}
              </IconButtonTooltip>
            </div>
          )}

          <div
            aria-hidden
            className="crewaid-image-attachment-caption pointer-events-none absolute inset-x-0 bottom-0 flex items-baseline justify-between gap-2 px-3.5 pt-7 pb-2.5 text-white opacity-0 transition-opacity duration-150 group-hover/media:opacity-100 group-focus-within/media:opacity-100"
          >
            <span className="min-w-0 truncate text-caption font-medium">{attachment.filename}</span>
            <span className="shrink-0 text-micro tabular-nums text-white/80">{sizeLabel}</span>
          </div>
        </div>

        {failure === null ? null : (
          <p role="alert" className="px-1 text-caption text-danger">
            {failure.message}
          </p>
        )}

        {previewing ? (
          <AttachmentPreviewOverlay attachment={attachment} onClose={() => setPreviewing(false)} />
        ) : null}
      </div>
    );
  }

  // Non-image files (and images while loading or offline) use one compact row:
  // primary identity first, clicking opens preview when supported, trailing
  // icon button handles download without a divider or second footer bar.
  const canPreview = kind !== null && kind !== 'image';
  const fileIdentity = (
    <>
      <span className={mark === undefined ? 'crewaid-file-icon' : 'crewaid-file-mark'}>
        {mark === undefined ? (
          <identity.Icon aria-hidden className="size-5" stroke={1.6} />
        ) : (
          <img src={mark} alt="" aria-hidden className="size-7 object-contain" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-footnote font-medium leading-[18px] text-foreground">
          {attachment.filename}
        </span>
        <span className="truncate text-micro leading-4 tabular-nums text-muted">
          {identity.label} · {sizeLabel}
        </span>
      </span>
    </>
  );

  return (
    <div
      className="flex max-w-full flex-col gap-1"
      data-attachment-card={attachment.id}
      data-audio-attachment={attachment.mimeType.startsWith('audio/') || undefined}
    >
      <div
        className="crewaid-file-attachment flex w-[min(100%,340px)] items-center gap-2 rounded-[18px] px-3 py-2.5"
        aria-label={t('attachments.label', { name: attachment.filename })}
      >
        {canPreview ? (
          <button
            type="button"
            onClick={() => setPreviewing(true)}
            aria-label={t('attachments.previewNamed', { name: attachment.filename })}
            className="crewaid-file-preview-trigger flex min-w-0 flex-1 cursor-[var(--cursor-interactive,pointer)] items-center gap-2.5 rounded-xl p-0.5 text-start outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus/60"
          >
            {fileIdentity}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2.5 p-0.5">{fileIdentity}</div>
        )}

        <div className="flex shrink-0 items-center">
          {permanent ? (
            <span className="px-1.5 text-micro text-warning">{t('attachments.unavailable')}</span>
          ) : (
            <IconButtonTooltip
              label={downloadLabel}
              tooltip={downloadTooltip}
              placement="top"
              aria-disabled={busy}
              aria-busy={busy}
              onPress={() => void handleDownload()}
              className="size-8 min-w-8 rounded-full p-0 text-muted hover:text-foreground"
            >
              {busy ? (
                <Spinner size="sm" color="current" aria-hidden className="size-3.5" />
              ) : (
                <IconDownload aria-hidden className="size-4" stroke={1.8} />
              )}
            </IconButtonTooltip>
          )}
        </div>
      </div>

      {failure === null ? null : (
        <p role="alert" className="px-1 text-caption text-danger">
          {failure.message}
        </p>
      )}

      {previewing ? (
        <AttachmentPreviewOverlay attachment={attachment} onClose={() => setPreviewing(false)} />
      ) : null}
    </div>
  );
}

export function AttachmentCardRow({
  attachments,
  filedTask,
  onOpenTask,
}: {
  attachments: MessageAttachment[];
  /** The task an attachment's deliverable is filed under, if any. */
  filedTask?: ((attachmentId: string) => { taskId: string; title: string } | undefined) | undefined;
  onOpenTask?: ((taskId: string) => void) | undefined;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {attachments.map((a) => {
        const task = filedTask?.(a.id);
        return (
          <div key={a.id} className="flex flex-col gap-0.5">
            <AttachmentCard attachment={a} />
            {task === undefined || onOpenTask === undefined ? null : (
              <button
                type="button"
                onClick={() => onOpenTask(task.taskId)}
                className="self-start px-1 text-micro text-muted hover:text-foreground"
              >
                → {task.title}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
