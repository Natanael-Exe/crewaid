import type { Locale, ModelErrorCode } from '@crewaid/shared';
import { SERVER_TRANSLATIONS } from '../i18n/locales/index.js';

/**
 * Every sentence a person reads when a model call fails, in each
 * language it ships in. One file, so a translation has one source; a
 * language missing here reads English.
 */

/**
 * What the PERSON is told.
 *
 * The audience is someone using a chat app. They do not have the server, they
 * cannot open a log, and they did not choose the provider's vocabulary — so a
 * sentence ending "check logs" asks them to do something they cannot do, and
 * a sentence naming an HTTP condition tells them something they cannot act
 * on. Every line below follows the same three-part shape:
 *
 * 1. **what happened**, in the terms of the thing they were doing,
 * 2. **whose end it is on**, when that is knowable — because "the provider
 * is busy" and "your key is wrong" lead to completely different next
 * moves,
 * 3. **the next move**, and only one, phrased as something they can do from
 * this window.
 *
 * `detail` still carries the vendor text for the log, and the code still
 * reaches the transcript's stopReason. Neither is display text — that
 * separation is D-006's, and this changes only what the display half says.
 */
const MODEL_FAILURES_EN: Readonly<Record<ModelErrorCode, string>> = {
  RATE_LIMITED: 'The model provider is busy right now. Wait a moment and ask the bot to carry on.',
  CONTEXT_OVERFLOW:
    'This conversation is too long for the model to hold at once. Start a new conversation, ' +
    'or switch to a model with a larger context window in the composer.',
  CONTENT_REFUSED:
    'The model would not answer this one. Rephrasing the request usually gets past it.',
  // 401 and 403 both land here, and only one of them is a wrong key: a 403
  // is often a key the provider accepts for something else (a free tier tied
  // to their own app, a region, a plan). So the sentence names the refusal,
  // and the explanation, when the provider gave one, names the reason.
  AUTH_FAILED:
    'The provider would not let the bot use this model. Check its key in Settings → Models, ' +
    'or pick another model in the composer.',
  PROVIDER_UNAVAILABLE:
    'The model provider is having trouble at their end. Try again in a minute, or switch to ' +
    'another model in the composer.',
  TIMEOUT: 'The model took too long to answer. Ask the bot to carry on and it will pick up again.',
  // Names the action the product actually expects, not just the diagnosis.
  // V1 has no automatic fallback (V2-BE-01 owns that), so the answer to a dry
  // account is to pick another model in the composer and tell the bot to carry
  // on — a bot's history is legitimately mixed-model. "Check billing"
  // alone leaves an operator who has a second provider configured waiting on a
  // top-up they did not need.
  QUOTA_EXCEEDED:
    'The provider account is out of credit. Switch to another model in the composer and ask ' +
    'the bot to continue, or top the account up.',
  // The one case that is usually THIS product's fault rather than the
  // operator's. It still gets a next move, because "this may be a bug" with
  // nothing after it leaves someone stuck in front of a bot that will not
  // answer.
  // D-157. Also what an account with no plan meets — its allowance is zero — so
  // the sentence must not claim something was used up. Both ways forward: a
  // plan, or the person's own key, which costs nothing extra and works now.
  ALLOWANCE_EXHAUSTED:
    'There is no included model use left on your plan: you have not chosen one yet, or this ' +
    'period’s is spent. Choose or upgrade a plan in Settings → Plan & usage, or add your own ' +
    'key in Settings → Models and switch to one of its models.',
  INVALID_REQUEST:
    'The model could not take this request. Switching to another model in the composer ' +
    'usually works; if it happens on every model, it is a bug worth reporting.',
  UNKNOWN:
    'Something went wrong between the bot and the model. Ask it to carry on, and switch models ' +
    'in the composer if it happens again.',
};

/**
 * A model that cannot be called because of how it is set up. Each
 * names the setting and where it lives. `{connection}` is the connection's
 * own name, as the person gave it.
 */
const SETUP_FAILURES_EN = {
  defaultModelUnset:
    'This bot is set to use the default model, and no default is chosen yet. ' +
    'Pick a model in the composer, or choose a default in Settings → Models.',
  unknownModel:
    'The model this bot was using is no longer set up. Pick another one in the composer.',
  modelNeedsCredential:
    '{connection} has no API key yet, so its models cannot answer. ' +
    'Add the key in Settings → Models, or pick another model in the composer.',
  contextBudgetUnknown:
    'This model has no context window set, so the bot cannot tell how much of the ' +
    'conversation fits. Set one for it in Settings → Models, or pick another model in ' +
    'the composer.',
  includedModelsUnavailable:
    'Crewaid’s included models are not available on this server. ' +
    'Pick another model in the composer.',
} as const;

export type FailureCopy = {
  readonly model: Readonly<Record<ModelErrorCode, string>>;
  readonly setup: Readonly<Record<keyof typeof SETUP_FAILURES_EN, string>>;
  /** A run that ended failed without saying why. */
  readonly runIncomplete: string;
  /** A reply that came back as raw tool markup, withheld rather than shown. */
  readonly garbledReply: string;
};

export const FAILURE_COPY_EN: FailureCopy = {
  model: MODEL_FAILURES_EN,
  setup: SETUP_FAILURES_EN,
  runIncomplete: 'The bot could not finish this request.',
  garbledReply:
    'The model’s reply came out garbled, so it was not shown. Ask the bot to carry on, or ' +
    'pick another model in the composer if it keeps happening.',
};

const FAILURE_COPIES: Readonly<Partial<Record<Locale, FailureCopy>>> = {
  en: FAILURE_COPY_EN,
  ...Object.fromEntries(
    Object.entries(SERVER_TRANSLATIONS).flatMap(([language, copy]) =>
      copy.failures === undefined ? [] : [[language, copy.failures]],
    ),
  ),
};

export function failureCopy(language: Locale | null | undefined): FailureCopy {
  return (
    (language === null || language === undefined ? undefined : FAILURE_COPIES[language]) ??
    FAILURE_COPY_EN
  );
}

/** Which setup sentence a `ModelSetupError` says, and the name it carries. */
export type SetupSentence = {
  readonly key: keyof FailureCopy['setup'];
  readonly connection?: string;
};

export function setupSentence(
  sentence: SetupSentence,
  language: Locale | null | undefined,
): string {
  const text = failureCopy(language).setup[sentence.key];
  return sentence.connection === undefined
    ? text
    : text.replaceAll('{connection}', () => sentence.connection ?? '');
}
