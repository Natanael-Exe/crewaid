import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * One file reads the Instabox API key, and one file imports `@insforge/instabox-sdk`
 * or `ssh2`.
 *
 * The key manages every sandbox on the Instabox account, so it stays in
 * `instabox-client.ts` inside the orchestrator process. The boot check asks
 * `instaboxApiKeyConfigured()` instead of reading it, and the one other mention
 * is that check's error message. The SDK also reads `INSTABOX_API_KEY` on its
 * own when no key is passed, so any second file importing it would be a second
 * reader in waiting.
 */
const KEY = 'INSTABOX_API_KEY';
const SDK_IMPORT =
  /from\s+['"]@insforge\/instabox-sdk(\/[^'"]*)?['"]|import\(\s*['"]@insforge\/instabox-sdk/;
const SSH2_IMPORT = /from\s+['"]ssh2(\/[^'"]*)?['"]|import\(\s*['"]ssh2/;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const READER = 'packages/sandbox-instabox/src/instabox-client.ts';
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

describe('the Instabox API key, SDK, and ssh2 transport have one reader', () => {
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
  const ssh2Imports = files.filter((file) => SSH2_IMPORT.test(file.text)).map((file) => file.path);

  it('finds the reader it allows, so the scan is looking in the right place', () => {
    expect(keyMentions).toContain(READER);
    expect(sdkImports).toContain(READER);
    expect(ssh2Imports).toContain(READER);
  });

  it('finds no other source file naming the key', () => {
    expect(keyMentions.filter((file) => !KEY_ALLOWED.has(file))).toEqual([]);
  });

  it('finds no other source file importing the Instabox SDK', () => {
    expect(sdkImports.filter((file) => file !== READER)).toEqual([]);
  });

  it('finds no other source file importing ssh2', () => {
    expect(ssh2Imports.filter((file) => file !== READER)).toEqual([]);
  });
});
