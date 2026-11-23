import { IconArrowDown, IconArrowUp, IconPencil, IconTrash } from '@tabler/icons-react';
import type { BotGroup } from '@crewaid/shared';
import { ContextMenu } from '../components/ui';
import { useT } from '../i18n/i18n';
import type { BotMenuPosition } from './BotRowMenu';

/**
 * A group header's context menu, rendered outside the virtualized ListBox
 * as a ContextMenu, so arrow-key navigation, disabled items and the glass
 * overlay match every other menu.
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
  position: BotMenuPosition;
  onClose: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onEdit: () => void;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
}) {
  const t = useT();
  const disabledKeys: string[] = [];
  if (!canMoveUp) disabledKeys.push('up');
  if (!canMoveDown) disabledKeys.push('down');

  return (
    <ContextMenu.Root
      open
      anchorPoint={position}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ContextMenu.Popover className="min-w-[200px]">
        <ContextMenu.Menu
          aria-label={t('bots.group.label', { name: group.name })}
          disabledKeys={disabledKeys}
          onAction={(key) => {
            onClose();
            if (key === 'edit') onEdit();
            else if (key === 'up') onMove(-1);
            else if (key === 'down') onMove(1);
            else if (key === 'delete') onDelete();
          }}
        >
          <ContextMenu.Item
            id="edit"
            textValue={t('bots.groupMenu.editGroup')}
            className="rounded-lg"
          >
            <IconPencil className="size-4 shrink-0 text-muted" stroke={1.8} />
            <span>{t('bots.groupMenu.editGroup')}</span>
          </ContextMenu.Item>
          <ContextMenu.Item id="up" textValue={t('bots.groupMenu.moveUp')} className="rounded-lg">
            <IconArrowUp className="size-4 shrink-0 text-muted" stroke={1.8} />
            <span>{t('bots.groupMenu.moveUp')}</span>
          </ContextMenu.Item>
          <ContextMenu.Item
            id="down"
            textValue={t('bots.groupMenu.moveDown')}
            className="rounded-lg"
          >
            <IconArrowDown className="size-4 shrink-0 text-muted" stroke={1.8} />
            <span>{t('bots.groupMenu.moveDown')}</span>
          </ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item
            id="delete"
            variant="danger"
            textValue={t('bots.groupDialog.deleteGroup')}
            className="rounded-lg text-danger data-[hovered]:text-danger"
          >
            <IconTrash className="size-4 shrink-0 text-danger" stroke={1.8} />
            <span className="text-danger">{t('bots.groupDialog.deleteGroup')}</span>
          </ContextMenu.Item>
        </ContextMenu.Menu>
      </ContextMenu.Popover>
    </ContextMenu.Root>
  );
}
