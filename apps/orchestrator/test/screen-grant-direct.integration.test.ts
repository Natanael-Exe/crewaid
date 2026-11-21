import { computerId, privateComputerBot } from './computer-fixtures.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { SCREEN_GATEWAY_PORT } from '@crewaid/shared';
import {
  importScreenTicketPublicKey,
  verifyScreenTicket,
  type ScreenUpstreamOptions,
} from '@crewaid/screen-stream';

import { SeatService } from '../src/sandbox/seat.service.js';
import { FakeSeatService } from './sandbox-fakes.js';
import { StructuredLogger } from '../src/logging/structured-logger.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../src/sandbox/sandbox.provider.js';
import { ScreenTicketService } from '../src/screen/screen-ticket.service.js';
import { ScreenGrantService } from '../src/screen/screen-grant.service.js';
import { RFB_UPSTREAM_FACTORY } from '../src/screen/screen-upstream.port.js';

/**
 * D-223's direct grant: a provider that can expose a computer's port privately
 * gets its viewers sent to the computer's own screen gateway, and the gateway
 * is told the key that signs their tickets.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const USER_ID = 'usr_crewaid_singleton_v1';
const BOT_PREFIX = 'screendirect';

class DirectProvider {
  provisionWorkspace = () => Promise.resolve();
  attachSession = () => Promise.resolve(null);
  readonly accessed: Array<{ sessionId: string; port: number }> = [];
  /** When the provider's token stops admitting; set per case. */
  expiresAt = Date.now() + 120_000;
  screenAccess = (options: { sessionId: string; port: number }) => {
    this.accessed.push(options);
    return Promise.resolve({
      url: `wss://7071-${options.sessionId}.runtimehost.test/?runtime_preview_token=pt`,
      expiresAt: this.expiresAt,
    });
  };
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'direct screen grants (real db)',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let grants: ScreenGrantService;
    const provider = new DirectProvider();
    const seats = new FakeSeatService();

    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const moduleRef = await Test.createTestingModule({
        imports: [(await import('../src/screen/screen.module.js')).ScreenModule],
      })
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(provider as unknown as SandboxProvider)
        .overrideProvider(RFB_UPSTREAM_FACTORY)
        .useValue((_options: ScreenUpstreamOptions) => {
          throw new Error('a direct grant opens no connection here');
        })
        .overrideProvider(SeatService)
        .useValue(seats)
        .compile();
      app = moduleRef.createNestApplication();
      await app.init();
      prisma = app.get(PrismaService);
      grants = app.get(ScreenGrantService);
      await prisma.user.upsert({
        where: { id: USER_ID },
        create: { id: USER_ID, name: 'Test User', email: `${USER_ID}@test.invalid` },
        update: {},
      });
    });

    afterAll(async () => {
      await prisma?.bot
        .deleteMany({ where: { name: { startsWith: `${BOT_PREFIX}-` } } })
        .catch(() => undefined);
      await app?.close();
    });

    beforeEach(() => {
      provider.accessed.length = 0;
      seats.publishedKeys.length = 0;
      provider.expiresAt = Date.now() + 120_000;
    });

    const runningBot = async (state: 'RUNNING' | 'STOPPED' = 'RUNNING'): Promise<string> => {
      const bot = await privateComputerBot(prisma, provider, USER_ID, {
        name: `${BOT_PREFIX}-${randomUUID().slice(0, 8)}`,
        role: 'R',
        avatarColor: '#123456',
        systemPrompt: 'x',
      });
      await prisma.sandbox.update({
        where: { id: await computerId(prisma, bot.id) },
        data: { sessionId: `session-${bot.id}`, state },
      });
      return bot.id;
    };

    it('uses a relay-only ticket with an older gateway image', async () => {
      vi.spyOn(seats, 'publishScreenKey').mockResolvedValueOnce(false);
      const id = await runningBot();
      const grant = await grants.grant(id);
      expect(grant.endpoint.kind).toBe('orchestrator');
      expect(provider.accessed).toEqual([]);
      const publicKey = app.get(ScreenTicketService).publicKey;
      expect(verifyScreenTicket(grant.ticket, importScreenTicketPublicKey(publicKey)).ok).toBe(
        false,
      );
    });

    it('sends the viewer to the computer’s gateway, with the provider’s token kept', async () => {
      const id = await runningBot();
      const grant = await grants.grant(id);
      expect(grant.endpoint.kind).toBe('direct');
      const url = new URL(grant.endpoint.kind === 'direct' ? grant.endpoint.url : '');
      expect(url.protocol).toBe('wss:');
      expect(url.host).toBe(`7071-session-${id}.runtimehost.test`);
      expect(url.pathname).toBe('/v1/stream');
      expect(url.searchParams.get('runtime_preview_token')).toBe('pt');
      expect(provider.accessed).toEqual([
        { sessionId: `session-${id}`, port: SCREEN_GATEWAY_PORT },
      ]);
    });

    it('tells the gateway the key that verifies the ticket, and which computer it is', async () => {
      const id = await runningBot();
      const grant = await grants.grant(id);
      expect(seats.publishedKeys).toHaveLength(1);
      const published = seats.publishedKeys[0]!;
      expect(published.sessionId).toBe(`session-${id}`);
      expect(published.session).toBe(`session-${id}`);

      // What the gateway will do with them: the published key verifies the
      // ticket, and the ticket names this computer and the bot's seat.
      const verdict = verifyScreenTicket(
        grant.ticket,
        importScreenTicketPublicKey(published.publicKey),
      );
      expect(verdict.ok).toBe(true);
      if (!verdict.ok) return;
      expect(verdict.claims.session).toBe(published.session);
      expect(verdict.claims.botId).toBe(id);
    });

    it('logs how long the grant and each of its parts took', async () => {
      const id = await runningBot();
      const info = vi.spyOn(app.get(StructuredLogger), 'info');
      try {
        await grants.grant(id);
        const logged = info.mock.calls.find(([event]) => event === 'screen.grant');
        expect(logged?.[1]).toMatchObject({
          botId: id,
          endpoint: 'direct',
          totalMs: expect.any(Number),
          seatMs: expect.any(Number),
          keyMs: expect.any(Number),
          accessMs: expect.any(Number),
        });
      } finally {
        info.mockRestore();
      }
    });

    it('expires when the first of the ticket and the provider’s token does', async () => {
      const id = await runningBot();
      provider.expiresAt = Date.now() + 5_000;
      const grant = await grants.grant(id);
      expect(Date.parse(grant.expiresAt)).toBe(provider.expiresAt);
    });

    it('asks the provider for nothing when the computer is not running', async () => {
      const id = await runningBot('STOPPED');
      await expect(grants.grant(id)).rejects.toMatchObject({ status: 409 });
      // A preview visit wakes a paused machine; refusing first means none exists.
      expect(provider.accessed).toEqual([]);
      expect(seats.publishedKeys).toEqual([]);
    });
  },
);
