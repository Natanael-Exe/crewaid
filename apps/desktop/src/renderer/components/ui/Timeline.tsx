import { createContext, useContext, type ComponentPropsWithRef } from 'react';
import { cx } from './compose';

/**
 * A vertical history: a dot per event joined by a hairline. The line stops at
 * the last event because the last item hides its connector.
 */

export type TimelineStatus = 'default' | 'complete' | 'current' | 'error' | 'warning';
type Density = 'compact' | 'comfortable' | 'spacious';
type Size = 'sm' | 'md' | 'lg';

const TimelineContext = createContext<{ readonly density: Density; readonly size: Size }>({
  density: 'compact',
  size: 'sm',
});
const ItemStatusContext = createContext<TimelineStatus>('default');

// The gap below an event belongs to its content, not the list item: the rail
// stretches to the item's content box, so padding on the item would stop the
// connector short of the next dot.
const contentSpacing: Record<Density, string> = {
  compact: 'pb-2.5',
  comfortable: 'pb-4',
  spacious: 'pb-6',
};

const markerSize: Record<Size, string> = {
  sm: 'size-2',
  md: 'size-2.5',
  lg: 'size-3',
};

const markerTone: Record<TimelineStatus, string> = {
  default: 'bg-foreground-faint',
  complete: 'bg-success',
  current: 'bg-accent ring-4 ring-accent-soft',
  error: 'bg-danger',
  warning: 'bg-warning',
};

export interface TimelineRootProps extends ComponentPropsWithRef<'ol'> {
  readonly density?: Density;
  readonly size?: Size;
}

export function TimelineRoot({
  className,
  density = 'compact',
  size = 'sm',
  ...props
}: TimelineRootProps) {
  return (
    <TimelineContext value={{ density, size }}>
      <ol data-slot="timeline" className={cx('flex flex-col', className)} {...props} />
    </TimelineContext>
  );
}

export interface TimelineItemProps extends ComponentPropsWithRef<'li'> {
  readonly status?: TimelineStatus;
}

export function TimelineItem({ className, status = 'default', ...props }: TimelineItemProps) {
  return (
    <ItemStatusContext value={status}>
      <li
        data-slot="timeline-item"
        data-status={status}
        aria-current={status === 'current' ? 'true' : undefined}
        className={cx('group/timeline flex gap-3', className)}
        {...props}
      />
    </ItemStatusContext>
  );
}

export function TimelineRail({ children, className, ...props }: ComponentPropsWithRef<'span'>) {
  return (
    <span
      data-slot="timeline-rail"
      className={cx('flex w-3 shrink-0 flex-col items-center pt-1', className)}
      {...props}
    >
      {children ?? (
        <>
          <TimelineMarker />
          <TimelineConnector />
        </>
      )}
    </span>
  );
}

export interface TimelineMarkerProps extends ComponentPropsWithRef<'span'> {
  readonly status?: TimelineStatus;
}

export function TimelineMarker({ className, status, ...props }: TimelineMarkerProps) {
  const { size } = useContext(TimelineContext);
  const itemStatus = useContext(ItemStatusContext);
  const tone = status ?? itemStatus;
  return (
    <span
      aria-hidden
      data-slot="timeline-marker"
      data-status={tone}
      className={cx('shrink-0 rounded-full', markerSize[size], markerTone[tone], className)}
      {...props}
    />
  );
}

export function TimelineConnector({ className, ...props }: ComponentPropsWithRef<'span'>) {
  return (
    <span
      aria-hidden
      data-slot="timeline-connector"
      className={cx('mt-1 w-px flex-1 bg-border group-last/timeline:hidden', className)}
      {...props}
    />
  );
}

export function TimelineContent({ className, ...props }: ComponentPropsWithRef<'div'>) {
  const { density } = useContext(TimelineContext);
  return (
    <div
      data-slot="timeline-content"
      className={cx('min-w-0 flex-1 group-last/timeline:pb-0', contentSpacing[density], className)}
      {...props}
    />
  );
}

export const Timeline = Object.assign(TimelineRoot, {
  Root: TimelineRoot,
  Item: TimelineItem,
  Rail: TimelineRail,
  Marker: TimelineMarker,
  Connector: TimelineConnector,
  Content: TimelineContent,
});
