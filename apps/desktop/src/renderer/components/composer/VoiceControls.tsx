import { Spinner } from '@heroui/react';
import {
  IconArrowUp,
  IconMicrophone,
  IconPlayerStopFilled,
  IconWaveSine,
  IconX,
} from '@tabler/icons-react';
import { formatClipTime } from '../../voice/recorder';
import type { ComposerVoice, VoiceCapture } from './useVoiceCapture';
import { IconButtonTooltip } from '../ui';
import { useT } from '../../i18n/i18n';

/**
 * Dictation: press to listen, press again to put the words in the draft.
 * Sits in the right-hand controls beside Send.
 */
export function DictationButton({
  voice,
  capture,
}: {
  voice: ComposerVoice | undefined;
  capture: VoiceCapture;
}) {
  const t = useT();
  if (voice === undefined) return null;
  const mine = capture.purpose === 'dictation';
  const busy = capture.stage !== 'idle';
  const listening = mine && capture.stage === 'recording';
  const working = mine && capture.stage === 'working';
  const label = !voice.configured
    ? t('composer.voice.notConfigured')
    : listening
      ? t('composer.voice.stopDictating')
      : working
        ? t('composer.voice.transcribing')
        : t('composer.voice.dictate');
  return (
    <IconButtonTooltip
      variant="ghost"
      size="sm"
      label={label}
      tooltip={
        listening
          ? t('composer.voice.listening', { elapsed: formatClipTime(capture.elapsedMs) })
          : label
      }
      placement="top"
      data-voice-dictation={listening ? 'listening' : working ? 'working' : 'idle'}
      isDisabled={!voice.configured || working || (busy && !mine)}
      onPress={() => (listening ? capture.finish() : capture.start('dictation'))}
      className={`size-8 min-w-8 shrink-0 rounded-full bg-transparent ${
        listening ? 'text-danger' : 'text-muted'
      }`}
    >
      {working ? (
        <Spinner size="sm" color="current" aria-hidden />
      ) : listening ? (
        <IconPlayerStopFilled className="size-3.5" />
      ) : (
        <IconMicrophone className="size-4" stroke={1.8} />
      )}
    </IconButtonTooltip>
  );
}

/**
 * The right-hand slot while the draft is empty. Records a voice message in the
 * exact same size and place as the send arrow so the composer never shifts.
 */
export function VoiceMessageButton({
  voice,
  capture,
}: {
  voice: ComposerVoice | undefined;
  capture: VoiceCapture;
}) {
  const t = useT();
  const recording = capture.purpose === 'message';
  if (recording) {
    const working = capture.stage === 'working';
    return (
      <IconButtonTooltip
        variant="primary"
        size="sm"
        label={working ? t('composer.voice.sending') : t('composer.voice.send')}
        tooltip={t('composer.voice.send')}
        placement="top"
        isPending={working}
        isDisabled={working}
        onPress={capture.finish}
        className="crewaid-compose-action me-0.5 size-8 min-w-8 shrink-0 rounded-full data-[pending=true]:opacity-100"
      >
        {working ? (
          <Spinner size="sm" color="current" aria-hidden />
        ) : (
          <IconArrowUp className="size-4" stroke={1.8} />
        )}
      </IconButtonTooltip>
    );
  }
  const unavailable = voice === undefined || !voice.configured;
  return (
    <IconButtonTooltip
      variant="primary"
      size="sm"
      label={t('composer.voice.record')}
      tooltip={unavailable ? t('composer.voice.notConfigured') : t('composer.voice.recordHint')}
      placement="top"
      isDisabled={unavailable || capture.stage !== 'idle'}
      onPress={() => capture.start('message')}
      className="crewaid-compose-action me-0.5 size-8 min-w-8 shrink-0 rounded-full"
    >
      <IconWaveSine className="size-4" stroke={1.8} aria-hidden />
    </IconButtonTooltip>
  );
}

/** What stands in the draft's place while a voice message records. */
export function VoiceMessageStrip({ capture }: { capture: VoiceCapture }) {
  const t = useT();
  if (capture.purpose !== 'message') return null;
  const working = capture.stage === 'working';
  return (
    <div
      data-composer-slot="text"
      data-voice-recording={working ? 'sending' : 'recording'}
      role="status"
      aria-live="polite"
      className="flex min-w-0 items-center gap-2 px-1 py-[7px] text-callout leading-[22px] text-muted"
    >
      <IconButtonTooltip
        label={t('composer.voice.discard')}
        placement="top"
        isDisabled={working}
        onPress={capture.cancel}
        className="size-6 min-w-6 rounded-full text-muted"
      >
        <IconX className="size-3.5" stroke={2} />
      </IconButtonTooltip>
      {working ? (
        <span>{t('composer.voice.sendingShort')}</span>
      ) : (
        <>
          <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-danger" />
          <span className="tabular-nums text-field-foreground">
            {formatClipTime(capture.elapsedMs)}
          </span>
          <span className="truncate">{t('composer.voice.recording')}</span>
        </>
      )}
    </div>
  );
}

/** A voice failure, under the pill, until the next recording or a dismiss. */
export function VoiceError({ capture }: { capture: VoiceCapture }) {
  const t = useT();
  if (capture.error === null) return null;
  return (
    <div role="alert" className="mt-1.5 flex items-center gap-1.5 px-4 text-caption text-danger">
      <span className="min-w-0 flex-1">{capture.error}</span>
      <IconButtonTooltip
        label={t('composer.dismiss')}
        placement="top"
        onPress={capture.dismissError}
        className="size-5 min-w-5 rounded-full text-muted"
      >
        <IconX className="size-3" stroke={2} />
      </IconButtonTooltip>
    </div>
  );
}
