import { CloseButton, type CloseButtonProps } from '@heroui/react';
import type { ComponentPropsWithRef, ReactNode } from 'react';
import {
  Autocomplete,
  useFilter,
  type AutocompleteProps,
} from 'react-aria-components/Autocomplete';
import { Dialog, type DialogProps } from 'react-aria-components/Dialog';
import { Header } from 'react-aria-components/Header';
import { Input, type InputProps } from 'react-aria-components/Input';
import {
  Menu,
  MenuItem,
  MenuSection,
  type MenuItemProps,
  type MenuProps,
  type MenuSectionProps,
} from 'react-aria-components/Menu';
import { Modal, ModalOverlay, type ModalOverlayProps } from 'react-aria-components/Modal';
import { SearchField, type SearchFieldProps } from 'react-aria-components/SearchField';
import { cx, composeTwRenderProps } from './compose';

/**
 * A search palette: a modal with a search field above a list it filters.
 *
 * The overlay, container and dialog wear HeroUI's modal classes, so the
 * room's palette styling (`.crewaid-search-*` in room.css) and the glass layer
 * apply to it exactly as to any other dialog. The list is a React Aria Menu
 * inside an Autocomplete, so arrow keys move through results while the
 * caret stays in the field.
 */

export function CommandRoot({ children }: { readonly children: ReactNode }) {
  return <>{children}</>;
}

export function CommandBackdrop({ className, isDismissable = true, ...props }: ModalOverlayProps) {
  return (
    <ModalOverlay
      data-slot="command-backdrop"
      isDismissable={isDismissable}
      className={composeTwRenderProps(className, 'modal__backdrop')}
      {...props}
    />
  );
}

export function CommandContainer({ className, ...props }: ModalOverlayProps) {
  return (
    <Modal
      data-slot="command-container"
      className={composeTwRenderProps(className, 'modal__container')}
      {...props}
    />
  );
}

export interface CommandDialogProps
  extends
    Omit<DialogProps, 'children'>,
    Pick<
      AutocompleteProps<object>,
      'defaultInputValue' | 'filter' | 'inputValue' | 'onInputChange'
    > {
  readonly children: ReactNode;
}

export function CommandDialog({
  children,
  className,
  defaultInputValue,
  filter,
  inputValue,
  onInputChange,
  ...props
}: CommandDialogProps) {
  const { contains } = useFilter({ sensitivity: 'base' });
  return (
    <Dialog
      data-slot="command-dialog"
      className={cx(
        'modal__dialog flex max-h-[min(70vh,640px)] flex-col overflow-hidden p-0',
        className,
      )}
      {...props}
    >
      <Autocomplete
        filter={filter ?? contains}
        {...(defaultInputValue !== undefined ? { defaultInputValue } : {})}
        {...(inputValue !== undefined ? { inputValue } : {})}
        {...(onInputChange !== undefined ? { onInputChange } : {})}
      >
        {children}
      </Autocomplete>
    </Dialog>
  );
}

export function CommandInputGroup({ autoFocus = true, className, ...props }: SearchFieldProps) {
  return (
    <SearchField
      data-slot="command-input-group"
      autoFocus={autoFocus}
      className={composeTwRenderProps(className, 'flex items-center')}
      {...props}
    />
  );
}

export function CommandInputGroupPrefix({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      data-slot="command-input-group-prefix"
      className={cx('flex shrink-0 items-center', className)}
      {...props}
    />
  );
}

export function CommandInputGroupInput({ onKeyDown, ...props }: InputProps) {
  return (
    <Input
      data-slot="command-input-group-input"
      onKeyDown={(event) => {
        onKeyDown?.(event);
        // Typing belongs to the field: printable keys must not reach the
        // room's global shortcuts underneath the palette.
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.stopPropagation();
        }
      }}
      {...props}
    />
  );
}

export function CommandInputGroupSuffix({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      data-slot="command-input-group-suffix"
      className={cx('flex shrink-0 items-center gap-1.5', className)}
      {...props}
    />
  );
}

export function CommandInputGroupClearButton({ className, ...props }: CloseButtonProps) {
  return (
    <CloseButton
      data-slot="command-input-group-clear-button"
      slot="clear"
      className={composeTwRenderProps(className, 'size-6 min-w-6')}
      {...props}
    />
  );
}

export interface CommandListProps<T extends object> extends Omit<MenuProps<T>, 'renderEmptyState'> {
  readonly renderEmptyState?: () => ReactNode;
}

export function CommandList<T extends object>({
  className,
  renderEmptyState,
  ...props
}: CommandListProps<T>) {
  return (
    <Menu
      data-slot="command-list"
      className={composeTwRenderProps(className, 'flex flex-col gap-0.5 outline-none')}
      {...(renderEmptyState !== undefined
        ? {
            renderEmptyState: () => (
              <div
                data-slot="command-empty"
                className="px-3 py-8 text-center text-footnote text-muted"
              >
                {renderEmptyState()}
              </div>
            ),
          }
        : {})}
      {...props}
    />
  );
}

export function CommandItem<T extends object>({ className, ...props }: MenuItemProps<T>) {
  return (
    <MenuItem
      data-slot="command-item"
      className={composeTwRenderProps(
        className,
        'flex cursor-[var(--cursor-interactive)] items-center gap-2 rounded-lg px-3 py-2 text-footnote text-foreground outline-none data-[focused]:bg-default data-[hovered]:bg-default',
      )}
      {...props}
    />
  );
}

export interface CommandGroupProps<T extends object> extends Omit<MenuSectionProps<T>, 'children'> {
  readonly children?: ReactNode;
  readonly heading?: ReactNode;
}

export function CommandGroup<T extends object>({
  children,
  className,
  heading,
  ...props
}: CommandGroupProps<T>) {
  return (
    <MenuSection
      data-slot="command-group"
      className={cx('flex flex-col gap-0.5 [&:not(:first-child)]:mt-2', className)}
      {...props}
    >
      {heading === undefined || heading === null || heading === false ? null : (
        <Header
          data-slot="command-group-heading"
          className="px-3 pt-1 pb-1 text-micro font-medium text-muted"
        >
          {heading}
        </Header>
      )}
      {children}
    </MenuSection>
  );
}

export const Command = Object.assign(CommandRoot, {
  Root: CommandRoot,
  Backdrop: CommandBackdrop,
  Container: CommandContainer,
  Dialog: CommandDialog,
  InputGroup: CommandInputGroup,
  InputGroupPrefix: CommandInputGroupPrefix,
  InputGroupInput: CommandInputGroupInput,
  InputGroupSuffix: CommandInputGroupSuffix,
  InputGroupClearButton: CommandInputGroupClearButton,
  List: CommandList,
  Item: CommandItem,
  Group: CommandGroup,
});
