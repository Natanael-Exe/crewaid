/**
 * The real `SkillModuleLoader`: writes compiled skill source to a private file
 * and imports it as an ES module.
 *
 * Skill source is a TS module, and the image's Node 22.23 runs it
 * with type stripping on by default — annotations are removed, nothing is
 * type-checked, and syntax stripping does not support (enums, namespaces,
 * decorators) fails as a load error that the run reports. That boundary is
 * documented in infra/sandbox-image/README.md; the compiler side must stay
 * inside it.
 *
 * Nothing here is a security boundary. The CONTAINER is: this
 * module exists only inside a sandbox, and `apps/orchestrator` importing it
 * would be the exact thing CC-06's lint rules ban.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { SkillModule } from './index.js';

/**
 * Write `source` into `workspace` and import it.
 *
 * The workspace is fresh per run (the runner makes it), so two runs of the
 * same source can never collide in the module cache.
 */
export async function loadModuleFromSource(
  workspace: string,
  source: string,
): Promise<SkillModule<unknown>> {
  const file = join(workspace, 'skill.ts');
  await writeFile(file, source, { encoding: 'utf8', mode: 0o600 });

  const imported: unknown = await import(pathToFileURL(file).href);
  const skill = (imported as { default?: unknown }).default;
  if (typeof skill !== 'function') {
    throw new Error('the skill module must default-export an async run(ctx, params) function');
  }
  return skill as SkillModule<unknown>;
}
