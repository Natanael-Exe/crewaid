import { describe, expect, it } from 'vitest';
import type { ToolDefinition as Tool } from '../src/agent/tool-contract.js';
import { botTools } from '../src/agent/bot-tools.js';

/**
 * The team-management built-ins — the model's hands on the user's roster.
 *
 * The load-bearing property is not what the tools DO (plain row writes) but
 * who DECIDES: every one is classified `sensitive`, so M5-BE-08's matcher
 * puts each call in front of the operator before it runs. A bot that can
 * create, reshape or delete its user's teammates unasked is the failure the
 * classification exists to prevent.
 */

const USER = 'user-under-test';
const SELF = 'clxself0000000000000001';

type Calls = { created: unknown[]; updated: Array<[string, unknown]>; removed: string[] };

function setup(): {
  calls: Calls;
  run: (name: string, botId: string, input?: unknown) => Promise<unknown>;
  describe: (name: string) => { description?: string };
} {
  const calls: Calls = { created: [], updated: [], removed: [] };
  const deps = {
    bots: {
      create: async (_userId: string, input: Record<string, unknown>) => {
        calls.created.push(input);
        return { id: 'clxnewbot00000000000001', name: String(input.name) };
      },
      update: async (_userId: string, botId: string, input: Record<string, unknown>) => {
        calls.updated.push([botId, input]);
        return { id: botId, name: 'Quill' };
      },
      remove: async (_userId: string, botId: string) => {
        calls.removed.push(botId);
      },
    },
  };
  const group = botTools(deps);
  const context = {
    userId: USER,
    botId: SELF,
  } as never;
  const run = async (name: string, botId: string, input?: unknown) => {
    const entry = group.find((candidate) => candidate.name === name);
    if (entry === undefined) throw new Error(`no tool named ${name}`);
    void botId;
    const built = entry.build(context) as Tool & {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    };
    return built.execute(input ?? {}, {});
  };
  const describe = (name: string) => {
    const entry = group.find((candidate) => candidate.name === name);
    if (entry === undefined) throw new Error(`no tool named ${name}`);
    return entry.build(context) as Tool;
  };
  return { calls, run, describe };
}

describe('bot management tools', () => {
  it('classifies all three as sensitive — every call asks the operator', () => {
    const { describe } = setup();
    for (const name of ['create_bot', 'edit_bot', 'delete_bot']) {
      expect(describe(name).description, name).toContain('approval');
    }
  });

  it('creates a bot and hands the model its id', async () => {
    const { calls, run } = setup();
    const result = await run('create_bot', '', {
      name: 'Quill',
      role: 'Outbound Writer',
      systemPrompt: 'You write outbound copy.',
    });

    expect(calls.created).toHaveLength(1);
    expect(calls.created[0]).toMatchObject({ name: 'Quill', role: 'Outbound Writer' });
    // A colour the model never chose is still a colour the UI can render.
    expect(calls.created[0]).toHaveProperty('avatarColor');
    expect(result).toContain('clxnewbot00000000000001');
  });

  it('honours a model-chosen avatar colour', async () => {
    const { calls, run } = setup();
    await run('create_bot', '', {
      name: 'Quill',
      role: 'Writer',
      systemPrompt: 'B.',
      avatarColor: '#123abc',
    });
    expect(calls.created[0]).toMatchObject({ avatarColor: '#123abc' });
  });

  it('refuses an edit that changes nothing', async () => {
    const { calls, run } = setup();
    const result = await run('edit_bot', '', { botId: 'clxtarget0000000000001' });
    expect(result).toContain('refused');
    expect(calls.updated).toHaveLength(0);
  });

  it('edits only the fields the model passed', async () => {
    const { calls, run } = setup();
    await run('edit_bot', '', { botId: 'clxtarget0000000000001', role: 'Editor' });
    expect(calls.updated[0]).toEqual(['clxtarget0000000000001', { role: 'Editor' }]);
  });

  it('never lets a bot delete itself — no approval can make that safe', async () => {
    const { calls, run } = setup();
    const result = await run('delete_bot', SELF, { botId: SELF });
    expect(result).toContain('refused');
    expect(result).toContain('your own id');
    expect(calls.removed).toHaveLength(0);
  });

  it('deletes another bot through the service', async () => {
    const { calls, run } = setup();
    await run('delete_bot', SELF, { botId: 'clxtarget0000000000001' });
    expect(calls.removed).toEqual(['clxtarget0000000000001']);
  });

  it('returns failures as sentences, not exceptions', async () => {
    const deps = {
      bots: {
        create: async () => {
          throw new Error('Bot name is already in use');
        },
        update: async () => {
          throw new Error('Bot not found');
        },
        remove: async () => {
          throw new Error('Sandbox lifecycle is in progress');
        },
      },
    };
    const group = botTools(deps);
    const context = { userId: USER, botId: SELF } as never;
    const execute = async (name: string, input: unknown) => {
      const entry = group.find((candidate) => candidate.name === name);
      if (entry === undefined) throw new Error(`no tool named ${name}`);
      const built = entry.build(context) as Tool & {
        execute: (input: unknown, options: unknown) => Promise<unknown>;
      };
      return built.execute(input, {});
    };

    expect(await execute('create_bot', { name: 'Quill', role: 'R', systemPrompt: 'S' })).toContain(
      'already in use',
    );
    expect(await execute('edit_bot', { botId: 'clxx00000000000000001', name: 'N' })).toContain(
      'not found',
    );
    expect(await execute('delete_bot', { botId: 'clxx00000000000000001' })).toContain('lifecycle');
  });
});
