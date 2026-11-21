import { setupSentence, type SetupSentence } from './failure-copy.js';

/**
 * A model that cannot be called because of how it is set up, rather than
 * because a provider refused the call: no default chosen, a model
 * that is gone, a connection without a key.
 *
 * Ours, and written for the person: the message names the setting and where
 * it lives. So `normalizeModelError` forwards it as the sentence they read,
 * where a provider-shaped guess ("something went wrong between the bot and
 * the model") would send them looking at the wrong end.
 */
export abstract class ModelSetupError extends Error {
  /**
   * Which sentence this is, so the person reads it in their language.
   * The English one is the message, for the log and any path that has no
   * person behind it.
   */
  protected constructor(readonly sentence: SetupSentence) {
    super(setupSentence(sentence, null));
  }
}
