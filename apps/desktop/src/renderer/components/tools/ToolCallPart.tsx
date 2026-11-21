import type { ReactNode } from 'react';
import { IconChevronRight, IconArrowUpRight } from '@tabler/icons-react';
import { Button } from '@heroui/react';
import { toolMark, fileMark } from '../attachments/artifactMarks';
import { systemBrowser } from '../../bridge';
import { TemplateResultCard } from '../../experience/TemplateResultCard';
import { ResourcePreview } from './ResourcePreview';
import { resourcePreview, type ResourcePreview as Resource } from './resourcePresentation';
import { ToolCard, ToolFields, ToolMark, ToolStatusTag } from './ToolCard';
import {
  displayStatus,
  filePreview,
  isUserOutput,
  previewFields,
  resultPreview,
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
      <div className="text-[11px] text-muted">{label}</div>
      <pre className={`crewaid-tool-preview mt-1 ${code ? 'crewaid-code' : ''}`}>{body}</pre>
    </div>
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
  const inputBody = row.input === undefined ? '' : safeJson(row.input, 2);
  const outputBody =
    row.output === undefined
      ? ''
      : typeof row.output === 'string'
        ? row.output
        : safeJson(row.output, 2);
  const preview = filePreview(row);
  if (inputBody === '' && outputBody === '' && preview === undefined) return null;
  return (
    <details className="crewaid-tool-details min-w-0 flex-1">
      <summary className="crewaid-tool-disclosure">{t('tools.details')}</summary>
      {inputBody === '' ? null : (
        <DetailBlock
          label={t('tools.detail.arguments')}
          code
          body={truncateForDisplay(inputBody, DETAIL_CHARS)}
        />
      )}
      {preview === undefined ? null : (
        <DetailBlock
          label={
            row.toolName === 'fs_write'
              ? status === 'ok'
                ? t('tools.detail.fileWritten')
                : t('tools.detail.filePreview')
              : t('tools.detail.fileContents')
          }
          body={preview}
        />
      )}
      {outputBody === '' ? null : (
        <DetailBlock
          label={t('tools.detail.result')}
          code={row.toolName === 'shell' || typeof row.output !== 'string'}
          body={truncateForDisplay(outputBody, DETAIL_CHARS)}
        />
      )}
      <DetailBlock label={t('tools.detail.tool')} body={row.toolName} code />
    </details>
  );
}

/**
 * A routine action — a read, a search, a command — as one quiet line.
 *
 * Cards are for what the user keeps (D-215); everything else a bot does is
 * machinery, and machinery between the bubbles is noise. The line still says
 * what ran and how it ended — in words, since colour is not a state — keeps a
 * failure's sentence on its face, and puts the arguments and the raw result
 * one Details away.
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
    <div
      data-tool-call={row.toolName}
      data-tool-status={status}
      data-tool-line
      className="crewaid-tool-line my-1"
    >
      <div className="flex min-w-0 items-center gap-2">
        <ToolMark kind={presentation.kind} mark={mark} variant="line" />
        <span className="min-w-0 flex-1 truncate text-[12px] leading-5" title={presentation.title}>
          {presentation.title}
        </span>
        {presentation.kind === 'computer' && context?.onViewComputer !== undefined ? (
          <Button size="sm" variant="ghost" onPress={context.onViewComputer}>
            {t('tools.viewComputer')}
          </Button>
        ) : null}
        <ToolStatusTag status={status} count={count} />
      </div>
      {failure === undefined ? null : (
        <p className="crewaid-tool-line-note mt-1 ps-[30px] text-[11px] leading-4 text-muted">
          {failure}
        </p>
      )}
      {asked === undefined ? null : (
        <p className="mt-1 ps-[30px] text-[11px] text-muted">{asked}</p>
      )}
      <DetailsDisclosure row={row} status={status} />
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
  /** How many identical runs of this action the row stands in for (D-215). */
  count?: number | undefined;
}): ReactNode {
  const t = useT();
  const row = isFoldedToolPart(part) ? part : looseToolPart(part);
  const status = displayStatus(row, context);
  // D-229: a template Crewaid read is a recommendation the person acts on.
  if (row.toolName === 'read_template' && status === 'ok')
    return <TemplateResultCard input={row.input} output={row.output} />;
  // D-215: cards are for what the user keeps. Everything else is routine work,
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
            <div className="mb-1 text-[11px] text-muted">
              {status === 'error' ? t('tools.whatWentWrong') : t('tools.detail.result')}
            </div>
            <pre className="crewaid-tool-preview" data-result-status={status}>
              {failure}
            </pre>
          </div>
        )}
        {asked === undefined ? null : <p className="mt-2 text-[11px] text-muted">{asked}</p>}
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
 * Runs of one producing action on one artifact render once, with a count
 * (D-215).
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

/**
 * A turn's actions, placed the way a person reads them.
 *
 * What the user keeps renders as cards; the steps that got there are one
 * collapsed disclosure — open while the reply streams so the work log is
 * live for whoever opted into it, settled and out of the way once the answer
 * lands. With "Show thinking and actions" off only the outputs remain,
 * because a transcript of fetches is machinery, not message (D-215).
 */
export function ToolActivityPart({
  part,
  context,
}: {
  part: AnyPart;
  context?: PartRenderContext | undefined;
}): ReactNode {
  const t = useT();
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
              preview !== undefined && preview.kind !== 'email' && preview.body === undefined;
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
      {routine.length === 0 ? null : (
        <details
          className="group/activity my-2 text-[12px] text-muted"
          open={context?.streaming === true ? true : undefined}
        >
          <summary className="crewaid-tool-disclosure flex items-center gap-1.5">
            <IconChevronRight
              aria-hidden
              className="size-3.5 group-open/activity:rotate-90 rtl:group-open/activity:-rotate-90 rtl:-scale-x-100"
            />
            {t('tools.actions', { count: routine.length })}
          </summary>
          {routine.map((call) => (
            <ToolCallPart key={call.toolCallId} part={call} context={context} />
          ))}
        </details>
      )}
    </div>
  );
}

// Registered from the feature folder, which is the contract `PartRenderer`
// states: adding a part type must not touch the transcript. The three outcome
// types are registered too so a part the fold could not pair — a history page
// that starts mid-turn — still renders as the action it was rather than as
// "[unsupported part type]".
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
