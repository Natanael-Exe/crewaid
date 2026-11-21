import { describe, expect, it } from 'vitest';
import { OnboardingBootstrapBodySchema } from '@crewaid/shared';
import { ZodValidationPipe } from '../src/common/zod-validation.pipe.js';
import { writingLanguage } from '../src/providers/user-preferences.js';
import { TEMPLATE_WORDS_EN, templateCatalog } from '../src/experience/template-catalog.js';
import { FAILURE_COPY_EN, failureCopy, setupSentence } from '../src/models/failure-copy.js';
import { normalizeModelError, normalizeRunError } from '../src/models/normalize-error.js';
import {
  DefaultModelUnsetError,
  ModelNeedsCredentialError,
} from '../src/models/model-resolution.service.js';

const row = (values: Partial<Record<'language' | 'systemLanguage', string | null>>) => ({
  language: null,
  timezone: null,
  systemLanguage: null,
  systemTimezone: null,
  ...values,
});

describe('D-235 — the language the server writes in', () => {
  it('is the choice, then the window asking, then the last computer report', () => {
    expect(writingLanguage(row({ language: 'de', systemLanguage: 'fr' }), 'es')).toBe('de');
    expect(writingLanguage(row({ systemLanguage: 'fr' }), 'es')).toBe('es');
    expect(writingLanguage(row({ systemLanguage: 'fr' }))).toBe('fr');
    expect(writingLanguage(null, 'ja')).toBe('ja');
    expect(writingLanguage(null)).toBeNull();
    // A stored value this build no longer knows is not a language.
    expect(writingLanguage(row({ language: 'klingon' }))).toBeNull();
  });

  it('takes a bootstrap with no body, and refuses a language Crewaid does not offer', () => {
    const pipe = new ZodValidationPipe(OnboardingBootstrapBodySchema.optional());
    expect(pipe.transform(undefined, { type: 'body' })).toBeUndefined();
    expect(pipe.transform({ language: 'fr' }, { type: 'body' })).toEqual({ language: 'fr' });
    expect(() => pipe.transform({ language: 'klingon' }, { type: 'body' })).toThrow();
  });
});

describe('D-235 — templates in the account’s language', () => {
  // Every language ships now; English is what an account with no known language reads.
  it('reads English when the language is not known', () => {
    expect(templateCatalog(null)).toBe(templateCatalog('en'));
  });

  it('serves a shipped language’s words over the same structure', () => {
    const english = templateCatalog('en');
    const french = templateCatalog('fr');
    expect(french).not.toBe(english);
    expect(french.map((entry) => entry.id)).toEqual(english.map((entry) => entry.id));
    const maya = french.find((entry) => entry.id === 'bot-maya');
    expect(maya?.bots[0]?.name).toBe('Maya');
    expect(maya?.bots[0]?.systemPrompt).not.toBe(TEMPLATE_WORDS_EN.specialists.maya.persona);
    expect(maya?.bots[0]?.avatarColor).toBe(
      english.find((entry) => entry.id === 'bot-maya')?.bots[0]?.avatarColor,
    );
  });

  it('builds every template from the words, and only names stay outside them', () => {
    const catalog = templateCatalog('en');
    const crew = catalog.find((entry) => entry.id === 'sales-outreach');
    expect(crew?.title).toBe(TEMPLATE_WORDS_EN.crews['sales-outreach']?.title);
    const maya = catalog.find((entry) => entry.id === 'bot-maya');
    expect(maya?.bots[0]?.role).toBe(TEMPLATE_WORDS_EN.specialists.maya.role);
    expect(maya?.bots[0]?.systemPrompt).toBe(TEMPLATE_WORDS_EN.specialists.maya.persona);
    expect(maya?.memberOf).toEqual([TEMPLATE_WORDS_EN.crews['sales-outreach']?.title]);
    expect(Object.keys(TEMPLATE_WORDS_EN.crews)).toHaveLength(
      catalog.filter((entry) => entry.kind === 'crew').length,
    );
  });
});

describe('D-235 — a failed run’s sentence in the account’s language', () => {
  it('words a model failure from its code, in English when the language is not known', () => {
    const failed = normalizeRunError(
      { message: 'rate limit hit', code: '429' },
      { language: null },
    );
    expect(failed.message).toBe(FAILURE_COPY_EN.model[failed.code]);
    expect(failureCopy(null)).toBe(FAILURE_COPY_EN);
  });

  it('words it in a shipped language', () => {
    const failed = normalizeRunError(
      { message: 'rate limit hit', code: '429' },
      { language: 'fr' },
    );
    expect(failed.message).toBe(failureCopy('fr').model[failed.code]);
    expect(failed.message).not.toBe(FAILURE_COPY_EN.model[failed.code]);
  });

  it('keeps connection names verbatim, including replacement metacharacters', () => {
    const connection = "$& $$ $` $'";
    const missing = new ModelNeedsCredentialError(connection);
    expect(missing.message).toBe(
      FAILURE_COPY_EN.setup.modelNeedsCredential.replace('{connection}', () => connection),
    );
    expect(normalizeModelError(missing).message).toBe(missing.message);
  });

  it('words a setup refusal from the sentence it carries, with the connection named', () => {
    const missingKey = new ModelNeedsCredentialError('OpenRouter');
    expect(missingKey.message).toBe(setupSentence(missingKey.sentence, null));
    expect(missingKey.message.startsWith('OpenRouter has no API key yet')).toBe(true);
    expect(normalizeModelError(missingKey, { language: null }).message).toBe(missingKey.message);
    const french = normalizeModelError(missingKey, { language: 'fr' }).message;
    expect(french).not.toBe(missingKey.message);
    expect(french).toContain('OpenRouter');
    expect(normalizeModelError(new DefaultModelUnsetError()).message).toBe(
      FAILURE_COPY_EN.setup.defaultModelUnset,
    );
  });
});
