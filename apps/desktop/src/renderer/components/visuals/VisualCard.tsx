import { IconAlertCircle } from '@tabler/icons-react';
import { resolveVisualForRender, type VisualBlock } from '@crewaid/shared';
import { useT } from '../../i18n/i18n';
import { formatPreviewInternalPaths } from '../markdown/internalPaths';
import { resultValue, type DisplayStatus } from '../tools/toolPresentation';
import type { FoldedToolPart } from '../tools/toolParts';
import { TextShimmer } from '../ui';
import { CalloutBlock } from './CalloutBlock';
import { ChartBlock } from './ChartBlock';
import { ChecksBlock } from './ChecksBlock';
import { ComparisonBlock } from './ComparisonBlock';
import { DiffBlock } from './DiffBlock';
import { HandoffBlock, type HandoffActions } from './HandoffBlock';
import { MetricsBlock } from './MetricsBlock';
import { TableBlock } from './TableBlock';
import { TimelineBlock } from './TimelineBlock';

function partialTitle(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const title = (input as Record<string, unknown>)['title'];
  return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined;
}

function errorMessage(row: FoldedToolPart): string | undefined {
  if (typeof row.detail === 'string' && row.detail.trim() !== '') return row.detail.trim();
  const value = resultValue(row.output);
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return undefined;
}

function VisualBlockView({
  block,
  handoffActions,
}: {
  readonly block: VisualBlock;
  readonly handoffActions?: HandoffActions | undefined;
}) {
  switch (block.kind) {
    case 'metrics':
      return <MetricsBlock block={block} />;
    case 'chart':
      return <ChartBlock block={block} />;
    case 'table':
      return <TableBlock block={block} />;
    case 'comparison':
      return <ComparisonBlock block={block} />;
    case 'timeline':
      return <TimelineBlock block={block} />;
    case 'callout':
      return <CalloutBlock block={block} />;
    case 'handoff':
      return <HandoffBlock block={block} actions={handoffActions} />;
    case 'checks':
      return <ChecksBlock block={block} />;
    case 'diff':
      return <DiffBlock block={block} />;
  }
}

/**
 * First-class client-rendered visual card for `present_visual`.
 * Only invoked when `row.toolName === 'present_visual'`; validates both
 * input arguments and any resolved file snapshot via `resolveVisualForRender`.
 */
export function VisualCard({
  row,
  status,
  handoffActions,
}: {
  readonly row: FoldedToolPart;
  readonly status: DisplayStatus;
  readonly handoffActions?: HandoffActions | undefined;
}) {
  const t = useT();

  const pathLabel = t('tools.path');
  const cleanText = (value: string): string => formatPreviewInternalPaths(value, pathLabel);

  if (status === 'running') {
    const rawTitle = partialTitle(row.input);
    const title = rawTitle === undefined ? undefined : cleanText(rawTitle);
    return (
      <div
        data-visual-card="loading"
        className="my-2 flex max-w-[640px] flex-col gap-3 rounded-card border border-border bg-surface px-5 py-4 shadow-[var(--surface-shadow)]"
      >
        <TextShimmer className="text-footnote font-medium text-muted">
          {title ?? t('visuals.loading')}
        </TextShimmer>
        <div aria-hidden className="flex flex-col gap-2">
          <div className="h-3 w-3/4 rounded-full bg-default" />
          <div className="h-24 w-full rounded-[12px] bg-default/70" />
        </div>
      </div>
    );
  }

  const payload =
    status === 'ok' ? resolveVisualForRender(row.input, resultValue(row.output)) : null;

  if (payload === null) {
    const detail = errorMessage(row);
    return (
      <div
        data-visual-card="error"
        className="my-2 flex max-w-[640px] items-start gap-2.5 rounded-card border border-danger/25 bg-surface px-4 py-3 text-caption shadow-[var(--surface-shadow)]"
      >
        <IconAlertCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium text-foreground">{t('visuals.errorTitle')}</span>
          {detail !== undefined ? (
            <span className="break-words text-muted">{cleanText(detail)}</span>
          ) : null}
        </div>
      </div>
    );
  }

  const displayTitle = payload.title === undefined ? undefined : cleanText(payload.title);
  const displaySubtitle = payload.subtitle === undefined ? undefined : cleanText(payload.subtitle);
  const displaySources = payload.sources?.map(cleanText);
  const displayNotes = payload.notes?.map(cleanText);
  const hasFooter =
    (displaySources !== undefined && displaySources.length > 0) ||
    (displayNotes !== undefined && displayNotes.length > 0);
  const compactChecks =
    payload.blocks.length === 1 &&
    payload.blocks[0]?.kind === 'checks' &&
    displayTitle === undefined &&
    displaySubtitle === undefined &&
    !hasFooter;

  return (
    <article
      data-visual-card="ready"
      data-visual-version={payload.version}
      data-visual-compact={compactChecks ? 'checks' : undefined}
      className={
        compactChecks
          ? 'my-1.5 flex w-fit max-w-[min(100%,520px)] flex-col rounded-message border border-border bg-surface px-4 py-3 shadow-[var(--surface-shadow)]'
          : 'my-2 flex max-w-[640px] flex-col gap-4 rounded-card border border-border bg-surface px-5 py-4 shadow-[var(--surface-shadow)]'
      }
    >
      {displayTitle !== undefined || displaySubtitle !== undefined ? (
        <header className="flex flex-col gap-0.5">
          {displayTitle !== undefined ? (
            <h3 className="m-0 text-headline font-semibold tracking-tight text-foreground">
              {displayTitle}
            </h3>
          ) : null}
          {displaySubtitle !== undefined ? (
            <p className="m-0 text-caption text-muted">{displaySubtitle}</p>
          ) : null}
        </header>
      ) : null}

      <div className="flex flex-col gap-5">
        {payload.blocks.map((block, idx) => (
          <VisualBlockView
            key={`${block.kind}-${idx}`}
            block={block}
            handoffActions={handoffActions}
          />
        ))}
      </div>

      {hasFooter ? (
        <footer className="flex flex-col gap-0.5 border-t border-separator/80 pt-2.5 text-micro text-muted">
          {displaySources !== undefined && displaySources.length > 0 ? (
            <span>{t('visuals.sources', { files: displaySources.join(', ') })}</span>
          ) : null}
          {displayNotes?.map((note, idx) => (
            <span key={idx}>{note}</span>
          ))}
        </footer>
      ) : null}
    </article>
  );
}
