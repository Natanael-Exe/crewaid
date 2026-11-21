/**
 * The hosted service's own ElevenLabs key, and the meter around it.
 *
 * Provided by `BillingModule` only when `CREWAID_ELEVENLABS_API_KEY` is set,
 * which only a cloud server reads. Where it is absent nothing is
 * metered and each person speaks on their own key.
 */

/** Which voice allowance a request draws on: audio heard, or audio made. */
export type VoiceUsage = 'listen' | 'speak';

export interface HostedVoice {
  readonly apiKey: string;
  /**
   * Reserve `estimateSeconds` of this person's `usage` allowance, run the
   * request, then settle to the seconds of audio it really took. Refuses with
   * `VoiceAllowanceExhaustedError` before calling anything once the period's
   * allowance of that kind is spent; a failed request settles to nothing.
   */
  meter<T>(
    userId: string,
    usage: VoiceUsage,
    estimateSeconds: number,
    run: () => Promise<{ readonly value: T; readonly seconds: number }>,
  ): Promise<T>;
}

export const HOSTED_VOICE = Symbol('HOSTED_VOICE');

/** The period's voice minutes of one kind are spent, or no plan is in force. */
export class VoiceAllowanceExhaustedError extends Error {
  constructor(readonly usage: VoiceUsage) {
    super(`voice allowance exhausted: ${usage}`);
    this.name = 'VoiceAllowanceExhaustedError';
  }
}
