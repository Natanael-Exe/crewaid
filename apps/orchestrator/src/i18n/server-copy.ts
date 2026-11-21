import type { TemplateWords } from '../experience/template-catalog.js';
import type { FailureCopy } from '../models/failure-copy.js';

/**
 * Everything the server writes for a person, in one language besides
 * English. Each language is one generated file in `./locales`; the English
 * lives beside the code that uses it. A part the translation tool could not
 * complete is left out, and reads English.
 */
export type ServerCopy = {
  readonly templates?: TemplateWords;
  readonly failures?: FailureCopy;
};
