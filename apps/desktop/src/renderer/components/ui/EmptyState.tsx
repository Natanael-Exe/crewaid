import { createContext, useContext, type ComponentPropsWithRef } from 'react';
import { cx } from './compose';

/**
 * A centred "nothing here yet" block: optional icon, a short title, one line
 * of explanation and an optional action. Sizes only change spacing and type,
 * so a roster, a palette and a full pane all read as the same component.
 */

type Size = 'sm' | 'md' | 'lg';

const SizeContext = createContext<Size>('md');

const rootSpacing: Record<Size, string> = {
  sm: 'gap-3 px-4 py-6',
  md: 'gap-4 px-6 py-10',
  lg: 'gap-5 px-8 py-16',
};

const titleType: Record<Size, string> = {
  sm: 'text-footnote',
  md: 'text-callout',
  lg: 'text-headline',
};

const descriptionType: Record<Size, string> = {
  sm: 'text-caption',
  md: 'text-footnote',
  lg: 'text-callout',
};

export interface EmptyStateRootProps extends ComponentPropsWithRef<'div'> {
  readonly size?: Size;
}

export function EmptyStateRoot({ className, size = 'md', ...props }: EmptyStateRootProps) {
  return (
    <SizeContext value={size}>
      <div
        data-slot="empty-state"
        data-size={size}
        className={cx(
          'flex flex-col items-center justify-center text-center',
          rootSpacing[size],
          className,
        )}
        {...props}
      />
    </SizeContext>
  );
}

export function EmptyStateHeader({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      data-slot="empty-state-header"
      className={cx('flex max-w-sm flex-col items-center gap-1.5', className)}
      {...props}
    />
  );
}

export interface EmptyStateMediaProps extends ComponentPropsWithRef<'div'> {
  readonly variant?: 'default' | 'icon';
}

export function EmptyStateMedia({
  className,
  variant = 'default',
  ...props
}: EmptyStateMediaProps) {
  return (
    <div
      data-slot="empty-state-media"
      data-variant={variant}
      className={cx(
        'mb-1 flex shrink-0 items-center justify-center',
        variant === 'icon' && 'size-10 rounded-xl bg-default text-muted',
        className,
      )}
      {...props}
    />
  );
}

export function EmptyStateTitle({ className, ...props }: ComponentPropsWithRef<'h3'>) {
  const size = useContext(SizeContext);
  return (
    <h3
      data-slot="empty-state-title"
      className={cx('font-medium text-balance text-foreground', titleType[size], className)}
      {...props}
    />
  );
}

export function EmptyStateDescription({ className, ...props }: ComponentPropsWithRef<'p'>) {
  const size = useContext(SizeContext);
  return (
    <p
      data-slot="empty-state-description"
      className={cx('text-pretty text-muted', descriptionType[size], className)}
      {...props}
    />
  );
}

export function EmptyStateContent({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      data-slot="empty-state-content"
      className={cx('flex flex-wrap items-center justify-center gap-2', className)}
      {...props}
    />
  );
}

export const EmptyState = Object.assign(EmptyStateRoot, {
  Root: EmptyStateRoot,
  Header: EmptyStateHeader,
  Media: EmptyStateMedia,
  Title: EmptyStateTitle,
  Description: EmptyStateDescription,
  Content: EmptyStateContent,
});
