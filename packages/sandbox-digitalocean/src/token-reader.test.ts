import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * D-150: one file reads the DigitalOcean token.
 *
 * The token manages every machine and template on the team, so it stays in
 * `do-api.ts` and the orchestrator's process. The boot check asks
 * `digitalOceanTokenConfigured()` instead of reading it, and the one other
 * mention is that check's error message. A second file naming the variable is
 * a second reader in waiting — and a sandbox-facing package reading it would
 * be the leak §7.3 exists to prevent.
 */
const TOKEN = 'DIGITALOCEAN_ACCESS_TOKEN';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ALLOWED = new Set([
  'packages/sandbox-digitalocean/src/do-api.ts',
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

describe('the DigitalOcean token has one reader (D-150)', () => {
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
  const mentions = roots
    .flatMap(sources)
    .filter((file) => readFileSync(file, 'utf8').includes(TOKEN))
    .map((file) => relative(ROOT, file));

  it('finds the reader it allows, so the scan is looking in the right place', () => {
    expect(mentions).toContain('packages/sandbox-digitalocean/src/do-api.ts');
  });

  it('finds no other source file naming the token', () => {
    expect(mentions.filter((file) => !ALLOWED.has(file))).toEqual([]);
  });
});
