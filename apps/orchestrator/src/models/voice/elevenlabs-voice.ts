import { generateSpeech, generateTranscription, listVoices, type CatalogVoice } from '@tanstack/ai';
import { createElevenLabsSpeech, createElevenLabsTranscription } from '@tanstack/ai-elevenlabs';
import { VoiceOptionSchema, type VoiceOption } from '@crewaid/shared';
import {
  SPEECH_MODEL,
  SPEECH_OUTPUT_FORMAT,
  TRANSCRIPTION_MODEL,
  type Transcript,
  type VoiceEngine,
} from './voice-engine.js';

/** Long enough for a five-minute clip to upload and transcribe. */
const TRANSCRIBE_TIMEOUT_MS = 120_000;
/** A reply capped near 2,500 characters synthesizes in a few seconds. */
const SPEAK_TIMEOUT_MS = 60_000;
const LIST_TIMEOUT_MS = 15_000;

/**
 * The one file that knows the speech provider.
 *
 * Built per key, never from `ELEVENLABS_API_KEY`: the adapter's env fallback
 * would make a self-hosted server speak on whatever key its process happened
 * to inherit, and the hosted key is read once, by the billing config.
 */
export function elevenLabsVoiceEngine(apiKey: string): VoiceEngine {
  const transcriber = createElevenLabsTranscription(TRANSCRIPTION_MODEL, apiKey);
  const speaker = createElevenLabsSpeech(SPEECH_MODEL, apiKey);

  return {
    async transcribe(audio, signal): Promise<Transcript> {
      const result = await generateTranscription({
        adapter: transcriber,
        // Copied into a plain ArrayBuffer: a Blob part may not be a shared one.
        audio: new Blob([new Uint8Array(audio.bytes)], { type: audio.mimeType }),
        timeout: TRANSCRIBE_TIMEOUT_MS,
        ...(signal === undefined ? {} : { abortSignal: signal }),
      });
      return {
        text: result.text.trim(),
        languageCode: result.language ?? null,
        durationSeconds: result.duration ?? null,
      };
    },

    async speak(text, voiceId, signal): Promise<Uint8Array> {
      const result = await generateSpeech({
        adapter: speaker,
        text,
        voice: voiceId,
        format: 'mp3',
        modelOptions: { outputFormat: SPEECH_OUTPUT_FORMAT },
        timeout: SPEAK_TIMEOUT_MS,
        ...(signal === undefined ? {} : { abortSignal: signal }),
      });
      return Buffer.from(result.audio, 'base64');
    },

    async listVoices(signal) {
      // This activity takes no `timeout`, so the bound rides on the signal.
      const bound = AbortSignal.timeout(LIST_TIMEOUT_MS);
      const result = await listVoices({
        adapter: speaker,
        abortSignal: signal === undefined ? bound : AbortSignal.any([signal, bound]),
      });
      return conversationalVoices(result.voices);
    },
  };
}

/** Use the provider's purpose label, never a guess from a voice's name or tone. */
export function conversationalVoices(voices: readonly CatalogVoice[]): VoiceOption[] {
  return voices
    .filter((voice) => voice.labels?.['use_case']?.trim().toLowerCase() === 'conversational')
    .map((voice) => {
      // A missing or unusable preview must not remove an otherwise usable voice.
      const preview = VoiceOptionSchema.shape.previewUrl.safeParse(voice.previewUrl);
      return {
        id: voice.voiceId,
        name: voice.name ?? voice.voiceId,
        ...(preview.success && preview.data !== undefined ? { previewUrl: preview.data } : {}),
      };
    });
}
