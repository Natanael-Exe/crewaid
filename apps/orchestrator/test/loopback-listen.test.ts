import { createServer, type AddressInfo, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `loopback-listen.setup.ts`: a suite's ephemeral server binds the address
 * supertest connects to, so a port another program holds there is refused
 * rather than silently shared.
 */
const open: Server[] = [];
const listening = (server: Server, ...args: unknown[]) =>
  new Promise<Server>((resolve, reject) => {
    open.push(server);
    server.once('error', reject);
    (server.listen as (...a: unknown[]) => Server)(...args, () => resolve(server));
  });

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined)))));
});

describe('a suite’s ephemeral server', () => {
  it('binds 127.0.0.1 when it asks for any port and names no host', async () => {
    const server = await listening(createServer(), 0);
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('is bound when listen returns, as supertest reads the port at once', () => {
    const server = createServer();
    open.push(server);
    server.listen(0);
    expect(server.address()).toMatchObject({ address: '127.0.0.1', port: expect.any(Number) });
  });

  it('keeps a host or port the caller names', async () => {
    const server = await listening(createServer(), 0, '0.0.0.0');
    expect((server.address() as AddressInfo).address).toBe('0.0.0.0');
  });

  it('is refused a port another program already holds on 127.0.0.1', async () => {
    const foreign = await listening(createServer(), 0, '127.0.0.1');
    const { port } = foreign.address() as AddressInfo;
    await expect(listening(createServer(), port, '127.0.0.1')).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
  });
});
