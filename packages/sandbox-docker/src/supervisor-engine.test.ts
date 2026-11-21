import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockerSandboxProvider } from './docker-sandbox-provider.js';

import { readSupervisorOptions } from './supervisor-engine.js';
import { NonceCache, signRequest, verifyRequest } from './supervisor-protocol.js';

const SECRET = 'f'.repeat(64);
afterEach(() => vi.unstubAllEnvs());

describe('D-200 the orchestrator needs a supervisor to reach Docker', () => {
  it('fails provider construction immediately when its supervisor settings are missing', () => {
    vi.stubEnv('SANDBOX_SUPERVISOR_URL', '');
    vi.stubEnv('SANDBOX_SUPERVISOR_SECRET', SECRET);
    expect(() => new DockerSandboxProvider()).toThrow('SANDBOX_SUPERVISOR_URL is required');
    vi.stubEnv('SANDBOX_SUPERVISOR_URL', 'http://127.0.0.1:7300');
    vi.stubEnv('SANDBOX_SUPERVISOR_SECRET', '');
    expect(() => new DockerSandboxProvider()).toThrow('at least 32');
  });
  it('reads the URL and secret, and refuses to start without them', () => {
    expect(
      readSupervisorOptions({
        SANDBOX_SUPERVISOR_URL: 'http://sandbox-supervisor:7300/',
        SANDBOX_SUPERVISOR_SECRET: SECRET,
      }),
    ).toEqual({ url: 'http://sandbox-supervisor:7300', secret: SECRET });
    expect(() => readSupervisorOptions({ SANDBOX_SUPERVISOR_SECRET: SECRET })).toThrow(
      'SANDBOX_SUPERVISOR_URL is required',
    );
    expect(() =>
      readSupervisorOptions({
        SANDBOX_SUPERVISOR_URL: 'unix:///var/run/docker.sock',
        SANDBOX_SUPERVISOR_SECRET: SECRET,
      }),
    ).toThrow('http://');
    expect(() =>
      readSupervisorOptions({
        SANDBOX_SUPERVISOR_URL: 'http://sandbox-supervisor:7300',
        SANDBOX_SUPERVISOR_SECRET: 'changeme',
      }),
    ).toThrow('at least 32');
  });
});

describe('D-200 a request signature', () => {
  const request = { method: 'POST', path: '/v1/containers/start', body: '{"id":"abc"}' };

  it('verifies once, under either accepted secret, and never twice', () => {
    const nonces = new NonceCache();
    const now = 1_000_000;
    const header = signRequest(SECRET, request, now);
    expect(verifyRequest(['0'.repeat(64), SECRET], request, header, nonces, now)).toEqual({
      ok: true,
    });
    expect(verifyRequest([SECRET], request, header, nonces, now + 1)).toEqual({
      ok: false,
      reason: 'replayed',
    });
  });

  it('binds the method, path and body', () => {
    const now = 1_000_000;
    const header = signRequest(SECRET, request, now);
    for (const changed of [
      { ...request, method: 'GET' },
      { ...request, path: '/v1/containers/remove' },
      { ...request, body: '{"id":"abd"}' },
    ]) {
      expect(verifyRequest([SECRET], changed, header, new NonceCache(), now)).toEqual({
        ok: false,
        reason: 'bad-signature',
      });
    }
  });

  it('refuses a request outside the window before checking anything else', () => {
    const header = signRequest(SECRET, request, 1_000_000);
    expect(verifyRequest([SECRET], request, header, new NonceCache(), 1_000_000 + 31_000)).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(verifyRequest([SECRET], request, 'garbage', new NonceCache(), 1_000_000)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});
