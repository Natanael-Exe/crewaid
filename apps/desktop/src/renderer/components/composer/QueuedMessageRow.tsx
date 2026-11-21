import { Button, Tooltip } from '@heroui/react';
import { IconGripVertical, IconPencil, IconSend2, IconTrash } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import type { QueuedMessage } from '../../state/messageQueue';
import { useT } from '../../i18n/i18n';

/**
 * The messages waiting above the composer.
 *
 * Each row is something the operator typed while the bot was busy and which
 * has NOT been sent. So each row offers the three things that stop being
 * possible the moment it is: change it, drop it, or push it now.
 *
 * "Send now" is a real choice rather than a shortcut for waiting. The server
 * accepts a message mid-turn and answers it when the current one settles,
 * so this is how an operator says "this one goes in whatever
 * happens next" — while leaving the rest of the queue where it is.
 *
 * Reordering is native HTML5 drag and drop: it is what a list of rows in an
 * Electron window already supports, it needs no dependency and no pointer
 * bookkeeping, and the drag image the browser produces is the row itself.
 */

export function QueuedMessageList({
  items,
  onEdit,
  onRemove,
  onSendNow,
  onMove,
}: {
  items: readonly QueuedMessage[];
  onEdit: (localId: string, text: string) => void;
  onRemove: (localId: string) => void;
  onSendNow: (localId: string) => void;
  onMove: (from: number, to: number) => void;
}) {
  const t = useT();
  // The index being dragged, held in a ref rather than state: it changes on
  // every dragover and re-rendering the list under the pointer is what makes
  // a hand-rolled drag feel broken.
  const dragging = useRef<number | null>(null);

  if (items.length === 0) return null;

  return (
    <div data-message-queue className="mb-1.5 flex flex-col gap-1 px-1">
      <div className="px-1 text-[11px] text-muted">
        {items.length === 1
          ? t('composer.queue.one')
          : t('composer.queue.many', { count: items.length })}
      </div>
      {items.map((item, index) => (
        <QueuedRow
          key={item.localId}
          item={item}
          index={index}
          onEdit={onEdit}
          onRemove={onRemove}
          onSendNow={onSendNow}
          onDragStart={() => {
            dragging.current = index;
          }}
          onDropAt={() => {
            const from = dragging.current;
            dragging.current = null;
            if (from !== null) onMove(from, index);
          }}
        />
      ))}
    </div>
  );
}

function QueuedRow({
  item,
  index,
  onEdit,
  onRemove,
  onSendNow,
  onDragStart,
  onDropAt,
}: {
  item: QueuedMessage;
  index: number;
  onEdit: (localId: string, text: string) => void;
  onRemove: (localId: string) => void;
  onSendNow: (localId: string) => void;
  onDragStart: () => void;
  onDropAt: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  const commit = () => {
    if (editing !== null) onEdit(item.localId, editing);
    setEditing(null);
  };

  return (
    <div
      data-queued-message={item.localId}
      data-queued-index={index}
      draggable={editing === null}
      onDragStart={onDragStart}
      onDragOver={(event) => {
        // Without this the drop never fires: the default handling of a
        // dragover is to refuse the drop.
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        onDropAt();
      }}
      className={`flex items-center gap-1.5 rounded-message border bg-surface px-2 py-1.5 text-[13px] ${
        over ? 'border-accent' : 'border-border'
      }`}
    >
      <IconGripVertical
        aria-hidden
        className="size-4 shrink-0 cursor-grab text-foreground-faint"
        stroke={1.8}
      />
      {editing === null ? (
        <span className="min-w-0 flex-1 truncate" title={item.text}>
          {item.text}
        </span>
      ) : (
        <input
          autoFocus
          aria-label={t('composer.queue.editLabel')}
          value={editing}
          onChange={(event) => setEditing(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
            // Escape abandons the edit rather than committing it — the row is
            // still queued and unsent either way.
            if (event.key === 'Escape') setEditing(null);
          }}
          className="min-w-0 flex-1 bg-transparent outline-none"
        />
      )}
      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip>
          <Tooltip.Trigger>
            <Button
              variant="ghost"
              isIconOnly
              size="sm"
              aria-label={t('composer.queue.sendNow', { text: item.text })}
              onPress={() => onSendNow(item.localId)}
              className="size-7 rounded-full text-muted"
            >
              <IconSend2 className="size-4" stroke={1.8} />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>{t('composer.queue.sendNowHint')}</Tooltip.Content>
        </Tooltip>
        <Button
          variant="ghost"
          isIconOnly
          size="sm"
          aria-label={t('composer.queue.edit', { text: item.text })}
          onPress={() => setEditing(item.text)}
          className="size-7 rounded-full text-muted"
        >
          <IconPencil className="size-4" stroke={1.8} />
        </Button>
        <Button
          variant="ghost"
          isIconOnly
          size="sm"
          aria-label={t('composer.queue.remove', { text: item.text })}
          onPress={() => onRemove(item.localId)}
          className="size-7 rounded-full text-muted"
        >
          <IconTrash className="size-4" stroke={1.8} />
        </Button>
      </div>
    </div>
  );
}
