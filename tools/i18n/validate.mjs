/**
 * D-234: what makes a translation of one message acceptable. Used on every
 * answer the model gives and by the catalog test, so a file that passes the
 * test is one the tool would have accepted.
 */
import { englishUnits, hashOf, readSnapshot, shippedLocales, translatedUnits } from './sources.mjs';
import { pluralCategories } from './languages.mjs';

const PLACEHOLDER = /\{(\w+)\}/g;
const TAG = /<\/?(\w+)>/g;

function placeholders(text) {
  return new Set(
    typeof text === 'string' ? [...text.matchAll(PLACEHOLDER)].map((match) => match[1]) : [],
  );
}

function tags(text) {
  return [...text.matchAll(TAG)].map((match) => match[0]).sort();
}

const count = (text, needle) => text.split(needle).length - 1;
const sameSet = (a, b) => a.size === b.size && [...a].every((item) => b.has(item));
const isPlural = (message) =>
  message !== null && typeof message === 'object' && !Array.isArray(message);

/** Tokens people must be able to copy, and names that identify the same product in every language. */
function protectedTokens(text) {
  return new Set([
    ...[...text.matchAll(/<code>(.*?)<\/code>/gs)].map((match) => match[1]),
    ...[...text.matchAll(/https?:\/\/[^\s<>"']*/g)].map((match) =>
      match[0].replace(/[.,;!?]+$/, ''),
    ),
    ...[...text.matchAll(/(?:^|\s)([@/][A-Za-z][\w-]*)/g)].map((match) => match[1]),
    ...[
      ...text.matchAll(
        /\b(?:Crewaid|Stripe|Telegram|Composio|ElevenLabs|OpenRouter|OpenAI|Anthropic|Google|Gmail|GitHub|Notion|Slack|Chrome|BotFather|LinkedIn|Microsoft|CSV|TSV|JSON|PDF|PNG|SVG|MMD|Markdown|Esc)\b/g,
      ),
    ].map((match) => match[0]),
    ...[...text.matchAll(/(?:—\s*|·\s*|\bkey\s+)(Enter)\b/g)].map((match) => match[1]),
    ...[...text.matchAll(/\bgpt-[\w.-]*\w/g)].map((match) => match[0]),
  ]);
}

function balancedTags(text) {
  const stack = [];
  for (const [token, name] of text.matchAll(TAG)) {
    if (token.startsWith('</')) {
      if (stack.pop() !== name) return false;
    } else stack.push(name);
  }
  return stack.length === 0;
}

/** The ways one variant can go wrong against the English it translates. */
function textIssues(english, translated, allowed) {
  const issues = [];
  if (typeof translated !== 'string' || translated.trim() === '') return ['empty'];
  const used = placeholders(translated);
  for (const name of used) if (!allowed.has(name)) issues.push(`unknown placeholder {${name}}`);
  if (tags(english).join() !== tags(translated).join()) issues.push('markup tags differ');
  else if (!balancedTags(translated)) issues.push('markup tags are unbalanced');
  if (count(english, '**') !== count(translated, '**')) issues.push('bold markers differ');
  for (const token of protectedTokens(english))
    if (!translated.includes(token)) issues.push(`"${token}" was translated`);
  if (english.trim() === english && translated.trim() !== translated)
    issues.push('space at the edge');
  return issues;
}

/** Why `translated` is not an acceptable `locale` rendering of `english`; empty when it is. */
export function messageIssues(english, translated, locale) {
  // A blank line in a multi-line text (the welcome's guide) stays blank.
  if (english === '') return translated === '' ? [] : ['should stay empty'];
  if (!isPlural(english)) {
    if (isPlural(translated)) return ['plural object for a plain message'];
    const issues = textIssues(english, translated, placeholders(english));
    const missing = [...placeholders(english)].filter(
      (name) => !placeholders(translated ?? '').has(name),
    );
    for (const name of missing) issues.push(`missing placeholder {${name}}`);
    return issues;
  }
  if (!isPlural(translated)) return ['plain text for a plural message'];
  const expected = new Set(pluralCategories(locale));
  const given = new Set(Object.keys(translated));
  if (!sameSet(expected, given)) {
    return [
      `plural categories ${[...given].sort().join('/')} should be ${[...expected].sort().join('/')}`,
    ];
  }
  const allowed = new Set(Object.values(english).flatMap((text) => [...placeholders(text)]));
  const issues = [];
  for (const [category, text] of Object.entries(translated)) {
    for (const issue of textIssues(english.other, text, allowed))
      issues.push(`${category}: ${issue}`);
    for (const name of allowed)
      if (name !== 'count' && !placeholders(text).has(name))
        issues.push(`${category}: missing placeholder {${name}}`);
  }
  // `other` is the form every number can land on, so it carries everything English's does.
  for (const name of placeholders(english.other))
    if (!placeholders(translated.other ?? '').has(name))
      issues.push(`other: missing placeholder {${name}}`);
  return issues;
}

/**
 * Structural integrity problems in shipped translations: malformed placeholders,
 * broken markup tags, translated protected tokens, invalid plural categories,
 * or keys that no longer exist in English. Runs on every PR without requiring
 * an API key.
 */
export function catalogIntegrityIssues(locales = shippedLocales()) {
  const english = englishUnits();
  const issues = [];
  for (const locale of locales) {
    const translated = translatedUnits(locale);
    for (const [unit, message] of english) {
      if (!translated.has(unit)) continue;
      for (const issue of messageIssues(message, translated.get(unit), locale))
        issues.push(`${locale} ${unit}: ${issue}`);
    }
    for (const unit of translated.keys())
      if (!english.has(unit)) issues.push(`${locale} ${unit}: no longer in English`);
  }
  return issues;
}

/**
 * Completeness and freshness problems: English strings modified since the last
 * translation snapshot, or keys not yet present in a shipped locale. Checked by
 * maintainers via `pnpm i18n:check` before release; at runtime missing keys
 * fall back to English.
 */
export function catalogCompletenessIssues(locales = shippedLocales()) {
  const english = englishUnits();
  const snapshot = readSnapshot();
  const issues = [];
  for (const [unit, message] of english)
    if (snapshot[unit] !== hashOf(message))
      issues.push(`${unit}: the English changed since it was translated`);
  for (const locale of locales) {
    const translated = translatedUnits(locale);
    for (const unit of english.keys()) {
      if (!translated.has(unit)) issues.push(`${locale} ${unit}: missing`);
    }
  }
  return issues;
}

/**
 * Every problem with the shipped translations: both integrity and completeness.
 * Enforced by `pnpm i18n:check`.
 */
export function catalogIssues(locales = shippedLocales()) {
  return [...catalogIntegrityIssues(locales), ...catalogCompletenessIssues(locales)];
}
