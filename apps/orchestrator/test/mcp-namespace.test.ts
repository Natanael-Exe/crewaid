import { toolReach } from '../src/agent/tool-registry.js';
import { describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '../src/mcp/mcp-connection.js';

import {
  collidingBuiltinTool,
  MAX_TOOL_NAME_LENGTH,
  namespacedToolName,
  parseNamespacedToolName,
} from '../src/mcp/mcp-namespace.js';
import {
  bindMcpTool,
  bindMcpTools,
  mcpResultText,
  toMcpInputSchema,
  type McpToolCall,
  type McpToolServer,
} from '../src/mcp/mcp-tool-binding.js';
import { CURATED_MCP_SERVERS } from '../src/mcp/mcp-directory.js';
import { ToolRegistry } from '../src/agent/tool-registry.js';
import { deriveMcpSlug } from '../src/mcp/mcp-slug.js';

/**
 * M6-BE-06 / M6-QA-01 — what an MCP tool is called, and where a call by that
 * name goes.
 *
 * Three claims, and the third is the one that is easy to assert vacuously.
 * The format is a string rule; the collision refusal is a string rule with the
 * registry's own names on one side; the ROUND TRIP is the claim that
 * `github__search` reaches the GitHub server's `search` and not the Linear
 * server's. A suite with one server proves nothing about the last of those, so
 * every routing case here has two servers that both offer a tool of the same
 * name, and the assertion is which one was dialled.
 */

const GITHUB: McpToolServer = { id: 'srv-github', name: 'GitHub', slug: 'github' };
const LINEAR: McpToolServer = { id: 'srv-linear', name: 'Linear', slug: 'linear' };

/** One cached row's worth, with the schema already read out of the column. */
function cached(name: string, description = `does ${name}`, readOnly = false) {
  return { name, description, inputSchema: toMcpInputSchema({ type: 'object' }), readOnly };
}

/** A caller that records what it was asked for and answers with plain text. */
function recordingCaller() {
  const calls: McpToolCall[] = [];
  const call = vi.fn(async (received: McpToolCall): Promise<CallToolResult> => {
    calls.push(received);
    return { content: [{ type: 'text', text: `${received.serverId}:${received.toolName}` }] };
  });
  return { calls, call };
}

function boundTool(server: McpToolServer, name: string, call: ReturnType<typeof recordingCaller>) {
  const binding = bindMcpTool(server, cached(name), call.call);
  if (!binding.ok) throw new Error(`expected a binding, got: ${binding.reason}`);
  return binding.tool;
}

/** The definition's `execute`, which is the only way in from the model. */
async function invoke(tool: ReturnType<typeof boundTool>, args: Record<string, unknown>) {
  const definition = tool.build({} as never);
  const execute = definition.execute;
  if (execute === undefined) throw new Error('an MCP tool must be executable');
  const output = await execute(args, { toolCallId: 'call-1', messages: [] });
  const projected = await definition.toModelOutput?.({ toolCallId: 'call-1', input: args, output });
  return projected?.type === 'text' ? projected.value : output;
}

describe('M6-BE-06 the namespaced name', () => {
  it('is <slug>__<toolName>', () => {
    expect(namespacedToolName('gmail', 'send_message')).toEqual({
      ok: true,
      name: 'gmail__send_message',
    });
  });

  it('refuses a tool name the model providers would reject', () => {
    // A server is a third party and may name a tool anything. Slugifying it
    // here would break the round trip (the call goes back under the SERVER's
    // name), so the name is refused and the tool is not offered.
    const refused = namespacedToolName('gmail', 'send.message');
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toMatch(/do not accept/);
  });

  it('refuses a combined name over the provider ceiling, and names the length', () => {
    const slug = 'a'.repeat(30);
    const fits = namespacedToolName(slug, 'b'.repeat(MAX_TOOL_NAME_LENGTH - 32));
    expect(fits).toEqual({ ok: true, name: `${slug}__${'b'.repeat(32)}` });

    const overflows = namespacedToolName(slug, 'b'.repeat(MAX_TOOL_NAME_LENGTH - 31));
    expect(overflows.ok).toBe(false);
    expect(overflows.ok === false && overflows.reason).toMatch(/65 characters/);
  });

  it('refuses a slug that is not one, rather than building a name around it', () => {
    for (const bad of ['', 'Gmail', '9lives', 'has space', 'has.dot']) {
      expect(namespacedToolName(bad, 'read').ok).toBe(false);
    }
    expect(namespacedToolName('gmail', '').ok).toBe(false);
  });

  it('produces a name the tool registry accepts', () => {
    // The forecast and the fence have to agree: this module says a name is
    // usable, and `ToolRegistry.register` is what actually refuses one. Two
    // regexes in two files is exactly the pair that drifts, so the assertion
    // is that a name blessed here survives registration.
    const named = namespacedToolName('a'.repeat(30), 'b'.repeat(32));
    expect(named.ok).toBe(true);
    const registry = new ToolRegistry();
    expect(() =>
      registry.register({
        name: named.ok ? named.name : 'unreachable',
        build: () => ({}) as never,
        behavior: {
          origin: { kind: 'mcp', serverId: 's' },
          failure: { kind: 'isolate' },

          effect: 'unknown',
          authority: false,
        },
      }),
    ).not.toThrow();
  });
});

describe('M6-BE-06 reading a namespaced name back', () => {
  it('splits on the first separator, so a tool may carry its own', () => {
    expect(parseNamespacedToolName('gmail__send_message')).toEqual({
      slug: 'gmail',
      toolName: 'send_message',
    });
    // A slug may contain a single underscore; a tool name may contain a
    // double one. First-separator wins is what makes that unambiguous.
    expect(parseNamespacedToolName('my_server__a__b')).toEqual({
      slug: 'my_server',
      toolName: 'a__b',
    });
  });

  it('answers null for anything that is not one', () => {
    // Every built-in: none carries a `__`, which is what keeps `browser_click`
    // from being read as a server called `browser`.
    for (const builtin of ['browser_click', 'shell', 'run_skill', 'send_message']) {
      expect(parseNamespacedToolName(builtin)).toBeNull();
    }
    // A slug half that is not a legal slug is refused rather than guessed at.
    expect(parseNamespacedToolName('Gmail__send')).toBeNull();
    expect(parseNamespacedToolName('__send')).toBeNull();
    expect(parseNamespacedToolName('gmail__')).toBeNull();
  });

  it('round-trips every name it built', () => {
    const named = namespacedToolName('linear', 'list_issues');
    expect(named.ok && parseNamespacedToolName(named.name)).toEqual({
      slug: 'linear',
      toolName: 'list_issues',
    });
  });
});

describe('M6-BE-06 a slug that would shadow a built-in', () => {
  const builtins = ['browser_click', 'shell', 'memory_read', 'send_message'];

  it('names the built-in it collides with', () => {
    // The prefix of a built-in is everything before its first underscore, so a
    // server slugged `browser` offers `browser__click` one character from
    // `browser_click`.
    expect(collidingBuiltinTool('browser', builtins)).toBe('browser_click');
    // A built-in with no underscore claims its whole name.
    expect(collidingBuiltinTool('shell', builtins)).toBe('shell');
  });

  it('leaves a slug that shadows nothing alone', () => {
    for (const fine of ['github', 'linear', 'browsers', 'memory-bank', 'send-grid']) {
      expect(collidingBuiltinTool(fine, builtins)).toBeUndefined();
    }
  });

  it('holds for every slug this build ships', () => {
    // A curated entry is a constant, so a collision added to that list would
    // be an install that can never succeed — discovered by whoever clicked it.
    const registry = new ToolRegistry();
    const names = [
      'browser_click',
      'shell',
      'memory_read',
      'send_message',
      'run_skill',
      'fs_read',
      'board_read',
      'capture_screen',
      'attach_file',
      'use_identity',
      'create_bot',
    ];
    for (const name of names) {
      registry.register({
        name,
        build: () => ({}) as never,
        behavior: {
          origin: { kind: 'builtin' },
          failure: { kind: 'isolate' },

          effect: 'draft',
          authority: false,
        },
      });
    }
    for (const entry of CURATED_MCP_SERVERS) {
      expect(collidingBuiltinTool(entry.slug, registry.names())).toBeUndefined();
    }
  });

  it('catches a colliding name the slug derivation would produce', () => {
    // The operator types a NAME; `deriveMcpSlug` turns it into the namespace.
    // The collision check has to be applied to the derived slug, which is what
    // this pins: "Browser" installs as `browser`.
    expect(deriveMcpSlug('Browser')).toBe('browser');
    expect(collidingBuiltinTool('browser', builtins)).toBe('browser_click');
  });
});

describe('M6-QA-01 a namespaced call reaches the right server and tool', () => {
  it('routes two servers offering one tool name to their own servers', async () => {
    const caller = recordingCaller();
    const fromGithub = boundTool(GITHUB, 'search', caller);
    const fromLinear = boundTool(LINEAR, 'search', caller);

    expect(fromGithub.name).toBe('github__search');
    expect(fromLinear.name).toBe('linear__search');

    await expect(invoke(fromGithub, { q: 'a' })).resolves.toBe('srv-github:search');
    await expect(invoke(fromLinear, { q: 'b' })).resolves.toBe('srv-linear:search');

    expect(caller.calls).toEqual([
      // The timeout rides with the call (M6-BE-10): the number the descriptor
      // published is the number the socket is held to, so it is asserted here
      // rather than left to whatever the caller happens to use.
      { serverId: 'srv-github', toolName: 'search', args: { q: 'a' }, timeoutMs: 30_000 },
      { serverId: 'srv-linear', toolName: 'search', args: { q: 'b' }, timeoutMs: 30_000 },
    ]);
  });

  it('calls the server under the server’s own name, never the namespaced one', () => {
    // The whole reason dispatch is a closure rather than a parse: the name the
    // model uses and the name the server knows are different strings, and
    // sending the first one back would fail on every server that works.
    const caller = recordingCaller();
    const tool = boundTool(GITHUB, 'search', caller);
    return invoke(tool, {}).then(() => {
      expect(caller.calls[0]?.toolName).toBe('search');
      expect(caller.calls[0]?.toolName).not.toBe(tool.name);
    });
  });

  it('tells the registry which server a tool came from, and whether it asks first', () => {
    const caller = recordingCaller();
    const tool = boundTool(GITHUB, 'search', caller);
    expect(tool.behavior.origin).toEqual({ kind: 'mcp', serverId: 'srv-github' });
    // M6-BE-08 / §6/M6: a write asks, a read does not. The classification is
    // the row's (the ladder ran at list time); the binding carries it onto
    // the descriptor the approval matcher reads.
    expect(toolReach(tool.behavior)).toBe('sensitive');

    const read = bindMcpTool(GITHUB, cached('search', 'does search', true), caller.call);
    expect(read.ok && toolReach(read.tool.behavior)).toBe('contained');
  });

  it('drops only the tools whose names cannot be namespaced', () => {
    const caller = recordingCaller();
    const bindings = bindMcpTools(
      GITHUB,
      [cached('search'), cached('list.issues'), cached('create_issue')],
      caller.call,
    );

    expect(bindings.map((b) => (b.ok ? b.tool.name : `refused:${b.toolName}`))).toEqual([
      'github__search',
      'refused:list.issues',
      'github__create_issue',
    ]);
  });

  it('turns a server’s failure into a result the model can read', async () => {
    // `failure: isolate` — §6/M6's "one broken plugin must never fail a turn"
    // begins here, at the one place a third party's exception could escape
    // into the turn.
    const tool = bindMcpTool(GITHUB, cached('search'), async () => {
      throw new Error('connect ECONNREFUSED');
    });
    if (!tool.ok) throw new Error('expected a binding');

    await expect(invoke(tool.tool, {})).resolves.toBe(
      'github__search could not be called: connect ECONNREFUSED',
    );
  });
});

describe('M6-BE-06 what the model is shown', () => {
  it('names the plugin a tool came from in its description', () => {
    const tool = boundTool(GITHUB, 'search', recordingCaller());
    const description = (tool.build({} as never) as { description?: string }).description;
    expect(description).toBe('does search (from the "GitHub" plugin)');
  });

  it('states type: object for a server that published no schema', () => {
    // `toToolDescriptor` substitutes `{}` when a server sends nothing, and a
    // schema with no `type` is refused by the provider for the whole request.
    expect(toMcpInputSchema({})).toEqual({ type: 'object' });
    expect(toMcpInputSchema(undefined)).toEqual({ type: 'object' });
    expect(toMcpInputSchema(null)).toEqual({ type: 'object' });
    expect(toMcpInputSchema([1, 2])).toEqual({ type: 'object' });
    // …and leaves a real one exactly as the server published it.
    const published = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
    expect(toMcpInputSchema(published)).toEqual(published);
  });

  it('renders content parts as text, naming the ones it cannot show', () => {
    expect(mcpResultText({ content: [{ type: 'text', text: 'one' }] })).toBe('one');
    expect(
      mcpResultText({
        content: [
          { type: 'text', text: 'here is the chart' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
      }),
    ).toBe('here is the chart\n[image/png image returned by the tool; it is not shown here]');
    expect(mcpResultText({ content: [] })).toBe('The server returned no content.');
  });

  it('says when the server itself reported the call failed', () => {
    expect(
      mcpResultText({ content: [{ type: 'text', text: 'no such issue' }], isError: true }),
    ).toBe('The tool reported an error.\nno such issue');
  });
});
