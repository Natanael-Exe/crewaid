import type { ComponentPropsWithRef, CSSProperties, ReactNode } from 'react';
import { cx } from './compose';

export interface ChartTooltipEntry {
  readonly label: string;
  readonly value: string;
  readonly color: string;
}

export function ChartTooltipRoot({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      data-slot="chart-tooltip"
      className={cx(
        'pointer-events-none flex min-w-[144px] flex-col gap-1.5 rounded-[var(--radius)] border border-separator bg-overlay px-3 py-2 shadow-[var(--overlay-shadow)] tabular-nums',
        className,
      )}
      {...props}
    />
  );
}

export function ChartTooltipHeader({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      data-slot="chart-tooltip-header"
      className={cx('text-caption font-medium text-muted', className)}
      {...props}
    />
  );
}

export function ChartTooltipItem({
  label,
  value,
  color,
  indicator = 'dot',
}: ChartTooltipEntry & { readonly indicator?: 'dot' | 'line' }) {
  return (
    <div data-slot="chart-tooltip-item" className="flex items-center gap-2">
      <span
        aria-hidden
        data-slot="chart-tooltip-indicator"
        className={cx('shrink-0 rounded-full', indicator === 'line' ? 'h-3 w-1' : 'size-2')}
        style={{ backgroundColor: color }}
      />
      <span className="min-w-0 flex-1 truncate text-caption text-muted">{label}</span>
      <span className="shrink-0 text-caption font-semibold tabular-nums text-foreground">
        {value}
      </span>
    </div>
  );
}

/**
 * Floating tooltip anchored to a percentage coordinate inside a relative chart
 * container, flipping horizontally past the midpoint so it never clips off the edge.
 */
export function ChartTooltipOverlay({
  xPct,
  yPct,
  header,
  entries,
  indicator = 'dot',
  footer,
}: {
  readonly xPct: number;
  readonly yPct: number;
  readonly header?: string | undefined;
  readonly entries: readonly ChartTooltipEntry[];
  readonly indicator?: 'dot' | 'line';
  readonly footer?: ReactNode;
}) {
  if (entries.length === 0) return null;
  const flipLeft = xPct > 58;
  const clampedX = Math.max(4, Math.min(96, xPct));
  const clampedY = Math.max(8, Math.min(82, yPct));
  const style: CSSProperties = {
    left: `${clampedX}%`,
    top: `${clampedY}%`,
    transform: flipLeft ? 'translate(calc(-100% - 10px), -20%)' : 'translate(10px, -20%)',
  };
  return (
    <div className="pointer-events-none absolute z-10" style={style}>
      <ChartTooltipRoot>
        {header !== undefined && header !== '' ? (
          <ChartTooltipHeader>{header}</ChartTooltipHeader>
        ) : null}
        {entries.map((entry, idx) => (
          <ChartTooltipItem
            key={`${entry.label}-${idx}`}
            label={entry.label}
            value={entry.value}
            color={entry.color}
            indicator={indicator}
          />
        ))}
        {footer}
      </ChartTooltipRoot>
    </div>
  );
}

export const ChartTooltip = Object.assign(ChartTooltipRoot, {
  Root: ChartTooltipRoot,
  Header: ChartTooltipHeader,
  Item: ChartTooltipItem,
  Overlay: ChartTooltipOverlay,
});
