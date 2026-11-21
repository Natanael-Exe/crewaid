import { createServer, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';

import { checkRedis } from '../src/health/redis-health.js';

/**
 * A throwaway RESP-speaking server. The probe is a wire protocol, so the test
 * speaks that wire: what a fake in the same process would prove is that two
 * mocks agree, not that the client frames a PING correctly.
 */
async function fakeRedis(
  respond: (data: string) => string | null,
): Promise<{ url: string; received: string[]; close: () => Promise<void> }> {
  const received: string[] = [];
  const server = createServer((socket: Socket) => {
    socket.on('data', (chunk: Buffer) => {
      const data = chunk.toString('utf8');
      received.push(data);
      const reply = respond(data);
      if (reply !== null) socket.write(reply);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no test address');
  return {
    url: `redis://127.0.0.1:${address.port}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** A port that was just released, so connecting to it refuses instead of hanging. */
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

describe('checkRedis', () => {
  it('answers healthy only on a PONG, and frames the PING correctly', async () => {
    const redis = await fakeRedis((data) => (data.includes('PING') ? '+PONG\r\n' : null));
    try {
      await expect(checkRedis(redis.url)).resolves.toBe(true);
      expect(redis.received.join('')).toBe('*1\r\n$4\r\nPING\r\n');
    } finally {
      await redis.close();
    }
  });

  it('sends AUTH before PING when the URL carries credentials', async () => {
    let authenticated = false;
    const redis = await fakeRedis((data) => {
      // AUTH and PING may arrive as one pipelined chunk; answer each.
      let reply = '';
      if (data.includes('AUTH')) {
        authenticated = true;
        reply += '+OK\r\n';
      }
      if (data.includes('PING')) {
        reply += authenticated ? '+PONG\r\n' : '-NOAUTH Authentication required.\r\n';
      }
      return reply === '' ? null : reply;
    });
    try {
      await expect(
        checkRedis(`redis://:s3cret@127.0.0.1:${new URL(redis.url).port}`),
      ).resolves.toBe(true);
      expect(redis.received.join('')).toContain('*2\r\n$4\r\nAUTH\r\n$6\r\ns3cret\r\n');
      expect(redis.received.join('')).toMatch(/AUTH[\s\S]*PING/);
    } finally {
      await redis.close();
    }
  });

  it('is unhealthy when Redis refuses the command', async () => {
    const redis = await fakeRedis(() => '-NOAUTH Authentication required.\r\n');
    try {
      await expect(checkRedis(redis.url)).resolves.toBe(false);
    } finally {
      await redis.close();
    }
  });

  it('is unhealthy when the server never answers, inside the bound', async () => {
    const redis = await fakeRedis(() => null);
    const started = Date.now();
    try {
      await expect(checkRedis(redis.url, 150)).resolves.toBe(false);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await redis.close();
    }
  });

  it('answers false at the absolute deadline even when the peer keeps trickling bytes', async () => {
    // An inactivity timeout resets on every byte, so a peer trickling one
    // byte per window holds it open forever. Only an absolute deadline makes
    // the documented bound true — this test hangs without one.
    const server = createServer((socket: Socket) => {
      const trickle = setInterval(() => socket.write(':'), 25);
      socket.on('close', () => clearInterval(trickle));
      socket.on('data', () => {
        // Swallow the PING; the trickle above is the only output.
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no test address');
    const started = Date.now();
    try {
      await expect(checkRedis(`redis://127.0.0.1:${address.port}`, 150)).resolves.toBe(false);
      // Settled by the deadline, not by any reply: the probe held past the
      // trickling window and was cut off at the bound.
      expect(Date.now() - started).toBeGreaterThanOrEqual(100);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it('is unhealthy when nothing is listening', async () => {
    await expect(checkRedis(await closedPortUrl(), 500)).resolves.toBe(false);
  });

  it('is unhealthy for anything that is not a redis URL', async () => {
    for (const url of [undefined, '', '   ', 'not a url', 'http://127.0.0.1:6379', 'redis://']) {
      await expect(checkRedis(url, 150)).resolves.toBe(false);
    }
  });
});
