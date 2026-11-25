import { Button } from '@heroui/react';
import { IconDownload, IconExternalLink, IconMessage, IconTrash } from '@tabler/icons-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import type {
  BotWithSandbox,
  DeliverableReviewState,
  DeliverableView,
  GoalWithProgress,
  ProjectWithCounts,
  TaskCard,
  UpdateDeliverableBody,
} from '@crewaid/shared';
import { downloadAttachment, failureOf } from '../api';
import type { ApiClient } from '../api/apiClient';
import { deleteDeliverable, listGoals, listTasks, updateDeliverable } from '../api/work';
import { previewKindOf } from '../components/attachments/AttachmentPreviewOverlay';
import { PdfPreviewLoading } from '../components/attachments/PdfPreviewLoading';
import { saveBlobAs } from '../components/attachments/saveBlob';
import { BotAvatar } from '../components/BotAvatar';
import { ExternalLink, isOpenableLink } from '../components/ExternalLink';
import { formatPreviewInternalPaths } from '../components/markdown/internalPaths';
import { StreamingMarkdown } from '../components/markdown/StreamingMarkdown';
import { documentTitle } from '../components/reader/documentText';
import { DocumentReaderOverlay } from '../components/reader/DocumentReaderOverlay';
import { byteSize, parseCsv, TEXT_PREVIEW_MAX_BYTES } from './deliverablesState';
import { Picker } from './Fields';
import { WorkDetailRail } from './WorkDetailRail';
import { workFailureText } from './workErrors';
import { useT, currentLocale } from '../i18n/i18n';

const PdfPreview = lazy(() => import('../components/attachments/pdfPreview'));

/**
 * One deliverable in the rail: a preview — markdown and text
 * rendered, CSV as a table, images, video and PDFs inline — and the three
 * things to do with it: Download, File under…, and Open in conversation.
 *
 * The bytes come through `ApiClient.download`: fetched with the
 * bearer and never linked, exactly as the transcript's attachment card does.
 */
export function DeliverablePane({
  client,
  deliverable,
  bots,
  projects,
  onClose,
  onOpenConversation,
  onOpenTask,
  onOpenDeliverableById,
}: {
  client: ApiClient;
  deliverable: DeliverableView;
  bots: readonly BotWithSandbox[];
  projects: readonly ProjectWithCounts[];
  onClose: () => void;
  onOpenConversation: (botId: string, messageId: string | null) => void;
  onOpenTask: (taskId: string) => void;
  onOpenDeliverableById?: ((deliverableId: string) => void) | undefined;
}) {
  const t = useT();
  const [item, setItem] = useState(deliverable);
  const [tasks, setTasks] = useState<readonly TaskCard[]>([]);
  const [goals, setGoals] = useState<readonly GoalWithProgress[]>([]);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => setItem(deliverable), [deliverable]);
  useEffect(() => {
    listTasks(client)
      .then(setTasks)
      .catch(() => undefined);
    listGoals(client, { status: 'ACTIVE' })
      .then(setGoals)
      .catch(() => undefined);
  }, [client]);

  const bot = item.botId === null ? undefined : bots.find((row) => row.id === item.botId);
  const publisherName = bot?.name ?? item.publisherName ?? null;
  const reviewState: DeliverableReviewState = item.reviewState ?? 'READY';
  const refile = async (body: UpdateDeliverableBody) => {
    setFailure(null);
    try {
      setItem(await updateDeliverable(client, item.id, body));
    } catch (error) {
      setFailure(workFailureText(failureOf(error)));
    }
  };

  return (
    <WorkDetailRail
      ariaLabel={t('work.deliverablePane.deliverable')}
      title={t('work.deliverablePane.deliverable')}
      closeLabel={t('work.deliverablePane.closePreview')}
      onClose={onClose}
    >
      <div>
        <h2 className="break-words text-body font-semibold leading-5">{item.title}</h2>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-caption tabular-nums text-muted">
          {bot !== undefined ? (
            <span className="flex items-center gap-1" data-deliverable-publisher>
              <BotAvatar bot={bot} size="sm" />
              {bot.name}
            </span>
          ) : publisherName !== null ? (
            <span data-deliverable-publisher>
              {t('work.deliverablePane.publishedBy', { name: publisherName })}
            </span>
          ) : null}
          <span data-deliverable-published-at>{item.createdAt.toLocaleString(currentLocale())}</span>
          {item.attachment === null ? null : <span>{byteSize(item.attachment.sizeBytes)}</span>}
        </p>
        {item.supersededById !== null && item.supersededById !== undefined ? (
          <div
            data-deliverable-superseded={item.supersededById}
            className="mt-2 flex items-center justify-between gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-caption text-foreground"
          >
            <span>{t('work.deliverablePane.supersededNotice')}</span>
            {onOpenDeliverableById === undefined ? null : (
              <Button
                size="sm"
                variant="secondary"
                data-open-latest-deliverable
                onPress={() => onOpenDeliverableById(item.supersededById!)}
                className="h-6 min-h-0 shrink-0 rounded-full px-2.5 text-micro font-medium"
              >
                {t('work.deliverablePane.openLatest')}
              </Button>
            )}
          </div>
        ) : null}
        {item.summary === null ? null : (
          <p className="mt-2 text-footnote text-foreground">{item.summary}</p>
        )}
        {item.sourcePath === null ? null : (
          <p className="mt-1 break-all font-mono text-micro text-muted">
            {formatPreviewInternalPaths(item.sourcePath, t('tools.path'))}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {item.attachment !== null ? (
          <Button
            variant="primary"
            size="sm"
            onPress={() =>
              void downloadAttachment(client, item.attachment!.id)
                .then((blob) => saveBlobAs(blob, item.attachment!.filename))
                .catch((error: unknown) => setFailure(workFailureText(failureOf(error))))
            }
            className="h-8 gap-1 rounded-[10px] text-caption font-medium"
          >
            <IconDownload className="size-3.5" stroke={1.8} />
            {t('work.deliverablePane.download')}
          </Button>
        ) : null}
        {isOpenableLink(item.url) ? (
          <ExternalLink
            href={item.url}
            className="flex h-8 items-center gap-1 rounded-[10px] bg-accent px-3 text-caption font-medium text-accent-foreground"
          >
            <IconExternalLink className="size-3.5" stroke={1.8} />
            {t('work.deliverablePane.openLink')}
          </ExternalLink>
        ) : null}
        {bot !== undefined ? (
          <Button
            variant="secondary"
            size="sm"
            onPress={() => onOpenConversation(bot.id, item.attachment?.messageId ?? item.messageId)}
            className="h-8 gap-1 rounded-[10px] text-caption font-medium"
          >
            <IconMessage className="size-3.5" stroke={1.8} />
            {t('work.deliverablePane.openInConversation')}
          </Button>
        ) : null}
      </div>

      <section className="flex flex-col gap-2">
        <h3 className="text-micro font-medium tracking-[0.02em] text-muted">
          {t('work.deliverablePane.filedUnder')}
        </h3>
        <div className="grid grid-cols-[64px_1fr] items-center gap-x-3 gap-y-2 text-footnote">
          <span className="text-muted">{t('work.deliverablePane.reviewState')}</span>
          <Picker
            appearance="inline"
            label={t('work.deliverablePane.reviewState')}
            value={reviewState}
            noneLabel={t('work.deliverablePane.reviewReady')}
            options={[
              { id: 'READY', label: t('work.deliverablePane.reviewReady') },
              { id: 'REVIEWED', label: t('work.deliverablePane.reviewReviewed') },
              { id: 'ARCHIVED', label: t('work.deliverablePane.reviewArchived') },
            ]}
            onChange={(next) => {
              if (next === 'READY' || next === 'REVIEWED' || next === 'ARCHIVED') {
                void refile({ reviewState: next });
              }
            }}
          />
          <span className="text-muted">{t('work.deliverablePane.task')}</span>
          <Picker
            appearance="inline"
            label={t('work.deliverablePane.task')}
            value={item.taskId}
            noneLabel={t('work.deliverablePane.noTask')}
            options={[
              ...(item.task !== null && !tasks.some((task) => task.id === item.taskId)
                ? [{ id: item.task.id, label: item.task.title }]
                : []),
              ...tasks.map((task) => ({ id: task.id, label: task.title })),
            ]}
            onChange={(taskId) => void refile({ taskId })}
          />
          <span className="text-muted">{t('work.deliverablePane.goal')}</span>
          <Picker
            appearance="inline"
            label={t('work.deliverablePane.goal')}
            value={item.goalId}
            noneLabel={t('work.deliverablePane.noGoal')}
            options={[
              ...(item.goal !== null && !goals.some((goal) => goal.id === item.goalId)
                ? [{ id: item.goal.id, label: item.goal.title }]
                : []),
              ...goals.map((goal) => ({ id: goal.id, label: goal.title })),
            ]}
            onChange={(goalId) => void refile({ goalId })}
          />
          <span className="text-muted">{t('work.deliverablePane.project')}</span>
          <Picker
            appearance="inline"
            label={t('work.deliverablePane.project')}
            value={item.projectId}
            noneLabel={t('work.boardState.noProject')}
            options={projects.map((project) => ({ id: project.id, label: project.name }))}
            onChange={(projectId) => void refile({ projectId })}
          />
        </div>
        {item.taskId === null ? null : (
          <Button
            variant="ghost"
            size="sm"
            onPress={() => onOpenTask(item.taskId!)}
            className="h-7 self-start rounded-lg px-1.5 text-caption text-accent"
          >
            {t('work.deliverablePane.openTheTask')}
          </Button>
        )}
      </section>

      {item.attachment === null ? null : <Preview client={client} attachment={item.attachment} />}

      {failure === null ? null : (
        <p role="alert" className="text-caption text-danger">
          {failure}
        </p>
      )}

      <div className="mt-auto flex flex-col gap-1.5 pt-2">
        <Button
          variant="danger-soft"
          size="sm"
          onPress={() =>
            void deleteDeliverable(client, item.id)
              .then(onClose)
              .catch((error: unknown) => setFailure(workFailureText(failureOf(error))))
          }
          className="h-8 gap-1 self-start rounded-[10px] text-caption"
        >
          <IconTrash className="size-3.5" stroke={1.8} />
          {t('work.deliverablePane.removeFromDeliverables')}
        </Button>
        <p className="text-micro text-muted">{t('work.deliverablePane.theFileStaysInThe')}</p>
      </div>
    </WorkDetailRail>
  );
}

function Preview({
  client,
  attachment,
}: {
  client: ApiClient;
  attachment: NonNullable<DeliverableView['attachment']>;
}) {
  const t = useT();
  const kind = previewKindOf(attachment);
  const csv =
    attachment.mimeType === 'text/csv' || attachment.filename.toLowerCase().endsWith('.csv');
  const tooBig =
    (kind === 'text' || kind === 'markdown') && attachment.sizeBytes > TEXT_PREVIEW_MAX_BYTES;
  const [blob, setBlob] = useState<Blob | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [reading, setReading] = useState(false);

  useEffect(() => {
    if (kind === null || tooBig) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setBlob(null);
    setText(null);
    setUrl(null);
    setFailed(false);
    downloadAttachment(client, attachment.id, controller.signal)
      .then(async (bytes) => {
        if (kind === 'text' || kind === 'markdown') setText(await bytes.text());
        else if (kind === 'pdf') setBlob(bytes);
        else {
          objectUrl = URL.createObjectURL(bytes);
          setUrl(objectUrl);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [client, attachment.id, kind, tooBig]);

  if (kind === null)
    return (
      <p className="text-caption text-muted">{t('work.deliverablePane.noPreviewForThisKind')}</p>
    );
  if (tooBig)
    return (
      <p className="text-caption text-muted">{t('work.deliverablePane.tooLargeToPreviewHere')}</p>
    );
  if (failed)
    return (
      <p className="text-caption text-danger">{t('work.deliverablePane.thePreviewCouldNotBe')}</p>
    );

  const readable = text !== null && (kind === 'markdown' || (kind === 'text' && !csv));
  return (
    <>
      {/* A rail is a narrow place to read a report; the reader gives it the
          whole window at a reading measure. */}
      {readable ? (
        <Button
          variant="secondary"
          size="sm"
          onPress={() => setReading(true)}
          className="h-8 self-start rounded-full px-3.5 text-caption"
        >
          {t('reader.openReader')}
        </Button>
      ) : null}
      {readable && (kind === 'markdown' || kind === 'text') ? (
        <DocumentReaderOverlay
          isOpen={reading}
          onOpenChange={setReading}
          document={{
            title:
              kind === 'markdown' ? documentTitle(text, attachment.filename) : attachment.filename,
            label: t('reader.deliverable'),
            format: kind,
            source: text,
          }}
          onDownload={() =>
            saveBlobAs(new Blob([text], { type: attachment.mimeType }), attachment.filename)
          }
        />
      ) : null}
      <section
        aria-label={t('work.deliverablePane.preview')}
        className="overflow-hidden rounded-[10px] border border-border bg-surface"
      >
        {kind === 'image' && url !== null ? (
          <img src={url} alt={attachment.filename} className="w-full" />
        ) : null}
        {kind === 'video' && url !== null ? <video src={url} controls className="w-full" /> : null}
        {kind === 'pdf' && blob !== null ? (
          <Suspense fallback={<PdfPreviewLoading label={t('work.deliverablePane.openingPdf')} />}>
            <div className="h-[480px]">
              <PdfPreview file={blob} />
            </div>
          </Suspense>
        ) : null}
        {text === null ? null : kind === 'markdown' ? (
          <StreamingMarkdown source={text} className="p-3 text-footnote leading-5" />
        ) : csv ? (
          <CsvTable text={text} />
        ) : (
          <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-micro leading-4">
            {text}
          </pre>
        )}
      </section>
    </>
  );
}

function CsvTable({ text }: { text: string }) {
  const t = useT();
  const { rows, truncated } = parseCsv(text);
  const [head, ...body] = rows;
  return (
    <div className="max-h-[520px] overflow-auto">
      <table className="w-full border-collapse text-caption">
        {head === undefined ? null : (
          <thead className="sticky top-0 bg-background-secondary">
            <tr>
              {head.map((cell, index) => (
                <th key={index} className="border-b border-border px-2 py-1 text-start font-medium">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td key={index} className="border-b border-separator px-2 py-1 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated ? (
        <p className="p-2 text-micro text-muted">
          {t('work.deliverablePane.showingTheFirstRowsDownload')}
        </p>
      ) : null}
    </div>
  );
}
