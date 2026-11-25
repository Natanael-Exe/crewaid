import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from './compose';
import { TrendChip, type TrendChipRootProps } from './TrendChip';

/**
 * Neutral metric tiles and responsive tile grids. Uses subdued secondary
 * surfaces without nested shadows so tiles sit cleanly inside cards.
 */

export function KPIGroupRoot({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      data-slot="kpi-group"
      role="group"
      className={cx(
        'grid grid-cols-[repeat(auto-fit,minmax(min(100%,144px),1fr))] gap-2.5',
        className,
      )}
      {...props}
    />
  );
}

export const KPIGroup = Object.assign(KPIGroupRoot, {
  Root: KPIGroupRoot,
});

export function KPIRoot({ className, ...props }: ComponentPropsWithRef<'dl'>) {
  return (
    <dl
      data-slot="kpi"
      className={cx(
        'm-0 flex min-w-0 flex-col justify-between gap-1.5 rounded-[12px] bg-surface-secondary px-3.5 py-3',
        className,
      )}
      {...props}
    />
  );
}

export function KPIHeader({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      data-slot="kpi-header"
      className={cx('flex min-w-0 items-center justify-between gap-2', className)}
      {...props}
    />
  );
}

export function KPITitle({ className, ...props }: ComponentPropsWithRef<'dt'>) {
  return (
    <dt
      data-slot="kpi-title"
      className={cx('min-w-0 truncate text-caption font-medium text-muted', className)}
      {...props}
    />
  );
}

export function KPIContent({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      data-slot="kpi-content"
      className={cx(
        'flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1',
        className,
      )}
      {...props}
    />
  );
}

export function KPIValue({ className, ...props }: ComponentPropsWithRef<'dd'>) {
  return (
    <dd
      data-slot="kpi-value"
      className={cx(
        'm-0 truncate text-heading font-semibold leading-none tracking-tight tabular-nums text-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function KPITrend(props: TrendChipRootProps) {
  return <TrendChip data-slot="kpi-trend" {...props} />;
}

export function KPISparkline({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      data-slot="kpi-sparkline"
      className={cx(
        'mt-0.5 overflow-hidden [mask-image:linear-gradient(to_right,transparent_0%,black_10%,black_90%,transparent_100%)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function KPIFooter({ className, ...props }: ComponentPropsWithRef<'p'>) {
  return (
    <p
      data-slot="kpi-footer"
      className={cx('m-0 line-clamp-2 text-micro leading-snug text-muted', className)}
      {...props}
    />
  );
}

export const KPI = Object.assign(KPIRoot, {
  Root: KPIRoot,
  Header: KPIHeader,
  Title: KPITitle,
  Content: KPIContent,
  Value: KPIValue,
  Trend: KPITrend,
  Sparkline: KPISparkline,
  Footer: KPIFooter,
});
