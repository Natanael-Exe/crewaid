import {
  DropdownItem,
  DropdownItemIndicator,
  DropdownSection,
  DropdownSubmenuIndicator,
  DropdownSubmenuTrigger,
} from '@heroui/react';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ComponentPropsWithRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Menu,
  Popover,
  Separator,
  type MenuProps,
  type PopoverProps,
} from 'react-aria-components/Menu';
import { PopoverContext } from 'react-aria-components/Popover';
import { cx, composeTwRenderProps } from './compose';

/**
 * A menu opened at the pointer (a right-click) instead of under a button.
 *
 * The screen decides whether it is open and where; this puts an invisible
 * anchor at that point and opens a popover on it. The popover and menu wear
 * HeroUI's dropdown classes and the items are HeroUI's dropdown items, so a
 * context menu looks and behaves like every other menu in the app. Submenus
 * nest through `SubmenuTrigger` as usual.
 */

type Point = { readonly x: number; readonly y: number };

const ContextMenuContext = createContext<{
  readonly anchor: RefObject<HTMLDivElement | null>;
  readonly at: Point | null;
  readonly isOpen: boolean;
  readonly close: () => void;
}>({ anchor: { current: null }, at: null, isOpen: false, close: () => undefined });

export interface ContextMenuRootProps {
  readonly children: ReactNode;
  readonly open: boolean;
  readonly anchorPoint: Point | null;
  readonly onOpenChange: (open: boolean) => void;
}

export function ContextMenuRoot({
  anchorPoint,
  children,
  onOpenChange,
  open,
}: ContextMenuRootProps) {
  const anchor = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const value = useMemo(
    () => ({ anchor, at: anchorPoint, isOpen: open && anchorPoint !== null, close }),
    [anchorPoint, close, open],
  );
  return (
    <ContextMenuContext value={value}>
      {anchorPoint !== null && typeof document !== 'undefined'
        ? createPortal(
            // On <body> and fixed to the viewport: a blurred or transformed
            // ancestor (the frosted sidebar) would otherwise become the
            // containing block and shift the anchor. Physical left/top match
            // the pointer's clientX/clientY in either reading direction.
            <div
              ref={anchor}
              aria-hidden
              style={{
                position: 'fixed',
                left: anchorPoint.x,
                top: anchorPoint.y,
                width: 0,
                height: 0,
                pointerEvents: 'none',
              }}
            />,
            document.body,
          )
        : null}
      {children}
    </ContextMenuContext>
  );
}

export type ContextMenuPopoverProps = Omit<PopoverProps, 'triggerRef' | 'isOpen' | 'onOpenChange'>;

export function ContextMenuPopover({ className, offset = 2, ...props }: ContextMenuPopoverProps) {
  const { anchor, at, close, isOpen } = useContext(ContextMenuContext);
  const parentPopover = useContext(PopoverContext);
  const styles = composeTwRenderProps(className, 'dropdown__popover min-w-[200px]');
  // Inside a SubmenuTrigger, React Aria already wires the popover to its item.
  if (parentPopover !== null) {
    return (
      <Popover data-slot="context-menu-popover" offset={offset} className={styles} {...props} />
    );
  }
  return (
    <Popover
      // A new point is a new menu: remount so it positions at the new anchor.
      key={at === null ? 'closed' : `${at.x},${at.y}`}
      data-slot="context-menu-popover"
      triggerRef={anchor}
      isOpen={isOpen}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      placement="bottom start"
      offset={offset}
      className={styles}
      {...props}
    />
  );
}

export function ContextMenuMenu<T extends object>({ className, onClose, ...props }: MenuProps<T>) {
  const { close } = useContext(ContextMenuContext);
  return (
    <Menu
      data-slot="context-menu-menu"
      onClose={onClose ?? close}
      className={composeTwRenderProps(className, 'dropdown__menu')}
      {...props}
    />
  );
}

export function ContextMenuSeparator({
  className,
  ...props
}: ComponentPropsWithRef<typeof Separator>) {
  return (
    <Separator
      data-slot="context-menu-separator"
      className={cx('separator my-1', className)}
      {...props}
    />
  );
}

export const ContextMenu = Object.assign(ContextMenuRoot, {
  Root: ContextMenuRoot,
  Popover: ContextMenuPopover,
  Menu: ContextMenuMenu,
  Separator: ContextMenuSeparator,
  Item: DropdownItem,
  ItemIndicator: DropdownItemIndicator,
  Section: DropdownSection,
  SubmenuTrigger: DropdownSubmenuTrigger,
  SubmenuIndicator: DropdownSubmenuIndicator,
});
