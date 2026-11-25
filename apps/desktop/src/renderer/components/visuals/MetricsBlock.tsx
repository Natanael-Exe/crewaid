import type { VisualMetricsBlock } from '@crewaid/shared';
import { formatChartNumber, KPI, KPIGroup, Sparkline } from '../ui';

function sparklineColor(trend: 'up' | 'down' | 'neutral' | undefined): string {
  if (trend === 'up') return 'var(--success)';
  if (trend === 'down') return 'var(--danger)';
  return 'var(--chart-1)';
}

export function MetricsBlock({ block }: { readonly block: VisualMetricsBlock }) {
  return (
    <section data-visual-block="metrics" className="flex flex-col gap-2.5">
      {block.title !== undefined ? (
        <h4 className="m-0 text-footnote font-medium text-muted">{block.title}</h4>
      ) : null}
      <KPIGroup>
        {block.items.map((item, idx) => {
          const displayValue =
            typeof item.value === 'number' ? formatChartNumber(item.value) : item.value;
          return (
            <KPI key={`${item.label}-${idx}`}>
              <KPI.Header>
                <KPI.Title title={item.label}>{item.label}</KPI.Title>
              </KPI.Header>
              <KPI.Content>
                <KPI.Value>{displayValue}</KPI.Value>
                {item.delta !== undefined ? (
                  <KPI.Trend trend={item.trend ?? 'neutral'}>{item.delta}</KPI.Trend>
                ) : null}
              </KPI.Content>
              {item.sparkline !== undefined && item.sparkline.length >= 2 ? (
                <KPI.Sparkline>
                  <Sparkline values={item.sparkline} color={sparklineColor(item.trend)} />
                </KPI.Sparkline>
              ) : null}
              {item.note !== undefined ? <KPI.Footer>{item.note}</KPI.Footer> : null}
            </KPI>
          );
        })}
      </KPIGroup>
    </section>
  );
}
