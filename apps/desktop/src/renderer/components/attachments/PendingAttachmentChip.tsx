import { Button, Spinner, Tooltip } from '@heroui/react';
import { IconAlertTriangle } from '@tabler/icons-react';
import { attachmentErrorTone, type PendingAttachment } from './attachmentState';
import { ChatAttachment, ChatAttachmentGroup } from '../ui';
import { useT } from '../../i18n/i18n';
import { formatFileSize } from '../../i18n/fileSize';

/**
 * Staged composer attachments as ChatAttachment chips: a file-type icon, the
 * size or upload status, retry on failure, and a remove button with a tooltip.
 */
export function PendingAttachmentChip({
  item,
  onRemove,
  onRetry,
}: {
  item: PendingAttachment;
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}) {
  const t = useT();
  const isUploading = item.status === 'uploading' || item.status === 'queued';
  const statusLabel = isUploading
    ? t('attachments.uploading')
    : item.status === 'error'
      ? (item.error?.message ?? t('attachments.uploadFailed'))
      : formatFileSize(item.file.size);

  const errorTone =
    item.status === 'error' ? attachmentErrorTone(item.error?.code ?? 'UNKNOWN') : null;
  const status: 'default' | 'warning' | 'danger' =
    errorTone === null ? 'default' : errorTone.color === 'warning' ? 'warning' : 'danger';

  return (
    <ChatAttachment.Root
      role="listitem"
      mimeType={item.file.type}
      name={item.file.name}
      status={status}
      className={
        status === 'danger'
          ? 'border-danger/35 bg-danger/10'
          : status === 'warning'
            ? 'border-warning/35 bg-warning/10'
            : ''
      }
    >
      <ChatAttachment.Icon
        className={
          status === 'danger' ? 'text-danger' : status === 'warning' ? 'text-warning' : undefined
        }
      >
        {isUploading ? (
          <Spinner size="sm" color="current" aria-hidden className="size-3.5" />
        ) : item.status === 'error' ? (
          <IconAlertTriangle className="size-4" stroke={1.8} aria-hidden />
        ) : undefined}
      </ChatAttachment.Icon>
      <ChatAttachment.Info>
        <ChatAttachment.Name>{item.file.name}</ChatAttachment.Name>
        <ChatAttachment.Size
          className={`tabular-nums ${
            status === 'danger'
              ? 'font-medium text-danger'
              : status === 'warning'
                ? 'font-medium text-warning'
                : ''
          }`}
        >
          {statusLabel}
        </ChatAttachment.Size>
      </ChatAttachment.Info>
      {item.status === 'error' ? (
        <Button
          variant="ghost"
          size="sm"
          onPress={() => onRetry(item.localId)}
          className="h-6 min-w-0 rounded-md px-2 text-caption"
        >
          {t('attachments.retry')}
        </Button>
      ) : null}
      <Tooltip delay={400}>
        <ChatAttachment.Remove
          aria-label={t('attachments.remove', { name: item.file.name })}
          onPress={() => onRemove(item.localId)}
        />
        <Tooltip.Content placement="top">
          {t('attachments.remove', { name: item.file.name })}
        </Tooltip.Content>
      </Tooltip>
    </ChatAttachment.Root>
  );
}

export function PendingAttachmentRow({
  items,
  onRemove,
  onRetry,
}: {
  items: PendingAttachment[];
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}) {
  const t = useT();
  if (items.length === 0) return null;
  return (
    <ChatAttachmentGroup
      className="mx-auto w-full max-w-(--chat-column) pb-1.5"
      role="list"
      aria-label={t('attachments.pending')}
    >
      {items.map((item) => (
        <PendingAttachmentChip
          key={item.localId}
          item={item}
          onRemove={onRemove}
          onRetry={onRetry}
        />
      ))}
    </ChatAttachmentGroup>
  );
}
