import { describe, expect, it } from 'vitest';

import {
  CompiledSkillSchema,
  SKILL_CONTEXT_SOURCE,
  toParamsSchema,
  type SkillParam,
} from '../src/skills/skill-compile.contract.js';

/**
 * M3-BE-06 — §6/M3's `generateObject` output schema, and what becomes of it.
 */

const param = (over: Partial<SkillParam> = {}): SkillParam => ({
  name: 'query',
  type: 'string',
  description: 'what to search for',
  required: true,
  ...over,
});

describe('CompiledSkillSchema — what the model is asked for', () => {
  it('accepts the fields §6 names, plus the summary D-098 added', () => {
    const parsed = CompiledSkillSchema.safeParse({
      name: 'search_the_web',
      description: 'Searches for a term and opens the first result.',
      params: [param()],
      steps: ['Open Chrome.', 'Type the search term.', 'Press Enter.'],
      script: 'export default async function run(ctx, params) {}',
    });

    expect(parsed.success).toBe(true);
  });

  it('takes a skill with no arguments at all', () => {
    const parsed = CompiledSkillSchema.safeParse({
      name: 'open_settings',
      description: 'Opens the settings panel.',
      params: [],
      steps: ['Open the settings panel.'],
      script: 'export default async function run(ctx) {}',
    });

    expect(parsed.success).toBe(true);
  });

  it('refuses a reply with no summary — it is part of what §6 asks for now', () => {
    // D-098: the review surface's default view is this list, so an answer
    // without one is an answer the validator sends back for repair.
    const parsed = CompiledSkillSchema.safeParse({
      name: 'open_settings',
      description: 'Opens the settings panel.',
      params: [],
      script: 'export default async function run(ctx) {}',
    });

    expect(parsed.success).toBe(false);
  });

  it('refuses a summary nobody could read: an empty step, or a list beyond the cap', () => {
    const base = {
      name: 'open_settings',
      description: 'Opens the settings panel.',
      params: [],
      script: 'export default async function run(ctx) {}',
    };

    expect(CompiledSkillSchema.safeParse({ ...base, steps: [''] }).success).toBe(false);
    expect(
      CompiledSkillSchema.safeParse({
        ...base,
        steps: Array.from({ length: 31 }, () => 'a step'),
      }).success,
    ).toBe(false);
    // The empty list is the SHAPE's to admit (a skill with nothing to say is
    // a validator verdict, where it can become a sentence the retry acts on).
    expect(CompiledSkillSchema.safeParse({ ...base, steps: [] }).success).toBe(true);
  });

  it('refuses a parameter with no description', () => {
    // §6: "every param needs a description". Enforced by the SHAPE, so the
    // provider constrains generation against it, rather than by a sentence in
    // a prompt the model may or may not honour.
    const parsed = CompiledSkillSchema.safeParse({
      name: 'search_the_web',
      description: 'x',
      params: [{ name: 'query', type: 'string', required: true }],
      steps: ['Search.'],
      script: 'x',
    });

    expect(parsed.success).toBe(false);
  });

  it('refuses a parameter type nothing could have been demonstrated as', () => {
    const parsed = CompiledSkillSchema.safeParse({
      name: 'x',
      description: 'x',
      params: [param({ type: 'array' as never })],
      steps: ['Search.'],
      script: 'x',
    });

    // A coordinate-level trace cannot demonstrate an array-of-objects
    // argument; a skill's parameters are things someone typed.
    expect(parsed.success).toBe(false);
  });
});

describe("toParamsSchema — assembling §3's paramsSchema column", () => {
  it('builds a JSON Schema object from the list', () => {
    expect(
      toParamsSchema([param(), param({ name: 'limit', type: 'integer', required: false })]),
    ).toEqual({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'what to search for' },
        limit: { type: 'integer', description: 'what to search for' },
      },
      required: ['query'],
      additionalProperties: false,
    });
  });

  it('produces a valid empty schema for a skill with no arguments', () => {
    expect(toParamsSchema([])).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });

  it('refuses the same parameter described twice', () => {
    // Keeping the last would hand the runner a schema that does not match the
    // script above it, and the mismatch would surface at run time.
    expect(() => toParamsSchema([param(), param({ description: 'something else' })])).toThrow(
      /described the parameter "query" twice/,
    );
  });

  it('marks nothing required when nothing is', () => {
    expect(toParamsSchema([param({ required: false })]).required).toEqual([]);
  });

  it('refuses extra arguments a skill was never taught', () => {
    expect(toParamsSchema([param()]).additionalProperties).toBe(false);
  });
});

describe("SKILL_CONTEXT_SOURCE — §6's target interface", () => {
  it('carries every method the PRD lists, by name', () => {
    // Transcribed rather than paraphrased: the script is written against this
    // API, and a paraphrase is how a compiler ends up emitting `pressKey` for
    // something called `key`.
    for (const method of [
      'click(x: number, y: number)',
      'doubleClick(x: number, y: number)',
      'type(text: string)',
      'key(combo: string)',
      'screenshot()',
      'waitFor(predicate: () => Promise<boolean>, timeoutMs: number)',
      'log(msg: string)',
    ]) {
      expect(SKILL_CONTEXT_SOURCE).toContain(method);
    }
  });
});
