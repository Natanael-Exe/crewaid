import { z } from 'zod';

/**
 * What the compiler asks the model for, and what it does with the answer
 * (M3-BE-06, PRD §6/M3).
 *
 * §6 fixes the output schema:
 *
 * name: string; // snake_case
 * description: string;
 * paramsSchema: JSONSchema; // object type; every param needs a description
 * script: string; // TS module, default-exports async run(ctx, params)
 */

/**
 * The parameter types a recorded skill can take.
 *
 * Deliberately not "any JSON Schema type": a skill's arguments are values a
 * person types into a form or a bot passes to `run_skill`, and an
 * array-of-objects parameter has no recorded gesture behind it — nothing in a
 * coordinate-level trace could have demonstrated one.
 */
export const SkillParamTypeSchema = z.enum(['string', 'number', 'integer', 'boolean']);

/**
 * A reason a compile cannot proceed, already written for an operator.
 *
 * Distinct from anything a provider throws, and that distinction is the whole
 * point: it decides whether `Recording.error` tells someone their model call
 * failed or that the model answered with something unusable. The two send
 * them to look in completely different places.
 */
export class CompileRefused extends Error {}

const SkillParamSchema = z.object({
  name: z.string().describe('snake_case name, used as the JSON Schema property name'),
  type: SkillParamTypeSchema,
  description: z.string().describe('what this parameter is for; §6 requires one on every param'),
  required: z.boolean().describe('false only when the script has a sensible default'),
});

/**
 * The compile output schema — what the model is asked for and what `persist` stores.
 *
 * Why the model returns a parameter list, not a json schema
 *
 * §6 names the field `paramsSchema: JSONSchema`, and that is what gets stored.
 * It is not what gets ASKED for, for two reasons that pull the same way.
 *
 * JSON Schema is recursive, and the shared `JsonSchemaObjectSchema` expresses
 * that with `z.lazy`. Generation constraints (and the schema rendered into the
 * compile prompt) work by describing the answer's shape up front, and a
 * recursive schema either fails that conversion or degrades to "any object" —
 * at which point "every param needs a description" is a sentence the model
 * reads rather than something the shape enforces.
 *
 * Second, a model asked for JSON Schema writes *plausible* JSON Schema:
 * `"type": "str"`, `required` nested inside a property, a `properties` map
 * whose values are bare type strings. Each is a defect that surfaces at run
 * time, in the runner, long after the compile that caused it.
 *
 * A flat list has neither problem, and `toParamsSchema` below assembles the
 * §3 column from it — one place, no guessing.
 */
export const CompiledSkillSchema = z.object({
  name: z.string().describe('snake_case, e.g. open_settings_panel'),
  description: z.string().describe('one or two sentences: what the skill does, from outside'),
  params: z.array(SkillParamSchema).describe('empty when the task takes no arguments'),
  steps: z
    .array(z.string().min(1).max(300))
    .max(30)
    .describe(
      'the task as a short list of plain-language steps, in order, one per meaningful ' +
        'action — what a person reads to check what the skill will do before approving it. ' +
        'No coordinates, selectors, or code in them.',
    ),
  script: z
    .string()
    .describe('a TypeScript module that default-exports async run(ctx: SkillContext, params)'),
});

export type CompiledSkill = z.infer<typeof CompiledSkillSchema>;
export type SkillParam = z.infer<typeof SkillParamSchema>;

/**
 * The D-042 judgement, asked of the model before a truncated trace is
 * compiled: is it worth compiling at all?
 *
 * One boolean and one sentence. The reason is the operator-facing half — a
 * `false` lands it on `Recording.error`, next to the warning that explains
 * the truncation — so it is written for the person who recorded the task,
 * not for a log.
 */
export const CompilabilitySchema = z.object({
  worthCompiling: z
    .boolean()
    .describe('true only when the captured part reaches a natural end of the task'),
  reason: z
    .string()
    .min(1)
    .describe('one sentence naming the evidence that decided it, shown to the operator'),
});

export type CompilabilityDecision = z.infer<typeof CompilabilitySchema>;

/**
 * The JSON Schema document stored in `Skill.paramsSchema`.
 *
 * Spelled out rather than typed as the shared `Json` union. `Json` admits
 * null, which Prisma's `InputJsonValue` does not, so the loose type would
 * force a cast at exactly the boundary CLAUDE.md says never to cast across —
 * and a cast there has already hidden one live defect in this repo. A precise
 * type has nothing to silence. It is a type ALIAS rather than an interface
 * for the same reason: only an alias gets TypeScript's implicit index
 * signature, which is what Prisma's `InputJsonObject` asks for.
 */
export type SkillParamsSchema = {
  readonly type: 'object';
  readonly properties: Record<string, { type: SkillParamType; description: string }>;
  readonly required: string[];
  readonly additionalProperties: false;
};

export type SkillParamType = z.infer<typeof SkillParamTypeSchema>;

/**
 * Assemble the `Skill.paramsSchema` from the list the model returned.
 *
 * Duplicate names are refused rather than merged: two params of the same name
 * means the model described one argument twice, and silently keeping the last
 * would hand the runner a schema that does not match the script above it.
 */
export function toParamsSchema(params: readonly SkillParam[]): SkillParamsSchema {
  const properties: Record<string, { type: SkillParamType; description: string }> = {};
  const required: string[] = [];
  for (const param of params) {
    if (Object.prototype.hasOwnProperty.call(properties, param.name)) {
      throw new CompileRefused(`the model described the parameter "${param.name}" twice`);
    }
    properties[param.name] = { type: param.type, description: param.description };
    if (param.required) required.push(param.name);
  }
  return {
    type: 'object',
    properties,
    required,
    // A recorded skill's arguments are exactly the ones it was taught. An
    // extra key is a caller mistake worth reporting, not a value to ignore.
    additionalProperties: false,
  };
}

/**
 * The target interface, transcribed verbatim, plus the browser half
 * §6/M4 requires ("emit Playwright calls for them").
 *
 * Sent to the model as source rather than as prose. It is the API the script
 * is written against, and a paraphrase of an interface is how a compiler ends
 * up emitting `ctx.pressKey` for something called `key`.
 *
 * `page` is PRESENT in every run even though only a browser-task recording
 * uses it: the trace is what says which steps have a page, and an interface
 * the model must conditionally reference would make every skill's shape
 * depend on a fact it cannot see.
 */
/**
 * The mandatory timing rule — one wording, every prompt that sends
 * a model at a trace or a script.
 *
 * A compiled skill waits with predicates, never durations. The D-042
 * judgement, the compile, and the revise all read the same evidence, so
 * the rule is shared here rather than copied — every request's wording is
 * identical by construction, not by three copies that can drift apart.
 */
export const TIMING_RULE = `Waits are predicates, never durations. Never call \`sleep(n)\`, and never use
    \`setTimeout(...)\` — where the trace shows a pause (a page loading, an app
    starting), wait with \`ctx.waitFor(async () => ..., timeoutMs)\`. The
    predicate answers whether the next step can go now — in the simplest case,
    capture twice and return true once the screen stops changing — and the
    timeout is the longest you are willing to wait, not a duration to spend. A
    gap in the trace is evidence that a wait happened there, never evidence of
    how long it was.`;

export const SKILL_CONTEXT_SOURCE = `interface SkillContext {
  click(x: number, y: number): Promise<void>;
  doubleClick(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  key(combo: string): Promise<void>;          // "ctrl+c", "Return"
  screenshot(): Promise<Buffer>;
  waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void>;
  log(msg: string): void;
  page: BrowserPage;                          // the sandbox browser's page
}

interface BrowserScope {
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  fill(selector: string, text: string, options?: { timeout?: number }): Promise<void>;
  waitForSelector(selector: string, options?: { timeout?: number; visible?: boolean }): Promise<void>;
  frameLocator(selector: string): BrowserScope;
}

interface BrowserPage extends BrowserScope {
  waitForLoadState(state?: 'load' | 'domcontentloaded', options?: { timeout?: number }): Promise<void>;
}

// Native Playwright resolves selectors strictly and waits for actionability.
// timeout is positive milliseconds (default 10000, maximum 60000).
// No first-match or forced action fallback. Use frameLocator only with a frame
// path evidenced by the demonstration; root-relative iframe/shadow selectors
// do not identify a target on the main page. Preserve their X11 coordinates.
// A popup from the selected page becomes selected; closing it returns to a live
// existing page. Never launch a browser, context or page. Do not mix a browser
// click with raw keys unless the demonstrated desktop focus is established.`;

/**
 * How to read the trace (M3-BE-01/02/03 decide the X11 vocabulary, M4-BE-02/04
 * the CDP rows, so this is the one place the two have to agree).
 *
 * The never-both-layers rule lives in the vocabulary
 *
 * "Write `correlatedWithId` on both rows. The compiler must not emit
 * both." `foldCorrelated` already collapsed every proven pair, so by the time
 * a trace reaches the model a correlated click appears exactly ONCE — as the
 * "click" row. The legend says so where the model is reading row types, which
 * is why it repeats the guarantee instead of trusting the prompt's rules
 * section alone: a model that emits a coordinate click AND a Playwright click
 * for the same action produces a script that clicks twice, and no validator
 * could reliably catch that after the fact.
 */
export const TRACE_LEGEND = `The trace is one JSON object per line, in order, where:
  - "ms" is milliseconds since the recording started. Gaps are evidence that a
    wait is needed, never evidence of how long it should be.
  - "type":"pointer" carries "x", "y" and "buttonMask" (RFC 6143: bit 0 is the
    left button, bit 1 middle, bit 2 right). A press and a release at the same
    point is a click; a press, some movement and a release is a drag.
  - "type":"pointer-path" packs consecutive movements with no button held.
    "points" contains every [ms, x, y] sample in order, with buttonMask = 0.
    Use these to recognize hover targets; do not turn each sample into a step.
    Button transitions, drags and scroll events are separate pointer rows.
  - "type":"type" carries "text": a run of typing, already merged.
  - "type":"key" carries "combo": one discrete keystroke, e.g. "ctrl+a" or
    "Return".
  - "screenshot": N means image N below shows a 200x200 crop of the screen at
    that moment, and "cropX"/"cropY" are that crop's top-left corner in screen
    coordinates.
  - "type":"click" is a click the page itself saw. "candidates" are its
    selectors, best first (data-testid, id, aria-label+role, CSS path), each
    with the "unique" flag the page measured at that moment; the first
    candidate with "unique":true names the element. A browser click the
    recorder could not name with a selector the page can execute carries no
    "candidates": drive it at its "x"/"y", the same as any other coordinate
    click. "x"/"y" are where the click landed on the desktop. When a click was
    captured on both layers it appears ONCE, as this row — its raw X11 pointer
    twin is not repeated, and the button's release belongs to this row, not a
    step of its own.
  - "type":"input"/"change" is a browser field that changed, with the same
    "candidates" ladder and the "value" the field ended up containing. The raw
    "type"/"key" rows that also recorded those keystrokes are the same action
    at the X11 layer.
  - "type":"navigate" carries "url": the page began loading that document.
    "type":"load" carries "url": that document finished loading.
  - "type":"submit" is a form the page submitted — the consequence of the step
    before it, evidence that a wait or a new document follows.`;
