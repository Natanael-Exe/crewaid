#!/usr/bin/env node
// Package one edition (D-152): `node scripts/package.mjs <cloud|selfhosted> [electron-builder args…]`.
//
// A script rather than a line in package.json because the hosted build carries
// a per-deployment value — its orchestrator's address — that must come from the
// environment, and must be refused rather than packaged when it is missing or
// not https: src/edition.ts would refuse it at first launch anyway, which is a
// release that installs and then cannot open.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [edition, ...rest] = process.argv.slice(2);
if (edition !== 'cloud' && edition !== 'selfhosted') {
  console.error('usage: node scripts/package.mjs <cloud|selfhosted> [electron-builder args…]');
  process.exit(2);
}

const args = ['--config', `electron-builder.${edition}.yml`, '--publish', 'never', ...rest];

// A Developer ID is opt-in by certificate (D-153). Without one, explicitly
// ad-hoc sign the finished bundle: skipping signing leaves Electron's linker
// signature with an unbound Info.plist, so macOS cannot reliably remember a
// microphone grant. Ad-hoc signing never selects a login-keychain identity.
// Hardened runtime requires a team identity for library validation; keep it
// for Developer ID builds. Notarization also needs that certificate.
const signing = (process.env.CSC_LINK ?? '') !== '';
if (!signing) args.push('-c.mac.identity=-', '-c.mac.hardenedRuntime=false');
// Read by the app: a signed macOS build installs its own updates, an unsigned
// one cannot (Squirrel.Mac checks the signature) and offers the download page.
args.push(`-c.extraMetadata.crewaid.macSigned=${signing}`);
const notarizing =
  signing &&
  ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'].every(
    (name) => (process.env[name] ?? '') !== '',
  );
if (notarizing) args.push('-c.mac.notarize=true');

if (edition === 'cloud') {
  const raw = (process.env.CREWAID_ORCHESTRATOR_URL ?? '').trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  if (url === undefined || url.protocol !== 'https:') {
    console.error(
      'A cloud build needs CREWAID_ORCHESTRATOR_URL set to the hosted orchestrator, https:// — ' +
        `got ${JSON.stringify(raw)}`,
    );
    process.exit(1);
  }
  args.push(`-c.extraMetadata.crewaid.orchestratorUrl=${url.origin}`);
}

// This package's own pinned binary, so the script works outside a pnpm script
// too (where node_modules/.bin is not on PATH).
const bin = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
);
// An unset CI secret arrives as an empty string, which electron-builder would
// read as a certificate path ("not a file"); remove it so it falls back to the
// ad-hoc signature above.
const env = { ...process.env };
if (!signing) {
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD']) {
    if ((env[name] ?? '') === '') delete env[name];
  }
  // electron-builder skips macOS code signing during pull request builds
  // unless CSC_FOR_PULL_REQUEST is true. Ad-hoc signing uses no secrets, so
  // allow ad-hoc signing during PR builds so the bundle gets signed.
  env.CSC_FOR_PULL_REQUEST = 'true';
}
const result = spawnSync(bin, args, {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});
if (result.error) console.error(`could not run electron-builder: ${result.error.message}`);
process.exit(result.status ?? 1);
