/** Pure math & SVG geometry helpers shared by Crewaid's clean-room chart primitives. */

export const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
] as const;

export function seriesColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length]!;
}

export interface AxisScale {
  readonly min: number;
  readonly max: number;
  readonly ticks: readonly number[];
}

function niceStep(range: number, tickCount: number): number {
  const rough = range / Math.max(tickCount - 1, 1);
  if (rough <= 0 || !Number.isFinite(rough)) return 1;
  const exp = Math.floor(Math.log10(rough));
  const base = 10 ** exp;
  const fraction = rough / base;
  const nice =
    fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * base;
}

/**
 * Compute clean human-readable axis bounds and tick values.
 * Anchors at zero when `anchorZero` is true (bar/area charts) or when data spans zero.
 */
export function niceScale(
  rawMin: number,
  rawMax: number,
  options?: { readonly tickCount?: number; readonly anchorZero?: boolean },
): AxisScale {
  const tickCount = options?.tickCount ?? 5;
  const anchorZero = options?.anchorZero ?? true;

  let lo = Number.isFinite(rawMin) ? rawMin : 0;
  let hi = Number.isFinite(rawMax) ? rawMax : 1;

  if (anchorZero) {
    if (lo > 0) lo = 0;
    if (hi < 0) hi = 0;
  }
  if (lo === hi) {
    if (lo === 0) {
      hi = 1;
    } else {
      const pad = Math.abs(lo) * 0.2;
      lo = anchorZero && lo > 0 ? 0 : lo - pad;
      hi = anchorZero && hi < 0 ? 0 : hi + pad;
    }
  }

  const step = niceStep(hi - lo, tickCount);
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  const count = Math.min(Math.round((max - min) / step), 12);
  for (let i = 0; i <= count; i += 1) {
    const val = min + i * step;
    ticks.push(Math.abs(val) < step * 1e-9 ? 0 : Number(val.toPrecision(12)));
  }
  return { min, max, ticks };
}

export function formatChartNumber(value: number, compact = false): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (compact && abs >= 1_000_000_000) {
    return `${Number((value / 1_000_000_000).toFixed(1))}B`;
  }
  if (compact && abs >= 1_000_000) {
    return `${Number((value / 1_000_000).toFixed(1))}M`;
  }
  if (compact && abs >= 10_000) {
    return `${Number((value / 1_000).toFixed(1))}k`;
  }
  return Number.isInteger(value)
    ? value.toLocaleString('en-US')
    : Number(value.toFixed(2)).toLocaleString('en-US');
}

export function formatChartValue(value: number | null, unit?: string, compact = false): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const num = formatChartNumber(value, compact);
  if (unit === undefined || unit === '') return num;
  if (/^[$€£¥]/.test(unit)) {
    return value < 0 ? `-${unit}${formatChartNumber(Math.abs(value), compact)}` : `${unit}${num}`;
  }
  if (unit === '%') return `${num}%`;
  return `${num} ${unit}`;
}

export function truncateTick(label: string, maxChars: number): string {
  if (label.length <= maxChars) return label;
  return `${label.slice(0, Math.max(1, maxChars - 1))}…`;
}

export interface Point2D {
  readonly x: number;
  readonly y: number;
}

/**
 * Fritsch-Carlson monotone cubic Bezier SVG path: smooth curves without
 * overshooting extrema, splitting cleanly across null gaps.
 */
export function monotoneLinePath(segments: readonly (readonly Point2D[])[]): string {
  const parts: string[] = [];
  for (const pts of segments) {
    if (pts.length === 0) continue;
    const p0 = pts[0]!;
    parts.push(`M${p0.x.toFixed(2)},${p0.y.toFixed(2)}`);
    if (pts.length === 1) continue;
    if (pts.length === 2) {
      const p1 = pts[1]!;
      parts.push(`L${p1.x.toFixed(2)},${p1.y.toFixed(2)}`);
      continue;
    }

    const n = pts.length;
    const dx: number[] = [];
    const slopes: number[] = [];
    for (let i = 0; i < n - 1; i += 1) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const d = b.x - a.x;
      dx.push(d);
      slopes.push(d === 0 ? 0 : (b.y - a.y) / d);
    }
    const tangents: number[] = new Array<number>(n).fill(0);
    tangents[0] = slopes[0]!;
    tangents[n - 1] = slopes[n - 2]!;
    for (let i = 1; i < n - 1; i += 1) {
      const prev = slopes[i - 1]!;
      const next = slopes[i]!;
      if (prev * next <= 0) {
        tangents[i] = 0;
      } else {
        const w1 = dx[i - 1]! + 2 * dx[i]!;
        const w2 = 2 * dx[i - 1]! + dx[i]!;
        tangents[i] = (w1 + w2) / (w1 / prev + w2 / next);
      }
    }

    for (let i = 0; i < n - 1; i += 1) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const step = dx[i]! / 3;
      const c1x = a.x + step;
      const c1y = a.y + tangents[i]! * step;
      const c2x = b.x - step;
      const c2y = b.y - tangents[i + 1]! * step;
      parts.push(
        `C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${b.x.toFixed(2)},${b.y.toFixed(2)}`,
      );
    }
  }
  return parts.join(' ');
}

export function monotoneAreaPath(
  segments: readonly (readonly Point2D[])[],
  baselineY: number,
): string {
  const parts: string[] = [];
  for (const pts of segments) {
    if (pts.length < 2) continue;
    const top = monotoneLinePath([pts]);
    const last = pts[pts.length - 1]!;
    const first = pts[0]!;
    parts.push(
      `${top} L${last.x.toFixed(2)},${baselineY.toFixed(2)} L${first.x.toFixed(2)},${baselineY.toFixed(2)} Z`,
    );
  }
  return parts.join(' ');
}

/**
 * A stacked band: the series' own top edge left to right, then the series
 * beneath it right to left. Closing to the zero baseline instead would make
 * every band cover the ones below it.
 */
export function monotoneBandPath(top: readonly Point2D[], bottom: readonly Point2D[]): string {
  if (top.length < 2 || bottom.length < 2) return '';
  const upper = monotoneLinePath([top]);
  const lower = monotoneLinePath([[...bottom].reverse()]).replace(/^M/, 'L');
  return `${upper} ${lower} Z`;
}

/** SVG path for an annular donut wedge (angles in radians, 0 at 12 o'clock, clockwise). */
export function donutSlicePath(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startAngle: number,
  endAngle: number,
): string {
  const sweep = endAngle - startAngle;
  // A full circle cannot be drawn in a single arc command; split into two semicircles.
  if (sweep >= Math.PI * 2 - 1e-4) {
    return [
      `M${(cx + outerR).toFixed(2)},${cy.toFixed(2)}`,
      `A${outerR},${outerR} 0 1 1 ${(cx - outerR).toFixed(2)},${cy.toFixed(2)}`,
      `A${outerR},${outerR} 0 1 1 ${(cx + outerR).toFixed(2)},${cy.toFixed(2)}`,
      `M${(cx + innerR).toFixed(2)},${cy.toFixed(2)}`,
      `A${innerR},${innerR} 0 1 0 ${(cx - innerR).toFixed(2)},${cy.toFixed(2)}`,
      `A${innerR},${innerR} 0 1 0 ${(cx + innerR).toFixed(2)},${cy.toFixed(2)}`,
      'Z',
    ].join(' ');
  }

  const a0 = startAngle - Math.PI / 2;
  const a1 = endAngle - Math.PI / 2;
  const large = sweep > Math.PI ? 1 : 0;

  const ox0 = cx + outerR * Math.cos(a0);
  const oy0 = cy + outerR * Math.sin(a0);
  const ox1 = cx + outerR * Math.cos(a1);
  const oy1 = cy + outerR * Math.sin(a1);

  const ix1 = cx + innerR * Math.cos(a1);
  const iy1 = cy + innerR * Math.sin(a1);
  const ix0 = cx + innerR * Math.cos(a0);
  const iy0 = cy + innerR * Math.sin(a0);

  return [
    `M${ox0.toFixed(2)},${oy0.toFixed(2)}`,
    `A${outerR},${outerR} 0 ${large} 1 ${ox1.toFixed(2)},${oy1.toFixed(2)}`,
    `L${ix1.toFixed(2)},${iy1.toFixed(2)}`,
    `A${innerR},${innerR} 0 ${large} 0 ${ix0.toFixed(2)},${iy0.toFixed(2)}`,
    'Z',
  ].join(' ');
}
