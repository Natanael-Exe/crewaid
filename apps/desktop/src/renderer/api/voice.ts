import {
  API_ROUTES,
  VoiceListResponseSchema,
  VoiceNoteResponseSchema,
  VoiceStatusResponseSchema,
  VoiceTranscriptionResponseSchema,
  type VoiceListResponse,
  type VoiceNoteResponse,
  type VoiceStatusResponse,
  type VoiceTranscriptionResponse,
} from '@crewaid/shared';
import type { ApiClient } from './apiClient';

/**
 * D-221 voice routes. A clip goes up as multipart under `file`, the field
 * the server's interceptor reads, named for its type so the server can tell
 * a webm from an m4a without sniffing.
 */
function clipForm(clip: Blob): FormData {
  const form = new FormData();
  const extension = clip.type.startsWith('audio/mp4') ? 'm4a' : 'webm';
  form.append('file', clip, `recording.${extension}`);
  return form;
}

/** POST /voice/transcriptions — dictation: the words, nothing kept. */
export function transcribe(
  client: ApiClient,
  clip: Blob,
  signal?: AbortSignal,
): Promise<VoiceTranscriptionResponse> {
  return client.request(API_ROUTES.voice.transcribe, {
    body: clipForm(clip),
    schema: VoiceTranscriptionResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

/**
 * POST /voice/notes — a voice message. The answer is an unclaimed upload and
 * its transcript; sending the transcript with that id is what posts it.
 */
export function uploadVoiceNote(
  client: ApiClient,
  clip: Blob,
  signal?: AbortSignal,
): Promise<VoiceNoteResponse> {
  return client.request(API_ROUTES.voice.note, {
    body: clipForm(clip),
    schema: VoiceNoteResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

/** GET /voice/voices — what a bot can speak in. */
export function listVoices(client: ApiClient, signal?: AbortSignal): Promise<VoiceListResponse> {
  return client.request(API_ROUTES.voice.voices, {
    schema: VoiceListResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

/** GET /voice/status — whether this account can speak and listen at all. */
export function voiceStatus(client: ApiClient): Promise<VoiceStatusResponse> {
  return client.request(API_ROUTES.voice.status, { schema: VoiceStatusResponseSchema });
}
