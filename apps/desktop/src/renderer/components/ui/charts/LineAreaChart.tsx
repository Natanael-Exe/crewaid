import { useId, useMemo, useState } from 'react';
import { ChartTooltip } from '../ChartTooltip';
import { cx } from '../compose';
import {
  formatChartValue,
  monotoneAreaPath,
  monotoneBandPath,
  monotoneLinePath,
  niceScale,
  seriesColor,
  truncateTick,
  type Point2D,
} from './chartMath';

export interface LineSeries {
  readonly name: string;
  readonly y: readonly (number | null)[];
}

export interface LineAreaChartProps {
  readonly variant: 'line' | 'area';
  readonly categories: readonly string[];
  readonly series: readonly LineSeries[];
  readonly stacked?: boolean;
  readonly unit?: string;
  readonly ariaLabel: string;
  readonly className?: string;
}

const VB_W = 560;
const VB_H = 240;

export function LineAreaChart({
  variant,
  categories,
  series,
  stacked = false,
  unit,
  ariaLabel,
  className,
}: LineAreaChartProps) {
  const uid = useId();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const isArea = variant === 'area';
  const stackOn = isArea && stacked && series.length > 1;

  const { scale, plottedValues } = useMemo(() => {
    const cumulative: number[][] = [];
    let minVal = Infinity;
    let maxVal = -Infinity;

    if (stackOn) {
      const running = new Array<number>(categories.length).fill(0);
      for (const s of series) {
        const next: number[] = [];
        for (let i = 0; i < categories.length; i += 1) {
          const v = s.y[i] ?? 0;
          const sum = (running[i] ?? 0) + v;
          running[i] = sum;
          next.push(sum);
          if (sum < minVal) minVal = sum;
          if (sum > maxVal) maxVal = sum;
        }
        cumulative.push(next);
      }
    } else {
      for (const s of series) {
        for (const v of s.y) {
          if (v === null) continue;
          if (v < minVal) minVal = v;
          if (v > maxVal) maxVal = v;
        }
      }
    }

    if (!Number.isFinite(minVal)) minVal = 0;
    if (!Number.isFinite(maxVal)) maxVal = 1;

    return {
      scale: niceScale(minVal, maxVal, { tickCount: 5, anchorZero: isArea }),
      plottedValues: cumulative,
    };
  }, [categories.length, isArea, series, stackOn]);

  const pad = { top: 14, right: 16, bottom: 32, left: 50 };
  const plotW = VB_W - pad.left - pad.right;
  const plotH = VB_H - pad.top - pad.bottom;
  const span = scale.max - scale.min || 1;
  const count = Math.max(categories.length, 1);

  const xPos = (i: number) =>
    count === 1 ? pad.left + plotW / 2 : pad.left + (i / (count - 1)) * plotW;
  const yPos = (value: number) => pad.top + plotH - ((value - scale.min) / span) * plotH;
  const baseY = yPos(Math.max(scale.min, Math.min(scale.max, 0)));
  const labelStride = count > 12 ? Math.ceil(count / 8) : 1;

  const seriesGeometry = useMemo(() => {
    return series.map((s, sIdx) => {
      const segments: Point2D[][] = [];
      let current: Point2D[] = [];
      const points: (Point2D | null)[] = [];
      for (let i = 0; i < categories.length; i += 1) {
        const val = stackOn ? (plottedValues[sIdx]?.[i] ?? null) : (s.y[i] ?? null);
        if (val === null) {
          points.push(null);
          if (current.length > 0) {
            segments.push(current);
            current = [];
          }
          continue;
        }
        const pt: Point2D = { x: xPos(i), y: yPos(val) };
        points.push(pt);
        current.push(pt);
      }
      if (current.length > 0) segments.push(current);

      const strokePath = monotoneLinePath(segments);
      const below = stackOn && sIdx > 0 ? plottedValues[sIdx - 1] : undefined;
      const fillPath = !isArea
        ? ''
        : below !== undefined
          ? // Stacked values are running sums with gaps counted as 0, so the
            // series is one unbroken segment.
            monotoneBandPath(
              segments[0] ?? [],
              below.map((value, i) => ({ x: xPos(i), y: yPos(value) })),
            )
          : monotoneAreaPath(segments, baseY);
      return {
        color: seriesColor(sIdx),
        gradientId: `crewaid-area-${uid}-${sIdx}`,
        points,
        strokePath,
        fillPath,
      };
    });
  }, [baseY, categories.length, isArea, plottedValues, series, stackOn, uid, xPos, yPos]);

  const activeEntries = useMemo(() => {
    if (activeIndex === null) return [];
    return series.map((s, idx) => ({
      label: s.name,
      value: formatChartValue(s.y[activeIndex] ?? null, unit),
      color: seriesColor(idx),
    }));
  }, [activeIndex, series, unit]);

  const hitW = count === 1 ? plotW : plotW / (count - 1);

  return (
    <div
      data-slot={isArea ? 'area-chart' : 'line-chart'}
      className={cx('relative w-full select-none', className)}
      onMouseLeave={() => setActiveIndex(null)}
    >
      <svg
        role="img"
        aria-label={ariaLabel}
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="block h-auto w-full overflow-visible"
      >
        {isArea ? (
          <defs>
            {seriesGeometry.map((geo) => (
              <linearGradient key={geo.gradientId} id={geo.gradientId} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={geo.color} stopOpacity={0.26} />
                <stop offset="100%" stopColor={geo.color} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
        ) : null}

        {scale.ticks.map((tick) => {
          const ty = yPos(tick);
          return (
            <g key={tick}>
              <line
                x1={pad.left}
                x2={pad.left + plotW}
                y1={ty}
                y2={ty}
                stroke="var(--muted)"
                strokeOpacity={0.15}
                strokeWidth={1}
              />
              <text
                x={pad.left - 8}
                y={ty + 3.5}
                textAnchor="end"
                fill="var(--muted)"
                fontSize={10}
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {formatChartValue(tick, unit, true)}
              </text>
            </g>
          );
        })}

        {/* Render area fills back-to-front so stacked/layered areas stay legible. */}
        {isArea
          ? [...seriesGeometry]
              .reverse()
              .map((geo) =>
                geo.fillPath === '' ? null : (
                  <path
                    key={`fill-${geo.gradientId}`}
                    d={geo.fillPath}
                    fill={`url(#${geo.gradientId})`}
                  />
                ),
              )
          : null}

        {seriesGeometry.map((geo, sIdx) => (
          <path
            key={`line-${sIdx}`}
            d={geo.strokePath}
            fill="none"
            stroke={geo.color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}

        {activeIndex !== null ? (
          <line
            x1={xPos(activeIndex)}
            x2={xPos(activeIndex)}
            y1={pad.top}
            y2={pad.top + plotH}
            stroke="var(--muted)"
            strokeOpacity={0.55}
            strokeWidth={1}
            strokeDasharray="4 4"
          />
        ) : null}

        {activeIndex !== null
          ? seriesGeometry.map((geo, sIdx) => {
              const pt = geo.points[activeIndex];
              if (pt === null || pt === undefined) return null;
              return (
                <circle
                  key={`dot-${sIdx}`}
                  cx={pt.x}
                  cy={pt.y}
                  r={4.5}
                  fill={geo.color}
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              );
            })
          : null}

        {categories.map((cat, i) => {
          const cxPos = xPos(i);
          const showLabel = i % labelStride === 0 || i === categories.length - 1;
          return (
            <g
              key={`${cat}-${i}`}
              tabIndex={0}
              className="outline-none"
              onMouseEnter={() => setActiveIndex(i)}
              onFocus={() => setActiveIndex(i)}
              onBlur={() => setActiveIndex((prev) => (prev === i ? null : prev))}
            >
              <rect
                x={Math.max(pad.left, cxPos - hitW / 2)}
                y={pad.top}
                width={hitW}
                height={plotH}
                fill="transparent"
              />
              {showLabel ? (
                <text
                  x={cxPos}
                  y={pad.top + plotH + 18}
                  textAnchor="middle"
                  fill="var(--muted)"
                  fontSize={10}
                >
                  {truncateTick(cat, count > 8 ? 8 : 12)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>

      {activeIndex !== null ? (
        <ChartTooltip.Overlay
          xPct={(xPos(activeIndex) / VB_W) * 100}
          yPct={20}
          header={categories[activeIndex]}
          entries={activeEntries}
          indicator="line"
        />
      ) : null}
    </div>
  );
}

/** Compact inline sparkline used inside KPI tiles. */
export function Sparkline({
  values,
  color = 'var(--chart-1)',
  className,
}: {
  readonly values: readonly number[];
  readonly color?: string;
  readonly className?: string;
}) {
  const uid = useId();
  if (values.length < 2) return null;

  const width = 120;
  const height = 32;
  const padY = 4;
  let min = values[0]!;
  let max = values[0]!;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  const pts: Point2D[] = values.map((v, i) => ({
    x: (i / (values.length - 1)) * width,
    y: padY + (height - padY * 2) * (1 - (v - min) / span),
  }));
  const strokePath = monotoneLinePath([pts]);
  const fillPath = monotoneAreaPath([pts], height);
  const gradId = `crewaid-spark-${uid}`;

  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cx('block h-8 w-full', className)}
    >
      <defs>
        <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0.02} />
        </linearGradient>
      </defs>
      <path d={fillPath} fill={`url(#${gradId})`} />
      <path
        d={strokePath}
        fill="none"
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
