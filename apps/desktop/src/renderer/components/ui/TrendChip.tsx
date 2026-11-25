import { Chip } from '@heroui/react';
import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from './compose';

export type TrendDirection = 'up' | 'down' | 'neutral';

const TREND_COLOR: Record<TrendDirection, 'success' | 'danger' | 'default'> = {
  up: 'success',
  down: 'danger',
  neutral: 'default',
};

function TrendArrow({ direction }: { readonly direction: 'up' | 'down' }) {
  return (
    <svg
      aria-hidden
      data-slot="trend-chip-indicator"
      className="size-3 shrink-0"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {direction === 'up' ? (
        <path d="M8 12.5V3.5M4.5 7 8 3.5 11.5 7" />
      ) : (
        <path d="M8 3.5v9M11.5 9 8 12.5 4.5 9" />
      )}
    </svg>
  );
}

export interface TrendChipRootProps extends Omit<
  ComponentPropsWithRef<typeof Chip>,
  'children' | 'color' | 'variant'
> {
  readonly trend?: TrendDirection;
  readonly variant?: 'primary' | 'secondary' | 'soft' | 'tertiary';
  readonly children: ReactNode;
}

export function TrendChipRoot({
  children,
  className,
  size = 'sm',
  trend = 'neutral',
  variant = 'soft',
  ...props
}: TrendChipRootProps) {
  return (
    <Chip
      data-slot="trend-chip"
      data-trend={trend}
      color={TREND_COLOR[trend]}
      size={size}
      variant={variant}
      className={cx('w-fit shrink-0 tabular-nums', className)}
      {...props}
    >
      {trend === 'neutral' ? null : <TrendArrow direction={trend} />}
      <Chip.Label className="tabular-nums">{children}</Chip.Label>
    </Chip>
  );
}

export const TrendChip = Object.assign(TrendChipRoot, {
  Root: TrendChipRoot,
});
