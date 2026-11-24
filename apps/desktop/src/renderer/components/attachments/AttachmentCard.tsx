import { useEffect, useRef, useState } from 'react';
import { Card } from '@heroui/react';
import { IconDownload, IconEye } from '@tabler/icons-react';
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

/** Inline image preview: fetched on mount, shown small, click for full size. */
function InlineImage({
  attachment,
  onOpenFull,
}: {
  attachment: MessageAttachment;
  onOpenFull: () => void;
}) {
  const t = useT();
  const client = useApiClient();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const mounted = { current: true };
    const controller = new AbortController();
    void (async () => {
      try {
        const blob = await downloadAttachment(client, attachment.id, controller.signal);
        if (mounted.current) setUrl(URL.createObjectURL(blob));
      } catch {
        if (mounted.current) setFailed(true);
      }
    })();
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [client, attachment.id]);

  // The blob URL must not outlive the element that shows it.
  useEffect(() => {
    return () => {
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [url]);

  if (failed || url === null) return null;
  return (
    <button
      type="button"
      onClick={onOpenFull}
      aria-label={t('attachments.showFullSize', { name: attachment.filename })}
      className="cursor-zoom-in self-start overflow-hidden rounded-card border border-border"
    >
      <img
        alt={attachment.filename}
        src={url}
        // Bounded, not intrinsic: a full 1280px machine capture renders at
        // its own size otherwise, and a conversation of screenshots stops
        // being a conversation.
        className="max-h-64 max-w-full object-contain"
      />
    </button>
  );
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

  // Prose reads as a page; CSV, JSON and logs are data, and keep the file card.
  const prose =
    kind === 'markdown' || (kind === 'text' && attachment.mimeType.startsWith('text/plain'));
  if (prose && attachment.sizeBytes <= DOCUMENT_PREVIEW_MAX_BYTES) {
    return (
      <div className="flex max-w-full flex-col gap-1" data-attachment-card={attachment.id}>
        <DocumentAttachment
          attachment={attachment}
          kind={kind === 'markdown' ? 'markdown' : 'text'}
          meta={`${identity.label} · ${formatFileSize(attachment.sizeBytes)}`}
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
            aria-label={t('attachments.downloadNamed', { name: attachment.filename })}
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

  return (
    <div
      className="max-w-full"
      data-attachment-card={attachment.id}
      data-audio-attachment={attachment.mimeType.startsWith('audio/') || undefined}
    >
      <Card
        variant="default"
        className="crewaid-tool-card crewaid-artifact-card"
        aria-label={t('attachments.label', { name: attachment.filename })}
      >
        {kind === 'image' ? (
          <InlineImage attachment={attachment} onOpenFull={() => setPreviewing(true)} />
        ) : null}
        <Card.Header className="flex-row items-start gap-3">
          <span className={mark === undefined ? 'crewaid-tool-icon' : 'crewaid-tool-mark'}>
            {mark === undefined ? (
              <identity.Icon aria-hidden className="size-5" stroke={1.6} />
            ) : (
              <img src={mark} alt="" aria-hidden className="size-8 object-contain" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <Card.Description className="mb-1 text-micro">
              {identity.label} · {formatFileSize(attachment.sizeBytes)}
            </Card.Description>
            <Card.Title className="break-words text-footnote font-medium">
              {attachment.filename}
            </Card.Title>
          </div>
        </Card.Header>
        {failure === null ? null : (
          <Card.Content>
            <p role="alert" className="text-caption text-danger">
              {failure.message}
            </p>
          </Card.Content>
        )}
        <Card.Footer className="flex-row flex-wrap gap-2 border-t border-border/70 pt-2">
          {/* An image's inline thumbnail IS its preview; a second chip for it
              would be a click between the operator and the screenshot. */}
          {kind === null || kind === 'image' ? null : (
            <button
              type="button"
              className="crewaid-artifact-action"
              aria-label={t('attachments.previewNamed', { name: attachment.filename })}
              onClick={() => setPreviewing(true)}
            >
              <IconEye aria-hidden className="size-3.5" />
              {t('attachments.preview')}
            </button>
          )}
          {permanent ? (
            <span className="text-caption text-warning">{t('attachments.unavailable')}</span>
          ) : (
            <button
              type="button"
              className="crewaid-artifact-action"
              aria-disabled={busy}
              aria-busy={busy}
              aria-label={
                failure
                  ? t('attachments.retryDownloadNamed', { name: attachment.filename })
                  : t('attachments.downloadNamed', { name: attachment.filename })
              }
              onClick={() => void handleDownload()}
            >
              <IconDownload aria-hidden className="size-3.5" />
              {busy
                ? t('attachments.downloading')
                : failure
                  ? t('attachments.retryDownload')
                  : t('attachments.download')}
            </button>
          )}
        </Card.Footer>
      </Card>

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
