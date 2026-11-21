import { createPortal } from 'react-dom';
import { Button, Modal, useOverlayState } from '@heroui/react';
import {
  IconBellRinging,
  IconCheck,
  IconChevronRight,
  IconCopy,
  IconEraser,
  IconEyeOff,
  IconFolder,
  IconFolderPlus,
  IconLock,
  IconPencil,
  IconPin,
  IconPinnedOff,
  IconTrash,
} from '@tabler/icons-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { isRtlLocale, type Bot, type BotGroup } from '@crewaid/shared';
import { listDeliverables, useApiClient } from '../api';
import { useLocale, useT, t } from '../i18n/i18n';

/** The screen point where a bot's context menu was requested. */
export type BotMenuPosition = {
  readonly x: number;
  readonly y: number;
};

/**
 * The menu's entries, as data.
 *
 * The schema only gives the sidebar five real actions. Keeping the list next
 * to the routing code makes adding an entry without wiring its click behavior
 * difficult to do accidentally.
 */
const BOT_MENU_LABELS = {
  pin: 'bots.menu.pin',
  move: 'bots.menu.move',
  unread: 'bots.menu.unread',
  edit: 'bots.menu.edit',
  duplicate: 'bots.menu.duplicate',
  hide: 'bots.menu.hide',
  clear: 'bots.menu.clear',
  delete: 'bots.menu.delete',
} as const;

// Getters: the list is built at import, and a label read then would stay in
// that moment's language.
export const BOT_MENU_ITEMS = (
  Object.keys(BOT_MENU_LABELS) as Array<keyof typeof BOT_MENU_LABELS>
).map((id) => ({
  id,
  get label() {
    return t(BOT_MENU_LABELS[id]);
  },
}));

export type BotMenuAction = keyof typeof BOT_MENU_LABELS;

const MENU_WIDTH = 236;
const MENU_MARGIN = 8;
/** The "Move to" flyout's width, used to decide which side it opens on. */
const FLYOUT_WIDTH = 220;

/** Open in reading order, using the other side when the viewport has no room. */
export function botMoveFlyoutX(menuX: number, viewportWidth: number, rtl: boolean): number {
  const before = menuX - FLYOUT_WIDTH + 6;
  const after = menuX + MENU_WIDTH - 6;
  const preferred = rtl ? before : after;
  const alternate = rtl ? after : before;
  const fits = preferred >= MENU_MARGIN && preferred + FLYOUT_WIDTH <= viewportWidth - MENU_MARGIN;
  return Math.max(
    MENU_MARGIN,
    Math.min(fits ? preferred : alternate, viewportWidth - FLYOUT_WIDTH - MENU_MARGIN),
  );
}

/**
 * What deleting a bot takes, counted: its deliverables go
 * with it, its tasks stay. `null` while the count is still being read.
 */
export function deleteBotConsequence(deliverables: number | null): string {
  return deliverables !== null && deliverables > 0
    ? t('bots.delete.consequenceWith', { count: deliverables })
    : t('bots.delete.consequence');
}

/**
 * Bot actions are deliberately opened from the row's native context-menu
 * gesture. A fixed-position menu escapes the virtualized list and the
 * resizable sidebar, so it remains usable when the row has almost no spare
 * horizontal room.
 */
export function BotRowMenu({
  bot,
  position = null,
  onClose = () => undefined,
  onEditProfile,
  onTogglePin,
  onHide,
  onDuplicate,
  onClearChat,
  onDelete,
  groups,
  onMoveToGroup,
  onNewGroup,
  onMarkUnread,
}: {
  bot: Pick<Bot, 'id' | 'name' | 'pinned' | 'groupId'> & Partial<Pick<Bot, 'kind'>>;
  position?: BotMenuPosition | null;
  onClose?: () => void;
  onEditProfile: () => void;
  onTogglePin: () => void;
  onHide: () => void;
  onDuplicate: () => void;
  /** Opens the shell's confirmation, which asks about memory. */
  onClearChat: () => void;
  onDelete: () => void;
  /** Every group, for "Move to". */
  groups: readonly BotGroup[];
  onMoveToGroup: (groupId: string | null) => void;
  onNewGroup: () => void;
  onMarkUnread: () => void;
}) {
  const t = useT();
  const rtl = isRtlLocale(useLocale());
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // The "Move to" flyout, and the menu row it hangs from.
  const [moveOpen, setMoveOpen] = useState(false);
  const moveRowRef = useRef<HTMLDivElement | null>(null);
  const flyoutRef = useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<BotMenuPosition | null>(position);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const confirmOverlay = useOverlayState({
    isOpen: confirmingDelete,
    onOpenChange: setConfirmingDelete,
  });
  // Deleting a bot takes what it produced, so the
  // confirmation says how much — read when it opens, never before.
  const client = useApiClient();
  const [deliverables, setDeliverables] = useState<number | null>(null);
  useEffect(() => {
    if (!confirmingDelete) return;
    let live = true;
    setDeliverables(null);
    listDeliverables(client, { botId: bot.id, limit: 1 })
      .then((page) => {
        if (live) setDeliverables(page.total);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [confirmingDelete, client, bot.id]);

  useEffect(() => {
    setMenuPosition(position);
    setMoveOpen(false);
  }, [position]);

  // Keep the menu inside the application viewport when the operator
  // right-clicks near the bottom or right edge of the window.
  useLayoutEffect(() => {
    if (
      position === null ||
      menuPosition === null ||
      menuRef.current === null ||
      typeof window === 'undefined'
    )
      return;
    const rect = menuRef.current.getBoundingClientRect();
    const width = Math.max(rect.width, MENU_WIDTH);
    const nextPosition = {
      x: Math.max(MENU_MARGIN, Math.min(position.x, window.innerWidth - width - MENU_MARGIN)),
      y: Math.max(
        MENU_MARGIN,
        Math.min(position.y, window.innerHeight - rect.height - MENU_MARGIN),
      ),
    };
    if (nextPosition.x !== menuPosition.x || nextPosition.y !== menuPosition.y) {
      setMenuPosition(nextPosition);
    }
  }, [menuPosition, position]);

  useEffect(() => {
    if (position === null) return undefined;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      // The flyout is outside the menu's box (the menu clips its overflow),
      // so a press inside it has to count as inside the menu.
      const inside =
        target instanceof Node &&
        (menuRef.current?.contains(target) === true ||
          flyoutRef.current?.contains(target) === true);
      if (!inside) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;

      const items = menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"] button',
      );
      if (items === undefined || items.length === 0) return;
      event.preventDefault();
      const current = Array.from(items).indexOf(document.activeElement as HTMLButtonElement);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = current < 0 ? 0 : (current + delta + items.length) % items.length;
      items[next]?.focus();
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, position]);

  useEffect(() => {
    if (position === null || menuPosition === null) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"] button')?.focus();
  }, [menuPosition, position]);

  const protectedAssistant = bot.kind === 'MAIN';

  const handleAction = (action: BotMenuAction) => {
    if (protectedAssistant && ['pin', 'move', 'duplicate', 'hide', 'delete'].includes(action))
      return;
    onClose();
    if (action === 'pin') onTogglePin();
    if (action === 'edit') onEditProfile();
    if (action === 'duplicate') onDuplicate();
    if (action === 'hide') onHide();
    if (action === 'clear') onClearChat();
    if (action === 'delete') setConfirmingDelete(true);
    if (action === 'unread') onMarkUnread();
  };

  /** A choice in the flyout: act, then close the whole menu. */
  const moveTo = (groupId: string | null) => {
    onClose();
    if (groupId !== (bot.groupId ?? null)) onMoveToGroup(groupId);
  };

  const flyout = (() => {
    if (!moveOpen || menuPosition === null) return null;
    const row = moveRowRef.current?.getBoundingClientRect();
    const top = row?.top ?? menuPosition.y;
    const left = botMoveFlyoutX(
      menuPosition.x,
      typeof window === 'undefined' ? Infinity : window.innerWidth,
      rtl,
    );
    const current = bot.groupId ?? null;
    return (
      <div
        ref={flyoutRef}
        role="menu"
        aria-label={t('bots.moveTo', { name: bot.name })}
        className="fixed z-50 overflow-hidden rounded-[14px] border border-border bg-surface p-1.5 text-foreground shadow-[0_18px_45px_rgba(28,25,23,0.16)]"
        style={{ left, top: top - 6, width: FLYOUT_WIDTH }}
      >
        {groups.map((group) => (
          <ContextMenuItem
            key={group.id}
            icon={
              group.id === current ? (
                <IconCheck className="size-[17px]" stroke={1.8} />
              ) : (
                <IconFolder className="size-[17px]" stroke={1.8} />
              )
            }
            onPress={() => moveTo(group.id)}
          >
            {group.name}
          </ContextMenuItem>
        ))}
        <ContextMenuItem
          icon={
            current === null ? (
              <IconCheck className="size-[17px]" stroke={1.8} />
            ) : (
              <IconFolder className="size-[17px]" stroke={1.8} />
            )
          }
          onPress={() => moveTo(null)}
        >
          {t('bots.botRowMenu.unassigned')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          icon={<IconFolderPlus className="size-[17px]" stroke={1.8} />}
          onPress={() => {
            onClose();
            onNewGroup();
          }}
        >
          {t('bots.botRowMenu.newGroup')}
        </ContextMenuItem>
      </div>
    );
  })();

  const menu =
    position === null || menuPosition === null ? null : (
      <div
        ref={menuRef}
        role="menu"
        aria-label={t('bots.actionsFor', { name: bot.name })}
        className="fixed z-50 w-[236px] overflow-hidden rounded-[14px] border border-border bg-surface p-1.5 text-foreground shadow-[0_18px_45px_rgba(28,25,23,0.16)]"
        style={{ left: menuPosition.x, top: menuPosition.y }}
      >
        {/* Says why Pin, Move, Hide and Delete are missing. */}
        {protectedAssistant ? (
          <div
            role="presentation"
            className="mb-1 flex items-center gap-2 border-b border-separator px-2.5 pb-2 pt-1 text-[12px] text-muted"
          >
            <IconLock className="size-3.5" stroke={1.8} aria-hidden />
            {t('bots.alwaysPinned', { name: bot.name })}
          </div>
        ) : null}
        {!protectedAssistant ? (
          <>
            <ContextMenuItem
              icon={
                bot.pinned ? (
                  <IconPinnedOff className="size-[17px]" stroke={1.8} />
                ) : (
                  <IconPin className="size-[17px]" stroke={1.8} />
                )
              }
              onPress={() => handleAction('pin')}
            >
              {bot.pinned ? t('bots.botRowMenu.unpin') : t('bots.botRowMenu.pin')}
            </ContextMenuItem>
            <div ref={moveRowRef} onMouseEnter={() => setMoveOpen(true)}>
              <ContextMenuItem
                icon={<IconFolder className="size-[17px]" stroke={1.8} />}
                trailing={
                  <IconChevronRight className="size-4 text-muted rtl:-scale-x-100" stroke={1.8} />
                }
                expanded={moveOpen}
                onPress={() => setMoveOpen((open) => !open)}
              >
                {t('bots.botRowMenu.moveTo')}
              </ContextMenuItem>
            </div>
          </>
        ) : null}
        <div onMouseEnter={() => setMoveOpen(false)}>
          <ContextMenuItem
            icon={<IconBellRinging className="size-[17px]" stroke={1.8} />}
            onPress={() => handleAction('unread')}
          >
            {t('bots.botRowMenu.markAsUnread')}
          </ContextMenuItem>
        </div>
        <ContextMenuSeparator />
        <ContextMenuItem
          icon={<IconPencil className="size-[17px]" stroke={1.8} />}
          onPress={() => handleAction('edit')}
        >
          {t('bots.botRowMenu.editProfile')}
        </ContextMenuItem>
        {!protectedAssistant ? (
          <ContextMenuItem
            icon={<IconCopy className="size-[17px]" stroke={1.8} />}
            onPress={() => handleAction('duplicate')}
          >
            {t('bots.botRowMenu.duplicate')}
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        {!protectedAssistant ? (
          <ContextMenuItem
            icon={<IconEyeOff className="size-[17px]" stroke={1.8} />}
            onPress={() => handleAction('hide')}
          >
            {t('bots.botRowMenu.hideFromSidebar')}
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem
          icon={<IconEraser className="size-[17px]" stroke={1.8} />}
          onPress={() => handleAction('clear')}
        >
          {t('bots.botRowMenu.clearChat')}
        </ContextMenuItem>
        {!protectedAssistant ? (
          <ContextMenuItem
            danger
            icon={<IconTrash className="size-[17px]" stroke={1.8} />}
            onPress={() => handleAction('delete')}
          >
            {t('bots.botRowMenu.delete')}
          </ContextMenuItem>
        ) : null}
      </div>
    );

  return (
    <>
      {typeof document === 'undefined' ? (
        <>
          {menu}
          {flyout}
        </>
      ) : (
        createPortal(
          <>
            {menu}
            {flyout}
          </>,
          document.body,
        )
      )}
      <Modal state={confirmOverlay}>
        <Modal.Backdrop>
          <Modal.Container
            size="cover"
            placement="center"
            className="sm:w-auto h-fit"
            scroll="inside"
          >
            <Modal.Dialog
              aria-label={t('bots.deleteLabel', { name: bot.name })}
              className="flex h-fit w-[380px] max-w-[92vw] flex-col gap-3 rounded-card bg-surface p-5"
            >
              <h2 className="text-[15px] font-semibold">
                {t('bots.deleteTitle', { name: bot.name })}
              </h2>
              <p className="text-[13px] leading-[18px] text-muted">
                {deleteBotConsequence(deliverables)}
              </p>
              <p className="text-[12px] leading-[17px] text-muted">
                {t('bots.botRowMenu.toKeepItsConversationAnd')}
              </p>
              <div className="mt-1 flex justify-end gap-2">
                <Button
                  variant="tertiary"
                  size="sm"
                  onPress={() => setConfirmingDelete(false)}
                  className="h-8 rounded-[10px] text-[12px] font-medium"
                >
                  {t('bots.botRowMenu.cancel')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onPress={() => {
                    setConfirmingDelete(false);
                    onHide();
                  }}
                  className="h-8 rounded-[10px] text-[12px] font-medium"
                >
                  {t('bots.botRowMenu.hideFromSidebar')}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onPress={() => {
                    setConfirmingDelete(false);
                    onDelete();
                  }}
                  className="h-8 rounded-[10px] text-[12px] font-medium"
                >
                  {t('bots.botRowMenu.delete')}
                </Button>
              </div>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}

export function ContextMenuItem({
  children,
  icon,
  trailing,
  expanded,
  danger = false,
  disabled = false,
  onPress,
}: {
  children: string;
  icon: ReactNode;
  /** Drawn at the row's far end — the "Move to" chevron. */
  trailing?: ReactNode;
  /** Set only on an item that opens a submenu. */
  expanded?: boolean;
  danger?: boolean;
  /** Shown but inert — "Move up" on the first group. */
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <div
      role="menuitem"
      aria-disabled={disabled || undefined}
      className="w-full"
      {...(expanded !== undefined && { 'aria-haspopup': 'menu', 'aria-expanded': expanded })}
    >
      <Button
        variant="ghost"
        isDisabled={disabled}
        onPress={onPress}
        className={`flex h-9 w-full items-center justify-start gap-3 rounded-[9px] px-2.5 text-start text-[13px] font-medium outline-none transition-colors hover:bg-background-secondary focus-visible:bg-background-secondary ${danger ? 'text-danger' : 'text-foreground'}`}
      >
        <span className="grid size-5 shrink-0 place-items-center">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{children}</span>
        {trailing}
      </Button>
    </div>
  );
}

export function ContextMenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-separator" />;
}
