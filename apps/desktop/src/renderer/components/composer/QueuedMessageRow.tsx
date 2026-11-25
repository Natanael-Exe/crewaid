import { Button, Input } from '@heroui/react';
import { IconGripVertical, IconPencil, IconSend2, IconTrash } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import type { QueuedMessage } from '../../state/messageQueue';
import { IconButtonTooltip } from '../ui';
import { useT } from '../../i18n/i18n';

/**
 * The messages waiting above the composer.
 *
 * Shows a `Queued` badge immediately and offers an explicit `Stop and send`
 * action while a run is active (or `Send now` when idle), plus drag/keyboard
 * reordering, inline edit, and remove.
 */
export function QueuedMessageList({
  items,
  streaming = false,
  interruptingId = null,
  onEdit,
  onRemove,
  onSendNow,
  onMove,
}: {
  items: readonly QueuedMessage[];
  streaming?: boolean;
  interruptingId?: string | null;
  onEdit: (localId: string, text: string) => void;
  onRemove: (localId: string) => void;
  onSendNow: (localId: string) => void;
  onMove: (from: number, to: number) => void;
}) {
  const t = useT();
  const dragging = useRef<number | null>(null);

  if (items.length === 0) return null;

  return (
    <div data-message-queue className="mb-1.5 flex flex-col gap-1 px-1">
      <div className="px-1 text-micro tabular-nums text-muted">
        {items.length === 1
          ? t('composer.queue.one')
          : t('composer.queue.many', { count: items.length })}
      </div>
      {items.map((item, index) => (
        <QueuedRow
          key={item.localId}
          item={item}
          index={index}
          total={items.length}
          streaming={streaming}
          interrupting={interruptingId === item.localId}
          onEdit={onEdit}
          onRemove={onRemove}
          onSendNow={onSendNow}
          onMove={onMove}
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
  total,
  streaming,
  interrupting,
  onEdit,
  onRemove,
  onSendNow,
  onMove,
  onDragStart,
  onDropAt,
}: {
  item: QueuedMessage;
  index: number;
  total: number;
  streaming: boolean;
  interrupting: boolean;
  onEdit: (localId: string, text: string) => void;
  onRemove: (localId: string) => void;
  onSendNow: (localId: string) => void;
  onMove: (from: number, to: number) => void;
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
    <div className="flex flex-col gap-1">
      <div
        data-queued-message={item.localId}
        data-queued-index={index}
        draggable={editing === null}
        onDragStart={onDragStart}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          onDropAt();
        }}
        onKeyDown={(event) => {
          if (editing !== null || !event.altKey) return;
          if (event.key === 'ArrowUp' && index > 0) {
            event.preventDefault();
            onMove(index, index - 1);
          } else if (event.key === 'ArrowDown' && index < total - 1) {
            event.preventDefault();
            onMove(index, index + 1);
          }
        }}
        className={`flex items-center gap-1.5 rounded-message border bg-surface px-2 py-1.5 text-footnote ${
          over ? 'border-accent' : 'border-border'
        }`}
      >
        <IconGripVertical
          aria-hidden
          className="size-4 shrink-0 cursor-grab text-foreground-faint"
          stroke={1.8}
        />
        <span
          data-queued-badge
          className="shrink-0 rounded-full bg-default px-2 py-0.5 text-micro font-medium text-muted"
        >
          {t('composer.queue.badge')}
        </span>
        {editing === null ? (
          <span className="min-w-0 flex-1 truncate" title={item.text}>
            {item.text}
          </span>
        ) : (
          <Input
            autoFocus
            variant="secondary"
            aria-label={t('composer.queue.editLabel')}
            value={editing}
            onChange={(event) => setEditing(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              }
              if (event.key === 'Escape') setEditing(null);
            }}
            className="h-7 min-w-0 flex-1 rounded-lg px-2 text-footnote"
          />
        )}
        <div className="flex shrink-0 items-center gap-1">
          {streaming ? (
            <Button
              size="sm"
              variant="secondary"
              data-stop-and-send
              isDisabled={interrupting}
              aria-label={t('composer.queue.stopAndSendLabel', { text: item.text })}
              onPress={() => onSendNow(item.localId)}
              className="h-6 min-h-0 rounded-full px-2.5 text-micro font-medium"
            >
              {interrupting ? t('composer.queue.stopping') : t('composer.queue.stopAndSend')}
            </Button>
          ) : (
            <IconButtonTooltip
              label={t('composer.queue.sendNow', { text: item.text })}
              tooltip={t('composer.queue.sendNowHint')}
              placement="top"
              onPress={() => onSendNow(item.localId)}
              className="size-7 rounded-full text-muted"
            >
              <IconSend2 className="size-4" stroke={1.8} />
            </IconButtonTooltip>
          )}
          <IconButtonTooltip
            label={t('composer.queue.edit', { text: item.text })}
            placement="top"
            onPress={() => setEditing(item.text)}
            className="size-7 rounded-full text-muted"
          >
            <IconPencil className="size-4" stroke={1.8} />
          </IconButtonTooltip>
          <IconButtonTooltip
            label={t('composer.queue.remove', { text: item.text })}
            placement="top"
            onPress={() => onRemove(item.localId)}
            className="size-7 rounded-full text-muted"
          >
            <IconTrash className="size-4" stroke={1.8} />
          </IconButtonTooltip>
        </div>
      </div>
      {item.notice === undefined ? null : (
        <p role="alert" data-queued-notice className="m-0 px-2 text-micro text-warning">
          {item.notice}
        </p>
      )}
    </div>
  );
}
