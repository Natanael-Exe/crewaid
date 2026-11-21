import { toolReach } from '../src/agent/tool-registry.js';
import { describe, expect, it } from 'vitest';
import type { ToolDefinition as Tool } from '../src/agent/tool-contract.js';
import { skillAuthoringTools } from '../src/agent/skill-authoring-tools.js';

/**
 * `save_skill` — the skill a bot writes for itself.
 *
 * Two invariants decide the shape of these tests. The REVIEW: the tool is
 * `sensitive`, because §7.3 says nothing model-generated runs unreviewed and
 * the approval prompt is where the operator sees the script. The REUSE: a
 * saved skill lands APPROVED (the approval of the call WAS the review) and a
 * copy lands in the bot's workspace, so `run_skill` can execute it and
 * `fs_read` can show it — and neither half of that may fail the save.
 */

const USER = 'user-under-test';
const BOT = 'clx1a2b3c4d5e6f7g8h9i0j1';

const GOOD_SCRIPT =
  'export default async function (ctx, params) {\n' +
  '  await ctx.waitFor(async () => true, 1000);\n' +
  '}\n';

function setup(
  overrides: {
    saved?: (input: {
      name: string;
      script: string;
    }) => Promise<{ id: string; name: string; version: number; created: boolean }>;
    writeTextFile?: (options: { path: string; content: string }) => Promise<void>;
  } = {},
): {
  saved: Array<{ name: string; paramsSchema: unknown; script: string }>;
  wrote: Array<{ path: string; content: string }>;
  run: (input: unknown) => Promise<unknown>;
} {
  const saved: Array<{ name: string; paramsSchema: unknown; script: string }> = [];
  const wrote: Array<{ path: string; content: string }> = [];
  const group = skillAuthoringTools({
    skills: {
      saveBotSkill: async (input) => {
        saved.push({ name: input.name, paramsSchema: input.paramsSchema, script: input.script });
        return (
          overrides.saved?.(input) ?? {
            id: 'clxskill000000000000001',
            name: input.name,
            version: input.name === 'existing_thing' ? 2 : 1,
            created: input.name !== 'existing_thing',
          }
        );
      },
    },
  });
  const context = {
    userId: USER,
    botId: BOT,
    messageId: 'message-under-test',
    session: async () => ({
      writeTextFile: async (options: { path: string; content: string }) => {
        if (overrides.writeTextFile === undefined) wrote.push(options);
        else await overrides.writeTextFile(options);
      },
    }),
  } as never;
  const entry = group[0];
  if (entry === undefined) throw new Error('save_skill not registered');
  const built = entry.build(context) as Tool & {
    execute: (input: unknown, options: unknown) => Promise<unknown>;
  };
  return {
    saved,
    wrote,
    run: (input) => built.execute(input, {}),
  };
}

describe('save_skill', () => {
  it('is sensitive — the approval prompt is where the operator reads the script', () => {
    const group = skillAuthoringTools({
      skills: { saveBotSkill: async () => ({ id: '1', name: 'x', version: 1, created: true }) },
    });
    expect(toolReach(group[0]?.behavior)).toBe('sensitive');
  });

  it('saves the row approved, with a params schema and a workspace copy', async () => {
    const { saved, wrote, run } = setup();
    const result = await run({
      name: 'apply_coupon',
      description: 'Applies the coupon field on the checkout page.',
      script: GOOD_SCRIPT,
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: 'apply_coupon' });
    expect(saved[0]?.paramsSchema).toEqual({ type: 'object', properties: {} });
    expect(result).toContain('version 1');
    expect(result).toContain('run_skill');
    expect(wrote[0]?.path).toBe(`/home/bot/agents/${BOT}/skills/apply_coupon.ts`);
    expect(wrote[0]?.content).toBe(GOOD_SCRIPT);
  });

  it('bumps the version when the name already exists', async () => {
    const { run } = setup();
    const result = await run({
      name: 'existing_thing',
      description: 'A newer take.',
      script: GOOD_SCRIPT,
    });
    expect(result).toContain('version 2');
    expect(result).toContain('new version');
  });

  it('refuses a script that waits by sleeping — the compile validator’s sentence', async () => {
    const { saved, run } = setup();
    const result = await run({
      name: 'sleepy_skill',
      description: 'Waits.',
      script: 'export default async () => { await sleep(500); };',
    });
    expect(result).toContain('refused');
    expect(result).toContain('ctx.waitFor');
    expect(saved).toHaveLength(0);
  });

  it('refuses a script that is too large to review', async () => {
    const { saved, run } = setup();
    const result = await run({
      name: 'big_one',
      description: 'Huge.',
      script: `export default async () => { /* ${'x'.repeat(300_000)} */ };`,
    });
    expect(result).toContain('refused');
    expect(saved).toHaveLength(0);
  });

  it('carries a model-supplied params schema through to the row', async () => {
    const { saved, run } = setup();
    await run({
      name: 'search_docs',
      description: 'Searches.',
      paramsSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What to look for' } },
        required: ['query'],
      },
      script: GOOD_SCRIPT,
    });
    expect(saved[0]?.paramsSchema).toMatchObject({ required: ['query'] });
  });

  it('never fails the save because the workspace copy could not be written', async () => {
    const { run } = setup({
      writeTextFile: async () => {
        throw new Error('the machine is asleep');
      },
    });
    const result = await run({
      name: 'resilient_one',
      description: 'Saves anyway.',
      script: GOOD_SCRIPT,
    });
    expect(result).toContain('saved regardless');
    expect(result).not.toContain('failed');
  });
});
