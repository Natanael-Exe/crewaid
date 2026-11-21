import { JsonSchema, NativeToolInputs } from '@crewaid/shared';
import type { ArgumentValidator } from './validate-arguments.js';

/** The same envelope is reviewed for model, direct and scheduled executions. */
export const SkillArgumentsSchema = NativeToolInputs.run_skill;
export const validateSkillArguments: ArgumentValidator = (input) => {
  const parsed = SkillArgumentsSchema.safeParse(input);
  return Promise.resolve(
    parsed.success
      ? { ok: true, value: JsonSchema.parse(parsed.data) }
      : { ok: false, reason: 'Arguments do not match the skill tool schema.' },
  );
};
