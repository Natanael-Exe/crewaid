import { describe, expect, it } from 'vitest';
import { ToolRegistry, CONTAINED_BUILTIN, SENSITIVE_BUILTIN } from '../src/agent/tool-registry.js';
import { ToolsController } from '../src/agent/tools.controller.js';

/**
 * `GET /tools` — the directory the composer's palette reads.
 *
 * The assertions are about the contract, not the transport: the list comes
 * from the registry (one source of truth), carries the description the MODEL
 * itself is given, and exposes the reach classification in the operator's
 * vocabulary — "asks approval" is the one fact the palette exists to show.
 */
describe('ToolsController', () => {
  function registryWith(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
      name: 'sample_safe',
      behavior: CONTAINED_BUILTIN,
      build: () =>
        ({
          description: 'A contained sample tool.',
          inputSchema: {},
        }) as never,
    });
    registry.register({
      name: 'sample_asked',
      behavior: SENSITIVE_BUILTIN,
      build: () =>
        ({
          description: 'A sensitive sample tool.',
          inputSchema: {},
        }) as never,
    });
    return registry;
  }

  it('lists every registered tool with its description and reach', () => {
    const controller = new ToolsController(registryWith());
    const list = controller.list({ userId: 'user-under-test' });

    expect(list.map((tool) => tool.name)).toEqual(['sample_safe', 'sample_asked']);
    const safe = list.find((tool) => tool.name === 'sample_safe');
    expect(safe).toMatchObject({
      description: 'A contained sample tool.',
      reach: 'contained',
      origin: 'builtin',
    });
    expect(list.find((tool) => tool.name === 'sample_asked')?.reach).toBe('sensitive');

    // A tool with no curated words — an MCP server's, a skill's — still gets
    // a readable alias, label and summary rather than an internal name.
    expect(safe).toMatchObject({
      alias: 'sample-safe',
      label: 'Sample safe',
      summary: 'A contained sample tool.',
    });
  });

  it('gives a built-in its curated user-facing words', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'browser_read',
      behavior: CONTAINED_BUILTIN,
      build: () => ({ description: 'Read the page. Verbatim.', inputSchema: {} }) as never,
    });
    const [info] = new ToolsController(registry).list({ userId: 'user-under-test' });

    expect(info).toMatchObject({
      name: 'browser_read',
      alias: 'read-page',
      label: 'Read the page',
      summary: 'Reads the current page as text the bot can act on.',
      // The model-facing description is untouched by the rename.
      description: 'Read the page. Verbatim.',
    });
  });

  it('answers with the shared contract shape', () => {
    // `list` parses its own answer through ListToolsResponseSchema, so a
    // registry entry that cannot be projected fails here rather than on the
    // client.
    const controller = new ToolsController(registryWith());
    expect(() => controller.list({ userId: 'user-under-test' })).not.toThrow();
  });
});
