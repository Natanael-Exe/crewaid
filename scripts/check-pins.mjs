#!/usr/bin/env node
/**
 * Exact version pins, no carets.
 *
 * These pins are load-bearing: several upstream SDK/harness packages carry
 * experimental types that churn across minors, so a caret range can silently
 * break the build. A code-review promise does not survive dependency bumps;
 * this script does.
 *
 * Fails CI if:
 *   1. any LOAD_BEARING package is missing, or pinned to anything other than
 *      its exact required version;
 *   2. any dependency anywhere in the workspace uses a `^` or `~` range.
 *
 * Run: node scripts/check-pins.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * PRD §2.5 churn caveat + TASKS.md M0-07, corrected by D-011.
 *
 * ⚠️ ALWAYS WRITE THE SCOPED NAME. D-011: the original M0-07 line said
 * "openai@4.0.55", which reads as OpenAI's own SDK. Pinning bare `openai` and
 * calling it directly breaches R3 (model access goes through a provider
 * adapter). The adapter is `@tanstack/ai-openai` since D-199. The FORBIDDEN
 * list below makes that mistake fail CI rather than pass review.
 *
 * All versions verified live on npm.
 */
const LOAD_BEARING = {
  '@composio/core': '0.22.0',
  '@ai-sdk/harness': '1.0.98',
  '@heroui/react': '3.2.4',
  '@novnc/novnc': '1.7.0',
  // D-011: zod is the ONLY runtime dependency packages/shared may have (M0
  // acceptance) — a major mismatch breaks schema inference across both apps.
  zod: '4.6.6',
  // D-007: Electron 32 (per the PRD) reached EOL 2025-03-04 embedding Chromium
  // M128. This app renders remote content and proxies a VNC framebuffer, so an
  // EOL engine is a live security defect. Do not let anyone "fix" this back.
  electron: '44.9.1',
  // M1-QA-05: Playwright's runner and Electron driver are a matched pair.
  // `_electron` is still experimental upstream, so even a minor float can
  // change its launch/lifecycle contract under the only real desktop E2E.
  '@playwright/test': '1.62.1',
  playwright: '1.62.1',
  // Both drivers attach to the image's existing Chrome with the same public APIs.
  'playwright-core': '1.62.1',
  // M1 gap fix (found 2026-09-02): Nest landed on PR #6 with caret ranges and
  // the LOAD_BEARING list didn't cover it — `pnpm add` carets sailed through
  // check-pins. The whole Nest runtime is load-bearing now that main.ts boots
  // from it: a surprise Nest major changes DI, guard, and interceptor
  // semantics under M1-BE-01's AuthGuard. Empirical proof on record: a
  // manifest with rxjs@7.8.3 (wrong version) fails this script with the
  // exact load-bearing message below. Moved together to 11.2.6 for the
  // multer 2.4.0 it brings: 2.2.0 had three reachable multipart DoS advisories
  // (GHSA-wc9g-mqfw-jrwm, GHSA-qfvm-cv95-jqjf and the array-index one).
  '@nestjs/common': '11.2.6',
  '@nestjs/core': '11.2.6',
  '@nestjs/platform-express': '11.2.6',
  '@nestjs/platform-ws': '11.2.6',
  '@nestjs/websockets': '11.2.6',
  // reflect-metadata + rxjs: the boot-critical pair. Undeclared on PR #6
  // three times while tests stayed green — vitest's @Inject-token pattern
  // bypasses the design:paramtypes metadata that real bootstrap needs, so
  // only a declared dep + live boot proves these exist.
  'reflect-metadata': '0.2.2',
  rxjs: '7.8.2',
  // M3-BE-06: the compile queue's runtime pair. BullMQ's defaults — a single
  // attempt, the per-job lock — are what the compile's no-retry fencing is
  // written against, and ioredis carries the blocking connection the worker
  // sits on; a float in either silently changes retry or reconnect behaviour
  // under a paid model call.
  bullmq: '6.3.4',
  ioredis: '6.0.0',
  // D-158/D-160: the TanStack AI set the modernization migrates to. Pre-1.0,
  // a minor a week, and the packages peer on each other — so they move as ONE
  // server set, and `mod-02-dependency-drift.test.ts`
  // checks that what is installed is what is written here and that the set
  // still agrees with itself. `@ag-ui/core` is the protocol version the core
  // pins exactly. D-205 uses the independent `@ag-ui/client` in the renderer
  // and compatibility suites, with its matching core and RxJS pins.
  '@tanstack/ai': '0.64.0',
  '@tanstack/ai-client': '0.36.1',
  '@tanstack/ai-persistence': '0.7.2',
  '@tanstack/ai-compaction': '0.1.12',
  '@tanstack/ai-mcp': '0.7.0',
  '@tanstack/ai-openai': '0.26.0',
  '@tanstack/ai-anthropic': '0.19.4',
  '@tanstack/ai-openrouter': '0.20.2',
  // D-221: speech-to-text and text-to-speech, peered on the same core.
  '@tanstack/ai-elevenlabs': '0.6.7',
  // D-222: the call's voice, imported only by renderer/voice/callSession.ts.
  '@elevenlabs/client': '1.28.0',
  '@ag-ui/core': '1.0.0',
  '@ag-ui/client': '1.0.1',
  // D-160: the transcript renderer MOD-MD-01 adopts. Its HTML handling
  // (rehype-raw, rehype-sanitize, rehype-harden) is configuration a minor
  // release can change, and that is a security boundary.
  streamdown: '2.7.0',
};

/**
 * Packages that must never appear in any manifest, with the reason.
 * R3 violations are cheaper to prevent than to find in review.
 */
const FORBIDDEN = {
  openai:
    'R3 / D-011: use the provider adapter (@tanstack/ai-openai), ' +
    "not OpenAI's own SDK. Model access goes through an adapter — never a provider API directly.",
  '@anthropic-ai/sdk':
    'R3: use the provider adapter (@tanstack/ai-anthropic). Model access goes through an adapter.',
  ai: 'D-199: the AI SDK engine was replaced by TanStack AI; no parallel inference SDK.',
  '@ai-sdk/openai': 'D-199: use @tanstack/ai-openai.',
  '@ai-sdk/anthropic': 'D-199: use @tanstack/ai-anthropic.',
  '@ai-sdk/openai-compatible': 'D-199: use the TanStack OpenAI adapter with a base URL.',
  '@openrouter/ai-sdk-provider': 'D-199: use @tanstack/ai-openrouter.',
};

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];

function findManifests() {
  const out = [join(ROOT, 'package.json')];
  for (const group of ['apps', 'packages']) {
    const dir = join(ROOT, group);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(dir, entry.name, 'package.json');
      if (existsSync(manifest)) out.push(manifest);
    }
  }
  return out;
}

const errors = [];
const found = new Set();

for (const manifestPath of findManifests()) {
  const rel = manifestPath.slice(ROOT.length + 1);
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));

  for (const field of DEP_FIELDS) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      // Workspace protocol links are not version ranges.
      if (typeof range !== 'string' || range.startsWith('workspace:')) continue;

      if (range.startsWith('^') || range.startsWith('~')) {
        errors.push(
          `${rel} → ${field}.${name} = "${range}" — ranges are banned. ` +
            `Pin the exact version (M0-07).`,
        );
      }

      // D-205: match the standalone SDK's core and nominal RxJS types; Nest keeps its own pins.
      const desktopPins = { '@ag-ui/core': '1.0.1', rxjs: '7.8.1' };
      const required =
        rel === 'apps/desktop/package.json'
          ? (desktopPins[name] ?? LOAD_BEARING[name])
          : LOAD_BEARING[name];
      if (required !== undefined) {
        found.add(name);
        if (range !== required) {
          errors.push(
            `${rel} → ${field}.${name} = "${range}" but M0-07 requires exactly "${required}". ` +
              `This pin is load-bearing (PRD §2.5): the harness interface churns.`,
          );
        }
      }
      const forbidden = FORBIDDEN[name];
      if (forbidden !== undefined) {
        errors.push(`${rel} → ${field}.${name} is FORBIDDEN. ${forbidden}`);
      }
    }
  }
}

const missing = Object.keys(LOAD_BEARING).filter((n) => !found.has(n));
if (missing.length > 0) {
  errors.push(
    `M0-07 packages absent from the workspace: ${missing.join(', ')}. ` +
      `Each must be declared at its exact pinned version.`,
  );
}

if (errors.length > 0) {
  console.error('\n✗ Version pin check failed (M0-07):\n');
  for (const e of errors) console.error(`  • ${e}`);
  console.error('');
  process.exit(1);
}

console.log(
  `✓ M0-07: all ${Object.keys(LOAD_BEARING).length} load-bearing pins exact; no ranges found.`,
);
