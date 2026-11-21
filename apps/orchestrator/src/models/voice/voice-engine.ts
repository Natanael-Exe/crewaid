import type { VoiceOption } from '@crewaid/shared';

/**
 * What the server asks of a speech provider.
 *
 * Narrow on purpose. Everything that decides WHEN to listen or speak — the
 * routes, the spoken reply, the meter — is written against this port, so the
 * suites fake it in memory and only `elevenlabs-voice.ts` knows a vendor.
 */
export interface VoiceEngine {
  transcribe(
    audio: { readonly bytes: Uint8Array; readonly mimeType: string },
    signal?: AbortSignal,
  ): Promise<Transcript>;
  /** One mp3 clip of `text`, read in `voiceId`. */
  speak(text: string, voiceId: string, signal?: AbortSignal): Promise<Uint8Array>;
  listVoices(signal?: AbortSignal): Promise<VoiceOption[]>;
}

export type Transcript = {
  readonly text: string;
  readonly languageCode: string | null;
  /** How long the clip was, when the engine measured it. */
  readonly durationSeconds: number | null;
};

/** Builds an engine for one key. Per call, because a self-hosted key is per user. */
export type VoiceEngineFactory = (apiKey: string) => VoiceEngine;

export const VOICE_ENGINE_FACTORY = Symbol('VOICE_ENGINE_FACTORY');

/** The upstream ids a charge is itemised under (D-157's `ModelCharge`). */
export const TRANSCRIPTION_MODEL = 'scribe_v2';
/**
 * The newest real-time voice: flash v2.5 speaks 32 languages, and a
 * reply in Hausa, Thai or Urdu has to be heard in Hausa, Thai or Urdu.
 */
export const SPEECH_MODEL = 'eleven_v4_turbo';

/**
 * The voice a bot speaks in until someone picks one: "Roger", a stock voice
 * labelled conversational rather than narration or character performance.
 */
export const HOUSE_VOICE_ID = 'CwhRBWXzGAHq8TQ4Fs17';

/**
 * Speech comes back as constant-bitrate mp3, asked for by name so the length
 * below stays true: ElevenLabs reports no duration for a synthesis, and a
 * player that reads 0:00 until the clip loads looks broken.
 */
export const SPEECH_OUTPUT_FORMAT = 'mp3_44100_128';

/** A synthesised clip's length: 128 kbit/s is 16 bytes a millisecond. */
export function spokenDurationMs(bytes: number): number {
  return Math.round(bytes / 16);
}

/**
 * How long `text` is assumed to take to say, before the audio exists: about
 * fifteen characters a second. Reserved, then settled to the real length.
 */
export function estimatedSpokenSeconds(text: string): number {
  return Math.max(1, Math.ceil(text.length / 15));
}

/**
 * What a clip of `bytes` is assumed to last before the engine says. Opus in
 * webm records near 32 kbit/s; assuming half that over-reserves, which a
 * settle then gives back, rather than under-reserving past the allowance.
 */
export function estimatedSeconds(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / 2000));
}
