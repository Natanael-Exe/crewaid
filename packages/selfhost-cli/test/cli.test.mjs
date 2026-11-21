import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  addressPlan,
  installConflict,
  parseArgs,
  readiness,
  updateEnvironment,
} from '../src/cli.mjs';
import { parseEnv, renderEnv, setEnvValue } from '../src/env.mjs';
import { lanAddress, overlaps, pickSandboxSubnet } from '../src/network.mjs';
import { generateSecrets } from '../src/secrets.mjs';

test('secrets come in the formats the orchestrator reads', () => {
  const secrets = generateSecrets();
  assert.match(secrets.POSTGRES_PASSWORD, /^[0-9a-f]{48}$/);
  assert.match(secrets.REDIS_PASSWORD, /^[0-9a-f]{48}$/);
  assert.equal(Buffer.from(secrets.BETTER_AUTH_SECRET, 'base64').length, 32);
  assert.match(JSON.parse(secrets.CREWAID_CREDENTIAL_KEYRING)['1'], /^[0-9a-f]{64}$/);
  assert.match(secrets.CREDENTIAL_KEY, /^[0-9a-f]{64}$/);
  assert.match(secrets.SANDBOX_SUPERVISOR_SECRET, /^[0-9a-f]{64}$/);
  assert.notEqual(generateSecrets().POSTGRES_PASSWORD, secrets.POSTGRES_PASSWORD);
});

test('.env round-trips every value, the JSON keyring included', () => {
  const secrets = generateSecrets();
  const values = { CREWAID_VERSION: '0.1.0', BETTER_AUTH_URL: 'http://localhost:3000', ...secrets };
  assert.deepEqual(parseEnv(renderEnv(values)), values);
  assert.match(renderEnv(values), /^CREWAID_CREDENTIAL_KEYRING='\{"1":"[0-9a-f]{64}"\}'$/m);
});

test('update changes the version line and nothing else', () => {
  const before = renderEnv({
    CREWAID_VERSION: '0.1.0',
    REDIS_PASSWORD: 'abc',
    BETTER_AUTH_URL: 'http://x:3000',
  });
  const after = setEnvValue(before, 'CREWAID_VERSION', '0.2.0');
  assert.equal(parseEnv(after).CREWAID_VERSION, '0.2.0');
  assert.equal(after.replace('0.2.0', '0.1.0'), before);
});

test('upgrade adds the missing supervisor secret once and preserves operator keys', () => {
  const before = renderEnv({
    CREWAID_VERSION: '0.1.0',
    REDIS_PASSWORD: 'retained',
    BETTER_AUTH_URL: 'http://localhost:3000',
  });
  const upgraded = updateEnvironment(before, '0.2.0');
  const values = parseEnv(upgraded);
  assert.match(values.SANDBOX_SUPERVISOR_SECRET, /^[0-9a-f]{64}$/);
  assert.equal(values.REDIS_PASSWORD, 'retained');
  assert.equal(values.BETTER_AUTH_URL, 'http://localhost:3000');
  assert.equal(updateEnvironment(upgraded, '0.2.0'), upgraded);
  const next = parseEnv(updateEnvironment(upgraded, '0.3.0'));
  assert.equal(next.SANDBOX_SUPERVISOR_SECRET, values.SANDBOX_SUPERVISOR_SECRET);
  assert.equal(next.CREWAID_VERSION, '0.3.0');
});

test('each way of reaching the server gets its address, bind and profile', () => {
  assert.deepEqual(addressPlan({ mode: 'local', port: 3000 }), {
    BETTER_AUTH_URL: 'http://localhost:3000',
    CREWAID_BIND: '127.0.0.1',
    CREWAID_PORT: '3000',
  });
  assert.deepEqual(addressPlan({ mode: 'lan', port: 3100, lan: '192.168.1.20' }), {
    BETTER_AUTH_URL: 'http://192.168.1.20:3100',
    CREWAID_BIND: '0.0.0.0',
    CREWAID_PORT: '3100',
  });
  const domain = addressPlan({ mode: 'domain', port: 3000, domain: 'crew.example.com' });
  assert.equal(domain.BETTER_AUTH_URL, 'https://crew.example.com');
  // HTTPS terminates at Caddy; the orchestrator stays on loopback.
  assert.equal(domain.CREWAID_BIND, '127.0.0.1');
  assert.equal(domain.COMPOSE_PROFILES, 'https');
  assert.throws(() => addressPlan({ mode: 'domain', port: 3000 }), /--domain/);
  assert.throws(() => addressPlan({ mode: 'lan', port: 3000, lan: null }), /local network address/);
});

test('the computers’ network avoids every range Docker already uses', () => {
  assert.deepEqual(pickSandboxSubnet(['172.17.0.0/16', '192.168.0.0/20']), {
    subnet: '10.231.0.0/24',
    orchestrator: '10.231.0.2',
  });
  assert.deepEqual(pickSandboxSubnet(['10.231.0.0/24', '10.231.1.0/24']).subnet, '10.231.2.0/24');
  // A wide network covering 10.231.0.0/16 rules the whole range out.
  assert.throws(() => pickSandboxSubnet(['10.0.0.0/8']), /No free/);
  assert.equal(overlaps('10.231.0.0/24', '10.231.0.128/25'), true);
  assert.equal(overlaps('10.231.0.0/24', '10.231.1.0/24'), false);
});

test('the LAN address is the first non-internal IPv4', () => {
  assert.equal(
    lanAddress({
      lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      en0: [
        { family: 'IPv6', internal: false, address: 'fe80::1' },
        { family: 'IPv4', internal: false, address: '192.168.1.20' },
      ],
    }),
    '192.168.1.20',
  );
  assert.equal(
    lanAddress({ lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] }),
    null,
  );
});

test('flags parse with and without "=", and positionals are kept in order', () => {
  assert.deepEqual(parseArgs(['init', '--mode', 'lan', '--port=3100', '--yes']), {
    _: ['init'],
    mode: 'lan',
    port: '3100',
    yes: true,
  });
  assert.deepEqual(parseArgs(['reset-password', 'a@b.c', '--dir', '/srv/crewaid'])._, [
    'reset-password',
    'a@b.c',
  ]);
});

test('the bundled compose file is the repository’s, byte for byte', async () => {
  // The package ships its own copy so `npx` needs nothing else; this is what
  // stops it drifting from infra/selfhost/compose.yml.
  const bundled = await readFile(new URL('../assets/compose.yml', import.meta.url), 'utf8');
  const source = await readFile(
    new URL('../../../infra/selfhost/compose.yml', import.meta.url),
    'utf8',
  );
  assert.equal(bundled, source);
});

test('ready means status ok, not merely an answer', () => {
  const ok = { status: 'ok', db: true, redis: true, docker: true };
  assert.deepEqual(readiness(ok), { ready: true });
  // /health answers 200 with a database outage in the body.
  assert.deepEqual(readiness({ ...ok, status: 'down', db: false }), {
    ready: false,
    problem: 'the database not reachable',
  });
  assert.equal(
    readiness({ ...ok, status: 'degraded', redis: false }).problem,
    'Redis not reachable',
  );
  assert.equal(readiness(null).problem, 'the server is not answering');
});

test('a second install never takes over the first one', () => {
  assert.equal(installConflict({ dir: '/home/a/crewaid', folders: [], dataVolume: false }), null);
  // Its own folder re-running init is caught earlier, by the .env check.
  assert.equal(
    installConflict({ dir: '/home/a/crewaid', folders: ['/home/a/crewaid'], dataVolume: true }),
    null,
  );
  assert.match(
    installConflict({ dir: '/srv/crewaid', folders: ['/home/a/crewaid'], dataVolume: true }),
    /already runs from \/home\/a\/crewaid/,
  );
  // Containers gone, data left behind: encrypted with keys this install would not have.
  assert.match(
    installConflict({ dir: '/srv/crewaid', folders: [], dataVolume: true }),
    /crewaid_postgres-data/,
  );
});
