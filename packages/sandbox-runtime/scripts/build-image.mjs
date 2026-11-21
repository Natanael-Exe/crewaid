#!/usr/bin/env node
/**
 * Put the sandbox image on Runtime (D-217), one of two ways:
 *
 *   RUNTIME_API_KEY=… pnpm --filter @crewaid/sandbox-runtime build-image v0.0.9
 *   RUNTIME_API_KEY=… pnpm --filter @crewaid/sandbox-runtime build-image v0.0.9 \
 *     --from ghcr.io/natanael-exe/crewaid-sandbox:0.0.9 --latest
 *
 * Without `--from`, Runtime builds infra/sandbox-image/Dockerfile on its own
 * builders, with the repo root as the context (the Dockerfile's context is
 * the repo root, and its .dockerignore applies). Nothing is built locally or
 * pushed anywhere. On an account without credit, Runtime's builder refuses
 * outbound requests after about sixty in one step (measured 2026-10-13), and
 * the image's apt step makes several hundred, so that build fails there.
 *
 * With `--from`, Runtime imports the image the release workflow already built
 * and smoke-tested on GHCR, which is the same Dockerfile at that tag. Runtime
 * pulls it with credentials stored once by
 * `runtime images registry set ghcr.io --username <user>` (a token that can
 * read packages, given on standard input). No RUN step runs, so the builder's
 * limit does not apply. GHCR tags drop the release's `v`.
 *
 * Either way each run is the next version of `crewaid-sandbox` on Runtime and
 * takes the given tag. `--latest` also moves `crewaid-sandbox:latest` to it,
 * which is what a deployment following releases names in
 * `SANDBOX_RUNTIME_IMAGE` (D-219); the release workflow passes it for the
 * newest release only.
 *
 * The start command is `crewaid-runtime-start`, which binds the home kept in
 * `/workspace` over `/home/bot` and then runs the entrypoint; the provider
 * switches a computer only to an image that starts with it. The ready check
 * is the bridge's port, so a create answers once the desktop is up. Runtime
 * runs it as the sandbox user, uid 1000, which is the image's `bot`, on create
 * and after a switch — the provider launches the desktop itself after
 * anything else.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Runtime } from 'withruntime';

const IMAGE_NAME = 'crewaid-sandbox';
const BRIDGE_PORT = 7070;
// The provider's RUNTIME_START_COMMAND; its tests read this file to keep the two equal.
const START_COMMAND = '/usr/local/bin/crewaid-runtime-start';
const USAGE =
  'usage: build-image.mjs <tag> [--from <registry image>] [--latest]\n' +
  '   e.g. build-image.mjs v0.0.9\n' +
  '        build-image.mjs v0.0.9 --from ghcr.io/natanael-exe/crewaid-sandbox:0.0.9 --latest';

const args = process.argv.slice(2);
const tag = args[0] ?? '';
const fromAt = args.indexOf('--from');
const from = fromAt === -1 ? null : (args[fromAt + 1] ?? '');
const latest = args.includes('--latest');
const extra = args.filter(
  (arg, i) => i !== 0 && i !== fromAt && i !== fromAt + 1 && arg !== '--latest',
);
if (
  !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(tag) ||
  tag === 'latest' ||
  from === '' ||
  extra.length > 0
) {
  console.error(USAGE);
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const runtime = new Runtime();
const started = Date.now();

const source =
  from === null
    ? {
        dockerfile: readFileSync(join(root, 'infra/sandbox-image/Dockerfile'), 'utf8'),
        contextDir: root,
      }
    : { image: from };

const image = await runtime.images.build(
  {
    name: IMAGE_NAME,
    tags: latest ? [tag, 'latest'] : [tag],
    ...source,
    // Runtime's default builder is 2 vCPU / 4 GiB, the most an account
    // without credit may use. A funded account can ask for a faster one with
    // RUNTIME_BUILD_VCPU / RUNTIME_BUILD_MEMORY_MIB; the hour covers the slow one.
    build: {
      ...builderSize(),
      timeoutSeconds: 3600,
    },
    start: {
      argv: [START_COMMAND],
      cwd: '/home/bot',
      readyPort: BRIDGE_PORT,
      readyTimeoutSeconds: 180,
    },
  },
  { onLog: (line) => process.stdout.write(`${line.text}\n`) },
);

function builderSize() {
  const vcpu = Number(process.env.RUNTIME_BUILD_VCPU ?? '');
  const memoryMiB = Number(process.env.RUNTIME_BUILD_MEMORY_MIB ?? '');
  return {
    ...(Number.isInteger(vcpu) && vcpu > 0 ? { vcpu } : {}),
    ...(Number.isInteger(memoryMiB) && memoryMiB > 0 ? { memoryMiB } : {}),
  };
}

const minutes = ((Date.now() - started) / 60_000).toFixed(1);
const how = from === null ? 'built from the Dockerfile' : `imported from ${from}`;
console.log(`\n${IMAGE_NAME}:${tag} (${image.id}) ${how} in ${minutes} min`);
console.log(
  latest
    ? `${IMAGE_NAME}:latest now names it; computers following it switch on their next start`
    : `SANDBOX_RUNTIME_IMAGE=${IMAGE_NAME}:${tag}`,
);
