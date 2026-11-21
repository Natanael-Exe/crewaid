import { describe, expect, it } from 'vitest';

import { validateCompiled } from '../src/skills/skill-validator.js';
import type { CompiledSkill } from '../src/skills/skill-compile.contract.js';

/**
 * M3-BE-08 — the output validator.
 *
 * §6/M3's required test: "output validator rejects a script containing
 * `sleep(`, a missing `paramsSchema`, or a non-snake_case name." The
 * validator is a pure function, so these pin the exact verdicts the compile
 * service retries on — without a model, a database, or a queue in the way.
 *
 * The validator judges the model's raw REPLY — parse, then shape, then
 * semantics — so every case below travels as the text a model would have
 * answered with.
 */

const GOOD: CompiledSkill = {
  name: 'search_the_web',
  description: 'Searches for a term and opens the first result.',
  params: [{ name: 'query', type: 'string', description: 'what to search for', required: true }],
  steps: ['Open Chrome.', 'Type the search term.', 'Press Enter.'],
  script: 'export default async function run(ctx, params) { await ctx.type(params.query); }',
};

const good = (): string => JSON.stringify(GOOD);

/** One cast, once: the point of several cases below is an answer the type cannot hold. */
const answer = (over: Record<string, unknown>): string => JSON.stringify({ ...GOOD, ...over });

function defectsOf(reply: string): string {
  const verdict = validateCompiled(reply);
  return verdict.ok ? '' : verdict.defects.join(' | ');
}

describe('validateCompiled — the reply is parsed before it is judged', () => {
  it('accepts the bare object', () => {
    expect(validateCompiled(good()).ok).toBe(true);
  });

  it('extracts the object from a markdown fence', () => {
    const verdict = validateCompiled('```json\n' + good() + '\n```');

    expect(verdict.ok).toBe(true);
  });

  it('extracts the object from a sentence wrapped around it', () => {
    const verdict = validateCompiled(
      'Here is the compiled skill:\n' + good() + '\nHope this helps!',
    );

    expect(verdict.ok).toBe(true);
  });

  it('rejects a reply with no JSON object as a defect, not a crash', () => {
    const verdict = validateCompiled('I compiled the task into a TypeScript module; see above.');

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.defects.join(' ')).toContain('no readable JSON object');
    }
  });
});

describe('validateCompiled — the shape (the schema the prompt carries)', () => {
  it('rejects an answer missing a field, naming the field', () => {
    // JSON.stringify drops the key, which is how "the model left it out"
    // arrives: the object simply does not have it.
    const defects = defectsOf(answer({ params: undefined }));

    expect(defects).toContain('"params" is missing');
  });

  it('rejects a field of the wrong type', () => {
    const defects = defectsOf(answer({ params: { name: 'query' } }));

    expect(defects).toContain('"params" must be array');
  });

  it('rejects an unknown parameter type', () => {
    const defects = defectsOf(
      answer({ params: [{ name: 'query', type: 'text', description: 'a', required: true }] }),
    );

    expect(defects).toContain('"params.0.type"');
  });
});

describe('validateCompiled — a usable answer comes back assembled', () => {
  it('accepts the happy path and carries §3’s paramsSchema', () => {
    const verdict = validateCompiled(good());

    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.skill.name).toBe('search_the_web');
      expect(verdict.skill.paramsSchema).toEqual({
        type: 'object',
        properties: { query: { type: 'string', description: 'what to search for' } },
        required: ['query'],
        additionalProperties: false,
      });
    }
  });

  it('takes a skill with no arguments at all', () => {
    const verdict = validateCompiled(JSON.stringify({ ...GOOD, params: [] }));

    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.skill.paramsSchema).toEqual({
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      });
    }
  });
});

describe('validateCompiled — the §6 timing rule (M3-QA-03)', () => {
  it('rejects a script containing `sleep(`', () => {
    const defects = defectsOf(answer({ script: 'await sleep(250); await ctx.type("x");' }));

    expect(defects).toContain('sleep(');
    expect(defects).toContain('waitFor');
  });

  it('rejects sleep( hidden behind a context or a member call', () => {
    // The literal match is deliberate: `ctx.sleep(500)` and `await sleep(1)`
    // mean the same banned thing, and a miss here ships a blind wait.
    expect(defectsOf(answer({ script: 'await ctx.sleep(500);' }))).toContain('sleep(');
    expect(defectsOf(answer({ script: 'await timers.sleep(500);' }))).toContain('sleep(');
  });

  it('rejects a script containing `setTimeout(`', () => {
    const defects = defectsOf(answer({ script: 'await new Promise((r) => setTimeout(r, 500));' }));

    expect(defects).toContain('setTimeout(');
    expect(defects).toContain('waitFor');
  });

  it('accepts the waitFor predicate the rule demands', () => {
    const defects = defectsOf(
      answer({
        script:
          'let last = await ctx.screenshot(); await ctx.waitFor(async () => { const next = await ctx.screenshot(); const done = last.equals(next); last = next; return done; }, 15000);',
      }),
    );

    expect(defects).toBe('');
  });
});

describe('validateCompiled — the name is snake_case (PRD §3, M3-QA-03)', () => {
  it('rejects a name that is not, and names the offending value', () => {
    const defects = defectsOf(answer({ name: 'SearchTheWeb' }));

    expect(defects).toContain('SearchTheWeb');
    expect(defects).toContain('not snake_case');
  });

  it('rejects kebab-case and a leading digit too', () => {
    expect(defectsOf(answer({ name: 'open-settings' }))).toContain('not snake_case');
    expect(defectsOf(answer({ name: '2fast' }))).toContain('not snake_case');
  });

  it('accepts digits and underscores after the first letter', () => {
    expect(defectsOf(answer({ name: 'open_settings_2' }))).toBe('');
  });
});

describe('validateCompiled — the paramsSchema (M3-QA-03)', () => {
  it('rejects a parameter list that describes one argument twice', () => {
    const defects = defectsOf(
      answer({
        params: [
          { name: 'query', type: 'string', description: 'a', required: true },
          { name: 'query', type: 'number', description: 'b', required: false },
        ],
      }),
    );

    expect(defects).toContain('twice');
  });

  it('rejects a parameter nobody described', () => {
    const defects = defectsOf(
      answer({
        params: [{ name: 'query', type: 'string', description: '   ', required: true }],
      }),
    );

    expect(defects).toContain('"query"');
    expect(defects).toContain('no description');
  });
});

describe('validateCompiled — every defect in one verdict', () => {
  it('collects the whole list, so one retry can fix all of it', () => {
    const defects = defectsOf(
      answer({
        name: 'SearchTheWeb',
        script: 'await sleep(10); await new Promise((r) => setTimeout(r, 10));',
        params: [
          { name: 'query', type: 'string', description: 'dup', required: true },
          { name: 'query', type: 'string', description: 'dup', required: false },
        ],
      }),
    );

    // Name, both forbidden waits, the duplicate — four sentences, not the
    // first one found. A retry that repaired one defect per attempt would
    // need as many attempts as there are ways to be wrong.
    expect(defects.split(' | ')).toHaveLength(4);
    expect(defects).toContain('SearchTheWeb');
    expect(defects).toContain('sleep(');
    expect(defects).toContain('setTimeout(');
    expect(defects).toContain('twice');
  });
});
