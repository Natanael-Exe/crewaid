import { Button, Spinner, Tooltip } from '@heroui/react';
import { IconArrowUp, IconMicrophone, IconPlayerStopFilled, IconX } from '@tabler/icons-react';
import { formatClipTime } from '../../voice/recorder';
import type { ComposerVoice, VoiceCapture } from './useVoiceCapture';
import { useT } from '../../i18n/i18n';

/**
 * dictation: press to listen, press again to put the words in the
 * draft. Sits in the right-hand controls beside Send.
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
    <Tooltip>
      <Tooltip.Trigger>
        <Button
          variant="ghost"
          isIconOnly
          size="sm"
          aria-label={label}
          data-voice-dictation={listening ? 'listening' : working ? 'working' : 'idle'}
          isDisabled={!voice.configured || working || (busy && !mine)}
          onPress={() => (listening ? capture.finish() : capture.start('dictation'))}
          className={`size-8 shrink-0 rounded-full bg-transparent ${
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
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>
        {listening
          ? t('composer.voice.listening', { elapsed: formatClipTime(capture.elapsedMs) })
          : label}
      </Tooltip.Content>
    </Tooltip>
  );
}

/**
 * The right-hand slot while the draft is empty. It records a voice
 * message, which the bot answers aloud. Same size and place as the send
 * arrow it yields to, so the composer never shifts (the rule the disabled
 * placeholder held before voice shipped).
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
      <Tooltip>
        <Tooltip.Trigger>
          <Button
            variant="primary"
            isIconOnly
            aria-label={working ? t('composer.voice.sending') : t('composer.voice.send')}
            isPending={working}
            isDisabled={working}
            onPress={capture.finish}
            className="crewaid-compose-action me-0.5 size-8 shrink-0 rounded-full data-[pending=true]:opacity-100"
          >
            {working ? (
              <Spinner size="sm" color="current" aria-hidden />
            ) : (
              <IconArrowUp className="size-4" stroke={1.8} />
            )}
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Content>{t('composer.voice.send')}</Tooltip.Content>
      </Tooltip>
    );
  }
  const unavailable = voice === undefined || !voice.configured;
  return (
    <Tooltip>
      <Tooltip.Trigger>
        <Button
          variant="primary"
          isIconOnly
          aria-label={t('composer.voice.record')}
          isDisabled={unavailable || capture.stage !== 'idle'}
          onPress={() => capture.start('message')}
          className="crewaid-compose-action me-0.5 size-8 shrink-0 rounded-full"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3V21" />
            <path d="M8 7V17" />
            <path d="M4 11V13" />
            <path d="M16 7V17" />
            <path d="M20 11V13" />
          </svg>
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>
        {unavailable ? t('composer.voice.notConfigured') : t('composer.voice.recordHint')}
      </Tooltip.Content>
    </Tooltip>
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
      className="flex min-w-0 items-center gap-2 px-1 py-[7px] text-[14px] leading-[22px] text-muted"
    >
      <Button
        variant="ghost"
        isIconOnly
        size="sm"
        aria-label={t('composer.voice.discard')}
        isDisabled={working}
        onPress={capture.cancel}
        className="size-6 min-w-6 rounded-full text-muted"
      >
        <IconX className="size-3.5" stroke={2} />
      </Button>
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
    <div role="alert" className="mt-1.5 flex items-center gap-1.5 px-4 text-[12px] text-danger">
      <span className="min-w-0 flex-1">{capture.error}</span>
      <Button
        variant="ghost"
        isIconOnly
        size="sm"
        aria-label={t('composer.dismiss')}
        onPress={capture.dismissError}
        className="size-5 min-w-5 rounded-full text-muted"
      >
        <IconX className="size-3" stroke={2} />
      </Button>
    </div>
  );
}
