/**
 * MOD-02 — what the renderer would ship if it imported the chat stack today.
 *
 * R1 says the renderer holds no orchestration logic, and D-159 §3.12 says which
 * TanStack packages it may import. A lint rule fences the renderer's own
 * imports; it cannot see what those packages pull in. This bundles the exact
 * entry points the renderer will use (the React hook, the SSE connection and
 * Streamdown) the way Vite will — browser platform, tree-shaken — and asserts
 * on the module graph that comes out.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Metafile } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Packages that must never reach a renderer bundle: providers, server state, MCP, keys. */
const SERVER_ONLY = [
  '@tanstack/ai',
  '@tanstack/ai-client',
  '@tanstack/ai-react',
  '@copilotkit/react-core',
  '@tanstack/ai-openai',
  '@tanstack/ai-anthropic',
  '@tanstack/ai-openrouter',
  '@tanstack/ai-persistence',
  '@tanstack/ai-mcp',
  '@tanstack/ai-compaction',
  '@tanstack/openai-base',
  'openai',
  '@anthropic-ai/sdk',
  '@openrouter/sdk',
  '@modelcontextprotocol/client',
  '@modelcontextprotocol/server',
  '@modelcontextprotocol/sdk',
  'ai',
] as const;

/** The package each bundled file belongs to: the last `node_modules/<name>` on its path. */
function packageOf(path: string): string | undefined {
  const matches = [...path.matchAll(/node_modules\/((?:@[^/]+\/)?[^/.][^/]*)\//g)];
  return matches.at(-1)?.[1];
}

let metafile: Metafile;
let outputBytes: number;

beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: [
        "export { crewaidChat } from './src/renderer/chat/crewaidChat';",
        "export { Streamdown } from 'streamdown';",
      ].join('\n'),
      resolveDir: DESKTOP,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    metafile: true,
    // The renderer's platform: a node builtin anywhere in the graph is a build
    // error here, which is the failure this file exists to surface.
    platform: 'browser',
    format: 'esm',
    minify: true,
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  metafile = result.metafile;
  outputBytes = result.outputFiles[0]!.contents.length;
}, 60_000);

describe('MOD-02: the renderer chat stack stays a client', () => {
  it('pulls in no provider SDK, server store, MCP client or old AI SDK', () => {
    const included = new Set(
      Object.keys(metafile.inputs)
        .map(packageOf)
        .filter((name) => name !== undefined),
    );
    for (const name of SERVER_ONLY)
      expect(included.has(name), `${name} reached the renderer`).toBe(false);
    expect(included.has('@ag-ui/client')).toBe(true);
  });

  it('stays inside a size a reviewer would notice growing', () => {
    // 1480 KiB for the actual AG-UI connection, shared contracts and Streamdown; React excluded. The ceiling is loose
    // on purpose: it trips on a bump that drags a new dependency tree in, not
    // on a patch release.
    expect(outputBytes).toBeLessThan(2 * 1024 * 1024);
  });
});
