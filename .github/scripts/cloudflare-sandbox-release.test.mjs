import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  deploymentFingerprint,
  deploymentPlan,
  FINGERPRINT_VAR,
  parseJsonc,
  releaseConfig,
  validateTarget,
  verifyDeployment,
  verifyTarget,
  workerSettings,
  WRANGLER_VERSION,
} from './cloudflare-sandbox-release.mjs';

const accountId = 'a'.repeat(32);
const workerName = 'existing-computers';
const fingerprint = 'b'.repeat(64);
const settings = () => ({
  bindings: [
    {
      name: 'COMPUTER',
      type: 'durable_object_namespace',
      namespace_id: 'computer-namespace',
      class_name: 'Computer',
    },
    {
      name: 'REGISTRY',
      type: 'durable_object_namespace',
      namespace_id: 'registry-namespace',
      class_name: 'Registry',
    },
    {
      name: 'WORKSPACES',
      type: 'r2_bucket',
      bucket_name: 'saved-computer-workspaces',
      jurisdiction: 'eu',
    },
    { name: 'CONTROL_SECRET', type: 'secret_text' },
    { name: 'INSTANCE_VCPU', type: 'plain_text', text: '2' },
    { name: 'INSTANCE_MEMORY_MIB', type: 'plain_text', text: '8192' },
    { name: 'INSTANCE_DISK_MB', type: 'plain_text', text: '12000' },
  ],
});
function source(overrides = {}, mode = () => '100644') {
  const inputs = {
    'infra/sandbox-image/Dockerfile':
      'FROM debian:bookworm-slim\nCOPY apps/desktop/package.json /desktop.json\nCOPY packages/skill-runtime/src /src\nCOPY infra/sandbox-image/bridge.py /bridge.py\n',
    'apps/desktop/package.json': JSON.stringify({
      version: '0.0.6',
      devDependencies: { esbuild: '0.28.2' },
    }),
    'packages/skill-runtime/src/runner.ts': 'executor',
    'infra/sandbox-image/bridge.py': 'bridge',
    '.dockerignore': 'node_modules/',
    'infra/cloudflare/control-worker/worker.js': 'worker',
    'infra/cloudflare/control-worker/wrangler.jsonc': 'config',
    ...overrides,
  };
  return deploymentFingerprint(
    (path) => inputs[path],
    (path) => Object.keys(inputs).filter((p) => p === path || p.startsWith(path + '/')),
    mode,
  );
}
test('desktop version-only changes do not copy or redeploy an unchanged sandbox', () => {
  const desktop = JSON.stringify({ version: '0.0.7', devDependencies: { esbuild: '0.28.2' } });
  assert.equal(source(), source({ 'apps/desktop/package.json': desktop }));
  assert.equal(source(), source({ 'infra/cloudflare/control-worker/README.md': 'new docs' }));
});
test('copied file additions and executable permissions change the deployment fingerprint', () => {
  assert.notEqual(source(), source({ 'packages/skill-runtime/src/new.ts': 'new input' }));
  assert.notEqual(
    source(),
    source({}, (path) => (path.endsWith('bridge.py') ? '100755' : '100644')),
  );
});
test('changed executor, bridge, Worker, config, Docker ignore rules or esbuild redeploy', () => {
  for (const path of [
    'packages/skill-runtime/src/runner.ts',
    'infra/sandbox-image/bridge.py',
    'infra/cloudflare/control-worker/worker.js',
    'infra/cloudflare/control-worker/wrangler.jsonc',
    '.dockerignore',
  ])
    assert.notEqual(source(), source({ [path]: 'updated' }));
  assert.notEqual(
    source(),
    source({
      'apps/desktop/package.json': JSON.stringify({ devDependencies: { esbuild: '0.28.3' } }),
    }),
  );
});
test('unsupported Dockerfile inputs refuse instead of silently excluding a new image dependency', () => {
  for (const line of [
    'ADD https://example.test/script /script',
    'COPY *.py /scripts',
    'COPY missing /missing',
  ])
    assert.throws(() => source({ 'infra/sandbox-image/Dockerfile': line }));
});
test('a matching live deployment skips, but a failed previous release is retried', () => {
  const remote = settings();
  assert.equal(deploymentPlan(remote, fingerprint).deploy, true);
  remote.bindings.push({ name: FINGERPRINT_VAR, type: 'plain_text', text: fingerprint });
  assert.equal(deploymentPlan(remote, fingerprint).deploy, false);
  remote.bindings.at(-1).text = 'c'.repeat(64);
  assert.equal(deploymentPlan(remote, fingerprint).deploy, true);
});
test('refuses a downloads Worker, absent namespaces, workspace or control secret', () => {
  for (const name of ['COMPUTER', 'REGISTRY', 'WORKSPACES', 'CONTROL_SECRET']) {
    const remote = settings();
    remote.bindings = remote.bindings.filter((binding) => binding.name !== name);
    assert.throws(() => deploymentPlan(remote, fingerprint), /not the existing/);
  }
});
test('target validation refuses missing or injected account and Worker names', () => {
  for (const values of [
    [undefined, workerName],
    [accountId, undefined],
    ['not-account', workerName],
    [accountId, '../new-worker'],
  ])
    assert.throws(() => validateTarget(...values));
  validateTarget(accountId, workerName);
});

test('the parent Worker must reference the user-selected sandbox application', () => {
  const remote = settings();
  assert.throws(() => deploymentPlan(remote, fingerprint, 'different-application'));
  assert.equal(deploymentPlan(remote, fingerprint, 'computer-namespace').deploy, true);
});
test('a namespace with an unexpected class refuses before deployment', () => {
  const remote = settings();
  remote.bindings[0].class_name = 'DifferentComputer';
  assert.throws(() => deploymentPlan(remote, fingerprint));
});
test('Worker lookup uses the exact account and name, and never creates a missing target', async () => {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return new Response('{}', { status: 404 });
  };
  await assert.rejects(
    workerSettings({ accountId, workerName, token: 'private-token', fetchFn }),
    /HTTP 404/,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/settings`,
  );
  assert.equal(calls[0].options.method, undefined);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer private-token');
  for (const status of [401, 403, 500])
    await assert.rejects(
      workerSettings({
        accountId,
        workerName,
        token: 'private-token',
        fetchFn: async () => new Response('private provider error', { status }),
      }),
      (error) => !error.message.includes('private') && error.message.includes(`HTTP ${status}`),
    );
});
test('missing credentials or malformed Cloudflare responses refuse before deployment', async () => {
  await assert.rejects(workerSettings({ accountId, workerName }), /CLOUDFLARE_API_TOKEN/);
  await assert.rejects(
    workerSettings({
      accountId,
      workerName,
      token: 'test',
      fetchFn: async () => Response.json({ success: true, result: {} }),
    }),
    /invalid Worker/,
  );
});
test('generated config retains the selected Worker, namespace classes, workspace, secret and sizing', () => {
  const text = readFileSync(
    new URL('../../infra/cloudflare/control-worker/wrangler.jsonc', import.meta.url),
    'utf8',
  );
  const base = parseJsonc(text);
  const remote = settings();
  remote.bindings.push({
    name: 'crewaid_workspaces',
    type: 'r2_bucket',
    bucket_name: 'saved-computer-workspaces',
  });
  const plan = deploymentPlan(remote, fingerprint);
  const sourceImage = `ghcr.io/natanael-exe/crewaid-sandbox@sha256:${'d'.repeat(64)}`;
  const config = releaseConfig(base, plan, {
    accountId,
    workerName,
    sourceImage,
    directory: '/tmp/release',
  });
  assert.equal(config.name, workerName);
  assert.equal(config.account_id, accountId);
  assert.deepEqual(config.durable_objects, base.durable_objects);
  assert.deepEqual(config.migrations, base.migrations);
  assert.equal(config.containers[0].scheduling_policy, 'durable_object');
  assert.equal(config.r2_buckets[0].bucket_name, 'saved-computer-workspaces');
  assert.equal(config.r2_buckets[0].jurisdiction, 'eu');
  assert.equal(config.r2_buckets[1].binding, 'crewaid_workspaces');
  assert.equal(config.vars.INSTANCE_VCPU, '2');
  assert.equal(config.vars.INSTANCE_MEMORY_MIB, '8192');
  assert.equal(config.vars[FINGERPRINT_VAR], fingerprint);
  assert.equal(config.keep_vars, true);
  assert.equal(config.vars.CONTROL_SECRET, undefined);
  assert.throws(
    () =>
      releaseConfig(base, plan, {
        accountId,
        workerName,
        sourceImage: 'ghcr.io/image:latest',
        directory: '/tmp',
      }),
    /immutable/,
  );
});
test('verification refuses changed namespaces, workspace bucket, resources or missing marker', () => {
  const initial = settings();
  const plan = deploymentPlan(initial, fingerprint);
  verifyTarget(initial, plan);
  assert.throws(() => verifyDeployment(initial, plan));
  initial.bindings.push({ name: FINGERPRINT_VAR, type: 'plain_text', text: fingerprint });
  verifyDeployment(initial, plan);
  for (const [name, key, value] of [
    ['COMPUTER', 'namespace_id', 'new'],
    ['REGISTRY', 'namespace_id', 'new'],
    ['WORKSPACES', 'bucket_name', 'new'],
    ['WORKSPACES', 'jurisdiction', 'different'],
    ['INSTANCE_VCPU', 'text', '4'],
  ]) {
    const remote = structuredClone(initial);
    remote.bindings.find((b) => b.name === name)[key] = value;
    assert.throws(() => verifyDeployment(remote, plan));
    assert.throws(() => verifyTarget(remote, plan));
  }
});
test('release workflow pins Wrangler, uses the successful sandbox artifact and serializes deployments', () => {
  const workflow = readFileSync(
    new URL('../workflows/release-images.yml', import.meta.url),
    'utf8',
  );
  const job = workflow.slice(workflow.indexOf('  cloudflare-sandbox:'));
  assert.ok(job.includes(`wrangler@${WRANGLER_VERSION} deploy`));
  assert.ok(job.includes('name: digest-sandbox-amd64'));
  assert.ok(job.includes('needs: build'));
  assert.ok(job.includes('group: cloudflare-sandbox-production'));
  assert.ok(job.includes('cancel-in-progress: false'));
  assert.ok(job.includes('--keep-vars'));
  assert.ok(job.includes('cloudflare-sandbox-release.mjs verify'));
  assert.ok(job.includes('git fetch origin --tags --force'));
});
