import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconArrowUpRight } from '@tabler/icons-react';
import { Button, Disclosure } from '@heroui/react';
import { ChatToolGroup } from '../ui';
import { toolMark, fileMark } from '../attachments/artifactMarks';
import { systemBrowser } from '../../bridge';
import { TemplateResultCard } from '../../experience/TemplateResultCard';
import { VisualCard } from '../visuals/VisualCard';
import { CodeView } from '../code/CodeView';
import type { CodeRow } from '../code/codeRows';
import { ResourcePreview } from './ResourcePreview';
import { resourcePreview, type ResourcePreview as Resource } from './resourcePresentation';
import { InternalPathHint, ToolCard, ToolFields, ToolMark, ToolStatusTag } from './ToolCard';
import {
  codingStepAction,
  displayStatus,
  editResultCode,
  fileCode,
  filePreview,
  isInternalWorkspacePath,
  isUserOutput,
  pathBasename,
  previewFields,
  resultPreview,
  toolFilePath,
  toolPresentation,
  type DisplayStatus,
} from './toolPresentation';
import { registerPartRenderer, type AnyPart, type PartRenderContext } from '../PartRenderer';
export { foldToolParts } from './toolParts';
import {
  errorTextOf,
  isFoldedToolPart,
  partField,
  safeJson,
  truncateForDisplay,
  type FoldedToolPart,
  type ToolCallStatus,
} from './toolParts';
import { t, useT } from '../../i18n/i18n';

/** All previews are bounded; the persisted result is never changed by presentation. */
const DETAIL_CHARS = 4000;

function DetailBlock({
  label,
  body,
  code = false,
}: {
  label: string;
  body: string;
  code?: boolean;
}): ReactNode {
  return (
    <div className="mt-2">
      <div className="text-micro text-muted">{label}</div>
      <pre className={`crewaid-tool-preview mt-1 ${code ? 'crewaid-code' : ''}`}>{body}</pre>
    </div>
  );
}

function NoteLines({ lines }: { lines: readonly string[] }): ReactNode {
  return lines.map((line, index) => (
    <p key={index} className="m-0 mt-1 text-micro text-muted [overflow-wrap:anywhere]">
      {line}
    </p>
  ));
}

/** File code under its label, with the tool's own notes (a summary, a range footer) around it. */
function CodeDetailBlock({
  label,
  rows,
  language,
  before = [],
  after = [],
}: {
  label: string;
  rows: readonly CodeRow[];
  language: string | null;
  before?: readonly string[];
  after?: readonly string[];
}): ReactNode {
  return (
    <div className="mt-2" data-tool-code>
      <div className="text-micro text-muted">{label}</div>
      <NoteLines lines={before} />
      <CodeView rows={rows} language={language} className="mt-1" />
      <NoteLines lines={after} />
    </div>
  );
}

function outputText(row: FoldedToolPart): string {
  if (row.output === undefined) return '';
  return typeof row.output === 'string' ? row.output : safeJson(row.output, 2);
}

/** Whether a row has anything at all to show behind its disclosure. */
function hasDetails(row: FoldedToolPart): boolean {
  return (
    row.input !== undefined ||
    outputText(row) !== '' ||
    fileCode(row) !== undefined ||
    filePreview(row) !== undefined
  );
}

/**
 * What a row's disclosure opens to: the arguments, the file the action
 * touched, the result and the tool's own name. A file a bot read or edited is
 * code, in the language its path names; everything else is bounded text.
 */
function ToolDetailBlocks({
  row,
  status,
}: {
  row: FoldedToolPart;
  status: DisplayStatus;
}): ReactNode {
  const t = useT();
  const inputBody = row.input === undefined ? '' : safeJson(row.input, 2);
  const outputBody = outputText(row);
  const code = fileCode(row);
  const preview = code === undefined ? filePreview(row) : undefined;
  const editResult = editResultCode(row);
  const fileLabel =
    row.toolName === 'fs_write'
      ? status === 'ok'
        ? t('tools.detail.fileWritten')
        : t('tools.detail.filePreview')
      : row.toolName === 'fs_edit'
        ? status === 'ok'
          ? t('tools.detail.fileEdited')
          : t('tools.detail.filePreview')
        : t('tools.detail.fileContents');
  return (
    <>
      {inputBody === '' ? null : (
        <DetailBlock
          label={t('tools.detail.arguments')}
          code
          body={truncateForDisplay(inputBody, DETAIL_CHARS)}
        />
      )}
      {code?.kind === 'read' ? (
        <CodeDetailBlock
          label={fileLabel}
          rows={code.code.rows}
          language={code.language}
          before={code.code.before}
          after={code.code.after}
        />
      ) : code?.kind === 'edit' ? (
        <CodeDetailBlock label={fileLabel} rows={code.rows} language={code.language} />
      ) : preview === undefined ? null : (
        <DetailBlock label={fileLabel} body={preview} />
      )}
      {/* A read's result IS the file contents above; repeating it only doubles the scroll. */}
      {outputBody === '' || code?.kind === 'read' ? null : editResult !== undefined ? (
        <CodeDetailBlock
          label={t('tools.detail.result')}
          rows={editResult.code.rows}
          language={editResult.language}
          before={editResult.code.before}
          after={editResult.code.after}
        />
      ) : (
        <DetailBlock
          label={t('tools.detail.result')}
          code={
            row.toolName === 'shell' ||
            row.toolName.startsWith('process_') ||
            typeof row.output !== 'string'
          }
          body={truncateForDisplay(outputBody, DETAIL_CHARS)}
        />
      )}
      <DetailBlock label={t('tools.detail.tool')} body={row.toolName} code />
    </>
  );
}

/**
 * A tool call the fold could not settle into a row.
 *
 * Reachable whenever a call's own part is missing — a history page that
 * begins mid-turn is the ordinary case. It renders the outcome on its own
 * rather than nothing, because a result with no visible call still tells the
 * reader what happened.
 */
function looseToolPart(part: AnyPart): FoldedToolPart {
  const status: ToolCallStatus =
    part.type === 'tool-error' ? 'error' : part.type === 'tool-output-denied' ? 'denied' : 'ok';
  const toolCallId = partField(part, 'toolCallId');
  const toolName = partField(part, 'toolName');
  const row: FoldedToolPart = {
    type: 'tool-call',
    toolCallId: typeof toolCallId === 'string' ? toolCallId : '',
    toolName: typeof toolName === 'string' ? toolName : 'tool',
    input: partField(part, 'input'),
    status,
  };
  if (part.type === 'tool-result') row.output = partField(part, 'output');
  if (part.type === 'tool-error') row.detail = errorTextOf(partField(part, 'error'));
  return row;
}

/** The identity mark of one row: a brand mark for connected apps and files, the kind glyph otherwise. */
function rowMark(row: FoldedToolPart, kind: string, status: DisplayStatus): string | undefined {
  const input = partField(row, 'input');
  const filePath =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)['path']
      : undefined;
  return kind === 'file' && typeof filePath === 'string'
    ? fileMark({ filename: filePath, mimeType: '' })
    : toolMark(
        row.toolName,
        resourcePreview(row.toolName, row.input, row.output, status)?.kind ?? kind,
      );
}

/** The operator-facing sentence for an action that did not complete. */
function failureText(row: FoldedToolPart, status: 'error' | 'denied' | 'incomplete'): string {
  if (status === 'incomplete') return t('tools.failure.incomplete');
  return truncateForDisplay(
    row.detail ??
      (resultPreview(row.output) ||
        (status === 'denied' ? t('tools.failure.declined') : t('tools.failure.failed'))),
    800,
  );
}

/**
 * The arguments, the result and the tool's own name, one disclosure away.
 *
 * This is where the machinery of ANY action lives — a raw JSON payload never
 * sits on a row's face. The bounded file preview belongs here too: file
 * contents are for inspecting, not for reading between the bubbles.
 */
function DetailsDisclosure({ row, status }: { row: FoldedToolPart; status: DisplayStatus }) {
  const t = useT();
  if (!hasDetails(row)) return null;
  return (
    <Disclosure defaultExpanded={false} className="crewaid-tool-details min-w-0 flex-1">
      <Disclosure.Heading>
        <Disclosure.Trigger className="crewaid-tool-disclosure inline-flex items-center gap-1 rounded-md py-0.5 text-caption text-muted hover:text-foreground">
          {t('tools.details')}
          <Disclosure.Indicator className="size-3.5 text-muted" />
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body>
          <ToolDetailBlocks row={row} status={status} />
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}

/**
 * A routine action — file write, read, search, shell, browser step — rendered
 * as one thin muted collapsible line with an inline arrow beside the label.
 *
 * Clicking the line expands its arguments, bounded file preview, result, and
 * internal tool name. Internal sandbox paths (`/home/bot/...`) stay off the
 * face and live behind a hoverable "path" hint placed beside the trigger so
 * interactive elements are never nested.
 */
function ToolCallLine({
  row,
  context,
  count,
}: {
  row: FoldedToolPart;
  context?: PartRenderContext | undefined;
  count?: number | undefined;
}): ReactNode {
  const t = useT();
  const status = displayStatus(row, context);
  const presentation = toolPresentation(row.toolName, context);
  const mark = rowMark(row, presentation.kind, status);
  const filePath = toolFilePath(row.input);
  const internalPath =
    filePath !== undefined && isInternalWorkspacePath(filePath) ? filePath : undefined;
  const filename = filePath !== undefined ? pathBasename(filePath) : undefined;
  const failure =
    status === 'error' || status === 'denied' || status === 'incomplete'
      ? failureText(row, status)
      : undefined;
  const asked =
    row.asked === true && status !== 'awaiting-approval'
      ? status === 'denied'
        ? t('tools.youDeclined')
        : t('tools.youApproved')
      : undefined;
  const codingProgress =
    row.toolName === 'code_task' && status === 'running'
      ? context?.codingProgress?.get(row.toolCallId)
      : undefined;
  const codingAction =
    codingProgress?.kind === 'step' ? codingStepAction(codingProgress) : undefined;
  const codingProgressLabel =
    codingProgress === undefined
      ? undefined
      : codingProgress.kind === 'step' && codingAction !== undefined
        ? t('tools.coding.stepAction', {
            step: codingProgress.step,
            max: codingProgress.maxSteps,
            action: codingAction,
          })
        : codingProgress.kind === 'step'
          ? t('tools.coding.step', {
              step: codingProgress.step,
              max: codingProgress.maxSteps,
            })
          : codingProgress.kind === 'started' && codingProgress.modelLabel !== undefined
            ? t('tools.coding.starting', { model: codingProgress.modelLabel })
            : undefined;
  return (
    <div
      data-tool-call={row.toolName}
      data-tool-status={status}
      data-tool-line
      className="crewaid-tool-line my-0.5"
    >
      <Disclosure defaultExpanded={false} className="crewaid-tool-line-disclosure min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <Disclosure.Heading className="min-w-0">
            <Disclosure.Trigger className="crewaid-tool-disclosure inline-flex max-w-full items-center gap-1.5 rounded-md py-0.5 text-caption text-muted outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus">
              <ToolMark kind={presentation.kind} mark={mark} variant="line" />
              <span className="truncate leading-5" title={presentation.title}>
                {presentation.title}
              </span>
              {filename === undefined ? null : (
                <span className="truncate font-mono text-micro opacity-80">{filename}</span>
              )}
              <Disclosure.Indicator className="size-3.5 shrink-0 text-muted" />
            </Disclosure.Trigger>
          </Disclosure.Heading>
          {internalPath === undefined ? null : <InternalPathHint path={internalPath} />}
          {presentation.kind === 'computer' && context?.onViewComputer !== undefined ? (
            <Button
              size="sm"
              variant="ghost"
              onPress={context.onViewComputer}
              className="h-6 min-h-0 px-1.5 text-micro text-muted hover:text-foreground"
            >
              {t('tools.viewComputer')}
            </Button>
          ) : null}
          <ToolStatusTag status={status} count={count} />
        </div>
        {codingProgressLabel === undefined ? null : (
          <p
            data-coding-progress
            className="mt-0.5 truncate ps-[24px] text-micro leading-4 text-muted tabular-nums"
          >
            {codingProgressLabel}
          </p>
        )}
        {failure === undefined ? null : (
          <p className="crewaid-tool-line-note mt-0.5 ps-[24px] text-micro leading-4 text-muted">
            {failure}
          </p>
        )}
        {asked === undefined ? null : (
          <p className="mt-0.5 ps-[24px] text-micro text-muted">{asked}</p>
        )}
        <Disclosure.Content>
          <Disclosure.Body>
            <div className="mt-1.5 border-s-2 border-separator ps-3 pb-1">
              <ToolDetailBlocks row={row} status={status} />
            </div>
          </Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>
    </div>
  );
}

/** Where a card's row places the action: the service it acted on, not a mechanism. */
function cardSource(
  row: FoldedToolPart,
  resource: Resource | undefined,
  presentation: ReturnType<typeof toolPresentation>,
): string {
  if (resource?.kind === 'document') return 'Google Docs';
  if (resource?.kind === 'spreadsheet') return 'Google Sheets';
  if (resource?.kind === 'slides') return 'Google Slides';
  if (row.toolName === 'preview_email') return t('tools.source.emailDraft');
  if (resource?.kind === 'email') return 'Gmail';
  return presentation.source;
}

export function ToolCallPart({
  part,
  context,
  count,
}: {
  part: AnyPart;
  context?: PartRenderContext | undefined;
  /** How many identical runs of this action the row stands in for. */
  count?: number | undefined;
}): ReactNode {
  const t = useT();
  const row = isFoldedToolPart(part) ? part : looseToolPart(part);
  const status = displayStatus(row, context);
  // A template Crewaid read is a recommendation the person acts on.
  if (row.toolName === 'read_template' && status === 'ok')
    return <TemplateResultCard input={row.input} output={row.output} />;
  // Declarative visuals always render via their dedicated card, keyed strictly on toolName.
  if (row.toolName === 'present_visual') {
    return <VisualCard row={row} status={status} handoffActions={context?.handoffActions} />;
  }
  // Cards are for what the user keeps. Everything else is routine work,
  // which renders as a quiet line — or, with "Show thinking and actions" off,
  // is filtered out before it ever reaches a renderer.
  if (!isUserOutput(row, context))
    return <ToolCallLine row={row} context={context} count={count} />;
  const resource = resourcePreview(row.toolName, row.input, row.output, status);
  const presentation = toolPresentation(row.toolName, context);
  const fields = previewFields(row.input);
  const mark = rowMark(row, resource?.kind ?? presentation.kind, status);
  const failure =
    status === 'error' || status === 'denied' || status === 'incomplete'
      ? failureText(row, status)
      : undefined;
  const asked =
    row.asked === true && status !== 'awaiting-approval'
      ? status === 'denied'
        ? t('tools.youDeclined')
        : t('tools.youApproved')
      : undefined;

  return (
    <div data-tool-call={row.toolName} data-tool-status={status} className="my-2">
      <ToolCard
        {...presentation}
        kind={resource?.kind ?? presentation.kind}
        title={resource?.title ?? presentation.title}
        source={cardSource(row, resource, presentation)}
        mark={mark}
        status={status}
        count={count}
      >
        {resource === undefined ? null : <ResourcePreview preview={resource} />}
        {resource !== undefined || fields.length === 0 ? null : <ToolFields fields={fields} />}
        {failure === undefined ? null : (
          <div className="mt-2" data-tool-result-preview>
            <div className="mb-1 text-micro text-muted">
              {status === 'error' ? t('tools.whatWentWrong') : t('tools.detail.result')}
            </div>
            <pre className="crewaid-tool-preview" data-result-status={status}>
              {failure}
            </pre>
          </div>
        )}
        {asked === undefined ? null : <p className="mt-2 text-micro text-muted">{asked}</p>}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-2">
          <DetailsDisclosure row={row} status={status} />
          {resource?.url === undefined ? null : (
            <Button
              size="sm"
              variant="ghost"
              onPress={() => {
                void systemBrowser.open(resource.url!);
              }}
              aria-label={t('tools.openResource', { title: resource.title })}
              // The same size as Details beside it: two actions in one footer.
              className="h-auto min-h-0 gap-1 rounded-md px-1.5 py-1 text-micro font-medium"
            >
              {t('tools.open')}
              <IconArrowUpRight aria-hidden className="size-3.5" />
            </Button>
          )}
        </div>
      </ToolCard>
    </div>
  );
}

function activityCalls(part: AnyPart): FoldedToolPart[] {
  const calls = partField(part, 'calls');
  return Array.isArray(calls) ? calls.filter(isFoldedToolPart) : [];
}

/**
 * Runs of one producing action on one artifact render once, with a count.
 *
 * A bot that retries a draft creation would otherwise stack two cards for one
 * artifact — the exact noise the cards exist to remove. The signature is the
 * artifact's IDENTITY (the service, the title, and for an email its
 * recipients), not the whole payload: a retry usually differs from the
 * attempt it replaces in exactly the argument the schema refused, while the
 * artifact on the card reads the same. The LAST run wins, because its
 * outcome is the artifact's final state; the count says how many times the
 * action ran. Routine lines are never merged — the work log is where an
 * inspector counts every step.
 */
function outputRows(
  calls: readonly FoldedToolPart[],
  context?: PartRenderContext,
): { row: FoldedToolPart; count: number }[] {
  const merged = new Map<string, { row: FoldedToolPart; count: number }>();
  const order: string[] = [];
  for (const call of calls) {
    const status = displayStatus(call, context);
    const resource = resourcePreview(call.toolName, call.input, call.output, status);
    const signature =
      resource === undefined
        ? `${call.toolName}|${safeJson(call.input)}`
        : resource.kind === 'email'
          ? `${call.toolName}|${resource.title}|${resource.fields
              .filter((field) => /^(From|To|Also to|Cc|Bcc)$/.test(field.label))
              .map((field) => field.value)
              .join('|')}`
          : `${call.toolName}|${resource.title}`;
    const existing = merged.get(signature);
    if (existing === undefined) {
      merged.set(signature, { row: call, count: 1 });
      order.push(signature);
      continue;
    }
    existing.count += 1;
    existing.row = call;
    order.splice(order.indexOf(signature), 1);
    order.push(signature);
  }
  return order.map((signature) => merged.get(signature)!);
}

function RoutineActivityDisclosure({
  routine,
  streaming,
  autoExpand,
  context,
}: {
  routine: readonly FoldedToolPart[];
  streaming: boolean;
  autoExpand: boolean;
  context?: PartRenderContext | undefined;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(streaming && autoExpand);
  const wasStreaming = useRef(streaming);

  // Only auto-open while streaming when the user opted into live work; once
  // the turn settles, collapse back into the quiet line so chat stays clean.
  useEffect(() => {
    if (streaming && !wasStreaming.current && autoExpand) {
      setExpanded(true);
    } else if (!streaming && wasStreaming.current) {
      setExpanded(false);
    }
    wasStreaming.current = streaming;
  }, [streaming, autoExpand]);

  return (
    <ChatToolGroup.Root
      active={streaming}
      isExpanded={expanded}
      onExpandedChange={setExpanded}
      className="my-1 text-caption text-muted"
    >
      <ChatToolGroup.Trigger className="crewaid-tool-disclosure">
        {t('tools.actions', { count: routine.length })}
      </ChatToolGroup.Trigger>
      <ChatToolGroup.Content>
        {routine.map((call) => (
          <ToolCallPart key={call.toolCallId} part={call} context={context} />
        ))}
      </ChatToolGroup.Content>
    </ChatToolGroup.Root>
  );
}

/**
 * A turn's actions, placed the way a person reads them.
 *
 * Deliverables (emails, Workspace docs, visuals, templates) render as cards.
 * Routine steps (file writes, reads, shell, browser, board lookups) stay hidden
 * when "Show thinking and actions" is off so chat stays uncluttered, and when
 * shown collapse into one quiet muted disclosure line inspectable on demand.
 */
export function ToolActivityPart({
  part,
  context,
}: {
  part: AnyPart;
  context?: PartRenderContext | undefined;
}): ReactNode {
  const calls = activityCalls(part);
  if (calls.length === 0) return null;
  const outputs = calls.filter((call) => isUserOutput(call, context));
  const routine =
    context?.showWork === false ? [] : calls.filter((call) => !isUserOutput(call, context));
  if (outputs.length === 0 && routine.length === 0) return null;
  const status = calls.some((call) => displayStatus(call, context) === 'running')
    ? 'running'
    : calls.some((call) => displayStatus(call, context) === 'awaiting-approval')
      ? 'approval'
      : calls.some((call) =>
            ['error', 'denied', 'incomplete'].includes(displayStatus(call, context)),
          )
        ? 'issue'
        : 'complete';
  return (
    <div data-tool-activity data-tool-activity-status={status}>
      {outputs.length === 0 ? null : (
        <div className="crewaid-output-grid">
          {outputRows(outputs, context).map(({ row, count }) => {
            const preview = resourcePreview(
              row.toolName,
              row.input,
              row.output,
              displayStatus(row, context),
            );
            const tile =
              row.toolName !== 'present_visual' &&
              preview !== undefined &&
              preview.kind !== 'email' &&
              preview.body === undefined;
            return (
              <div
                key={row.toolCallId}
                className={tile ? 'crewaid-output-tile' : 'crewaid-output-wide'}
              >
                <ToolCallPart part={row} context={context} count={count} />
              </div>
            );
          })}
        </div>
      )}
      {routine.length === 1 && routine[0] !== undefined ? (
        <ToolCallLine row={routine[0]} context={context} />
      ) : routine.length > 1 ? (
        <RoutineActivityDisclosure
          routine={routine}
          streaming={context?.streaming === true}
          autoExpand={context?.showWork === true}
          context={context}
        />
      ) : null}
    </div>
  );
}

// Registered from the feature folder, which is the contract `PartRenderer`
// states: adding a part type must not touch the transcript. Only deliverables
// stay visible when "Show thinking and actions" is off; routine actions stay
// hidden until the user opts in.
function isUserOutputPart(part: AnyPart): boolean {
  return isUserOutput(isFoldedToolPart(part) ? part : looseToolPart(part));
}
registerPartRenderer('tool-call', ToolCallPart, isUserOutputPart);
registerPartRenderer('tool-result', ToolCallPart, isUserOutputPart);
registerPartRenderer('tool-error', ToolCallPart, isUserOutputPart);
registerPartRenderer('tool-output-denied', ToolCallPart, isUserOutputPart);
registerPartRenderer('tool-activity', ToolActivityPart, (part) =>
  activityCalls(part).some((call) => isUserOutput(call)),
);
