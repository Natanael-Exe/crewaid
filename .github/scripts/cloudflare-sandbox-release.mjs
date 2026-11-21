import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FINGERPRINT_VAR = 'CREWAID_SANDBOX_RELEASE_FINGERPRINT';
export const WRANGLER_VERSION = '4.149.0';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKER = 'infra/cloudflare/control-worker';

/** Hash image inputs, rather than release labels or the desktop version. */
export function deploymentFingerprint(read, files, mode = () => '100644') {
  const dockerfile = read('infra/sandbox-image/Dockerfile').toString();
  const inputs = new Set([
    'infra/sandbox-image/Dockerfile',
    '.dockerignore',
    `${WORKER}/worker.js`,
    `${WORKER}/wrangler.jsonc`,
  ]);
  const instructions = dockerfile.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  for (const line of instructions) {
    const match = /^\s*(COPY|ADD)\s+(.+)$/i.exec(line);
    if (match === null) continue;
    const body = match[2];
    if (/^--from=/.test(body)) continue;
    if (match[1].toUpperCase() === 'ADD' || /[[\]$*?]/.test(body) || body.startsWith('--'))
      throw new Error('Unsupported sandbox image input: extend the fingerprint parser.');
    for (const path of body.trim().split(/\s+/).slice(0, -1)) {
      if (path === 'apps/desktop/package.json') continue;
      const copied = files(path);
      if (copied.length === 0) throw new Error(`Missing sandbox input: ${path}`);
      for (const file of copied) inputs.add(file);
    }
  }
  const esbuild = JSON.parse(read('apps/desktop/package.json')).devDependencies.esbuild;
  if (!/^\d+\.\d+\.\d+$/.test(esbuild)) throw new Error('Expected an exact esbuild pin.');
  const hash = createHash('sha256').update(`wrangler=${WRANGLER_VERSION}\nesbuild=${esbuild}\n`);
  for (const path of [...inputs].filter((p) => !p.includes('/.wrangler/')).sort())
    hash.update(path).update('\0').update(mode(path)).update('\0').update(read(path)).update('\0');
  return hash.digest('hex');
}

export function validateTarget(accountId, workerName) {
  if (!/^[a-f0-9]{32}$/.test(accountId ?? '')) throw new Error('Set CLOUDFLARE_ACCOUNT_ID.');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerName ?? ''))
    throw new Error('Set CLOUDFLARE_SANDBOX_WORKER_NAME to the existing Worker name.');
}

/** A 404 is a refusal, never permission for Wrangler to create a Worker. */
export async function workerSettings({ accountId, workerName, token, fetchFn = fetch }) {
  validateTarget(accountId, workerName);
  if (!token) throw new Error('Set the CLOUDFLARE_API_TOKEN GitHub secret.');
  const response = await fetchFn(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/settings`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok)
    throw new Error(`Existing sandbox Worker lookup failed (HTTP ${response.status}).`);
  const body = await response.json();
  if (body.success !== true || !Array.isArray(body.result?.bindings))
    throw new Error('Cloudflare returned invalid Worker settings.');
  return body.result;
}

export function deploymentPlan(settings, fingerprint, applicationId) {
  const bindings = settings.bindings;
  const binding = (name, type) => bindings.find((b) => b.name === name && b.type === type);
  const computer = binding('COMPUTER', 'durable_object_namespace');
  const registry = binding('REGISTRY', 'durable_object_namespace');
  const workspace = binding('WORKSPACES', 'r2_bucket');
  if (
    !computer?.namespace_id ||
    computer.class_name !== 'Computer' ||
    !registry?.namespace_id ||
    registry.class_name !== 'Registry' ||
    !workspace?.bucket_name ||
    !binding('CONTROL_SECRET', 'secret_text')
  )
    throw new Error('The target is not the existing Crewaid sandbox Worker.');
  if (applicationId !== undefined && computer.namespace_id !== applicationId)
    throw new Error('The Worker is bound to a different sandbox application.');
  const vars = {};
  for (const name of ['INSTANCE_VCPU', 'INSTANCE_MEMORY_MIB', 'INSTANCE_DISK_MB']) {
    const entry = binding(name, 'plain_text');
    if (entry !== undefined) {
      if (!/^\d+$/.test(entry.text)) throw new Error(`Invalid existing ${name}.`);
      vars[name] = entry.text;
    }
  }
  return {
    deploy: binding(FINGERPRINT_VAR, 'plain_text')?.text !== fingerprint,
    fingerprint,
    namespaceIds: { COMPUTER: computer.namespace_id, REGISTRY: registry.namespace_id },
    bucketName: workspace.bucket_name,
    jurisdiction: workspace.jurisdiction,
    r2Buckets: bindings
      .filter((b) => b.type === 'r2_bucket')
      .map((b) => ({
        binding: b.name,
        bucket_name: b.bucket_name,
        ...(b.jurisdiction === undefined ? {} : { jurisdiction: b.jurisdiction }),
      })),
    vars,
  };
}

export function releaseConfig(base, plan, { accountId, workerName, sourceImage, directory }) {
  validateTarget(accountId, workerName);
  if (!/^ghcr\.io\/natanael-exe\/crewaid-sandbox@sha256:[a-f0-9]{64}$/.test(sourceImage))
    throw new Error('Expected the immutable release sandbox image.');
  if (
    base.containers.length !== 1 ||
    base.containers[0].class_name !== 'Computer' ||
    base.containers[0].scheduling_policy !== 'durable_object'
  )
    throw new Error('The existing sandbox scheduling contract changed.');
  return {
    ...base,
    name: workerName,
    account_id: accountId,
    main: resolve(ROOT, WORKER, base.main),
    keep_vars: true,
    vars: { ...base.vars, ...plan.vars, [FINGERPRINT_VAR]: plan.fingerprint },
    r2_buckets: plan.r2Buckets,
    containers: [
      {
        ...base.containers[0],
        images: {
          base: {
            dockerfile: resolve(directory, 'Dockerfile'),
            build_context: directory,
          },
        },
      },
    ],
  };
}

export function verifyTarget(settings, plan) {
  const actual = deploymentPlan(settings, plan.fingerprint);
  if (
    actual.bucketName !== plan.bucketName ||
    actual.jurisdiction !== plan.jurisdiction ||
    plan.r2Buckets.some(
      (b) =>
        !actual.r2Buckets.some(
          (a) =>
            a.binding === b.binding &&
            a.bucket_name === b.bucket_name &&
            a.jurisdiction === b.jurisdiction,
        ),
    ) ||
    Object.entries(plan.namespaceIds).some(([name, id]) => actual.namespaceIds[name] !== id) ||
    Object.entries(plan.vars).some(([name, value]) => actual.vars[name] !== value)
  )
    throw new Error('Cloudflare deployment did not retain the existing sandbox bindings.');
}

export function verifyDeployment(settings, plan) {
  verifyTarget(settings, plan);
  if (deploymentPlan(settings, plan.fingerprint).deploy)
    throw new Error('Cloudflare deployment did not record the release fingerprint.');
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
}
function fingerprint() {
  const tree = (path) =>
    git(['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', path])
      .toString()
      .split('\0')
      .filter(Boolean);
  return deploymentFingerprint(
    (path) => git(['show', `HEAD:${path}`]),
    tree,
    (path) => git(['ls-tree', 'HEAD', '--', path]).toString().split(' ')[0],
  );
}
export function parseJsonc(text) {
  // Wrangler's checked-in JSONC uses full-line comments and Prettier trailing commas.
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
}
function target() {
  return {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    workerName: process.env.CLOUDFLARE_SANDBOX_WORKER_NAME,
    token: process.env.CLOUDFLARE_API_TOKEN,
    applicationId: process.env.CLOUDFLARE_SANDBOX_APPLICATION_ID,
  };
}
function output(values) {
  if (process.env.GITHUB_OUTPUT)
    for (const [key, value] of Object.entries(values))
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(JSON.stringify(values));
}

async function main(command) {
  const directory = resolve(ROOT, WORKER, '.wrangler/release');
  const statePath = resolve(directory, 'state.json');
  if (command === 'fingerprint') return output({ fingerprint: fingerprint() });
  if (command === 'plan') {
    if (!/^[a-f0-9]{32}$/.test(target().applicationId ?? ''))
      throw new Error('Set CLOUDFLARE_SANDBOX_APPLICATION_ID to the existing sandbox ID.');
    const plan = deploymentPlan(
      await workerSettings(target()),
      fingerprint(),
      target().applicationId,
    );
    plan.accountId = target().accountId;
    plan.workerName = target().workerName;
    plan.applicationId = target().applicationId;
    mkdirSync(directory, { recursive: true });
    writeFileSync(statePath, JSON.stringify(plan), { mode: 0o600 });
    output({ deploy: plan.deploy, fingerprint: plan.fingerprint });
    return;
  }
  const plan = JSON.parse(readFileSync(statePath, 'utf8'));
  if (
    plan.accountId !== target().accountId ||
    plan.workerName !== target().workerName ||
    plan.applicationId !== target().applicationId
  )
    throw new Error('The deployment target changed after the existing Worker was verified.');
  if (command === 'prepare') {
    const [digest, ...extra] = readdirSync(process.env.SANDBOX_DIGEST_DIR);
    if (extra.length !== 0 || !/^[a-f0-9]{64}$/.test(digest ?? ''))
      throw new Error('Expected exactly one successful AMD64 sandbox build digest.');
    const sourceImage = `ghcr.io/natanael-exe/crewaid-sandbox@sha256:${digest}`;
    const config = releaseConfig(
      parseJsonc(readFileSync(resolve(ROOT, WORKER, 'wrangler.jsonc'), 'utf8')),
      plan,
      { ...target(), sourceImage, directory },
    );
    writeFileSync(resolve(directory, 'Dockerfile'), `FROM ${sourceImage}\n`);
    const configPath = resolve(directory, 'wrangler.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    output({ config: configPath, sourceImage });
    return;
  }
  if (command === 'verify') {
    verifyDeployment(await workerSettings(target()), plan);
    console.log('Existing Worker updated; workspace and Durable Object bindings retained.');
    return;
  }
  if (command === 'check') {
    verifyTarget(await workerSettings(target()), plan);
    console.log('Existing deployment target rechecked before updating.');
    return;
  }
  throw new Error('Usage: cloudflare-sandbox-release.mjs fingerprint|plan|prepare|check|verify');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main(process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
