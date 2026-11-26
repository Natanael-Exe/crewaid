import { describe, expect, it } from 'vitest';
import type { BrowserPage } from '../src/agent/browser-page.js';
import { browserTools } from '../src/agent/browser-tools.js';

async function resultOf(
  tools: ReturnType<typeof browserTools>,
  name: string,
  input: unknown,
  page: BrowserPage,
) {
  const entry = tools.find((t) => t.name === name);
  if (entry === undefined) throw new Error(`no tool ${name}`);
  const definition = entry.build({ browser: async () => page });
  const execute = (definition as { execute?: unknown }).execute as (
    input: unknown,
    options: unknown,
  ) => Promise<string>;
  return execute(input, { toolCallId: 'c1', messages: [], context: undefined });
}

describe('M5-BE-04 what the model is told', () => {
  function fakePage(overrides: Partial<BrowserPage> = {}): BrowserPage {
    return {
      navigate: async (url) => ({ url }),
      read: async () => 'heading "Pricing"',
      click: async () => undefined,
      type: async () => undefined,
      screenshot: async () => Buffer.from('png'),
      stopLoading: async () => undefined,
      ...overrides,
    };
  }

  it('registers exactly the four §6/M5 names as built-ins', () => {
    const tools = browserTools();

    expect(tools.map((t) => t.name)).toEqual([
      'browser_navigate',
      'browser_read',
      'browser_click',
      'browser_type',
    ]);
    expect(tools.every((t) => t.behavior.origin.kind === 'builtin')).toBe(true);
    expect(tools.every((t) => t.behavior.failure.kind === 'isolate')).toBe(true);
  });

  it('answers a failed click with something the model can act on', async () => {
    // The model's most common mistake and its most recoverable one: told
    // plainly, it reads the page again and picks another reference. An
    // exception here would be shaped for a developer reading a stack.
    const page = fakePage({
      click: async () => {
        throw new Error('no element matches "#gone"');
      },
    });

    const result = await resultOf(browserTools(), 'browser_click', { reference: '#gone' }, page);

    expect(result).toBe('click failed: no element matches "#gone"');
  });

  it('refuses a non-browsable scheme by telling the model, not by throwing', async () => {
    const tools = browserTools();
    const page = fakePage();

    expect(await resultOf(tools, 'browser_navigate', { url: 'file:///etc/passwd' }, page)).toBe(
      'navigate failed: file: is not a browsable scheme',
    );
    expect(await resultOf(tools, 'browser_navigate', { url: 'not a url' }, page)).toContain(
      'is not an absolute URL',
    );
  });

  it('never echoes typed text back into the transcript', async () => {
    // A tool result is persisted verbatim, and the text can be a credential
    // the bot was asked to enter.
    const result = await resultOf(
      browserTools(),
      'browser_type',
      { reference: '#password', text: 'hunter2-secret' },
      fakePage(),
    );

    expect(result).not.toContain('hunter2-secret');
    expect(result).toBe('typed 14 characters into #password');
  });

  it('hands back the page text on a read', async () => {
    expect(await resultOf(browserTools(), 'browser_read', {}, fakePage())).toBe(
      'heading "Pricing"',
    );
  });
});

/**
 * The last mile. Every case above builds the tools directly, so never
 * registering them would leave all fifteen green and no bot would have a
 * browser — the "correct and unused" hole this session has now hit twice.
 */
describe('M5-BE-04 the four tools reach a real turn', () => {
  it('registers them into the registry BotsModule actually builds', async () => {
    // Built from the MODULE's own provider, not a registry this test made:
    // deleting the registration loop from BotsModule has to fail here, and
    // with a hand-rolled registry it would not.
    await import('reflect-metadata');
    const { BotsModule } = await import('../src/bots/bots.module.js');
    const { ToolRegistry } = await import('../src/agent/tool-registry.js');
    const providers = Reflect.getMetadata('providers', BotsModule) as Array<{
      provide?: unknown;
      useFactory?: () => unknown;
    }>;
    const entry = providers.find((p) => p?.provide === ToolRegistry);
    if (entry?.useFactory === undefined) throw new Error('BotsModule builds no ToolRegistry');
    const registry = entry.useFactory() as InstanceType<typeof ToolRegistry>;

    // §6/M5's built-in table, as far as it is built: the browser four
    // (M5-BE-04), the computer four (M5-BE-05), the machine-level tools (the
    // seat's own screen, pointer and camera), M5-BE-27's identity switch,
    // M5-BE-20's shared board and M5-BE-21's shared memory. `run_skill`,
    // `attach_file` and `send_message` register from the skills module, which
    // this provider does not build.
    expect(registry.names()).toEqual([
      'preview_email',
      'present_visual',
      'browser_navigate',
      'browser_read',
      'browser_click',
      'browser_type',
      'screenshot',
      'shell',
      'fs_read',
      'fs_write',
      'fs_edit',
      'fs_grep',
      'fs_glob',
      'process_start',
      'process_output',
      'process_stop',
      'code_task',
      'capture_screen',
      'record_screen_start',
      'record_screen_stop',
      'mouse_move',
      'mouse_click',
      'mouse_scroll',
      'keyboard',
      'create_bot',
      'edit_bot',
      'delete_bot',
      'use_identity',
      'board_read',
      'board_add',
      'board_update',
      'memory_read',
      'remember',
      'memory_search',
      'forget',
    ]);
    // Every one is classified, so M5-BE-08's matcher and M6-BE-08's
    // read-only pass have something to read.
    for (const name of registry.names()) {
      expect(registry.behaviorOf(name).origin.kind).toBe('builtin');
    }
  });

  it('offers them to the provider, and starts no desktop to do it', async () => {
    // The promise M5-BE-14 made, kept through registration: four browser
    // tools are offered on a turn that never touches one.
    const { ToolRegistry } = await import('../src/agent/tool-registry.js');
    const registry = new ToolRegistry();
    for (const entry of browserTools()) registry.register(entry);
    let woken = 0;

    const set = registry.toolSetFor({
      browser: async () => {
        woken += 1;
        throw new Error('should not be reached');
      },
    });

    expect(Object.keys(set).sort()).toEqual([
      'browser_click',
      'browser_navigate',
      'browser_read',
      'browser_type',
    ]);
    expect(woken).toBe(0);
  });
});
