#!/usr/bin/env node
/**
 * CC-07 source security probe.
 *
 * This is intentionally a small, dependency-free guard for the Electron
 * boundary. It complements tokenStore.test.ts with a fail-closed check that
 * the privileged APIs stay in main, renderer isolation stays enabled, and the
 * storage path cannot regress to direct JSON/plaintext writes or logging.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(path.join(appDir, 'src/main.ts'), 'utf8');
const preload = readFileSync(path.join(appDir, 'src/preload.ts'), 'utf8');
const bridge = readFileSync(path.join(appDir, 'src/renderer/bridge.ts'), 'utf8');
const tokenStore = readFileSync(path.join(appDir, 'src/tokenStore.ts'), 'utf8');

const failures = [];
const checks = [];

function check(name, condition) {
  checks.push(name);
  if (!condition) failures.push(name);
}

check('main keeps context isolation enabled', main.includes('contextIsolation: true'));
check('main keeps node integration disabled', main.includes('nodeIntegration: false'));
check('main keeps the renderer sandbox enabled', main.includes('sandbox: true'));
check('main uses an ESM-resolvable token-store import', main.includes("from './tokenStore.js'"));
check(
  'main authenticates token IPC against the main frame',
  main.includes('isTrustedRendererSender') &&
    tokenStore.includes('senderFrame') &&
    tokenStore.includes('mainFrame') &&
    tokenStore.includes('registerTokenIpc'),
);
check(
  'token IPC also checks the sending document is the renderer',
  main.includes('isTrustedRendererSender(event, [...rendererWindows], isRendererDocument)') &&
    tokenStore.includes('isRendererDocument('),
);
check(
  'a packaged build ignores ELECTRON_START_URL',
  main.includes('packaged: app.isPackaged') &&
    !/loadURL\(\s*process\.env\.ELECTRON_START_URL/.test(main) &&
    !/const RENDERER_URL = process\.env\.ELECTRON_START_URL/.test(main),
);
check(
  'renderer windows refuse navigation and new windows',
  main.includes("contents.on('will-navigate'") &&
    main.includes("contents.on('will-redirect'") &&
    main.includes('setWindowOpenHandler') &&
    main.includes("action: 'deny'"),
);
check(
  'preload exposes only the typed context bridge',
  preload.includes("contextBridge.exposeInMainWorld('crewaid', api)") &&
    preload.includes("ipcRenderer.invoke('crewaid:token:get')") &&
    preload.includes("ipcRenderer.invoke('crewaid:token:set', bag)"),
);
check(
  'preload never imports filesystem or safeStorage privileges',
  !/node:(?:fs|path)|\bsafeStorage\b/.test(preload),
);
check(
  'renderer bridge uses preload without direct persistence or privileges',
  bridge.includes('window.crewaid.token') &&
    !/^import .*node:(?:fs|path)|^import .*\bsafeStorage\b/m.test(bridge) &&
    !/\b(?:localStorage|sessionStorage)\b/.test(bridge),
);
check(
  'storage encrypts before writing bytes',
  tokenStore.includes('safeStorage.encryptString') &&
    tokenStore.includes('writeFileSync(temporaryPath, encrypted'),
);
check(
  'storage replaces ciphertext atomically with restrictive mode',
  tokenStore.includes('renameSync(temporaryPath, filePath)') &&
    tokenStore.includes('TOKEN_FILE_MODE = 0o600'),
);
check(
  'storage never writes serialized credentials directly',
  !/writeFileSync\([^\n]*JSON\.stringify/.test(tokenStore),
);
check(
  'token store contains no logging calls',
  !/\bconsole\.(?:log|info|warn|error)\s*\(/.test(tokenStore),
);
check(
  'credential-bearing paths never log token details',
  ![main, preload, bridge, tokenStore].some((source) =>
    source
      .split('\n')
      .some(
        (line) =>
          /\bconsole\.(?:log|info|warn|error)\s*\(/.test(line) &&
          /token|credential|secret|password/i.test(line),
      ),
  ),
);
check(
  'token store has no plaintext legacy fallback path',
  !/\b(?:token|credentials)\.(?:json|txt)\b/i.test(tokenStore),
);
check(
  'token errors expose normalized codes only',
  tokenStore.includes('ENCRYPTION_UNAVAILABLE') &&
    tokenStore.includes('STORAGE_ERROR') &&
    tokenStore.includes('INVALID_CREDENTIALS') &&
    tokenStore.includes('UNAUTHORIZED'),
);

for (const name of checks) {
  console.log(`${failures.includes(name) ? 'FAIL' : 'PASS'}  ${name}`);
}
if (failures.length > 0) {
  console.error(`CC-07 security probe failed (${failures.length}/${checks.length}).`);
  process.exit(1);
}
console.log(`CC-07 security probe passed (${checks.length}/${checks.length}).`);
