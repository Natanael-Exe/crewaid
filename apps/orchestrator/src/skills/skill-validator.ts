import { SnakeCaseSchema } from '@crewaid/shared';
import type { z } from 'zod';

import { parseJsonAnswer } from '../models/structured-answer.js';
import {
  CompiledSkillSchema,
  CompileRefused,
  toParamsSchema,
  type SkillParamsSchema,
} from './skill-compile.contract.js';

/**
 * The output validator.
 *
 * §6's acceptance criteria: "Generated scripts contain no `sleep(` or
 * `setTimeout(`. Enforced by a validator that retries once with a corrective
 * message before failing." The validator is the thing that decides an answer
 * is unusable, and it exists separately from the compile service so that
 * decision is a pure function of the answer — unit-testable without a model,
 * a database, or a queue in the way.
 *
 * What it judges, in order
 *
 * The raw reply text. The model is asked for a JSON object whose shape is in
 * the prompt (`answerInstructions`), because no capability record promises a
 * provider can constrain generation to a schema — so parsing and shape are
 * THIS file's verdict, not the transport's: a fenced or prose-wrapped object
 * is extracted, and anything that is not a `CompiledSkill` becomes defects the
 * corrective retry can act on, exactly like a semantic defect. What remains
 * after the shape are the two defects the shape cannot express:
 *
 * - a script that waits by sleeping (the §6 timing rule), and
 * - a name that is not snake_case (a regex, not a type).
 *
 * plus the assembly step that turns the model's flat parameter list into §3's
 * `paramsSchema` column, whose refusals (a parameter described twice) are
 * defects to repair rather than exceptions to throw.
 *
 * Why defects are sentences
 *
 * The same list is shown to two audiences: the model, in the corrective retry
 * (M3-BE-08), and — when the retry cannot fix it — the operator, on
 * `Recording.error`. Each sentence therefore says what is wrong AND
 * what the correct shape is, so it reads as direction to the model and as a
 * diagnosis to the person who recorded the task.
 */

/** The §6 output, assembled: exactly what would be stored in §3's columns. */
export interface ValidatedSkill {
  readonly name: string;
  readonly description: string;
  readonly paramsSchema: SkillParamsSchema;
  readonly steps: readonly string[];
  readonly script: string;
}

/** Either the usable skill, or the sentences saying why not. */
export type Verdict =
  | { readonly ok: true; readonly skill: ValidatedSkill }
  | { readonly ok: false; readonly defects: readonly string[] };

/**
 * The waits the runtime does not have, matched literally.
 *
 * `sleep(` is matched anywhere, not only as a bare call: the only thing a
 * model could mean by `ctx.sleep(500)` or `await sleep(500)` is what this bans,
 * and a false positive costs one corrective retry, while a miss ships a script
 * that waits blind. `setTimeout(` is §6's other named way to fake a wait —
 * `await new Promise((resolve) => setTimeout(resolve, 1000))` — and is banned
 * the same way; a plausible-looking timer is exactly the brittleness M3's
 * timing rule exists to keep out.
 */
const FORBIDDEN_WAIT_PATTERNS: ReadonlyArray<{ readonly snippet: string; readonly why: string }> = [
  { snippet: 'sleep(', why: 'a sleep waits for a guessed duration' },
  { snippet: 'setTimeout(', why: 'a timer waits for a guessed duration' },
];

/** Where a predicate-shaped wait is written down; repeated in every catch. */
const WAIT_DIRECTION =
  'every wait must be `ctx.waitFor(async () => ..., timeoutMs)`, whose predicate answers whether the next step can go now';

/**
 * Judge one model answer.
 *
 * Empty defect list = usable. Any defect = retryable (once) by the caller,
 * which is what §6's "retries once with a corrective message" means.
 */
export function validateCompiled(reply: string): Verdict {
  const parsed = parseJsonAnswer(reply);
  if (!parsed.ok) return { ok: false, defects: [parsed.problem] };

  const shape = CompiledSkillSchema.safeParse(parsed.value);
  if (!shape.success) {
    return { ok: false, defects: shapeDefects(shape.error.issues) };
  }
  return validateShape(shape.data);
}

/** The shape's verdict, over an answer the zod schema already admitted. */
function validateShape(answer: z.infer<typeof CompiledSkillSchema>): Verdict {
  const defects: string[] = [];

  const name = SnakeCaseSchema.safeParse(answer.name);
  if (!name.success) {
    defects.push(
      `the name "${String(answer.name)}" is not snake_case; use lower-case words joined by underscores, e.g. open_settings_panel`,
    );
  }

  if (typeof answer.script !== 'string') {
    defects.push('the answer has no script module');
  } else {
    for (const { snippet, why } of FORBIDDEN_WAIT_PATTERNS) {
      if (answer.script.includes(snippet)) {
        defects.push(`the script contains \`${snippet}\` — ${why}; ${WAIT_DIRECTION}`);
      }
    }
  }

  const paramsSchema = assembleParams(answer, defects);
  const steps = assembleSteps(answer, defects);
  // `assembleParams`/`assembleSteps` push a defect on every path that returns
  // null, so the inner guard is unreachable — it is here so an empty
  // `defects` can never slip out of an `ok: false` verdict, and the outer
  // return is what narrows the types without a cast.
  if (paramsSchema === null || steps === null) {
    if (defects.length === 0) defects.push('the skill has no paramsSchema');
    return { ok: false, defects };
  }

  if (defects.length > 0) return { ok: false, defects };
  return {
    ok: true,
    skill: {
      // Reaching here means every check above passed, including the name's —
      // the same string the check parsed.
      name: answer.name,
      description: answer.description,
      paramsSchema,
      steps,
      script: answer.script,
    },
  };
}

/**
 * A zod rejection, as defect sentences.
 *
 * The retry asks the model to fix its answer, so each sentence names the field
 * the schema wanted and what it wanted to be — `"params" is missing` reads as
 * direction where `Invalid input: expected array, received undefined` reads as
 * a stack trace. Anything with no tighter phrasing keeps the schema's own
 * words.
 */
function shapeDefects(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.map((issue) => {
    const at = issue.path.length === 0 ? 'the answer' : `"${issue.path.join('.')}"`;
    // zod's own sentence ("Invalid input: expected array, received object")
    // carries the types; `received` the field is not populated for every
    // shape, so the wording is read off the message rather than the field.
    const typed = /^(?:Invalid input: )?expected (\S+), received (\S+)$/.exec(issue.message);
    if (typed !== null) {
      const [, expected, received] = typed;
      if (received === 'undefined') {
        return `${at} is missing; the schema asks for ${expected}`;
      }
      return `${at} must be ${expected}, not ${received}`;
    }
    return `${at}: ${issue.message}`;
  });
}

/**
 * §3's `paramsSchema`, or defects explaining why it cannot be assembled.
 *
 * §6's output schema names the field `paramsSchema`; the model is asked for a
 * flat parameter LIST (M3-BE-06 explains why) and this is where the two meet.
 * A missing list is a defect rather than a crash because the validator is a
 * pure function anyone can hand a hand-built answer to (M3-QA-03 does).
 */
function assembleParams(
  answer: z.infer<typeof CompiledSkillSchema>,
  defects: string[],
): SkillParamsSchema | null {
  if (!Array.isArray(answer.params)) {
    defects.push(
      'the skill has no paramsSchema; return the parameter list (an empty list when the task takes no arguments)',
    );
    return null;
  }

  let schema: SkillParamsSchema;
  try {
    schema = toParamsSchema(answer.params);
  } catch (error: unknown) {
    if (!(error instanceof CompileRefused)) throw error;
    // The assembler's refusal is a defect like any other — naming the
    // direction (one entry per argument) is what the corrective retry turns
    // into a fix.
    defects.push(`${error.message} — describe each argument exactly once`);
    return null;
  }

  // §6: "every param needs a description". The shape asks for one, but an
  // empty string passes a `z.string()` — a parameter the runner cannot
  // explain is one the person running the skill cannot fill in.
  for (const [param, spec] of Object.entries(schema.properties)) {
    if (spec.description.trim() === '') {
      defects.push(
        `the parameter "${param}" has no description; §6 requires one on every parameter`,
      );
    }
  }
  return schema;
}

/**
 * The plain-language summary (D-098), or defects explaining why it is unusable.
 *
 * The schema already bounds the list (≤ 30 entries, each ≤ 300 characters) and
 * maps a missing or mistyped one onto defect sentences through `shapeDefects`;
 * what it cannot express is emptiness — an empty array parses, and a summary
 * of nothing is exactly the review surface showing nothing, which is the
 * outcome this summary exists to prevent. Whitespace-only entries are the
 * same defect in a subtler form.
 */
function assembleSteps(
  answer: z.infer<typeof CompiledSkillSchema>,
  defects: string[],
): readonly string[] | null {
  if (answer.steps.length === 0) {
    defects.push(
      '"steps" is empty; describe what the skill does as one short plain-language step per action, in order',
    );
    return null;
  }
  if (answer.steps.some((step) => step.trim() === '')) {
    defects.push('"steps" has a blank entry; every step must say what happens');
    return null;
  }
  return answer.steps;
}
