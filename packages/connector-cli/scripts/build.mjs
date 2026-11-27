#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(PKG_DIR, '..', '..');
const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
const version = pkg.version && pkg.version !== '0.0.0'
  ? pkg.version
  : JSON.parse(readFileSync(join(REPO_ROOT, 'apps', 'desktop', 'package.json'), 'utf8')).version ?? '0.0.0';
const cliOutfile = join(PKG_DIR, 'dist', 'bin.mjs');
const workerOutfile = join(PKG_DIR, 'dist', 'desktop-worker.cjs');

// Keep LICENSE synced for npm tarball publishing without drifting from repo root.
const rootLicense = join(REPO_ROOT, 'LICENSE');
const pkgLicense = join(PKG_DIR, 'LICENSE');
if (existsSync(rootLicense) && !existsSync(pkgLicense)) {
  copyFileSync(rootLicense, pkgLicense);
}

const sharedBuildOptions = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  sourcemap: false,
  minify: false,
  // Optional native addons probed inside try/catch by `ws`.
  external: ['bufferutil', 'utf-8-validate'],
  define: {
    __CREWAID_CONNECT_VERSION__: JSON.stringify(version),
  },
};

await Promise.all([
  // 1. Standalone ESM executable published to npm (`npx crewaid-connect`).
  build({
    ...sharedBuildOptions,
    entryPoints: [join(PKG_DIR, 'src', 'bin.ts')],
    outfile: cliOutfile,
    format: 'esm',
    banner: {
      js: [
        '#!/usr/bin/env node',
        "import { createRequire as __crewaidCreateRequire } from 'node:module';",
        'const require = __crewaidCreateRequire(import.meta.url);',
      ].join('\n'),
    },
  }),
  // 2. Self-contained CommonJS worker forked by Electron's `utilityProcess.fork()`
  //    (D-242). Excluded from package.json `files` so the npm tarball stays lean.
  build({
    ...sharedBuildOptions,
    entryPoints: [join(PKG_DIR, 'src', 'desktop-worker.ts')],
    outfile: workerOutfile,
    format: 'cjs',
  }),
]);

chmodSync(cliOutfile, 0o755);
