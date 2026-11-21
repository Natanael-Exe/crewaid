import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Spinner } from '@heroui/react';
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from '@tabler/icons-react';
import { downloadAttachment, isAbortError, useApiClient } from '../../api';
import { formatClipTime } from '../../voice/recorder';
import type { MessageAttachment } from './AttachmentCard';
import { useT } from '../../i18n/i18n';

/**
 * A voice note in the transcript — the person's voice message, or a
 * bot's spoken reply. The message's hover footer discloses its words, so this
 * player is the message's visible bubble.
 *
 * The clip is fetched on the first press, not on mount: a long history of
 * voice messages must not download every one of them to be scrolled past.
 * Bytes come through the authenticated fetch into an object URL.
 */
export function VoiceNoteBubble({
  attachment,
  align,
  autoplay = false,
  localClip,
}: {
  attachment: MessageAttachment;
  align: 'start' | 'end';
  /** Play once on mount — a reply heard as it lands, in a focused window. */
  autoplay?: boolean;
  /** An unsent recording, kept in memory for playback and retry. */
  localClip?: Blob;
}) {
  const t = useT();
  const client = useApiClient();
  const audio = useRef<HTMLAudioElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'paused' | 'failed'>('idle');
  const [positionMs, setPositionMs] = useState(0);
  const [lengthMs, setLengthMs] = useState(attachment.durationMs ?? 0);
  const fetching = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      fetching.current?.abort();
    },
    [],
  );
  // The object URL must not outlive the element that plays it.
  useEffect(
    () => () => {
      if (url !== null) URL.revokeObjectURL(url);
    },
    [url],
  );

  const play = useCallback(async () => {
    const element = audio.current;
    if (element === null) return;
    if (url !== null) {
      await element.play().catch(() => setState('failed'));
      return;
    }
    if (fetching.current !== null) return;
    const controller = new AbortController();
    fetching.current = controller;
    setState('loading');
    try {
      const blob =
        localClip ?? (await downloadAttachment(client, attachment.id, controller.signal));
      if (controller.signal.aborted) return;
      const next = URL.createObjectURL(blob);
      setUrl(next);
      element.src = next;
      await element.play();
    } catch (caught: unknown) {
      if (!isAbortError(caught)) setState('failed');
    } finally {
      if (fetching.current === controller) fetching.current = null;
    }
  }, [client, attachment.id, localClip, url]);

  const autoplayed = useRef(false);
  useEffect(() => {
    if (!autoplay || autoplayed.current) return;
    autoplayed.current = true;
    if (typeof document !== 'undefined' && document.hasFocus()) void play();
  }, [autoplay, play]);

  const playing = state === 'playing';
  const progress = lengthMs > 0 ? Math.min(1, positionMs / lengthMs) : 0;
  const label =
    state === 'loading'
      ? t('attachments.voice.loading')
      : playing
        ? t('attachments.voice.pause')
        : t('attachments.voice.play');

  return (
    <div
      data-voice-note={attachment.id}
      data-voice-state={state}
      data-message-bubble={align === 'end' ? 'user' : 'bot'}
      className={`flex w-60 max-w-full items-center gap-2.5 rounded-full border py-1 pe-4 ps-1 ${
        align === 'end'
          ? 'self-end bg-message-user text-message-user-foreground'
          : 'self-start bg-message-bot text-message-bot-foreground'
      }`}
    >
      <Button
        isIconOnly
        size="sm"
        variant="primary"
        aria-label={label}
        isPending={state === 'loading'}
        isDisabled={state === 'loading'}
        onPress={() => (playing ? audio.current?.pause() : void play())}
        className="size-8 min-w-8 shrink-0 rounded-full data-[pending=true]:opacity-100"
      >
        {state === 'loading' ? (
          <Spinner size="sm" color="current" aria-hidden />
        ) : playing ? (
          <IconPlayerPauseFilled className="size-3.5" />
        ) : (
          <IconPlayerPlayFilled className="size-3.5" />
        )}
      </Button>
      <div
        data-voice-track
        role="progressbar"
        aria-label={t('attachments.voice.progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/15"
      >
        <div
          className="h-full rounded-full bg-foreground"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
      <span className="shrink-0 text-[12px] tabular-nums text-muted">
        {state === 'failed'
          ? t('attachments.voice.cannotPlay')
          : formatClipTime(playing || positionMs > 0 ? positionMs : lengthMs)}
      </span>
      <audio
        ref={audio}
        preload="none"
        onPlay={() => setState('playing')}
        onPause={() => setState('paused')}
        onEnded={() => {
          setState('idle');
          setPositionMs(0);
        }}
        onError={() => {
          if (url !== null) setState('failed');
        }}
        onTimeUpdate={(event) => setPositionMs(event.currentTarget.currentTime * 1000)}
        onLoadedMetadata={(event) => {
          const seconds = event.currentTarget.duration;
          if (Number.isFinite(seconds) && seconds > 0) setLengthMs(seconds * 1000);
        }}
      />
    </div>
  );
}
