import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceNoteResponse } from '@crewaid/shared';
import { uploadVoiceNote, type ApiClient } from '../api';
import type { ChatThreadView } from '../chat/ChatThread';
import { voiceErrorCopy } from '../components/composer/useVoiceCapture';

export type PendingVoiceNote = {
  readonly id: string;
  readonly threadId: string;
  readonly clip: Blob;
  readonly durationMs: number;
  readonly status: 'sending' | 'failed';
  readonly error: string | null;
  readonly attachmentId: string | null;
};

/** Unsent clips belong to this window and their original thread, never to history. */
export function useVoiceOutbox(client: ApiClient) {
  const [notes, setNotes] = useState<readonly PendingVoiceNote[]>([]);
  const uploaded = useRef(new Map<string, VoiceNoteResponse>()).current;
  const inFlight = useRef(new Map<string, AbortController>()).current;

  useEffect(
    () => () => {
      for (const controller of inFlight.values()) controller.abort();
    },
    [inFlight],
  );

  const attempt = useCallback(
    async (note: PendingVoiceNote, send: ChatThreadView['send'] | null) => {
      if (inFlight.has(note.id)) return;
      const controller = new AbortController();
      inFlight.set(note.id, controller);
      setNotes((rows) =>
        rows.map((row) => (row.id === note.id ? { ...row, status: 'sending', error: null } : row)),
      );
      try {
        // Capture the thread's sender before uploading. Switching bots while
        // the upload runs must never send this recording to the new bot.
        if (send === null) throw new Error('The conversation is not open.');
        let result = uploaded.get(note.id);
        if (result === undefined) {
          result = await uploadVoiceNote(client, note.clip, controller.signal);
          uploaded.set(note.id, result);
        }
        if (controller.signal.aborted) return;
        const { attachment, transcript } = result;
        const { id, filename, mimeType, sizeBytes, kind, durationMs } = attachment;
        setNotes((rows) =>
          rows.map((row) => (row.id === note.id ? { ...row, attachmentId: attachment.id } : row)),
        );
        if (
          !(await send(transcript, [id], [{ id, filename, mimeType, sizeBytes, kind, durationMs }]))
        )
          throw new Error('The voice message was not sent.');
        uploaded.delete(note.id);
        setNotes((rows) => rows.filter((row) => row.id !== note.id));
      } catch (failure: unknown) {
        if (!controller.signal.aborted)
          setNotes((rows) =>
            rows.map((row) =>
              row.id === note.id
                ? { ...row, status: 'failed', error: voiceErrorCopy(failure) }
                : row,
            ),
          );
      } finally {
        inFlight.delete(note.id);
      }
    },
    [client, inFlight, uploaded],
  );

  const send = useCallback(
    (threadId: string, clip: Blob, durationMs: number, sender: ChatThreadView['send'] | null) => {
      const note: PendingVoiceNote = {
        id: crypto.randomUUID(),
        threadId,
        clip,
        durationMs,
        status: 'sending',
        error: null,
        attachmentId: null,
      };
      setNotes((rows) => [...rows, note]);
      return attempt(note, sender);
    },
    [attempt],
  );

  const discard = useCallback(
    (id: string) => {
      if (inFlight.has(id)) return;
      uploaded.delete(id);
      setNotes((rows) => rows.filter((row) => row.id !== id));
    },
    [inFlight, uploaded],
  );

  return { notes, send, retry: attempt, discard };
}
