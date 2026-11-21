import { createPortal } from 'react-dom';
import { IconArrowDown, IconArrowUp, IconPencil, IconTrash } from '@tabler/icons-react';
import { useEffect, useRef } from 'react';
import type { BotGroup } from '@crewaid/shared';
import { ContextMenuItem, ContextMenuSeparator, type BotMenuPosition } from './BotRowMenu';
import { useT } from '../i18n/i18n';

const MENU_WIDTH = 200;
const MENU_MARGIN = 8;

/**
 * A group header's menu.
 *
 * Rendered by the sidebar OUTSIDE the virtualized list, like the bot row
 * menu, and for a reason that showed on screen: a React Aria menu mounted
 * inside the list's section inherits the list's layout, so it drew
 * full-width with every item a bot row tall.
 */
export function GroupMenu({
  group,
  position,
  onClose,
  canMoveUp,
  canMoveDown,
  onEdit,
  onMove,
  onDelete,
}: {
  group: BotGroup;
  /** Where the header was right-clicked. */
  position: BotMenuPosition;
  onClose: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onEdit: () => void;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
}) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || menuRef.current?.contains(target) !== true) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"] button')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  // Opens at the pointer, kept inside the window.
  const left = Math.max(
    MENU_MARGIN,
    Math.min(
      position.x,
      (typeof window === 'undefined' ? Infinity : window.innerWidth) - MENU_WIDTH - MENU_MARGIN,
    ),
  );

  const menu = (
    <div
      ref={menuRef}
      role="menu"
      aria-label={t('bots.group.label', { name: group.name })}
      className="fixed z-50 overflow-hidden rounded-[14px] border border-border bg-surface p-1.5 text-foreground shadow-[0_18px_45px_rgba(28,25,23,0.16)]"
      style={{ left, top: position.y, width: MENU_WIDTH }}
    >
      <ContextMenuItem
        icon={<IconPencil className="size-[17px]" stroke={1.8} />}
        onPress={() => {
          onClose();
          onEdit();
        }}
      >
        {t('bots.groupMenu.editGroup')}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!canMoveUp}
        icon={<IconArrowUp className="size-[17px]" stroke={1.8} />}
        onPress={() => {
          onClose();
          onMove(-1);
        }}
      >
        {t('bots.groupMenu.moveUp')}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!canMoveDown}
        icon={<IconArrowDown className="size-[17px]" stroke={1.8} />}
        onPress={() => {
          onClose();
          onMove(1);
        }}
      >
        {t('bots.groupMenu.moveDown')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        danger
        icon={<IconTrash className="size-[17px]" stroke={1.8} />}
        onPress={() => {
          onClose();
          onDelete();
        }}
      >
        {t('bots.groupDialog.deleteGroup')}
      </ContextMenuItem>
    </div>
  );
  return typeof document === 'undefined' ? menu : createPortal(menu, document.body);
}
