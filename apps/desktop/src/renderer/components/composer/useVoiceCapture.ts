import { useCallback, useEffect, useRef, useState } from 'react';
import { failureOf } from '../../api';
import {
  RecorderError,
  VoiceRecorder,
  browserRecorderDeps,
  type RecorderDeps,
} from '../../voice/recorder';
import { resolveMicrophone } from '../../voice/microphonePreference';
import { t } from '../../i18n/i18n';

/**
 * What the composer needs to listen. The shell provides it, bound to
 * this bot and the API client; the composer only records.
 */
export type ComposerVoice = {
  /** Whether this account has a key to listen and speak with. */
  readonly configured: boolean;
  /** Dictation: the clip's words, to land in the draft. */
  readonly transcribe: (clip: Blob) => Promise<string>;
  /** A voice message: upload it, then post its transcript with it. */
  readonly sendVoiceNote: (clip: Blob, durationMs: number) => Promise<void>;
  /** Tests record against fakes; the app uses the browser's recorder. */
  readonly recorderDeps?: RecorderDeps;
};

export type CapturePurpose = 'dictation' | 'message';

export type VoiceCapture = {
  /** What is being recorded, or null. */
  readonly purpose: CapturePurpose | null;
  /** Recording, or sending the finished clip up. */
  readonly stage: 'idle' | 'recording' | 'working';
  readonly elapsedMs: number;
  readonly error: string | null;
  readonly start: (purpose: CapturePurpose) => void;
  /** Stop and use the clip. */
  readonly finish: () => void;
  /** Stop and drop the clip. */
  readonly cancel: () => void;
  readonly dismissError: () => void;
};

/** Dictation fills a draft; a voice message is a turn of speech. */
export const DICTATION_MAX_MS = 2 * 60 * 1000;
export const VOICE_MESSAGE_MAX_MS = 5 * 60 * 1000;

export function useVoiceCapture(
  voice: ComposerVoice | undefined,
  onDictated: (text: string) => void,
): VoiceCapture {
  const [purpose, setPurpose] = useState<CapturePurpose | null>(null);
  const [stage, setStage] = useState<VoiceCapture['stage']>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<VoiceRecorder | null>(null);
  const purposeRef = useRef<CapturePurpose | null>(null);
  // The latest callbacks, so a recording that outlives a render uses them.
  const latest = useRef({ voice, onDictated });
  latest.current = { voice, onDictated };

  const reset = useCallback(() => {
    recorder.current = null;
    purposeRef.current = null;
    setPurpose(null);
    setStage('idle');
    setElapsedMs(0);
  }, []);

  const finish = useCallback(() => {
    const active = recorder.current;
    const what = purposeRef.current;
    if (active === null || what === null) return;
    // Consume Finish once, including while the recorder delivers its last chunk.
    purposeRef.current = null;
    setStage('working');
    void (async () => {
      const clip = await active.stop();
      if (recorder.current !== active) return;
      if (clip === null) {
        reset();
        return;
      }
      try {
        const current = latest.current.voice;
        if (current === undefined) return;
        if (what === 'dictation') {
          const text = await current.transcribe(clip.blob);
          if (recorder.current === active && text !== '') latest.current.onDictated(text);
        } else {
          await current.sendVoiceNote(clip.blob, clip.durationMs);
        }
      } catch (failure) {
        if (recorder.current === active) setError(voiceErrorCopy(failure));
      } finally {
        if (recorder.current === active) reset();
      }
    })();
  }, [reset]);

  const start = useCallback(
    (next: CapturePurpose) => {
      const current = latest.current.voice;
      if (current === undefined || !current.configured || recorder.current !== null) return;
      setError(null);
      const created = new VoiceRecorder(current.recorderDeps ?? browserRecorderDeps(), {
        maxDurationMs: next === 'dictation' ? DICTATION_MAX_MS : VOICE_MESSAGE_MAX_MS,
        // At the cap the clip is used, not lost: a long message still sends.
        onLimit: () => {
          if (recorder.current === created) finish();
        },
        microphone: () => resolveMicrophone(),
      });
      recorder.current = created;
      purposeRef.current = next;
      setPurpose(next);
      setStage('recording');
      created.start().catch((failure: unknown) => {
        if (recorder.current !== created) return;
        setError(voiceErrorCopy(failure));
        reset();
      });
    },
    [finish, reset],
  );

  const cancel = useCallback(() => {
    recorder.current?.cancel();
    reset();
  }, [reset]);

  // The timer reads the recorder rather than counting ticks, so a throttled
  // background window still shows the right length when it comes back.
  useEffect(() => {
    if (stage !== 'recording') return;
    const timer = window.setInterval(() => {
      setElapsedMs(recorder.current?.elapsedMs() ?? 0);
    }, 250);
    return () => window.clearInterval(timer);
  }, [stage]);

  // Leaving the composer (a bot switch remounts it) lets go of the microphone.
  useEffect(
    () => () => {
      recorder.current?.cancel();
      recorder.current = null;
      purposeRef.current = null;
    },
    [],
  );

  return {
    purpose,
    stage,
    elapsedMs,
    error,
    start,
    finish,
    cancel,
    dismissError: () => setError(null),
  };
}

/** One sentence the person can act on; never a server's own text. */
export function voiceErrorCopy(failure: unknown): string {
  if (failure instanceof RecorderError) {
    switch (failure.code) {
      case 'PERMISSION_DENIED':
        return t('composer.voice.denied');
      case 'NO_MICROPHONE':
        return t('composer.voice.noMic');
      default:
        return t('composer.voice.startFailed');
    }
  }
  const { code, message } = failureOf(failure);
  if (code === 'CONFLICT') return t('composer.voice.needsKey');
  if (code === 'PLAN_REQUIRED') return message;
  if (code === 'INVALID_REQUEST') return t('composer.voice.nothingHeard');
  if (code === 'TOO_LARGE') return t('composer.voice.tooLong');
  return t('composer.voice.sendFailed');
}
