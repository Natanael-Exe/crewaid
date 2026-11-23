import { Button, Spinner } from '@heroui/react';
import type { PendingVoiceNote } from '../../voice/useVoiceOutbox';
import { VoiceNoteBubble } from './VoiceNoteBubble';
import { useT } from '../../i18n/i18n';

/** A local recording stays playable until it is sent or explicitly discarded. */
export function PendingVoiceNoteRow({
  note,
  onRetry,
  onDiscard,
}: {
  note: PendingVoiceNote;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const t = useT();
  const sending = note.status === 'sending';
  return (
    <div
      data-pending-voice-note={note.id}
      data-voice-send-state={note.status}
      className="mt-2 flex max-w-full flex-col items-end gap-1.5 self-end"
    >
      <VoiceNoteBubble
        attachment={{
          id: note.id,
          filename: 'recording.webm',
          mimeType: note.clip.type,
          sizeBytes: note.clip.size,
          kind: 'VOICE_NOTE',
          durationMs: note.durationMs,
        }}
        align="end"
        localClip={note.clip}
      />
      {sending ? (
        <div role="status" className="flex items-center gap-1.5 px-2 text-caption text-muted">
          <Spinner size="sm" color="current" aria-hidden />
          {t('attachments.voice.sending')}
        </div>
      ) : (
        <>
          <p role="alert" className="max-w-72 px-2 text-end text-caption text-danger">
            {note.error}
          </p>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onPress={onDiscard}
              aria-label={t('attachments.voice.discardLabel')}
            >
              {t('attachments.voice.discard')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onPress={onRetry}
              aria-label={t('attachments.voice.retryLabel')}
            >
              {t('attachments.retry')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
