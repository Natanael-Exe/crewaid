/** D-194: which deferred tools a step is sent, and what `find_plugin_tools` loads. */
import { describe, expect, it } from 'vitest';
import type { ChatMiddlewareConfig, ModelMessage, Tool } from '@tanstack/ai';
import { FIND_PLUGIN_TOOLS } from '@crewaid/shared';
import { deferredTools, loadedNames } from '../src/agent/execution/deferred-tools.js';
import { deferredPluginTools } from '../src/mcp/mcp-deferred-tools.js';
import type { CatalogueEntry } from '../src/mcp/mcp-indirect-tools.js';
import type { RegisteredTool, ToolContext } from '../src/agent/tool-registry.js';

const tool = (name: string, description = 'x'): Tool => ({
  name,
  description,
  inputSchema: { type: 'object', properties: {} },
});

const discovery = tool(FIND_PLUGIN_TOOLS);
const builtin = tool('read_file');
const plugins = ['p__a', 'p__b', 'p__c'].map((name) => tool(name, 'd'.repeat(200)));

function assistantCall(id: string, name: string): ModelMessage {
  return {
    role: 'assistant',
    content: null,
    toolCalls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
  };
}
const result = (id: string, content: string): ModelMessage => ({
  role: 'tool',
  toolCallId: id,
  content,
});

function sent(messages: ModelMessage[], budgetTokens?: number): string[] {
  const middleware = deferredTools({
    tools: [discovery, builtin, ...plugins],
    discovery: FIND_PLUGIN_TOOLS,
    names: new Set(plugins.map((entry) => entry.name)),
    ...(budgetTokens === undefined ? {} : { budgetTokens }),
  });
  const config = {
    messages,
    systemPrompts: [],
    tools: [discovery, builtin, ...plugins],
  } as ChatMiddlewareConfig;
  const out = middleware.onConfig?.({ phase: 'beforeModel' } as never, config) as {
    tools: Tool[];
  };
  return out.tools.map((entry) => entry.name);
}

describe('the deferred-tools middleware', () => {
  it('sends none of them until the history loads one', () => {
    expect(sent([])).toEqual([FIND_PLUGIN_TOOLS, 'read_file']);
  });

  it('sends what a discovery result loaded, and only that', () => {
    const history = [
      assistantCall('d1', FIND_PLUGIN_TOOLS),
      result('d1', JSON.stringify({ loaded: ['p__b'], note: '' })),
    ];
    expect(sent(history)).toEqual([FIND_PLUGIN_TOOLS, 'read_file', 'p__b']);
  });

  it('ignores a load that names a tool this run was not given', () => {
    const history = [
      assistantCall('d1', FIND_PLUGIN_TOOLS),
      result('d1', JSON.stringify({ loaded: ['revoked__x'] })),
    ];
    expect(sent(history)).toEqual([FIND_PLUGIN_TOOLS, 'read_file']);
  });

  it('keeps the most recent within the budget, and drops the oldest', () => {
    const history = [
      assistantCall('d1', FIND_PLUGIN_TOOLS),
      result('d1', JSON.stringify({ loaded: ['p__a', 'p__b'] })),
      assistantCall('c1', 'p__c'),
      result('c1', '"ok"'),
    ];
    // Each definition costs ~55 estimated tokens; room for two.
    expect(sent(history, 120)).toEqual([FIND_PLUGIN_TOOLS, 'read_file', 'p__b', 'p__c']);
  });

  it('always sends a tool whose call is still waiting, even over the budget', () => {
    const history = [assistantCall('c1', 'p__a')];
    expect(sent(history, 1)).toEqual([FIND_PLUGIN_TOOLS, 'read_file', 'p__a']);
  });

  it('reads a stored load as text or as an object, and nothing else', () => {
    expect(loadedNames('{"loaded":["a"]}')).toEqual(['a']);
    expect(loadedNames({ loaded: ['b'] })).toEqual(['b']);
    expect(loadedNames('not json')).toEqual([]);
    expect(loadedNames({ tools: [{ name: 'c' }] })).toEqual([]);
  });
});

describe('find_plugin_tools', () => {
  const entry = (name: string, description: string): CatalogueEntry => ({
    name: `inv__${name}`,
    serverName: 'Invoices',
    serverId: 's1',
    toolName: name,
    description,
    inputSchema: { type: 'object' },
    readOnly: true,
    behavior: {
      origin: { kind: 'mcp', serverId: 's1' },
      failure: { kind: 'isolate' },
      effect: 'read',
      authority: false,
    },
  });
  const catalogue = [
    entry('list_invoices', 'List the invoices'),
    entry('send_invoice', 'Send one invoice'),
    ...Array.from({ length: 30 }, (_, index) => entry(`report_${String(index)}`, 'A report')),
  ];
  const bound: RegisteredTool[] = [];
  const [find] = deferredPluginTools(catalogue, bound);
  const run = async (input: unknown) =>
    find?.build({} as ToolContext).execute?.(input, { toolCallId: 't', messages: [] });

  it('loads exact names and says which it did not know', async () => {
    const answer = await run({ names: ['inv__send_invoice', 'inv__nope'] });
    expect(answer).toMatchObject({ loaded: ['inv__send_invoice'], unknown: ['inv__nope'] });
    // The middleware reads the same answer back from history.
    expect(loadedNames(JSON.stringify(answer))).toEqual(['inv__send_invoice']);
  });

  it('loads what a query matches, ten at most, and counts the rest', async () => {
    const answer = (await run({ query: 'report' })) as { loaded: string[]; more?: number };
    expect(answer.loaded).toHaveLength(10);
    expect(answer.more).toBe(20);
  });

  it('answers with the listing and loads nothing when asked for nothing', async () => {
    const answer = (await run({})) as { loaded: string[]; listing?: string };
    expect(answer.loaded).toEqual([]);
    expect(answer.listing).toContain('inv__list_invoices');
  });

  it('is absent when there is no catalogue', () => {
    expect(deferredPluginTools([], [])).toEqual([]);
  });
});

describe('the bot’s plugin sentence (D-116)', () => {
  it('on a TanStack run names loading, not the bridge door', async () => {
    const { pluginInstructions } = await import('../src/agent/agent-instructions.js');
    const deferred = pluginInstructions([{ name: 'Notion', toolCount: 45 }], 'deferred');
    expect(deferred).toContain('find_plugin_tools loads');
    expect(deferred).not.toContain('use_plugin_tool');
    expect(pluginInstructions([{ name: 'Notion', toolCount: 45 }])).toContain('use_plugin_tool');
  });
});
