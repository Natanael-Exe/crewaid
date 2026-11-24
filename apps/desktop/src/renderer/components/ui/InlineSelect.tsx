import {
  Select,
  type SelectIndicatorProps,
  type SelectPopoverProps,
  type SelectProps,
  type SelectTriggerProps,
  type SelectValueProps,
} from '@heroui/react';
import { IconSelector } from '@tabler/icons-react';
import { cx, composeTwRenderProps } from './compose';

/**
 * HeroUI's Select without the field chrome: the value reads as text in a
 * property row and only gains a tint when hovered or focused, the way a
 * detail pane's properties sit quietly until edited.
 */

export function InlineSelectRoot<T extends object, M extends 'single' | 'multiple' = 'single'>({
  className,
  ...props
}: SelectProps<T, M>) {
  return (
    <Select
      data-slot="inline-select"
      className={composeTwRenderProps(className, 'min-w-0')}
      {...props}
    />
  );
}

export function InlineSelectTrigger({ className, ...props }: SelectTriggerProps) {
  return (
    <Select.Trigger
      data-slot="inline-select-trigger"
      className={composeTwRenderProps(
        className,
        'h-8 min-h-8 gap-1 rounded-lg border-0 bg-transparent px-2 text-footnote shadow-none data-[hovered=true]:bg-default data-[focus-visible=true]:bg-default data-[pressed=true]:bg-default',
      )}
      {...props}
    />
  );
}

export function InlineSelectValue({ className, ...props }: SelectValueProps) {
  return (
    <Select.Value
      data-slot="inline-select-value"
      className={composeTwRenderProps(
        className,
        'text-foreground data-[placeholder=true]:text-muted',
      )}
      {...props}
    />
  );
}

export function InlineSelectIndicator({ children, className, ...props }: SelectIndicatorProps) {
  return (
    <Select.Indicator
      data-slot="inline-select-indicator"
      className={cx('shrink-0 text-muted', className)}
      {...props}
    >
      {children ?? <IconSelector className="size-3.5" stroke={1.75} aria-hidden />}
    </Select.Indicator>
  );
}

export function InlineSelectPopover({
  className,
  placement = 'bottom end',
  ...props
}: SelectPopoverProps) {
  return (
    <Select.Popover
      data-slot="inline-select-popover"
      placement={placement}
      className={composeTwRenderProps(className, 'min-w-52')}
      {...props}
    />
  );
}

export const InlineSelect = Object.assign(InlineSelectRoot, {
  Root: InlineSelectRoot,
  Trigger: InlineSelectTrigger,
  Value: InlineSelectValue,
  Indicator: InlineSelectIndicator,
  Popover: InlineSelectPopover,
});
