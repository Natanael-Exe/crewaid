import type { ComponentPropsWithRef } from 'react';
import { cx } from './compose';

/**
 * The board's frame: columns side by side, each with a header (title and
 * count) above a body the screen fills with cards. Dragging and dropping
 * stays with the screen, which owns the order.
 */

export function KanbanRoot({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return <div data-slot="kanban" className={cx('flex items-start gap-3', className)} {...props} />;
}

export function KanbanColumn({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div data-slot="kanban-column" className={cx('flex min-w-0 flex-col', className)} {...props} />
  );
}

export function KanbanColumnHeader({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      data-slot="kanban-column-header"
      className={cx('flex min-h-6 items-center justify-between gap-2', className)}
      {...props}
    />
  );
}

export function KanbanColumnTitle({ className, ...props }: ComponentPropsWithRef<'span'>) {
  return <span data-slot="kanban-column-title" className={cx('truncate', className)} {...props} />;
}

export function KanbanColumnCount({ className, ...props }: ComponentPropsWithRef<'span'>) {
  return (
    <span
      data-slot="kanban-column-count"
      className={cx('shrink-0 text-caption', className)}
      {...props}
    />
  );
}

export function KanbanColumnBody({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      data-slot="kanban-column-body"
      className={cx('flex min-h-10 flex-col', className)}
      {...props}
    />
  );
}

export const Kanban = Object.assign(KanbanRoot, {
  Root: KanbanRoot,
  Column: KanbanColumn,
  ColumnHeader: KanbanColumnHeader,
  ColumnTitle: KanbanColumnTitle,
  ColumnCount: KanbanColumnCount,
  ColumnBody: KanbanColumnBody,
});
