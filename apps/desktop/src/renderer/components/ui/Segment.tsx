import { createContext, useCallback, useContext } from 'react';
import type { Key } from 'react-aria-components';
import { SelectionIndicator } from 'react-aria-components/SelectionIndicator';
import {
  ToggleButton,
  ToggleButtonGroup,
  type ToggleButtonGroupProps,
  type ToggleButtonProps,
} from 'react-aria-components/ToggleButtonGroup';
import { cx } from './compose';

/**
 * A segmented control: one pill track, one choice raised onto paper. Built on
 * React Aria's single-selection ToggleButtonGroup, so arrow keys move between
 * segments and exactly one stays selected.
 */

type Size = 'sm' | 'md' | 'lg';

const SizeContext = createContext<Size>('md');

const itemSize: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-caption',
  md: 'h-8 px-3 text-footnote',
  lg: 'h-9 px-4 text-callout',
};

export interface SegmentRootProps extends Omit<
  ToggleButtonGroupProps,
  | 'defaultSelectedKeys'
  | 'disallowEmptySelection'
  | 'onSelectionChange'
  | 'selectedKeys'
  | 'selectionMode'
> {
  readonly defaultSelectedKey?: Key;
  readonly selectedKey?: Key;
  readonly onSelectionChange?: (key: Key) => void;
  readonly size?: Size;
}

export function SegmentRoot({
  className,
  defaultSelectedKey,
  onSelectionChange,
  selectedKey,
  size = 'md',
  ...props
}: SegmentRootProps) {
  const changed = useCallback(
    (keys: Set<Key>) => {
      const [key] = keys;
      if (key !== undefined) onSelectionChange?.(key);
    },
    [onSelectionChange],
  );
  return (
    <SizeContext value={size}>
      <ToggleButtonGroup
        data-slot="segment"
        selectionMode="single"
        disallowEmptySelection
        orientation="horizontal"
        {...(selectedKey !== undefined ? { selectedKeys: [selectedKey] } : {})}
        {...(defaultSelectedKey !== undefined ? { defaultSelectedKeys: [defaultSelectedKey] } : {})}
        onSelectionChange={changed}
        className={cx(
          'inline-flex w-fit items-center gap-0.5 rounded-full bg-default p-0.5',
          className,
        )}
        {...props}
      />
    </SizeContext>
  );
}

export function SegmentItem({ children, className, ...props }: ToggleButtonProps) {
  const size = useContext(SizeContext);
  return (
    <ToggleButton
      data-slot="segment-item"
      className={cx(
        'relative isolate inline-flex min-w-0 cursor-[var(--cursor-interactive)] items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium text-muted outline-none',
        'data-[hovered]:text-foreground data-[selected]:text-foreground data-[disabled]:opacity-50',
        'data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-1 data-[focus-visible]:outline-focus',
        itemSize[size],
        className,
      )}
      {...props}
    >
      {(state) => (
        <>
          <SelectionIndicator
            data-slot="segment-indicator"
            className="absolute inset-0 -z-10 rounded-full bg-surface shadow-[var(--surface-shadow)] transition-[translate,width] duration-200 ease-out motion-reduce:transition-none"
          />
          {typeof children === 'function' ? children(state) : children}
        </>
      )}
    </ToggleButton>
  );
}

export const Segment = Object.assign(SegmentRoot, {
  Root: SegmentRoot,
  Item: SegmentItem,
});
