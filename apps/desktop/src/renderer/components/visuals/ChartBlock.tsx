import { useMemo, useState } from 'react';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import type { VisualChartBlock, VisualTableBlock } from '@crewaid/shared';
import { useT } from '../../i18n/i18n';
import {
  BarChart,
  DonutChart,
  formatChartValue,
  IconButtonTooltip,
  LineAreaChart,
  Segment,
  seriesColor,
} from '../ui';
import { TableBlock } from './TableBlock';
import { chartToCsv, copyToClipboard } from './visualExport';

export function ChartBlock({ block }: { readonly block: VisualChartBlock }) {
  const t = useT();
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [stacked, setStacked] = useState(block.stacked === true);
  const [copied, setCopied] = useState(false);

  const canStack =
    block.series.length > 1 &&
    (block.chartType === 'bar' || block.chartType === 'hbar' || block.chartType === 'area');

  const ariaLabel =
    block.title !== undefined
      ? t('visuals.chartAria', { type: block.chartType, title: block.title })
      : t('visuals.chartAriaUntitled', { type: block.chartType });

  const tableProjection = useMemo<VisualTableBlock>(() => {
    const cols = [t('visuals.category'), ...block.series.map((s) => s.name)];
    const rows = block.x.map((label, idx) => [
      label,
      ...block.series.map((s) => {
        const val = s.y[idx] ?? null;
        return block.unit !== undefined && val !== null ? formatChartValue(val, block.unit) : val;
      }),
    ]);
    return {
      kind: 'table',
      cols,
      rows,
      align: ['l', ...block.series.map(() => 'r' as const)],
    };
  }, [block.series, block.unit, block.x, t]);

  const donutSlices = useMemo(() => {
    if (block.chartType !== 'donut') return [];
    const primary = block.series[0];
    if (primary === undefined) return [];
    return block.x.map((label, idx) => ({
      label,
      value: Math.max(0, primary.y[idx] ?? 0),
    }));
  }, [block.chartType, block.series, block.x]);

  const handleCopyCsv = async () => {
    const csv = chartToCsv(block, t('visuals.category'));
    const ok = await copyToClipboard(csv);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section
      data-visual-block="chart"
      data-chart-type={block.chartType}
      className="flex flex-col gap-2.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        {block.title !== undefined ? (
          <h4 className="m-0 min-w-0 flex-1 truncate text-footnote font-medium text-muted">
            {block.title}
          </h4>
        ) : (
          <span className="flex-1" />
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          {view === 'chart' && canStack ? (
            <Segment
              size="sm"
              aria-label={t('visuals.barMode')}
              selectedKey={stacked ? 'stacked' : 'grouped'}
              onSelectionChange={(key) => setStacked(key === 'stacked')}
            >
              <Segment.Item id="grouped">{t('visuals.grouped')}</Segment.Item>
              <Segment.Item id="stacked">{t('visuals.stacked')}</Segment.Item>
            </Segment>
          ) : null}

          <Segment
            size="sm"
            aria-label={t('visuals.viewMode')}
            selectedKey={view}
            onSelectionChange={(key) => setView(key === 'table' ? 'table' : 'chart')}
          >
            <Segment.Item id="chart">{t('visuals.viewChart')}</Segment.Item>
            <Segment.Item id="table">{t('visuals.viewTable')}</Segment.Item>
          </Segment>

          <IconButtonTooltip
            label={copied ? t('visuals.copied') : t('visuals.copyCsv')}
            onPress={() => {
              void handleCopyCsv();
            }}
          >
            {copied ? (
              <IconCheck aria-hidden className="size-3.5 text-success" />
            ) : (
              <IconCopy aria-hidden className="size-3.5" />
            )}
          </IconButtonTooltip>
        </div>
      </div>

      {view === 'chart' && block.series.length > 1 && block.chartType !== 'donut' ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-muted">
          {block.series.map((s, idx) => (
            <span key={`${s.name}-${idx}`} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: seriesColor(idx) }}
              />
              <span>{s.name}</span>
            </span>
          ))}
        </div>
      ) : null}

      {view === 'table' ? (
        <TableBlock block={tableProjection} compact />
      ) : block.chartType === 'bar' || block.chartType === 'hbar' ? (
        <BarChart
          categories={block.x}
          series={block.series}
          orientation={block.chartType === 'hbar' ? 'horizontal' : 'vertical'}
          stacked={stacked}
          {...(block.unit !== undefined ? { unit: block.unit } : {})}
          ariaLabel={ariaLabel}
        />
      ) : block.chartType === 'line' || block.chartType === 'area' ? (
        <LineAreaChart
          variant={block.chartType}
          categories={block.x}
          series={block.series}
          stacked={stacked}
          {...(block.unit !== undefined ? { unit: block.unit } : {})}
          ariaLabel={ariaLabel}
        />
      ) : (
        <DonutChart
          slices={donutSlices}
          {...(block.unit !== undefined ? { unit: block.unit } : {})}
          totalLabel={t('visuals.total')}
          ariaLabel={ariaLabel}
        />
      )}
    </section>
  );
}
