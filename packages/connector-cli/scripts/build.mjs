#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(PKG_DIR, '..', '..');
const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
const outfile = join(PKG_DIR, 'dist', 'bin.mjs');

// Keep LICENSE synced for npm tarball publishing without drifting from repo root.
const rootLicense = join(REPO_ROOT, 'LICENSE');
const pkgLicense = join(PKG_DIR, 'LICENSE');
if (existsSync(rootLicense) && !existsSync(pkgLicense)) {
  copyFileSync(rootLicense, pkgLicense);
}

await build({
  entryPoints: [join(PKG_DIR, 'src', 'bin.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  minify: false,
  // Optional native addons probed inside try/catch by `ws`.
  external: ['bufferutil', 'utf-8-validate'],
  define: {
    __CREWAID_CONNECT_VERSION__: JSON.stringify(pkg.version ?? '0.0.0'),
  },
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __crewaidCreateRequire } from 'node:module';",
      'const require = __crewaidCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});

chmodSync(outfile, 0o755);
