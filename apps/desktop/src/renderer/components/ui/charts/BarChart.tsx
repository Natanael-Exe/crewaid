import { useMemo, useState } from 'react';
import { ChartTooltip } from '../ChartTooltip';
import { cx } from '../compose';
import { formatChartValue, niceScale, seriesColor, truncateTick } from './chartMath';

export interface BarChartSeries {
  readonly name: string;
  readonly y: readonly (number | null)[];
}

export interface BarChartProps {
  readonly categories: readonly string[];
  readonly series: readonly BarChartSeries[];
  readonly orientation?: 'vertical' | 'horizontal';
  readonly stacked?: boolean;
  readonly unit?: string;
  readonly ariaLabel: string;
  readonly className?: string;
}

const VB_W = 560;
const VERT_H = 240;

export function BarChart({
  categories,
  series,
  orientation = 'vertical',
  stacked = false,
  unit,
  ariaLabel,
  className,
}: BarChartProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const scale = useMemo(() => {
    let minVal = 0;
    let maxVal = 0;
    if (stacked && series.length > 1) {
      for (let i = 0; i < categories.length; i += 1) {
        let pos = 0;
        let neg = 0;
        for (const s of series) {
          const v = s.y[i];
          if (v === null || v === undefined) continue;
          if (v >= 0) pos += v;
          else neg += v;
        }
        if (pos > maxVal) maxVal = pos;
        if (neg < minVal) minVal = neg;
      }
    } else {
      for (const s of series) {
        for (const v of s.y) {
          if (v === null) continue;
          if (v > maxVal) maxVal = v;
          if (v < minVal) minVal = v;
        }
      }
    }
    return niceScale(minVal, maxVal, { tickCount: 5, anchorZero: true });
  }, [categories.length, series, stacked]);

  const span = scale.max - scale.min || 1;
  const activeEntries = useMemo(() => {
    if (activeIndex === null) return [];
    return series.map((s, idx) => ({
      label: s.name,
      value: formatChartValue(s.y[activeIndex] ?? null, unit),
      color: seriesColor(idx),
    }));
  }, [activeIndex, series, unit]);

  if (orientation === 'horizontal') {
    const rowH = Math.max(30, Math.min(40, Math.floor(260 / Math.max(categories.length, 1))));
    const pad = { top: 8, right: 56, bottom: 26, left: 112 };
    const plotW = VB_W - pad.left - pad.right;
    const plotH = Math.max(110, categories.length * rowH);
    const vbH = plotH + pad.top + pad.bottom;
    const xPos = (value: number) => pad.left + ((value - scale.min) / span) * plotW;
    const zeroX = xPos(0);
    const singleSeries = series.length === 1;

    return (
      <div
        data-slot="bar-chart"
        data-orientation="horizontal"
        className={cx('relative w-full select-none', className)}
        onMouseLeave={() => setActiveIndex(null)}
      >
        <svg
          role="img"
          aria-label={ariaLabel}
          viewBox={`0 0 ${VB_W} ${vbH}`}
          className="block h-auto w-full overflow-visible"
        >
          {scale.ticks.map((tick) => {
            const tx = xPos(tick);
            return (
              <g key={tick}>
                <line
                  x1={tx}
                  x2={tx}
                  y1={pad.top}
                  y2={pad.top + plotH}
                  stroke="var(--muted)"
                  strokeOpacity={tick === 0 ? 0.25 : 0.14}
                  strokeWidth={1}
                />
                <text
                  x={tx}
                  y={pad.top + plotH + 16}
                  textAnchor="middle"
                  fill="var(--muted)"
                  fontSize={10}
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {formatChartValue(tick, unit, true)}
                </text>
              </g>
            );
          })}

          {categories.map((cat, i) => {
            const slotY = pad.top + i * rowH;
            const innerPad = 5;
            const availH = Math.max(8, rowH - innerPad * 2);
            const hovered = activeIndex === i;

            let posCursor = 0;
            let negCursor = 0;

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
                  x={pad.left}
                  y={slotY}
                  width={plotW}
                  height={rowH}
                  rx={4}
                  fill="currentColor"
                  fillOpacity={hovered ? 0.05 : 0}
                />
                <text
                  x={pad.left - 8}
                  y={slotY + rowH / 2 + 3.5}
                  textAnchor="end"
                  fill="var(--muted)"
                  fontSize={11}
                >
                  {truncateTick(cat, 16)}
                </text>

                {series.map((s, sIdx) => {
                  const raw = s.y[i];
                  if (raw === null || raw === undefined) return null;
                  if (stacked && series.length > 1) {
                    const base = raw >= 0 ? posCursor : negCursor;
                    const end = base + raw;
                    if (raw >= 0) posCursor = end;
                    else negCursor = end;
                    const x0 = xPos(Math.min(base, end));
                    const w = Math.max(1.5, Math.abs(xPos(end) - xPos(base)));
                    return (
                      <rect
                        key={`${s.name}-${sIdx}`}
                        x={x0}
                        y={slotY + innerPad}
                        width={w}
                        height={availH}
                        rx={3}
                        fill={seriesColor(sIdx)}
                        fillOpacity={hovered || activeIndex === null ? 0.92 : 0.65}
                      />
                    );
                  }
                  const barGap = 2;
                  const barH = Math.max(4, (availH - barGap * (series.length - 1)) / series.length);
                  const by = slotY + innerPad + sIdx * (barH + barGap);
                  const x0 = raw >= 0 ? zeroX : xPos(raw);
                  const w = Math.max(1.5, Math.abs(xPos(raw) - zeroX));
                  return (
                    <g key={`${s.name}-${sIdx}`}>
                      <rect
                        x={x0}
                        y={by}
                        width={w}
                        height={barH}
                        rx={3}
                        fill={seriesColor(sIdx)}
                        fillOpacity={hovered || activeIndex === null ? 0.92 : 0.65}
                      />
                      {singleSeries ? (
                        <text
                          x={x0 + w + 6}
                          y={by + barH / 2 + 3.5}
                          textAnchor="start"
                          fill="var(--foreground)"
                          fontSize={10}
                          fontWeight={500}
                          style={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                          {formatChartValue(raw, unit, true)}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>

        {activeIndex !== null ? (
          <ChartTooltip.Overlay
            xPct={52}
            yPct={((pad.top + (activeIndex + 0.5) * rowH) / vbH) * 100}
            header={categories[activeIndex]}
            entries={activeEntries}
          />
        ) : null}
      </div>
    );
  }

  // Vertical bar chart
  const pad = { top: 12, right: 12, bottom: 32, left: 50 };
  const plotW = VB_W - pad.left - pad.right;
  const plotH = VERT_H - pad.top - pad.bottom;
  const yPos = (value: number) => pad.top + plotH - ((value - scale.min) / span) * plotH;
  const zeroY = yPos(0);
  const count = Math.max(categories.length, 1);
  const stepW = plotW / count;
  const labelStride = count > 12 ? Math.ceil(count / 8) : 1;

  return (
    <div
      data-slot="bar-chart"
      data-orientation="vertical"
      className={cx('relative w-full select-none', className)}
      onMouseLeave={() => setActiveIndex(null)}
    >
      <svg
        role="img"
        aria-label={ariaLabel}
        viewBox={`0 0 ${VB_W} ${VERT_H}`}
        className="block h-auto w-full overflow-visible"
      >
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
                strokeOpacity={tick === 0 ? 0.25 : 0.14}
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

        {categories.map((cat, i) => {
          const slotX = pad.left + i * stepW;
          const hovered = activeIndex === i;
          const groupW = Math.min(48, Math.max(8, stepW * 0.68));
          const groupX = slotX + (stepW - groupW) / 2;
          const showLabel = i % labelStride === 0 || i === categories.length - 1;

          let posCursor = 0;
          let negCursor = 0;

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
                x={slotX + 1}
                y={pad.top}
                width={Math.max(2, stepW - 2)}
                height={plotH}
                rx={4}
                fill="currentColor"
                fillOpacity={hovered ? 0.05 : 0}
              />

              {series.map((s, sIdx) => {
                const raw = s.y[i];
                if (raw === null || raw === undefined) return null;
                if (stacked && series.length > 1) {
                  const base = raw >= 0 ? posCursor : negCursor;
                  const end = base + raw;
                  if (raw >= 0) posCursor = end;
                  else negCursor = end;
                  const topY = yPos(Math.max(base, end));
                  const botY = yPos(Math.min(base, end));
                  const h = Math.max(1.5, botY - topY);
                  return (
                    <rect
                      key={`${s.name}-${sIdx}`}
                      x={groupX}
                      y={topY}
                      width={groupW}
                      height={h}
                      rx={3}
                      fill={seriesColor(sIdx)}
                      fillOpacity={hovered || activeIndex === null ? 0.92 : 0.65}
                    />
                  );
                }

                const gap = series.length > 1 ? 2 : 0;
                const barW = Math.max(3, (groupW - gap * (series.length - 1)) / series.length);
                const bx = groupX + sIdx * (barW + gap);
                const topY = raw >= 0 ? yPos(raw) : zeroY;
                const h = Math.max(1.5, Math.abs(yPos(raw) - zeroY));
                return (
                  <rect
                    key={`${s.name}-${sIdx}`}
                    x={bx}
                    y={topY}
                    width={barW}
                    height={h}
                    rx={3}
                    fill={seriesColor(sIdx)}
                    fillOpacity={hovered || activeIndex === null ? 0.92 : 0.65}
                  />
                );
              })}

              {showLabel ? (
                <text
                  x={slotX + stepW / 2}
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
          xPct={((pad.left + (activeIndex + 0.5) * stepW) / VB_W) * 100}
          yPct={22}
          header={categories[activeIndex]}
          entries={activeEntries}
        />
      ) : null}
    </div>
  );
}
