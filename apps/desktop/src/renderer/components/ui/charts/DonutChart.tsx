import { useMemo, useState } from 'react';
import { ChartTooltip } from '../ChartTooltip';
import { cx } from '../compose';
import { donutSlicePath, formatChartValue, seriesColor } from './chartMath';

export interface DonutSlice {
  readonly label: string;
  readonly value: number;
}

export interface DonutChartProps {
  readonly slices: readonly DonutSlice[];
  readonly unit?: string;
  readonly totalLabel: string;
  readonly ariaLabel: string;
  readonly className?: string;
}

export function DonutChart({ slices, unit, totalLabel, ariaLabel, className }: DonutChartProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const { total, arcs } = useMemo(() => {
    const positive = slices.filter((s) => Number.isFinite(s.value) && s.value > 0);
    const sum = positive.reduce((acc, item) => acc + item.value, 0);
    const gap = positive.length > 1 ? 0.024 : 0;
    let cursor = 0;
    const built = positive.map((item, idx) => {
      const share = sum > 0 ? item.value / sum : 0;
      const sweep = share * Math.PI * 2;
      const start = cursor + gap / 2;
      const end = Math.max(start + 0.005, cursor + sweep - gap / 2);
      cursor += sweep;
      return {
        label: item.label,
        value: item.value,
        pct: Math.round(share * 1000) / 10,
        color: seriesColor(idx),
        path: donutSlicePath(92, 92, 82, 54, start, end),
      };
    });
    return { total: sum, arcs: built };
  }, [slices]);

  const active = activeIndex !== null ? arcs[activeIndex] : undefined;

  return (
    <div
      data-slot="donut-chart"
      className={cx(
        'relative flex flex-col items-center gap-4 sm:flex-row sm:items-center',
        className,
      )}
      onMouseLeave={() => setActiveIndex(null)}
    >
      <div className="relative size-[184px] shrink-0">
        <svg role="img" aria-label={ariaLabel} viewBox="0 0 184 184" className="block size-full">
          {arcs.map((arc, idx) => {
            const hovered = activeIndex === idx;
            return (
              <path
                key={`${arc.label}-${idx}`}
                d={arc.path}
                fill={arc.color}
                fillOpacity={activeIndex === null || hovered ? 0.94 : 0.45}
                tabIndex={0}
                className="cursor-[var(--cursor-interactive)] outline-none transition-opacity duration-150"
                onMouseEnter={() => setActiveIndex(idx)}
                onFocus={() => setActiveIndex(idx)}
                onBlur={() => setActiveIndex((prev) => (prev === idx ? null : prev))}
              />
            );
          })}
          <text
            x={92}
            y={88}
            textAnchor="middle"
            fill="var(--foreground)"
            fontSize={16}
            fontWeight={600}
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {active !== undefined ? `${active.pct}%` : formatChartValue(total, unit, true)}
          </text>
          <text x={92} y={106} textAnchor="middle" fill="var(--muted)" fontSize={10}>
            {active !== undefined
              ? active.label.length > 14
                ? `${active.label.slice(0, 13)}…`
                : active.label
              : totalLabel}
          </text>
        </svg>

        {active !== undefined ? (
          <ChartTooltip.Overlay
            xPct={50}
            yPct={18}
            entries={[
              {
                label: active.label,
                value: `${formatChartValue(active.value, unit)} (${active.pct}%)`,
                color: active.color,
              },
            ]}
          />
        ) : null}
      </div>

      <ul className="m-0 flex min-w-0 flex-1 list-none flex-col gap-1.5 p-0">
        {arcs.map((arc, idx) => {
          const hovered = activeIndex === idx;
          return (
            <li
              key={`${arc.label}-${idx}`}
              className={cx(
                'flex items-center gap-2 rounded-md px-2 py-1 text-caption transition-colors',
                hovered && 'bg-default',
              )}
              onMouseEnter={() => setActiveIndex(idx)}
            >
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: arc.color }}
              />
              <span className="min-w-0 flex-1 truncate text-foreground">{arc.label}</span>
              <span className="shrink-0 font-medium tabular-nums text-foreground">
                {formatChartValue(arc.value, unit)}
              </span>
              <span className="w-11 shrink-0 text-end tabular-nums text-muted">{arc.pct}%</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
