/**
 * D-234: keep every language's translations in step with the English.
 *
 *   pnpm i18n:check                      what is missing, stale or broken (exit 1 if anything)
 *   pnpm i18n:translate                  translate what is missing or stale in every shipped language
 *   pnpm i18n:translate --locales fr,de  ...or in these, adding them if new
 *
 * Options: --max-chunks N (a pilot), --dry (print, write nothing), --model,
 * --effort (the model's reasoning effort), --concurrency.
 *
 * Talks to OpenRouter's chat completions with plain fetch and needs
 * OPENROUTER_API_KEY, from the environment or from infra/compose/.env, which
 * `pnpm i18n:translate` loads when it exists (as `pnpm orch` does). A value
 * already exported in the shell wins over the file. It is a key for this tool
 * only, so it stays out of .env.example: no deployment reads it (V1-06).
 * It fixes the vocabulary per language first
 * (tools/i18n/glossary), translates in chunks of related strings, checks
 * every answer, and asks again, with the reasons, for any it rejects.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { LANGUAGES, pluralSamples } from './languages.mjs';
import {
  ROOT,
  englishUnits,
  formatFiles,
  hashOf,
  readGlossary,
  readSnapshot,
  shippedLocales,
  translatedUnits,
  writeGlossary,
  writeSnapshot,
  writeTranslations,
} from './sources.mjs';
import { catalogIssues, messageIssues } from './validate.mjs';

const API = 'https://openrouter.ai/api/v1/chat/completions';
/**
 * Every accepted answer, appended the moment it arrives, keyed by the hash of
 * the English it translates. A run that stops — out of credits, a crash, a
 * closed laptop — loses nothing it paid for: the next one starts from here.
 */
const CACHE = join(tmpdir(), 'crewaid-i18n-cache.jsonl');
const MAX_ENTRIES = 60;
const MAX_CHARS = 7000;
/** A chunk that failed once is retried smaller: at high effort a long one can run out of room. */
const RETRY_DIVISOR = 5;

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    locales: { type: 'string' },
    model: { type: 'string', default: 'deepseek/deepseek-v4.1-flash-1017' },
    effort: { type: 'string', default: 'max' },
    concurrency: { type: 'string', default: '16' },
    dry: { type: 'boolean', default: false },
    'max-chunks': { type: 'string' },
  },
});

// ── The words that must not drift ─────────────────────────────────────────

const TERMS = {
  bot: 'an AI agent the person runs; each has a name, a role and its own computer',
  crew: "the person's team of bots, or a group of bots that work together",
  specialist: 'a bot made for one kind of job, offered in templates',
  routine: 'a job a bot runs again and again on a schedule',
  skill: 'a procedure the person taught a bot by recording their own screen',
  plugin: 'a connection to an outside tool server (MCP)',
  connection: 'an account or service the person connected, such as an API key or Gmail',
  tool: 'something a bot can use, such as a browser or a connected app',
  Work: 'the name of the screen that holds tasks, goals and projects; a proper name in the app',
  task: 'one piece of work on the Work board',
  goal: 'an outcome several tasks work toward',
  project: 'a group of related tasks and goals',
  deliverable: 'a file or result a bot produced',
  template: 'a ready-made crew or specialist the person can add',
  computer: 'the Linux computer each bot works on',
  screen: "the live view of a bot's computer",
  'take control': "the person using a bot's computer with their own mouse and keyboard",
  approval: "the person's yes or no to an action a bot asked to take",
  conversation: 'the chat between the person and one bot',
  composer: 'the box where the person types a message',
  model: 'an AI model, such as a Claude or GPT model',
  call: 'a live voice conversation with a bot',
  'voice message': 'a recorded audio message',
  dictation: 'speaking instead of typing into the composer',
  recording: "capturing the person's screen actions to teach a skill",
  memory: 'what a bot remembers about the person',
};
const SCREENS = {
  Settings: "the app's settings window",
  General: 'the first settings pane: account, appearance, language',
  Models: 'the settings pane where AI providers, keys and models are set up',
  Channels: 'the settings pane for messaging apps such as Telegram',
  'Plan & usage': 'the settings pane for the subscription and what is left of it',
  Computer: "the settings pane about the bots' computer",
  Templates: 'the library of ready-made crews and specialists',
  Routines: 'the list of scheduled routines',
};

const PRODUCT = `Crewaid is a desktop app where a person runs a small team of AI agents ("bots"). Each bot has a name, a role and its own Linux computer, whose screen the person can watch and take over. The app also has Work (a board of tasks, goals, projects and deliverables), routines (jobs a bot runs on a schedule), skills (procedures the person taught a bot by recording their screen), plugins and connections (outside tools such as Gmail or GitHub), templates (ready-made crews of specialist bots), calls (talking to a bot by voice), and Settings. Its people are founders, freelancers and small teams.`;

function glossaryRequest(locale) {
  const { name, notes } = LANGUAGES[locale];
  return {
    system: `You are the lead localizer for a software product, choosing its vocabulary in ${name} before anything is translated. ${PRODUCT}`,
    user:
      `Fix the vocabulary for translating Crewaid into ${name}${notes ? ` (${notes})` : ''}.\n\n` +
      `Return one JSON object and nothing else:\n` +
      `{"address": "<how the app speaks to the person in ${name}, e.g. the pronoun or register, in a few English words>",\n` +
      ` "terms": {"<English term>": "<the one ${name} rendering to use everywhere>"},\n` +
      ` "screens": {"<English screen name>": "<its ${name} name>"}}\n\n` +
      `Choose what a well-made consumer app in ${name} would use: natural, current, short. Never translate "Crewaid".\n\n` +
      `Terms (with what each means here):\n${JSON.stringify(TERMS, null, 2)}\n\n` +
      `Screens:\n${JSON.stringify(SCREENS, null, 2)}`,
  };
}

// ── The translation request ───────────────────────────────────────────────

function systemPrompt(locale) {
  const { name, notes } = LANGUAGES[locale];
  return `You are localizing the user interface of a desktop app into ${name}${notes ? ` (${notes})` : ''}. ${PRODUCT}

The English is plain, short, sentence case, and speaks to the person directly. Write ${name} the way a well-made app in that language would: natural and idiomatic, never word for word, and about as short as the English, because these strings sit in buttons, menus and narrow panes. Long texts (a bot's description, an example) should read as if written in ${name}.

Hard rules. A translation that breaks one is rejected:
1. Keep every {placeholder} exactly as written, braces and name included; never translate, drop or add one. Move it wherever the grammar needs it.
2. Keep markup tags such as <code>…</code> and <strong>…</strong>: the same tags, the same number of them. Translate only the words between them, and nothing inside <code>.
3. Keep **bold** markers and list numbering where the English has them, and keep line breaks.
4. Never translate "Crewaid", product or company names (Stripe, Telegram, Composio, ElevenLabs, OpenRouter, OpenAI, Anthropic, Google, Gmail, GitHub, Notion, Slack, Chrome, BotFather and the like), file formats, keyboard keys, URLs, code, or model names.
5. Use the glossary's rendering for its terms every time, and the given names for screens and settings, including when a string points to one ("Settings → Models").
6. A plural entry is an object keyed by plural category. Answer with exactly the categories listed for ${name}, each a whole string, with {count} where the number goes.
7. Answer with one JSON object mapping each id to its translation, and nothing else.`;
}

function languageBlock(locale, glossary) {
  const samples = Object.entries(pluralSamples(locale))
    .map(([category, numbers]) => `${category} (e.g. ${numbers.join(', ')})`)
    .join('; ');
  return (
    `How the app addresses the person: ${glossary.address}\n\n` +
    `Glossary:\n${JSON.stringify(glossary.terms, null, 2)}\n\n` +
    `Screen and setting names:\n${JSON.stringify(glossary.screens, null, 2)}\n\n` +
    `Plural categories for ${LANGUAGES[locale].name}: ${samples}.`
  );
}

function translationRequest(locale, glossary, entries, feedback) {
  const items = entries.map(({ id, unit, english, issues }) => ({
    id,
    where: unit,
    en: english,
    ...(issues === undefined ? {} : { rejected_because: issues }),
  }));
  return {
    system: `${systemPrompt(locale)}\n\n${languageBlock(locale, glossary)}`,
    user:
      (feedback
        ? 'An earlier translation of these was rejected for the reasons given with each. Translate them again, fixing that.\n\n'
        : '') +
      `Translate each entry's "en" into ${LANGUAGES[locale].name}. "where" is the key the text has in the app, for context only.\n\n` +
      JSON.stringify(items, null, 1),
  };
}

// ── The API ───────────────────────────────────────────────────────────────

let spent = 0;
let calls = 0;

/** One chat completion; the JSON object it answers with, or null. Retries what a retry can fix. */
async function complete({ system, user }, retry = false) {
  const key = process.env['OPENROUTER_API_KEY'];
  if (!key) throw new Error('OPENROUTER_API_KEY is not set.');
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    let response;
    try {
      response = await fetch(API, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'x-title': 'Crewaid translations',
        },
        body: JSON.stringify({
          model: options.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          // Credit is reserved against this before the call; an answer needs far less.
          max_tokens: retry ? 32000 : 16000,
          temperature: 0.2,
          reasoning: { effort: options.effort },
          response_format: { type: 'json_object' },
          // Only providers that honour the JSON format; a free-form answer is a wasted call.
          provider: { require_parameters: true },
          usage: { include: true },
        }),
        signal: AbortSignal.timeout(600_000),
      });
    } catch {
      await sleep(3000 * attempt);
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      await sleep(5000 * attempt * attempt);
      continue;
    }
    // No credit or no key: nothing later in the run can succeed either.
    if ([401, 402, 403].includes(response.status))
      throw new Stop(
        `OpenRouter answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    // One refused request: its strings go to the next round.
    if (!response.ok) return null;
    const body = await response.json();
    calls += 1;
    spent += body.usage?.cost ?? 0;
    const choice = body.choices?.[0];
    // An upstream failure can arrive as a 200 with an error and no answer.
    if (body.error !== undefined || choice === undefined) {
      await sleep(3000 * attempt);
      continue;
    }
    if (choice.finish_reason === 'length') return null;
    return parseObject(choice.message?.content ?? '');
  }
  return null;
}

function parseObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A failure no retry fixes (no credit, a bad key): stop sending, keep what came back. */
class Stop extends Error {}

/** `work` over `items`, `size` at a time. A `Stop` ends the run after the calls in flight. */
async function pool(items, size, work) {
  const results = [];
  let next = 0;
  let done = 0;
  let stop;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length && stop === undefined) {
        const item = items[next++];
        try {
          results.push(await work(item));
        } catch (error) {
          if (!(error instanceof Stop)) throw error;
          stop = error;
        }
        done += 1;
        if (done % 25 === 0 || done === items.length)
          console.log(`  ${done}/${items.length} answered`);
      }
    }),
  );
  if (stop !== undefined) throw stop;
  return results;
}

function cached(english) {
  const found = new Map();
  if (!existsSync(CACHE)) return found;
  for (const line of readFileSync(CACHE, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const { locale, unit, hash, text } = JSON.parse(line);
    if (english.has(unit) && hashOf(english.get(unit)) === hash)
      found.set(`${locale} ${unit}`, text);
  }
  return found;
}

function remember(locale, unit, english, text) {
  appendFileSync(CACHE, `${JSON.stringify({ locale, unit, hash: hashOf(english), text })}\n`);
}

// ── Planning ──────────────────────────────────────────────────────────────

function groupOf(unit) {
  const [source, id] = [unit.slice(0, unit.indexOf(':')), unit.slice(unit.indexOf(':') + 1)];
  const parts = id.split('.');
  return source === 'templates' ? `${source}:${parts[0]}.${parts[1]}` : `${source}:${parts[0]}`;
}

/** Units in groups of related strings, each chunk small enough to answer reliably. */
function chunk(units, english, divisor = 1) {
  const maxEntries = Math.max(1, Math.floor(MAX_ENTRIES / divisor));
  const maxChars = Math.max(800, Math.floor(MAX_CHARS / divisor));
  const groups = new Map();
  for (const unit of units) {
    const group = groupOf(unit);
    groups.set(group, [...(groups.get(group) ?? []), unit]);
  }
  const chunks = [];
  let current = [];
  let chars = 0;
  for (const members of groups.values()) {
    for (const unit of members) {
      const size = JSON.stringify(english.get(unit)).length;
      if (current.length > 0 && (current.length >= maxEntries || chars + size > maxChars)) {
        chunks.push(current);
        current = [];
        chars = 0;
      }
      current.push(unit);
      chars += size;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ── Commands ──────────────────────────────────────────────────────────────

function check() {
  const issues = catalogIssues();
  for (const issue of issues.slice(0, 200)) console.log(issue);
  if (issues.length > 200) console.log(`… and ${issues.length - 200} more`);
  console.log(
    issues.length === 0
      ? 'Every shipped language is complete and current.'
      : `${issues.length} issues.`,
  );
  return issues.length === 0 ? 0 : 1;
}

async function glossaries(locales) {
  const missing = locales.filter((locale) => readGlossary(locale) === undefined);
  if (missing.length === 0) return;
  console.log(`Fixing the vocabulary for ${missing.join(', ')}.`);
  const answers = await pool(missing, Number(options.concurrency), async (locale) => [
    locale,
    await complete(glossaryRequest(locale)),
  ]);
  for (const [locale, glossary] of answers) {
    if (
      glossary === null ||
      typeof glossary.terms !== 'object' ||
      typeof glossary.screens !== 'object'
    )
      throw new Error(`No usable glossary came back for ${locale}; run again.`);
    writeGlossary(locale, glossary);
  }
}

async function run() {
  const english = englishUnits();
  const snapshot = readSnapshot();
  const requested = options.locales ? options.locales.split(',').map((code) => code.trim()) : [];
  for (const locale of requested)
    if (!(locale in LANGUAGES)) throw new Error(`Unknown language ${locale}.`);
  const locales = [...new Set([...shippedLocales(), ...requested])].sort();
  if (locales.length === 0) throw new Error('No language to translate: pass --locales.');
  const stale = new Set(
    [...english]
      .filter(([unit, message]) => snapshot[unit] !== hashOf(message))
      .map(([unit]) => unit),
  );

  // What each language needs: missing, broken, or translated from older English.
  const current = new Map(locales.map((locale) => [locale, translatedUnits(locale)]));
  const todo = new Map();
  for (const locale of locales) {
    const have = current.get(locale);
    const need = [...english.keys()].filter((unit) => {
      if (english.get(unit) === '') return false;
      if (!have.has(unit) || stale.has(unit)) return true;
      return messageIssues(english.get(unit), have.get(unit), locale).length > 0;
    });
    if (need.length > 0) todo.set(locale, need);
  }
  const total = [...todo.values()].reduce((sum, units) => sum + units.length, 0);
  console.log(`${total} strings to translate across ${todo.size} languages.`);
  if (total === 0) return finish(locales, english, snapshot, current, new Map());

  await glossaries([...todo.keys()]);

  // What an earlier, interrupted run already paid for.
  const accepted = new Map([...todo.keys()].map((locale) => [locale, new Map()]));
  const earlier = cached(english);
  let pending = new Map();
  let reused = 0;
  for (const [locale, units] of todo) {
    const left = [];
    for (const unit of units) {
      const text = earlier.get(`${locale} ${unit}`);
      if (text !== undefined && messageIssues(english.get(unit), text, locale).length === 0) {
        accepted.get(locale).set(unit, text);
        reused += 1;
      } else left.push(unit);
    }
    if (left.length > 0) pending.set(locale, left);
  }
  if (reused > 0) console.log(`${reused} strings reused from the last run.`);
  let issues = new Map();
  const maxChunks = options['max-chunks'] === undefined ? Infinity : Number(options['max-chunks']);
  for (let round = 1; round <= 3 && pending.size > 0; round += 1) {
    const requests = [];
    for (const [locale, units] of pending) {
      const glossary = readGlossary(locale);
      // Strings that failed before, in this run or an earlier one, go in smaller chunks.
      const retrying = round > 1 || reused > 0;
      for (const members of chunk(units, english, retrying ? RETRY_DIVISOR : 1)) {
        if (requests.length >= maxChunks) break;
        const entries = members.map((unit, index) => ({
          id: `e${index + 1}`,
          unit,
          english: english.get(unit),
          ...(issues.has(`${locale} ${unit}`) ? { issues: issues.get(`${locale} ${unit}`) } : {}),
        }));
        requests.push({
          locale,
          entries,
          retry: retrying,
          request: translationRequest(locale, glossary, entries, round > 1),
        });
      }
    }
    console.log(`Round ${round}: ${requests.length} requests.`);
    const next = new Map();
    issues = new Map();
    // Each answer is checked and kept as it arrives, so a stop keeps it.
    const take = ({ locale, entries }, answer) => {
      for (const { id, unit } of entries) {
        const translated = answer?.[id];
        const problems =
          answer === null
            ? ['no usable answer']
            : messageIssues(english.get(unit), translated, locale);
        if (problems.length === 0) {
          accepted.get(locale).set(unit, translated);
          if (!options.dry) remember(locale, unit, english.get(unit), translated);
        } else {
          issues.set(`${locale} ${unit}`, problems);
          next.set(locale, [...(next.get(locale) ?? []), unit]);
        }
      }
    };
    try {
      await pool(requests, Number(options.concurrency), async (item) =>
        take(item, await complete(item.request, item.retry)),
      );
    } catch (error) {
      if (!(error instanceof Stop)) throw error;
      const kept = [...accepted.values()].reduce((sum, units) => sum + units.size, 0);
      console.log(`Stopped: ${error.message}`);
      console.log(`${kept} strings are saved in ${CACHE}; run the same command again to carry on.`);
      report();
      return 1;
    }
    pending = next;
    if (options.dry) break;
  }
  for (const [locale, units] of pending)
    console.log(
      `  ${locale}: ${units.length} still rejected, e.g. ${units[0]} (${issues.get(`${locale} ${units[0]}`)?.join('; ')})`,
    );
  if (options.dry) {
    for (const [locale, units] of accepted)
      for (const [unit, text] of [...units].slice(0, 12))
        console.log(`${locale} ${unit}: ${JSON.stringify(text)}`);
    report();
    return 0;
  }
  return finish(locales, english, snapshot, current, accepted);
}

function finish(locales, english, snapshot, current, accepted) {
  const merged = new Map();
  for (const locale of locales) {
    const units = new Map();
    for (const [unit, message] of current.get(locale))
      if (english.has(unit)) units.set(unit, message);
    for (const [unit, message] of accepted.get(locale) ?? []) units.set(unit, message);
    for (const [unit, message] of english) if (message === '') units.set(unit, '');
    merged.set(locale, units);
  }
  // A unit is current once every language holds an acceptable translation of today's English.
  for (const [unit, message] of english) {
    const hash = hashOf(message);
    const done = locales.every((locale) => {
      const translated = merged.get(locale).get(unit);
      if (translated === undefined || messageIssues(message, translated, locale).length > 0)
        return false;
      return message === '' || accepted.get(locale)?.has(unit) || snapshot[unit] === hash;
    });
    if (done) snapshot[unit] = hash;
  }
  for (const unit of Object.keys(snapshot)) if (!english.has(unit)) delete snapshot[unit];
  const written = [...writeTranslations(merged), writeSnapshot(snapshot)];
  formatFiles(written);
  report();
  // A fresh process: this one holds the generated modules as they were before it wrote them.
  try {
    execFileSync('pnpm', ['exec', 'tsx', 'tools/i18n/translate.mjs', 'check'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    return 0;
  } catch {
    return 1;
  }
}

function report() {
  console.log(`${calls} calls, $${spent.toFixed(4)} spent (as OpenRouter reports it).`);
}

async function main(command) {
  if (command === 'check') return check();
  if (command !== 'run') {
    console.error(`Unknown command ${command}.`);
    return 2;
  }
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    console.log(`Stopped: ${error.message}`);
    report();
    return 1;
  }
}

process.exitCode = await main(positionals[0] ?? 'check');
