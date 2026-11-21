import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * D-217: one file reads the Runtime API key, and one file imports the SDK.
 *
 * The key manages every sandbox, image and volume on the account, so it stays
 * in `runtime-client.ts` and the orchestrator's process. The boot check asks
 * `runtimeApiKeyConfigured()` instead of reading it, and the one other mention
 * is that check's error message. The SDK reads the same variable by itself
 * when no key is passed, so a second file importing it is a second reader in
 * waiting — and a sandbox-facing package doing either would be the leak §7.3
 * exists to prevent.
 */
const KEY = 'RUNTIME_API_KEY';
const SDK_IMPORT = /from\s+['"]withruntime(\/[^'"]*)?['"]|import\(\s*['"]withruntime/;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const READER = 'packages/sandbox-runtime/src/runtime-client.ts';
const KEY_ALLOWED = new Set([
  READER,
  // The boot check's error message names the variable it wants set.
  'apps/orchestrator/src/sandbox/sandbox.config.ts',
]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist') return [];
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|mts|js|mjs|py|sh)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)
      ? [path]
      : [];
  });
}

describe('the Runtime API key has one reader (D-217)', () => {
  const roots = [
    ...readdirSync(join(ROOT, 'apps')).map((app) => join(ROOT, 'apps', app, 'src')),
    ...readdirSync(join(ROOT, 'packages')).map((pkg) => join(ROOT, 'packages', pkg, 'src')),
    join(ROOT, 'infra/sandbox-image'),
  ].filter((dir) => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
  const files = roots.flatMap(sources).map((file) => ({
    path: relative(ROOT, file),
    text: readFileSync(file, 'utf8'),
  }));
  const keyMentions = files.filter((file) => file.text.includes(KEY)).map((file) => file.path);
  const sdkImports = files.filter((file) => SDK_IMPORT.test(file.text)).map((file) => file.path);

  it('finds the reader it allows, so the scan is looking in the right place', () => {
    expect(keyMentions).toContain(READER);
    expect(sdkImports).toContain(READER);
  });

  it('finds no other source file naming the key', () => {
    expect(keyMentions.filter((file) => !KEY_ALLOWED.has(file))).toEqual([]);
  });

  it('finds no other source file importing the SDK', () => {
    expect(sdkImports.filter((file) => file !== READER)).toEqual([]);
  });
});
