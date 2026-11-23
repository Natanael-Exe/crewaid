import { Button, Modal, useOverlayState } from '@heroui/react';
import {
  IconBellRinging,
  IconCheck,
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
import { useEffect, useState } from 'react';
import type { Bot, BotGroup } from '@crewaid/shared';
import { listDeliverables, useApiClient } from '../api';
import { ContextMenu } from '../components/ui';
import { t, useT } from '../i18n/i18n';

/** The screen point where a bot's context menu was requested. */
export type BotMenuPosition = {
  readonly x: number;
  readonly y: number;
};

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
 * What deleting a bot takes, counted: its deliverables go with it, its tasks
 * stay. `null` while the count is still being read.
 */
export function deleteBotConsequence(deliverables: number | null): string {
  return deliverables !== null && deliverables > 0
    ? t('bots.delete.consequenceWith', { count: deliverables })
    : t('bots.delete.consequence');
}

/**
 * Bot actions in a pointer-anchored ContextMenu, so keyboard navigation, RTL
 * submenu placement, viewport clamping and the glass overlay match every
 * other menu in the app.
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
  onClearChat: () => void;
  onDelete: () => void;
  groups: readonly BotGroup[];
  onMoveToGroup: (groupId: string | null) => void;
  onNewGroup: () => void;
  onMarkUnread: () => void;
}) {
  const tr = useT();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const confirmOverlay = useOverlayState({
    isOpen: confirmingDelete,
    onOpenChange: setConfirmingDelete,
  });

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

  const protectedAssistant = bot.kind === 'MAIN';
  const currentGroup = bot.groupId ?? null;

  const handleAction = (key: string | number) => {
    const id = String(key);
    onClose();
    if (id === 'pin' && !protectedAssistant) onTogglePin();
    else if (id === 'unread') onMarkUnread();
    else if (id === 'edit') onEditProfile();
    else if (id === 'duplicate' && !protectedAssistant) onDuplicate();
    else if (id === 'hide' && !protectedAssistant) onHide();
    else if (id === 'clear') onClearChat();
    else if (id === 'delete' && !protectedAssistant) setConfirmingDelete(true);
  };

  const handleMoveAction = (key: string | number) => {
    const id = String(key);
    onClose();
    if (id === '__new__') {
      onNewGroup();
      return;
    }
    const nextGroup = id === '__unassigned__' ? null : id;
    if (nextGroup !== currentGroup) onMoveToGroup(nextGroup);
  };

  return (
    <>
      <ContextMenu.Root
        open={position !== null}
        anchorPoint={position}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <ContextMenu.Popover className="min-w-[228px]">
          {protectedAssistant ? (
            <div
              role="presentation"
              className="mb-1 flex items-center gap-2 border-b border-separator px-2.5 pb-2 pt-1.5 text-caption text-muted"
            >
              <IconLock className="size-3.5 shrink-0" stroke={1.8} aria-hidden />
              <span>{tr('bots.alwaysPinned', { name: bot.name })}</span>
            </div>
          ) : null}
          <ContextMenu.Menu
            aria-label={tr('bots.actionsFor', { name: bot.name })}
            onAction={handleAction}
          >
            {!protectedAssistant ? (
              <ContextMenu.Item
                id="pin"
                textValue={bot.pinned ? tr('bots.botRowMenu.unpin') : tr('bots.botRowMenu.pin')}
                className="rounded-lg"
              >
                {bot.pinned ? (
                  <IconPinnedOff className="size-4 shrink-0 text-muted" stroke={1.8} />
                ) : (
                  <IconPin className="size-4 shrink-0 text-muted" stroke={1.8} />
                )}
                <span>{bot.pinned ? tr('bots.botRowMenu.unpin') : tr('bots.botRowMenu.pin')}</span>
              </ContextMenu.Item>
            ) : null}
            {!protectedAssistant ? (
              <ContextMenu.SubmenuTrigger>
                <ContextMenu.Item
                  id="move"
                  textValue={tr('bots.botRowMenu.moveTo')}
                  className="rounded-lg"
                >
                  <IconFolder className="size-4 shrink-0 text-muted" stroke={1.8} />
                  <span className="flex-1">{tr('bots.botRowMenu.moveTo')}</span>
                  <ContextMenu.SubmenuIndicator />
                </ContextMenu.Item>
                <ContextMenu.Popover className="min-w-[208px]">
                  <ContextMenu.Menu
                    aria-label={tr('bots.moveTo', { name: bot.name })}
                    onAction={handleMoveAction}
                  >
                    {groups.map((group) => (
                      <ContextMenu.Item
                        key={group.id}
                        id={group.id}
                        textValue={group.name}
                        className="rounded-lg"
                      >
                        {group.id === currentGroup ? (
                          <IconCheck className="size-4 shrink-0 text-accent" stroke={2} />
                        ) : (
                          <IconFolder className="size-4 shrink-0 text-muted" stroke={1.8} />
                        )}
                        <span className="truncate">{group.name}</span>
                      </ContextMenu.Item>
                    ))}
                    <ContextMenu.Item
                      id="__unassigned__"
                      textValue={tr('bots.botRowMenu.unassigned')}
                      className="rounded-lg"
                    >
                      {currentGroup === null ? (
                        <IconCheck className="size-4 shrink-0 text-accent" stroke={2} />
                      ) : (
                        <IconFolder className="size-4 shrink-0 text-muted" stroke={1.8} />
                      )}
                      <span>{tr('bots.botRowMenu.unassigned')}</span>
                    </ContextMenu.Item>
                    <ContextMenu.Separator />
                    <ContextMenu.Item
                      id="__new__"
                      textValue={tr('bots.botRowMenu.newGroup')}
                      className="rounded-lg"
                    >
                      <IconFolderPlus className="size-4 shrink-0 text-muted" stroke={1.8} />
                      <span>{tr('bots.botRowMenu.newGroup')}</span>
                    </ContextMenu.Item>
                  </ContextMenu.Menu>
                </ContextMenu.Popover>
              </ContextMenu.SubmenuTrigger>
            ) : null}
            <ContextMenu.Item
              id="unread"
              textValue={tr('bots.botRowMenu.markAsUnread')}
              className="rounded-lg"
            >
              <IconBellRinging className="size-4 shrink-0 text-muted" stroke={1.8} />
              <span>{tr('bots.botRowMenu.markAsUnread')}</span>
            </ContextMenu.Item>
            <ContextMenu.Separator />
            <ContextMenu.Item
              id="edit"
              textValue={tr('bots.botRowMenu.editProfile')}
              className="rounded-lg"
            >
              <IconPencil className="size-4 shrink-0 text-muted" stroke={1.8} />
              <span>{tr('bots.botRowMenu.editProfile')}</span>
            </ContextMenu.Item>
            {!protectedAssistant ? (
              <ContextMenu.Item
                id="duplicate"
                textValue={tr('bots.botRowMenu.duplicate')}
                className="rounded-lg"
              >
                <IconCopy className="size-4 shrink-0 text-muted" stroke={1.8} />
                <span>{tr('bots.botRowMenu.duplicate')}</span>
              </ContextMenu.Item>
            ) : null}
            <ContextMenu.Separator />
            {!protectedAssistant ? (
              <ContextMenu.Item
                id="hide"
                textValue={tr('bots.botRowMenu.hideFromSidebar')}
                className="rounded-lg"
              >
                <IconEyeOff className="size-4 shrink-0 text-muted" stroke={1.8} />
                <span>{tr('bots.botRowMenu.hideFromSidebar')}</span>
              </ContextMenu.Item>
            ) : null}
            <ContextMenu.Item
              id="clear"
              textValue={tr('bots.botRowMenu.clearChat')}
              className="rounded-lg"
            >
              <IconEraser className="size-4 shrink-0 text-muted" stroke={1.8} />
              <span>{tr('bots.botRowMenu.clearChat')}</span>
            </ContextMenu.Item>
            {!protectedAssistant ? (
              <ContextMenu.Item
                id="delete"
                variant="danger"
                textValue={tr('bots.botRowMenu.delete')}
                className="rounded-lg"
              >
                <IconTrash className="size-4 shrink-0" stroke={1.8} />
                <span>{tr('bots.botRowMenu.delete')}</span>
              </ContextMenu.Item>
            ) : null}
          </ContextMenu.Menu>
        </ContextMenu.Popover>
      </ContextMenu.Root>

      <Modal state={confirmOverlay}>
        <Modal.Backdrop variant="blur">
          <Modal.Container size="sm" placement="center" scroll="inside">
            <Modal.Dialog aria-label={tr('bots.deleteLabel', { name: bot.name })}>
              <Modal.Header>
                <Modal.Heading>{tr('bots.deleteTitle', { name: bot.name })}</Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-2 text-footnote leading-[18px] text-muted">
                <p>{deleteBotConsequence(deliverables)}</p>
                <p className="text-caption leading-[17px]">
                  {tr('bots.botRowMenu.toKeepItsConversationAnd')}
                </p>
              </Modal.Body>
              <Modal.Footer className="gap-2">
                <Button variant="ghost" size="sm" onPress={() => setConfirmingDelete(false)}>
                  {tr('bots.botRowMenu.cancel')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onPress={() => {
                    setConfirmingDelete(false);
                    onHide();
                  }}
                >
                  {tr('bots.botRowMenu.hideFromSidebar')}
                </Button>
                <Button
                  variant="danger-soft"
                  size="sm"
                  onPress={() => {
                    setConfirmingDelete(false);
                    onDelete();
                  }}
                >
                  {tr('bots.botRowMenu.delete')}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}
