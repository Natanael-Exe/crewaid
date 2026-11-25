import { Modal, useOverlayState } from '@heroui/react';
import { IconX } from '@tabler/icons-react';
import { useEffect, type ReactNode } from 'react';
import { cx } from './compose';
import { IconButtonTooltip } from './IconButtonTooltip';

export interface SheetProps {
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The dialog's accessible name. */
  readonly 'aria-label': string;
  /**
   * When set, Escape calls this instead of closing. A sheet with drill-down
   * screens steps back one level first, so Escape never throws away the
   * place the user navigated to.
   */
  readonly onEscape?: (() => void) | undefined;
  readonly className?: string;
  readonly children: ReactNode;
}

/**
 * A full-window spatial overlay: the room blurs out behind a frosted veil and
 * the content floats in a centred column. For focus modes (settings, reading
 * a document) where a boxed dialog would crop what is being read.
 *
 * Built on HeroUI's Modal so focus trapping, scroll locking and focus
 * restoration stay React Aria's.
 */
export function Sheet({
  isOpen,
  onOpenChange,
  'aria-label': ariaLabel,
  onEscape,
  className,
  children,
}: SheetProps) {
  const state = useOverlayState({ isOpen, onOpenChange });
  // On the document, not the sheet's own element: right after a drill-down or
  // returning to the index the control that had focus is gone and focus can sit
  // on the document, where a listener inside the sheet never hears the key. The
  // document hears it after any popover or nested dialog inside the sheet has
  // claimed its own Escape, and before the shell's window-level Escape (which
  // closes an open task behind the sheet).
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      if (onEscape !== undefined) onEscape();
      else onOpenChange(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onEscape, onOpenChange]);
  return (
    <Modal state={state}>
      <Modal.Backdrop className="crewaid-sheet-backdrop" isKeyboardDismissDisabled>
        <Modal.Container size="full" className="crewaid-sheet-container">
          <Modal.Dialog aria-label={ariaLabel} className={cx('crewaid-sheet', className)}>
            <div className="flex h-full min-h-0 w-full flex-col">{children}</div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

/** The round, floating button a sheet's corner carries. */
export function SheetButton({
  label,
  onPress,
  children = <IconX className="size-4" stroke={1.8} aria-hidden />,
  className,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly children?: ReactNode;
  readonly className?: string;
}) {
  return (
    <IconButtonTooltip
      label={label}
      variant="secondary"
      onPress={onPress}
      className={cx('crewaid-sheet-button size-10 min-w-10 shrink-0 rounded-full', className)}
    >
      {children}
    </IconButtonTooltip>
  );
}
