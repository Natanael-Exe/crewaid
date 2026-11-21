import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceOption } from '@crewaid/shared';
import { isAbortError } from '../api';
import { t } from '../i18n/i18n';

/** One public sample at a time, fetched on press and released when the picker closes. */
export function useVoicePreview() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const request = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; loading: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const release = useCallback(() => {
    request.current?.abort();
    request.current = null;
    if (audio.current !== null) {
      audio.current.pause();
      audio.current.removeAttribute('src');
      audio.current.load();
    }
    if (objectUrl.current !== null) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
  }, []);
  const stop = useCallback(() => {
    release();
    setPreview(null);
  }, [release]);
  useEffect(() => {
    const element = audio.current;
    return () => {
      element?.pause();
      release();
    };
  }, [release]);

  async function play(voice: VoiceOption): Promise<void> {
    if (voice.id === preview?.id) {
      stop();
      return;
    }
    const element = audio.current;
    if (element === null || voice.previewUrl === undefined) return;
    release();
    setError(null);
    const controller = new AbortController();
    request.current = controller;
    setPreview({ id: voice.id, loading: true });
    try {
      // Public samples need no bearer; a blob keeps the media CSP unchanged.
      const response = await fetch(voice.previewUrl, { signal: controller.signal });
      if (!response.ok) throw new Error('Preview unavailable');
      const blob = await response.blob();
      if (request.current !== controller || controller.signal.aborted) return;
      // Some hosted MP3 samples are labelled text/plain; keep real audio types
      // when supplied, and correct that label so Chromium can play the sample.
      const sample = blob.type.startsWith('audio/')
        ? blob
        : new Blob([blob], { type: 'audio/mpeg' });
      objectUrl.current = URL.createObjectURL(sample);
      element.src = objectUrl.current;
      await element.play();
      if (request.current === controller) setPreview({ id: voice.id, loading: false });
    } catch (caught: unknown) {
      if (request.current !== controller || isAbortError(caught)) return;
      stop();
      setError(t('voice.useVoicePreview.thisPreviewCouldnTPlay'));
    }
  }

  const fail = () => {
    if (objectUrl.current === null) return;
    stop();
    setError(t('voice.useVoicePreview.thisPreviewCouldnTPlay'));
  };
  return { audio, preview, error, play, stop, fail };
}
