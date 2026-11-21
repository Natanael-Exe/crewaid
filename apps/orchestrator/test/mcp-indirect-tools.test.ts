import { toolReach } from '../src/agent/tool-registry.js';
import { describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '../src/mcp/mcp-connection.js';
import { PLUGIN_LISTING_TOKEN_BUDGET } from '@crewaid/shared';

import {
  BRIDGE_TOOL_SLOTS,
  indirectPluginTools,
  type CatalogueEntry,
} from '../src/mcp/mcp-indirect-tools.js';
import type { McpToolCall } from '../src/mcp/mcp-tool-binding.js';
import { mcpToolBehavior } from '../src/mcp/mcp-tool-binding.js';

/**
 * D-113 — the two doors every plugin tool goes through.
 *
 * The claim that is easy to assert vacuously is that a call through a door
 * reaches the SAME server and the SAME tool a direct binding would have. So
 * the catalogue here always holds two servers offering a tool of one name, and
 * every routing case says which one was dialled.
 */
function entry(over: Partial<CatalogueEntry> = {}): CatalogueEntry {
  return {
    name: 'github__list_issues',
    serverName: 'GitHub',
    serverId: 'srv-github',
    toolName: 'list_issues',
    description: 'List the issues on a repository',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' } } },
    readOnly: true,
    behavior: mcpToolBehavior('srv-github', true),
    ...over,
  };
}

const WRITES = entry({
  name: 'github__create_issue',
  toolName: 'create_issue',
  description: 'Open a new issue',
  readOnly: false,
  behavior: mcpToolBehavior('srv-github', false),
});

const OTHER_SERVER = entry({
  name: 'linear__list_issues',
  serverName: 'Linear',
  serverId: 'srv-linear',
  description: 'List Linear issues',
  behavior: mcpToolBehavior('srv-linear', true),
});

function recordingCaller() {
  const calls: McpToolCall[] = [];
  const call = vi.fn(async (received: McpToolCall): Promise<CallToolResult> => {
    calls.push(received);
    return { content: [{ type: 'text', text: `${received.serverId}:${received.toolName}` }] };
  });
  return { calls, call };
}

function doors(catalogue: readonly CatalogueEntry[], caller = recordingCaller()) {
  const built = indirectPluginTools(catalogue, caller.call);
  const find = (name: string) => {
    const found = built.find((registered) => registered.name === name);
    if (found === undefined) throw new Error(`no door named ${name}`);
    return found;
  };
  const invoke = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const definition = find(name).build({} as never);
    const execute = definition.execute;
    if (execute === undefined) throw new Error(`${name} is not executable`);
    const output = await execute(args, { toolCallId: 'call-1', messages: [] });
    const projected = await definition.toModelOutput?.({
      toolCallId: 'call-1',
      input: args,
      output,
    });
    return projected?.type === 'text' ? projected.value : String(output);
  };
  return { built, caller, find, invoke };
}

describe('D-113 the doors themselves', () => {
  it('costs the slots it says it costs', () => {
    const { built } = doors([entry()]);
    expect(built).toHaveLength(BRIDGE_TOOL_SLOTS);
    expect(built.map((registered) => registered.name)).toEqual([
      'find_plugin_tools',
      'use_plugin_tool',
    ]);
  });

  it('offers nothing for an empty catalogue', () => {
    // Two tools that can only answer "there are none" are two slots and a
    // paragraph spent saying so — and a bot with no plugins should see a tool
    // list that does not mention them at all.
    expect(indirectPluginTools([], recordingCaller().call)).toEqual([]);
  });

  it('keeps the search door contained and the call door fail-safe', () => {
    // `find_plugin_tools` touches the catalogue this turn already holds, so
    // nothing about it can reach a server and there is nothing to ask about.
    // `use_plugin_tool` runs anything, so its own descriptor is `sensitive` —
    // and it is deliberately NOT what decides a call: `unwrap` below answers
    // that with the tool the call names (D-113).
    const { find } = doors([entry()]);
    expect(toolReach(find('find_plugin_tools').behavior)).toBe('contained');
    expect(toolReach(find('use_plugin_tool').behavior)).toBe('sensitive');
  });
});

describe('D-113 what a call is really about', () => {
  it('answers with the plugin tool, its own arguments and its own classification', () => {
    // The half that lets one call door keep both sentences of §6/M6's approval
    // rule ("Every MCP tool defaults to `ask`. Tools classified `readOnly`
    // default to `allow`"): what the approval matcher classifies is the tool
    // the model named, not the door it came through.
    const { find } = doors([entry(), WRITES]);

    expect(
      find('use_plugin_tool').unwrap?.({ tool: 'github__list_issues', arguments: { a: 1 } }),
    ).toMatchObject({
      name: 'github__list_issues',
      args: { a: 1 },
      behavior: mcpToolBehavior('srv-github', true),
    });
    expect(find('use_plugin_tool').unwrap?.({ tool: 'github__create_issue' })).toMatchObject({
      name: 'github__create_issue',
      args: {},
      behavior: mcpToolBehavior('srv-github', false),
    });
  });

  it('answers a name it does not have with no classification at all', () => {
    // Not the door's own `sensitive`: a call naming a tool this bot does not
    // have can run nothing, and `decideAutoReview` denies a call with no
    // descriptor (D-092). Answering with the door's blanket classification
    // instead would ask the operator to approve a call that cannot happen.
    const { find } = doors([entry()]);
    expect(find('use_plugin_tool').unwrap?.({ tool: 'github__wire_transfer' })).toMatchObject({
      name: 'github__wire_transfer',
      args: {},
      behavior: undefined,
    });
  });

  it('is not a door at all when there is nothing to unwrap', () => {
    // `undefined` from `unwrap` means "the call is about the definition that
    // was called", which is every tool but this one.
    const { find } = doors([entry()]);
    expect(find('find_plugin_tools').unwrap).toBeUndefined();
  });
});

describe('D-113 finding a tool', () => {
  it('carries name, plugin and one line in the definition, without the schemas', () => {
    // The listing in the DEFINITION is what saves the round trip — Hermes
    // measured models declaring a capability missing when the bridge
    // advertised nothing. A catalogue that dumped every schema into it would
    // cost the tokens the bridge exists to save.
    const { find } = doors([entry(), WRITES, OTHER_SERVER]);

    const description = String(
      (find('find_plugin_tools').build({} as never) as { description?: unknown }).description,
    );

    expect(description).toContain('github__list_issues');
    expect(description).toContain('linear__list_issues');
    expect(description).toContain('GitHub');
    expect(description).toContain('List the issues on a repository');
    expect(description).not.toContain('properties');
    expect(description).toContain('use_plugin_tool');
  });

  it('answers a query with the schema for what matched, and what to expect at the approval', async () => {
    const { invoke } = doors([entry(), WRITES, OTHER_SERVER]);

    const answer = await invoke('find_plugin_tools', { query: 'open a new issue' });

    expect(answer).toContain('github__create_issue');
    expect(answer).toContain('"properties"');
    expect(answer).toContain('approve');
    // The read-only sibling did not match this query, which is what says the
    // filter is doing something.
    expect(answer).not.toContain('github__list_issues');
  });

  it('bounds the answer by the same budget the listing has', async () => {
    // The answer is the EXPENSIVE half: it is a tool result, so it sits in the
    // message history behind the cached prefix and is re-sent on every step of
    // the turn. Ten of these schemas unbounded is a bigger recurring cost than
    // the whole advertisement.
    const fat = (index: number): CatalogueEntry =>
      entry({
        name: `github__fat_${String(index)}`,
        toolName: `fat_${String(index)}`,
        description: 'fat schema tool',
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(
            Array.from({ length: 120 }, (_unused, field) => [
              `field_${String(field)}`,
              { type: 'string', description: 'x'.repeat(80) },
            ]),
          ),
        },
      });
    const { invoke } = doors(Array.from({ length: 10 }, (_unused, index) => fat(index)));

    const answer = await invoke('find_plugin_tools', { query: 'fat' });

    expect(Math.ceil(answer.length / 4)).toBeLessThanOrEqual(PLUGIN_LISTING_TOKEN_BUDGET);
    // Not by silently answering with less: the ones held back are counted, so
    // the model narrows its query instead of concluding they do not exist.
    expect(answer).toContain('more match');
    expect(answer).toContain('github__fat_0');
  });

  it('answers the first match whatever it costs, so a big schema is still callable', async () => {
    // The reachability floor. A tool whose schema alone is over budget must
    // still be answered for — the schema is what makes it callable, and half a
    // JSON Schema is not a smaller schema, it is an unparseable one.
    const huge = entry({
      name: 'github__huge',
      toolName: 'huge',
      description: 'one enormous schema',
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: 2_000 }, (_unused, field) => [
            `field_${String(field)}`,
            { type: 'string', description: 'y'.repeat(80) },
          ]),
        ),
      },
    });
    const { invoke } = doors([huge]);

    const answer = await invoke('find_plugin_tools', { query: 'enormous' });

    expect(answer).toContain('github__huge');
    // Whole, not truncated — the model has to be able to parse it.
    expect(answer).toContain('"field_1999"');
    expect(Math.ceil(answer.length / 4)).toBeGreaterThan(PLUGIN_LISTING_TOKEN_BUDGET);
  });

  it('says so when nothing matches, rather than answering with everything', async () => {
    const { invoke } = doors([entry()]);

    const answer = await invoke('find_plugin_tools', { query: 'wire transfer' });

    expect(answer).toContain('Nothing matches');
    expect(answer).not.toContain('github__list_issues');
  });

  it('degrades to names when the descriptions do not fit the budget', async () => {
    // 600 tools of real prose is past the listing budget and nowhere near what
    // a bot may have: the form gives way, the reachability does not.
    const many = Array.from({ length: 600 }, (_unused, index) =>
      entry({
        name: `github__tool_${String(index)}`,
        toolName: `tool_${String(index)}`,
        description: `Tool number ${String(index)} `.padEnd(200, 'x'),
      }),
    );
    const { invoke } = doors(many);

    const answer = await invoke('find_plugin_tools', {});

    expect(answer).toContain('github__tool_0');
    expect(answer).toContain('names only');
    expect(answer).not.toContain('xxxxxx');
    expect(Math.ceil(answer.length / 4)).toBeLessThanOrEqual(PLUGIN_LISTING_TOKEN_BUDGET);
  });

  it('degrades to the plugins themselves, cut at the budget, when even names do not fit', async () => {
    // Artificial on purpose: it takes thousands of tools with long names to
    // reach the last rung, and the rung is the one that must never grow past
    // the budget rather than the one that must look good.
    const vast = Array.from({ length: 300 }, (_unused, index) =>
      entry({
        name: `plugin${String(index)}__${'a'.repeat(60)}`,
        serverName: `Plugin ${String(index).padStart(3, '0')} ${'n'.repeat(40)}`,
        toolName: 'a'.repeat(60),
      }),
    );
    const { invoke } = doors(vast);

    const answer = await invoke('find_plugin_tools', {});

    expect(answer).toContain('call find_plugin_tools with a query');
    expect(answer).toContain('…and');
    expect(answer).not.toContain('aaaaaaaaaa');
    expect(Math.ceil(answer.length / 4)).toBeLessThanOrEqual(PLUGIN_LISTING_TOKEN_BUDGET);
  });
});

describe('D-113 calling through a door', () => {
  it('reaches the right server and the server’s own tool name', async () => {
    const { invoke, caller } = doors([entry(), OTHER_SERVER]);

    await expect(
      invoke('use_plugin_tool', { tool: 'linear__list_issues', arguments: { a: 1 } }),
    ).resolves.toBe('srv-linear:list_issues');

    expect(caller.calls).toEqual([
      {
        serverId: 'srv-linear',
        toolName: 'list_issues',
        args: { a: 1 },
        timeoutMs: 30_000,
      },
    ]);
  });

  it('runs a write through the same door a read takes', async () => {
    // One door, and the difference between the two is the classification
    // `unwrap` returns — which is what the approval matcher reads, not what
    // this door does with the call.
    const { invoke } = doors([entry(), WRITES]);
    await expect(invoke('use_plugin_tool', { tool: 'github__create_issue' })).resolves.toBe(
      'srv-github:create_issue',
    );
  });

  it('answers an unknown name with the near misses', async () => {
    const { invoke, caller } = doors([entry(), WRITES]);

    const answer = await invoke('use_plugin_tool', { tool: 'github__close_issue' });

    expect(answer).toContain('No plugin tool named');
    expect(answer).toContain('github__list_issues');
    expect(caller.calls).toEqual([]);
  });

  it('turns a server’s failure into a result the model can read', async () => {
    // Same rule as a direct binding (D-109): one broken plugin must never
    // fail a turn, and a door is not an exception to it.
    const built = indirectPluginTools([entry()], async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const door = built.find((registered) => registered.name === 'use_plugin_tool');
    const execute = door?.build({} as never).execute;

    await expect(
      execute?.({ tool: 'github__list_issues' }, { toolCallId: 'c', messages: [] }),
    ).resolves.toContain('could not be called');
  });
});
