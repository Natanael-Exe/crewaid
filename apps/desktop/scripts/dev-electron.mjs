#!/usr/bin/env node
/**
 * `pnpm dev`'s Electron launcher: runs the app from a copy of Electron.app
 * that macOS can tell apart from every other copy.
 *
 * Browser sign-in returns through a custom scheme (`crewaid-selfhosted://`,
 * `crewaid://`), and macOS routes a scheme to an app by BUNDLE ID. Stock
 * Electron.app is `com.github.Electron` in every checkout, worktree and scratch
 * copy on the machine — dozens of them — so the callback went to whichever copy
 * Launch Services preferred, which opened Electron's own welcome window and
 * left the running dev app signed out. Re-registering a copy does not change
 * that preference; only a distinct bundle ID does.
 *
 * So on macOS this clones Electron.app into `.dev/` (APFS clone: instant, no
 * space), gives it a bundle ID unique to this checkout, declares both sign-in
 * schemes, re-signs it ad hoc and launches from it. The app's own
 * `setAsDefaultProtocolClient` then names this copy, and the callback arrives
 * in the running window as `open-url`. Elsewhere it launches stock Electron.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Required from Node, the `electron` package is the path to its executable. */
const stockBinary = require('electron');

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

function macDevBinary() {
  const stockApp = path.resolve(stockBinary, '..', '..', '..');
  const { version } = require('electron/package.json');
  const checkout = createHash('sha256').update(desktopDir).digest('hex').slice(0, 10);
  const bundleId = `ai.crewaid.dev.${checkout}`;
  const devDir = path.join(desktopDir, '.dev');
  const app = path.join(devDir, 'Crewaid Dev.app');
  const binary = path.join(app, 'Contents', 'MacOS', 'Electron');
  // Rebuilt only when Electron or the checkout changes.
  const stampFile = path.join(devDir, 'stamp.json');
  const stamp = JSON.stringify({ version, bundleId, stockApp });
  if (existsSync(binary) && existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp)
    return binary;

  rmSync(app, { recursive: true, force: true });
  mkdirSync(devDir, { recursive: true });
  try {
    execFileSync('cp', ['-cR', stockApp, app]);
  } catch {
    // Not APFS: a plain copy works, it just takes the space.
    execFileSync('cp', ['-R', stockApp, app]);
  }
  const plist = path.join(app, 'Contents', 'Info.plist');
  const replace = (key, type, value) =>
    execFileSync('plutil', ['-replace', key, `-${type}`, value, plist]);
  replace('CFBundleIdentifier', 'string', bundleId);
  replace('CFBundleName', 'string', 'Crewaid Dev');
  replace('CFBundleDisplayName', 'string', 'Crewaid Dev');
  // Both editions' schemes, as the packaged builds declare theirs.
  replace(
    'CFBundleURLTypes',
    'json',
    JSON.stringify([
      { CFBundleURLName: 'Crewaid sign-in', CFBundleURLSchemes: ['crewaid', 'crewaid-selfhosted'] },
    ]),
  );
  // The plist edit breaks the outer signature, and Apple silicon will not run
  // an unsigned app: re-sign it ad hoc, as stock Electron already is. Only the
  // outer bundle changed, so the nested frameworks keep theirs (`--deep` fails
  // on Electron Framework with an internal Code Signing error).
  execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'ignore' });
  execFileSync(LSREGISTER, ['-f', app]);
  writeFileSync(stampFile, stamp);
  console.log(`[dev-electron] prepared ${path.relative(desktopDir, app)} as ${bundleId}`);
  return binary;
}

const binary = process.platform === 'darwin' ? macDevBinary() : stockBinary;
const child = spawn(binary, ['.', ...process.argv.slice(2)], {
  cwd: desktopDir,
  stdio: 'inherit',
  env: process.env,
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    child.kill(signal);
  });
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
