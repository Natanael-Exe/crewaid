import { Button } from '@heroui/react';
import { IconDownload, IconExternalLink, IconMessage, IconTrash, IconX } from '@tabler/icons-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import type {
  BotWithSandbox,
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
import { StreamingMarkdown } from '../components/markdown/StreamingMarkdown';
import { byteSize, parseCsv, TEXT_PREVIEW_MAX_BYTES } from './deliverablesState';
import { Picker } from './Fields';
import { workFailureText } from './workErrors';
import { useT, currentLocale } from '../i18n/i18n';

const PdfPreview = lazy(() => import('../components/attachments/pdfPreview'));

/**
 * One deliverable in the rail: a preview — markdown and text
 * rendered, CSV as a table, images, video and PDFs inline — and the three
 * things to do with it: Download, File under…, and Open in conversation.
 *
 * The bytes come through `ApiClient.download()`: fetched with the
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
}: {
  client: ApiClient;
  deliverable: DeliverableView;
  bots: readonly BotWithSandbox[];
  projects: readonly ProjectWithCounts[];
  onClose: () => void;
  onOpenConversation: (botId: string, messageId: string | null) => void;
  onOpenTask: (taskId: string) => void;
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
  const refile = async (body: UpdateDeliverableBody) => {
    setFailure(null);
    try {
      setItem(await updateDeliverable(client, item.id, body));
    } catch (error) {
      setFailure(workFailureText(failureOf(error)));
    }
  };

  return (
    <aside
      aria-label={t('work.deliverablePane.deliverable')}
      className="crewaid-work-detail flex h-full min-h-0 flex-col"
    >
      <header className="window-drag flex h-12 shrink-0 items-center justify-between px-4">
        <span className="text-[12px] font-medium text-muted">
          {t('work.deliverablePane.deliverable')}
        </span>
        <Button
          variant="ghost"
          isIconOnly
          size="sm"
          aria-label={t('work.deliverablePane.closePreview')}
          onPress={onClose}
          className="window-no-drag size-7 rounded-lg text-muted"
        >
          <IconX className="size-4" stroke={1.8} />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
        <div>
          <h2 className="break-words text-[15px] font-semibold leading-5">{item.title}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
            {bot === undefined ? null : (
              <span className="flex items-center gap-1">
                <BotAvatar bot={bot} size="sm" />
                {bot.name}
              </span>
            )}
            <span>{item.createdAt.toLocaleString(currentLocale())}</span>
            {item.attachment === null ? null : <span>{byteSize(item.attachment.sizeBytes)}</span>}
          </p>
          {item.summary === null ? null : (
            <p className="mt-2 text-[13px] text-foreground">{item.summary}</p>
          )}
          {item.sourcePath === null ? null : (
            <p className="mt-1 break-all font-mono text-[11px] text-muted">{item.sourcePath}</p>
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
              className="h-8 gap-1 rounded-[10px] text-[12px] font-medium"
            >
              <IconDownload className="size-3.5" stroke={1.8} />
              {t('work.deliverablePane.download')}
            </Button>
          ) : null}
          {isOpenableLink(item.url) ? (
            <ExternalLink
              href={item.url}
              className="flex h-8 items-center gap-1 rounded-[10px] bg-accent px-3 text-[12px] font-medium text-accent-foreground"
            >
              <IconExternalLink className="size-3.5" stroke={1.8} />
              {t('work.deliverablePane.openLink')}
            </ExternalLink>
          ) : null}
          {bot !== undefined ? (
            <Button
              variant="secondary"
              size="sm"
              onPress={() =>
                onOpenConversation(bot.id, item.attachment?.messageId ?? item.messageId)
              }
              className="h-8 gap-1 rounded-[10px] text-[12px] font-medium"
            >
              <IconMessage className="size-3.5" stroke={1.8} />
              {t('work.deliverablePane.openInConversation')}
            </Button>
          ) : null}
        </div>

        <section className="flex flex-col gap-2">
          <h3 className="text-[11px] font-medium tracking-[0.02em] text-muted">
            {t('work.deliverablePane.filedUnder')}
          </h3>
          <div className="grid grid-cols-[64px_1fr] items-center gap-x-3 gap-y-2 text-[13px]">
            <span className="text-muted">{t('work.deliverablePane.task')}</span>
            <Picker
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
              label={t('work.deliverablePane.project')}
              value={item.projectId}
              noneLabel={t('work.boardState.noProject')}
              options={projects.map((project) => ({ id: project.id, label: project.name }))}
              onChange={(projectId) => void refile({ projectId })}
            />
          </div>
          {item.taskId === null ? null : (
            <button
              type="button"
              onClick={() => onOpenTask(item.taskId!)}
              className="self-start text-[12px]! text-accent hover:underline"
            >
              {t('work.deliverablePane.openTheTask')}
            </button>
          )}
        </section>

        {item.attachment === null ? null : <Preview client={client} attachment={item.attachment} />}

        {failure === null ? null : (
          <p role="alert" className="text-[12px] text-danger">
            {failure}
          </p>
        )}

        <Button
          variant="ghost"
          size="sm"
          onPress={() =>
            void deleteDeliverable(client, item.id)
              .then(onClose)
              .catch((error: unknown) => setFailure(workFailureText(failureOf(error))))
          }
          className="mt-auto h-8 gap-1 self-start rounded-[10px] text-[12px] text-danger"
        >
          <IconTrash className="size-3.5" stroke={1.8} />
          {t('work.deliverablePane.removeFromDeliverables')}
        </Button>
        <p className="-mt-3 text-[11px] text-muted">
          {t('work.deliverablePane.theFileStaysInThe')}
        </p>
      </div>
    </aside>
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
      <p className="text-[12px] text-muted">{t('work.deliverablePane.noPreviewForThisKind')}</p>
    );
  if (tooBig)
    return (
      <p className="text-[12px] text-muted">{t('work.deliverablePane.tooLargeToPreviewHere')}</p>
    );
  if (failed)
    return (
      <p className="text-[12px] text-danger">{t('work.deliverablePane.thePreviewCouldNotBe')}</p>
    );

  return (
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
        <StreamingMarkdown source={text} className="p-3 text-[13px] leading-5" />
      ) : csv ? (
        <CsvTable text={text} />
      ) : (
        <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-4">
          {text}
        </pre>
      )}
    </section>
  );
}

function CsvTable({ text }: { text: string }) {
  const t = useT();
  const { rows, truncated } = parseCsv(text);
  const [head, ...body] = rows;
  return (
    <div className="max-h-[520px] overflow-auto">
      <table className="w-full border-collapse text-[12px]">
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
        <p className="p-2 text-[11px] text-muted">
          {t('work.deliverablePane.showingTheFirstRowsDownload')}
        </p>
      ) : null}
    </div>
  );
}
