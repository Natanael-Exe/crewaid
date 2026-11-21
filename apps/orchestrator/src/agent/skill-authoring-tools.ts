import { tool } from './tool-contract.js';
import { NativeToolInputs } from '@crewaid/shared';

import { AUTHORITY_BUILTIN } from './tool-registry.js';
import type { RegisteredTool, ToolContext } from './tool-registry.js';
import { MACHINE_HOME } from './workspace-paths.js';

/**
 * `save_skill` — a skill the bot writes for itself (and the operator approves).
 *
 * The recording path is not the only way a skill should come into
 * existence. Halfway through real work a bot works out a procedure — the
 * exact selector dance a stubborn page needs, the steps that survive a
 * captch — and throwing that away is how the next turn starts from zero. This
 * tool persists the procedure as a first-class skill: a `Skill` row the
 * `run_skill` gate accepts, plus a copy in the bot's own workspace where the
 * bot can `fs_read` (and hand-write improvements to) it later.
 *
 * WHY IT IS `sensitive`, AND WHY THE ROW LANDS APPROVED
 *
 * The rule is "nothing model-generated may run unreviewed", and a
 * bot-written script is model-generated. The approval flow IS the review: the
 * tool is `sensitive`, so the operator is shown the call — name, description,
 * and the whole script among the args — before it runs, and approving the
 * call is approving exactly those bytes. The row is therefore written APPROVED
 * (an unrunnable DRAFT skill would strand the review inside a JSON blob
 * nobody was going to open twice), while every LATER version of it goes back
 * through this same gate — a new call, a new approval, a new version.
 *
 * The recording path keeps its own review surface: a compiled skill still
 * lands DRAFT for the reviewer to read in the Skills UI. This tool is for the
 * bot's own reusable procedures, reviewed at the moment they are saved.
 *
 * What the script is
 *
 * The same module the runner executes for recorded skills: a default-exported
 * async function receiving `(ctx, params)`, with `ctx.browser` (CDP), `ctx.page`
 * helpers and `ctx.waitFor(predicate, timeoutMs)` — and NO `sleep(` or
 * `setTimeout(`, which are refused by name, because a skill that waits for a
 * guessed duration is the failure the timing rule exists to end.
 */
const SCRIPT_MAX_CHARS = 256_000;

/** The waits the runtime does not have — the same ban the compile validator applies. */
const FORBIDDEN_WAIT_SNIPPETS = ['sleep(', 'setTimeout('] as const;

function failure(action: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${action} failed: ${detail}`;
}

export function skillAuthoringTools(deps: {
  skills: {
    /** Next free version for `[botId, name]`, then the row, written APPROVED. */
    saveBotSkill(input: {
      userId: string;
      botId: string;
      name: string;
      description: string;
      script: string;
      paramsSchema: Record<string, unknown>;
    }): Promise<{ id: string; name: string; version: number; created: boolean }>;
  };
}): RegisteredTool[] {
  return [
    {
      name: 'save_skill',
      behavior: AUTHORITY_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            'Save a reusable skill — a small program for a procedure you want to be able to ' +
            'run again with run_skill instead of re-deriving it every time (the exact clicks ' +
            'a stubborn page needs, the steps that survive a tricky flow). Write it as a ' +
            'TypeScript module: `export default async function (ctx, params) { ... }` using ' +
            'ctx.browser (CDP) and ctx.waitFor(predicate, timeoutMs) for every wait — never ' +
            'sleep or setTimeout. Saving needs the user’s approval (they see the script), and ' +
            'once approved you can run it by name.',
          inputSchema: NativeToolInputs.save_skill,
          execute: async (input: {
            name: string;
            description: string;
            paramsSchema?: Record<string, unknown> | undefined;
            script: string;
          }) => {
            const { name, description, script } = input;
            // The same defects the compile validator refuses, said the same
            // way — a model that just heard them in a corrective retry will
            // recognise the sentence here.
            if (script.trim() === '') {
              return 'save_skill refused: the script is empty.';
            }
            if (script.length > SCRIPT_MAX_CHARS) {
              return (
                `save_skill refused: the script is ${script.length} characters, over the ` +
                `${SCRIPT_MAX_CHARS}-character limit for one skill.`
              );
            }
            for (const snippet of FORBIDDEN_WAIT_SNIPPETS) {
              if (script.includes(snippet)) {
                return (
                  `save_skill refused: the script contains \`${snippet}\` — a sleep waits for ` +
                  'a guessed duration. Every wait must be ' +
                  '`ctx.waitFor(async () => ..., timeoutMs)`, whose predicate answers whether ' +
                  'the next step can go now.'
                );
              }
            }
            const paramsSchema = input.paramsSchema ?? { type: 'object', properties: {} };

            try {
              const saved = await deps.skills.saveBotSkill({
                userId: context.userId,
                botId: context.botId,
                name,
                description,
                script,
                paramsSchema,
              });

              // The workspace copy is a convenience, not the truth — the ROW
              // is what run_skill executes. A machine that is asleep (or a
              // write the workspace refuses) must not fail a save that
              // succeeded, so this is best-effort and reported either way.
              let copyNote = '';
              try {
                const session = await context.session();
                const path = `${MACHINE_HOME}/agents/${context.botId}/skills/${name}.ts`;
                await session.writeTextFile({ path, content: script });
                copyNote = ` A copy is at ${path}.`;
              } catch {
                copyNote =
                  ' (The workspace copy could not be written right now; the skill is saved regardless.)';
              }

              return (
                `Skill "${name}" saved as version ${saved.version}${saved.created ? '' : ' (a new version of an existing skill)'} ` +
                '— approved and runnable with run_skill.' +
                copyNote
              );
            } catch (error) {
              return failure(`save_skill ${JSON.stringify(name)}`, error);
            }
          },
        }),
    },
  ];
}
