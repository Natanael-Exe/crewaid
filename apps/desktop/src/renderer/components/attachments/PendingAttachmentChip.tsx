import { Chip, Button } from '@heroui/react';
import { attachmentErrorTone, type PendingAttachment } from './attachmentState';
import { useT } from '../../i18n/i18n';
import { formatFileSize } from '../../i18n/fileSize';

/**
 * Pending-attachment chips (composer).
 *
 * Formal acceptance note (PO): chips are the free HeroUI `Chip` from
 * '@heroui/react' — NOT hand-rolled badges. API verified in-tree
 * (@heroui/styles 3.2.4): color default|accent|success|warning|danger,
 * variant primary|secondary|tertiary|soft, size sm|md|lg, Chip.Label slot.
 *
 * PO state mapping:
 * pending (queued/uploading) → accent/soft
 * uploaded (ready) → default/secondary
 * error (D-020/D-021 fences) → danger (hard failures) /
 * warning (recoverable: expired, too large)
 *
 * Each chip keeps its filename, a status line, and remove/retry actions.
 * The remove button is HeroUI Button (PO requirement 1); the bare-glyph
 * child is wrapped in a span because react-aria press semantics reject
 * text-only children.
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
  const statusLabel =
    item.status === 'uploading' || item.status === 'queued'
      ? t('attachments.uploading')
      : item.status === 'error'
        ? (item.error?.message ?? t('attachments.uploadFailed'))
        : formatFileSize(item.file.size);

  const tone =
    item.status === 'error'
      ? attachmentErrorTone(item.error?.code ?? 'UNKNOWN')
      : item.status === 'ready'
        ? { color: 'default' as const, variant: 'secondary' as const }
        : { color: 'accent' as const, variant: 'soft' as const };

  return (
    <Chip
      color={tone.color}
      variant={tone.variant}
      size="sm"
      className="h-auto gap-1.5 rounded-lg px-2.5 py-1.5"
    >
      <span aria-hidden className="text-[11px] leading-none opacity-60">
        {item.status === 'error' ? '⚠' : '📄'}
      </span>
      <span className="min-w-0">
        <span className="block max-w-[180px] truncate text-[13px] font-medium">
          {item.file.name}
        </span>
        <Chip.Label
          className={`block truncate text-[11px] normal-case ${
            item.status === 'error' ? 'font-medium' : 'opacity-70'
          }`}
        >
          {statusLabel}
        </Chip.Label>
      </span>
      {item.status === 'error' ? (
        <Button
          variant="ghost"
          size="sm"
          onPress={() => onRetry(item.localId)}
          className="h-6 min-w-0 rounded px-1.5 text-[12px]"
        >
          {t('attachments.retry')}
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        isIconOnly
        aria-label={t('attachments.remove', { name: item.file.name })}
        onPress={() => onRemove(item.localId)}
        className="ms-auto size-5 min-w-0 rounded-full px-0 text-[12px] text-muted"
      >
        <span aria-hidden>✕</span>
      </Button>
    </Chip>
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
    <div
      className="mx-auto flex w-full max-w-[900px] flex-wrap gap-1.5 pb-1.5"
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
    </div>
  );
}
