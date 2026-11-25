import { IconAlertCircle } from '@tabler/icons-react';
import { resolveVisualForRender, type VisualBlock } from '@crewaid/shared';
import { useT } from '../../i18n/i18n';
import { resultValue, type DisplayStatus } from '../tools/toolPresentation';
import type { FoldedToolPart } from '../tools/toolParts';
import { TextShimmer } from '../ui';
import { CalloutBlock } from './CalloutBlock';
import { ChartBlock } from './ChartBlock';
import { ComparisonBlock } from './ComparisonBlock';
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

function VisualBlockView({ block }: { readonly block: VisualBlock }) {
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
}: {
  readonly row: FoldedToolPart;
  readonly status: DisplayStatus;
}) {
  const t = useT();

  if (status === 'running') {
    const title = partialTitle(row.input);
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
          {detail !== undefined ? <span className="break-words text-muted">{detail}</span> : null}
        </div>
      </div>
    );
  }

  return (
    <article
      data-visual-card="ready"
      data-visual-version={payload.version}
      className="my-2 flex max-w-[640px] flex-col gap-4 rounded-card border border-border bg-surface px-5 py-4 shadow-[var(--surface-shadow)]"
    >
      {payload.title !== undefined || payload.subtitle !== undefined ? (
        <header className="flex flex-col gap-0.5">
          {payload.title !== undefined ? (
            <h3 className="m-0 text-headline font-semibold tracking-tight text-foreground">
              {payload.title}
            </h3>
          ) : null}
          {payload.subtitle !== undefined ? (
            <p className="m-0 text-caption text-muted">{payload.subtitle}</p>
          ) : null}
        </header>
      ) : null}

      <div className="flex flex-col gap-5">
        {payload.blocks.map((block, idx) => (
          <VisualBlockView key={`${block.kind}-${idx}`} block={block} />
        ))}
      </div>

      {(payload.sources !== undefined && payload.sources.length > 0) ||
      (payload.notes !== undefined && payload.notes.length > 0) ? (
        <footer className="flex flex-col gap-0.5 border-t border-separator/80 pt-2.5 text-micro text-muted">
          {payload.sources !== undefined && payload.sources.length > 0 ? (
            <span>{t('visuals.sources', { files: payload.sources.join(', ') })}</span>
          ) : null}
          {payload.notes?.map((note, idx) => (
            <span key={idx}>{note}</span>
          ))}
        </footer>
      ) : null}
    </article>
  );
}
