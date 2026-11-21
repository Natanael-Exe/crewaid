import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HEALTH_PROBE_TIMEOUT_MS,
  HealthService,
  withTimeout,
} from '../src/health/health.service.js';

/**
 * The status ladder and the probe-failure behaviour, driven with fakes.
 *
 * The live-stack suite proves the wiring against real Postgres/Redis/Docker;
 * THIS suite proves the decisions those probes feed are right — which is
 * impossible to arrange against live services (turning off the real database
 * is not a test case, it is an outage).
 */

async function fakeRedis(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((socket) => {
    socket.on('data', () => socket.write('+PONG\r\n'));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no test address');
  return {
    url: `redis://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no test address');
  const port = address.port;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return `redis://127.0.0.1:${port}`;
}

function buildService(
  options: {
    db?: Promise<unknown>;
    docker?: Promise<unknown>;
    sandboxes?: Promise<{ botId: string; state: string; healthy: boolean }[]>;
  } = {},
): {
  service: HealthService;
  provider: { listManagedSessions: ReturnType<typeof vi.fn> };
  sandboxes: { snapshot: ReturnType<typeof vi.fn> };
} {
  const prisma = { $queryRaw: vi.fn(() => options.db ?? Promise.resolve([{ '?column?': 1 }])) };
  const provider = {
    listManagedSessions: vi.fn(() => options.docker ?? Promise.resolve([])),
  };
  const sandboxes = { snapshot: vi.fn(() => options.sandboxes ?? Promise.resolve([])) };
  return {
    service: new HealthService(prisma as never, provider as never, sandboxes as never),
    provider,
    sandboxes,
  };
}

/** The signed-in caller whose bots `sandboxes` lists. */
const CALLER = 'usr_health_caller';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('HealthService.read', () => {
  it('lists the caller’s sandboxes only, and none — with no probe — for an anonymous read', async () => {
    const entries = [{ botId: 'bot-a', state: 'STOPPED', healthy: false }];
    const signedIn = buildService({ sandboxes: Promise.resolve(entries) });
    expect((await signedIn.service.read(CALLER)).sandboxes).toEqual(entries);
    expect(signedIn.sandboxes.snapshot).toHaveBeenCalledWith(CALLER);

    const anonymous = buildService({ sandboxes: Promise.resolve(entries) });
    expect((await anonymous.service.read(null)).sandboxes).toEqual([]);
    expect(anonymous.sandboxes.snapshot).not.toHaveBeenCalled();
  });

  it('reports ok, with every sandbox row, when all three dependencies answer', async () => {
    const redis = await fakeRedis();
    vi.stubEnv('REDIS_URL', redis.url);
    try {
      const entries = [{ botId: 'bot-a', state: 'STOPPED', healthy: false }];
      const { service } = buildService({ sandboxes: Promise.resolve(entries) });
      const health = await service.read(CALLER);
      expect(health).toMatchObject({ status: 'ok', db: true, redis: true, docker: true });
      expect(health.sandboxes).toEqual(entries);
    } finally {
      await redis.close();
    }
  });

  it('degrades when Redis refuses and keeps the rest of the answer intact', async () => {
    vi.stubEnv('REDIS_URL', await closedPortUrl());
    const { service } = buildService();
    await expect(service.read(CALLER)).resolves.toMatchObject({
      status: 'degraded',
      db: true,
      redis: false,
      docker: true,
    });
  });

  it('treats an unconfigured Redis as not available, never as healthy', async () => {
    vi.stubEnv('REDIS_URL', '');
    const { service } = buildService();
    await expect(service.read(CALLER)).resolves.toMatchObject({ status: 'degraded', redis: false });
  });

  it('degrades when Docker is unreachable and does not let the rejection escape', async () => {
    vi.stubEnv('REDIS_URL', '');
    const { service, provider } = buildService({
      docker: Promise.reject(new Error('connect ENOENT /var/run/docker.sock')),
    });
    await expect(service.read(CALLER)).resolves.toMatchObject({
      status: 'degraded',
      docker: false,
    });
    expect(provider.listManagedSessions).toHaveBeenCalledOnce();
  });

  it('reports down when Postgres is unreachable, whatever the others say', async () => {
    const redis = await fakeRedis();
    vi.stubEnv('REDIS_URL', redis.url);
    try {
      const { service } = buildService({ db: Promise.reject(new Error('db down')) });
      await expect(service.read(CALLER)).resolves.toMatchObject({
        status: 'down',
        db: false,
        redis: true,
        docker: true,
      });
    } finally {
      await redis.close();
    }
  });

  it('degrades the sandbox list to empty when the database cannot answer it', async () => {
    vi.stubEnv('REDIS_URL', '');
    const { service } = buildService({ sandboxes: Promise.reject(new Error('db down')) });
    const health = await service.read(CALLER);
    expect(health.sandboxes).toEqual([]);
  });
});

describe('HealthService.read — the sandbox read is bounded like every other probe', () => {
  /**
   * The controlled shape that caught the unbounded snapshot: one arm hangs a
   * probe the read already bounded, the other hangs the sandbox read itself.
   * Both must settle `read()` at the bound anyway. The clock is controlled —
   * waiting out a real bound would measure the suite, not the bound.
   */
  const hung = (): Promise<never> => new Promise<never>(() => undefined);

  it('settles as down when the Postgres probe never answers (control)', async () => {
    vi.useFakeTimers();
    vi.stubEnv('REDIS_URL', '');
    try {
      const { service } = buildService({ db: hung() });
      let settled = false;
      const reading = service.read(CALLER).then((health) => {
        settled = true;
        return health;
      });
      // Still pending the instant before the bound…
      await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      // …and settled within it.
      await vi.advanceTimersByTimeAsync(1);
      await expect(reading).resolves.toMatchObject({
        status: 'down',
        db: false,
        docker: true,
        sandboxes: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles within the bound when the sandbox snapshot never resolves (treatment)', async () => {
    vi.useFakeTimers();
    vi.stubEnv('REDIS_URL', '');
    try {
      const { service } = buildService({ sandboxes: hung() });
      let settled = false;
      const reading = service.read(CALLER).then((health) => {
        settled = true;
        return health;
      });
      await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      // The route answered without the snapshot, the list degraded to empty,
      // and `status` is still exactly the db/redis/docker verdict — the
      // sandbox portion never moves it, not even when it blows the bound.
      await expect(reading).resolves.toMatchObject({
        status: 'degraded',
        db: true,
        redis: false,
        docker: true,
        sandboxes: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('withTimeout', () => {
  it('passes a fast result through untouched', async () => {
    await expect(withTimeout(Promise.resolve(7), 100)).resolves.toBe(7);
  });

  it('rejects a hung probe at the bound instead of holding the route open', async () => {
    const started = Date.now();
    await expect(withTimeout(new Promise<never>(() => undefined), 50)).rejects.toThrow(
      'timed out after 50ms',
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('clears its timer when the work finishes first, so nothing leaks per request', async () => {
    vi.useFakeTimers();
    try {
      await withTimeout(Promise.resolve('done'), 10_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says which release and edition this server is (D-155)', async () => {
    vi.stubEnv('REDIS_URL', '');
    vi.stubEnv('CREWAID_VERSION', '0.0.4');
    vi.stubEnv('CREWAID_EDITION', 'selfhosted');
    try {
      const { service } = buildService({});
      await expect(service.read(CALLER)).resolves.toMatchObject({
        version: '0.0.4',
        edition: 'selfhosted',
      });
      vi.stubEnv('CREWAID_VERSION', '');
      await expect(service.read(CALLER)).resolves.toMatchObject({ version: 'dev' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
