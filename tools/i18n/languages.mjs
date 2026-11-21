/**
 * D-234: the languages Crewaid is translated into, with the notes a
 * translator needs to pick the right variety. English is the source.
 */
export const LANGUAGES = {
  af: { name: 'Afrikaans' },
  ar: { name: 'Arabic', notes: 'Modern Standard Arabic.' },
  bn: { name: 'Bengali', notes: 'Standard Bengali (Bangla script).' },
  cs: { name: 'Czech' },
  da: { name: 'Danish' },
  de: { name: 'German' },
  el: { name: 'Greek' },
  es: { name: 'Spanish', notes: 'Neutral Latin American Spanish.' },
  fi: { name: 'Finnish' },
  fr: { name: 'French', notes: 'French as written in France.' },
  ha: { name: 'Hausa', notes: 'Hausa in the Latin (Boko) script.' },
  he: { name: 'Hebrew' },
  hi: { name: 'Hindi', notes: 'Hindi in Devanagari.' },
  hu: { name: 'Hungarian' },
  id: { name: 'Indonesian' },
  it: { name: 'Italian' },
  ja: { name: 'Japanese' },
  ko: { name: 'Korean' },
  mr: { name: 'Marathi', notes: 'Marathi in Devanagari.' },
  nb: { name: 'Norwegian Bokmål' },
  nl: { name: 'Dutch' },
  pl: { name: 'Polish' },
  pt: { name: 'Portuguese', notes: 'Brazilian Portuguese.' },
  ru: { name: 'Russian' },
  sv: { name: 'Swedish' },
  sw: { name: 'Swahili' },
  ta: { name: 'Tamil' },
  te: { name: 'Telugu' },
  th: { name: 'Thai' },
  tr: { name: 'Turkish' },
  uk: { name: 'Ukrainian' },
  ur: { name: 'Urdu', notes: 'Urdu in the Nastaliq (Arabic) script.' },
  vi: { name: 'Vietnamese' },
  'zh-Hans': { name: 'Simplified Chinese', notes: 'Simplified Chinese as used in mainland China.' },
  'zh-Hant': { name: 'Traditional Chinese', notes: 'Traditional Chinese as used in Taiwan.' },
};

/** Laid out right to left (CC-85); the renderer mirrors by reading order. */
export const RIGHT_TO_LEFT = new Set(['ar', 'he', 'ur']);

/** Every category `Intl` gives the language's cardinal plurals, with a number that picks each. */
export function pluralSamples(locale) {
  const rules = new Intl.PluralRules(locale);
  const samples = {};
  for (const category of rules.resolvedOptions().pluralCategories) samples[category] = [];
  for (let n = 0; n <= 200; n += 1) {
    const list = samples[rules.select(n)];
    if (list.length < 3) list.push(n);
  }
  for (const n of [1.5, 1000000]) {
    const list = samples[rules.select(n)];
    if (list.length < 4 && !list.includes(n)) list.push(n);
  }
  return samples;
}

export function pluralCategories(locale) {
  return new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
}
