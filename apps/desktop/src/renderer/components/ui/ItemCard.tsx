import type { ComponentPropsWithRef, CSSProperties } from 'react';
import { cx } from './compose';

/**
 * A small titled tile: icon, title and a sentence or two. Descriptions wrap;
 * a caller that wants a single line clamps it.
 */

type Variant = 'default' | 'outline' | 'transparent';

const surface: Record<Variant, string> = {
  default: 'bg-surface shadow-[var(--surface-shadow)]',
  outline: 'border border-border bg-surface/60',
  transparent: 'bg-transparent',
};

export interface ItemCardRootProps extends ComponentPropsWithRef<'div'> {
  readonly variant?: Variant;
}

export function ItemCardRoot({ className, variant = 'default', ...props }: ItemCardRootProps) {
  return (
    <div
      data-slot="item-card"
      data-variant={variant}
      className={cx(
        'flex min-w-0 items-center gap-3 rounded-card px-4 py-3',
        surface[variant],
        className,
      )}
      {...props}
    />
  );
}

export function ItemCardIcon({ className, ...props }: ComponentPropsWithRef<'span'>) {
  return (
    <span
      data-slot="item-card-icon"
      className={cx(
        'grid size-9 shrink-0 place-items-center rounded-[10px] bg-default text-foreground [&_svg]:size-4',
        className,
      )}
      {...props}
    />
  );
}

export function ItemCardContent({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      data-slot="item-card-content"
      className={cx('flex min-w-0 flex-1 flex-col', className)}
      {...props}
    />
  );
}

export function ItemCardTitle({ className, ...props }: ComponentPropsWithRef<'span'>) {
  return (
    <span
      data-slot="item-card-title"
      className={cx('text-footnote font-medium text-foreground', className)}
      {...props}
    />
  );
}

export function ItemCardDescription({ className, ...props }: ComponentPropsWithRef<'span'>) {
  return (
    <span
      data-slot="item-card-description"
      className={cx('mt-0.5 text-caption text-muted', className)}
      {...props}
    />
  );
}

export const ItemCard = Object.assign(ItemCardRoot, {
  Root: ItemCardRoot,
  Icon: ItemCardIcon,
  Content: ItemCardContent,
  Title: ItemCardTitle,
  Description: ItemCardDescription,
});

export interface ItemCardGroupRootProps extends ComponentPropsWithRef<'div'> {
  readonly layout?: 'grid' | 'list';
  /** Grid columns; the grid shares the width evenly however long a card's text is. */
  readonly columns?: number;
  readonly variant?: 'default' | 'transparent';
}

export function ItemCardGroupRoot({
  className,
  columns = 2,
  layout = 'list',
  style,
  variant = 'default',
  ...props
}: ItemCardGroupRootProps) {
  const grid: CSSProperties | undefined =
    layout === 'grid' ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined;
  return (
    <div
      data-slot="item-card-group"
      data-layout={layout}
      className={cx(
        layout === 'grid' ? 'grid gap-3' : 'flex flex-col',
        variant === 'default' && 'overflow-hidden rounded-card bg-surface',
        className,
      )}
      style={{ ...grid, ...style }}
      {...props}
    />
  );
}

export const ItemCardGroup = Object.assign(ItemCardGroupRoot, {
  Root: ItemCardGroupRoot,
});
