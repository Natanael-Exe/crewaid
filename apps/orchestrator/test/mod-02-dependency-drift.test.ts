/**
 * MOD-02 — the dependency set D-160 pins, and the surface D-159 codes against.
 *
 * This is the cheap first alarm for an upgrade. `check-pins.mjs` proves the
 * manifests say an exact version; this proves the INSTALLED packages are that
 * version, that the set agrees with itself (each adapter's peer range admits
 * the core that is installed, the core's AG-UI pin is the one resolved), and
 * that every export the contracts name is still there. The behavioural proof
 * is `mod-02-tanstack-compat.test.ts`; a bump that passes this file and fails
 * that one changed behaviour, not shape.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as ai from '@tanstack/ai';
import * as aiAdapters from '@tanstack/ai/adapters';
import * as persistence from '@tanstack/ai-persistence';
import * as compaction from '@tanstack/ai-compaction';
import * as mcp from '@tanstack/ai-mcp';
import * as openai from '@tanstack/ai-openai';
import * as anthropic from '@tanstack/ai-anthropic';
import * as openrouter from '@tanstack/ai-openrouter';
import * as client from '@tanstack/ai-client';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(APP, '..', 'desktop');

type Manifest = {
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

function manifestAt(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
}

/** The manifest of a package as installed for `app` (pnpm links it under the app). */
function installed(app: string, name: string): Manifest {
  return manifestAt(join(app, 'node_modules', name));
}

/** `^x.y.z` on a 0.y line admits only x.y.*, which is all these ranges use. */
function caretAdmits(range: string, version: string): boolean {
  const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (match === null) return range === version;
  const [major, minor, patch] = version.split('.').map(Number) as [number, number, number];
  const [rMajor, rMinor, rPatch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (major !== rMajor) return false;
  if (rMajor === 0) return minor === rMinor && patch >= rPatch;
  return minor > rMinor || (minor === rMinor && patch >= rPatch);
}

const ORCHESTRATOR_SET = [
  '@tanstack/ai',
  '@tanstack/ai-persistence',
  '@tanstack/ai-compaction',
  '@tanstack/ai-mcp',
  '@tanstack/ai-openai',
  '@tanstack/ai-anthropic',
  '@tanstack/ai-openrouter',
  '@tanstack/ai-elevenlabs',
] as const;

const DESKTOP_SET = ['@ag-ui/core', '@ag-ui/client', 'streamdown'] as const;

describe('MOD-02: the pinned set is the installed set, and it agrees with itself', () => {
  it('the native Playwright driver matches the desktop test pin', () => {
    expect(manifestAt(APP).dependencies?.['playwright-core']).toBe('1.62.1');
    expect(installed(APP, 'playwright-core').version).toBe('1.62.1');
    const skill = join(APP, '..', '..', 'packages', 'skill-runtime');
    expect(manifestAt(skill).dependencies?.['playwright-core']).toBe('1.62.1');
    expect(installed(skill, 'playwright-core').version).toBe('1.62.1');
    expect(manifestAt(DESKTOP).devDependencies?.['@playwright/test']).toBe('1.62.1');
  });
  it.each(ORCHESTRATOR_SET)('orchestrator installs exactly the pinned %s', (name) => {
    const pin = manifestAt(APP).dependencies?.[name];
    expect(pin, `${name} is not a dependency of the orchestrator`).toBeDefined();
    expect(installed(APP, name).version).toBe(pin);
  });

  it.each(DESKTOP_SET)('desktop installs exactly the pinned %s', (name) => {
    const pin = manifestAt(DESKTOP).dependencies?.[name];
    expect(pin, `${name} is not a dependency of the desktop`).toBeDefined();
    expect(installed(DESKTOP, name).version).toBe(pin);
  });

  it('the renderer has no TanStack AI or CopilotKit dependency', () => {
    const dependencies = Object.keys(manifestAt(DESKTOP).dependencies ?? {});
    expect(
      dependencies.filter(
        (name) => name.startsWith('@tanstack/ai') || name.startsWith('@copilotkit/'),
      ),
    ).toEqual([]);
  });

  it.each(ORCHESTRATOR_SET.filter((name) => name !== '@tanstack/ai'))(
    '%s admits the installed core and resolves to the same copy of it',
    (name) => {
      const app = APP;
      const own = installed(app, name);
      // `@tanstack/ai-mcp` takes the core as a dependency rather than a peer,
      // so a bump of either could install a second core beside the first —
      // two copies whose `instanceof` checks and capability registries never
      // meet. The realpath comparison is what catches that.
      const range = own.peerDependencies?.['@tanstack/ai'] ?? own.dependencies?.['@tanstack/ai'];
      expect(range, `${name} no longer depends on @tanstack/ai`).toBeDefined();
      expect(caretAdmits(range!, installed(app, '@tanstack/ai').version)).toBe(true);
      const packageDir = realpathSync(join(app, 'node_modules', name));
      const seenFromPackage = realpathSync(join(packageDir, '..', '..', '@tanstack', 'ai'));
      expect(seenFromPackage).toBe(realpathSync(join(app, 'node_modules', '@tanstack', 'ai')));
    },
  );

  it('the core pins AG-UI exactly, and that is the protocol version D-159 §3.2 supports', () => {
    const core = installed(APP, '@tanstack/ai');
    expect(core.dependencies?.['@ag-ui/core']).toBe('1.0.0');
    expect(manifestAt(APP).devDependencies?.['@ag-ui/core']).toBe('1.0.0');
  });
});

describe('MOD-02: every export the D-159 contracts name is present', () => {
  const expectFunctions = (module: Record<string, unknown>, names: readonly string[]): void => {
    for (const name of names) expect(typeof module[name], name).toBe('function');
  };

  it('core: loop, tools, interrupts, delivery and cancellation', () => {
    expectFunctions(ai, [
      'chat',
      'chatParamsFromRequestBody',
      'toolDefinition',
      'defineInterrupt',
      'memoryStream',
      'replayRunStream',
      'resumeServerSentEventsResponse',
      'toServerSentEventsResponse',
      'requestRunCancel',
      'wasCancelRequested',
      'isTerminalRunStatus',
      'maxIterations',
      'modelMessagesToUIMessages',
    ]);
    expect(ai.RUN_CANCEL_REASON).toBeTypeOf('string');
    expect(ai.INTERRUPT_BOUNDARY_PHASES).toContain('beforeTools');
    expect(ai.INTERRUPT_TOOL_RESUMES).toEqual(['continue', 'cancel', 'stop']);
    expectFunctions(aiAdapters, ['BaseTextAdapter']);
  });

  it('persistence: the four store definitions, the middleware and hydrate', () => {
    expectFunctions(persistence, [
      'defineAIPersistence',
      'defineMessageStore',
      'defineRunStore',
      'defineInterruptStore',
      'withPersistence',
      'reconstructChat',
      'memoryPersistence',
    ]);
  });

  it('compaction, MCP and the three provider adapters', () => {
    expectFunctions(compaction, [
      'withCompaction',
      'evictOldest',
      'summarizeOldest',
      'clearToolResults',
    ]);
    expectFunctions(mcp, ['createMCPClient', 'createMCPClientFromTransport']);
    expectFunctions(openai, ['createOpenaiChat', 'createOpenaiChatCompletions']);
    expectFunctions(anthropic, ['createAnthropicChat', 'createAnthropicChatWithClient']);
    expectFunctions(openrouter, ['createOpenRouterText']);
  });

  it('client: the chat client and the SSE connection the renderer uses', () => {
    expectFunctions(client, ['fetchServerSentEvents']);
    expect(typeof client.ChatClient).toBe('function');
  });
});
