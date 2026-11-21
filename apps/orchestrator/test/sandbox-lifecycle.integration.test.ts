import { computerId, privateComputerBot } from './computer-fixtures.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';

import { BotsService } from '../src/bots/bots.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { SandboxWorkspaceService } from '../src/sandbox/sandbox-workspace.service.js';
import { SandboxService } from '../src/sandbox/sandbox.service.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { FakeProvider } from './sandbox-fakes.js';

/**
 * M2-BE-04 — idempotent start/stop and the concurrent-start lock.
 *
 * These run against a REAL database and a fake provider, which is the split
 * that matters: the lock is `updateMany`'s row count under Postgres'
 * concurrency semantics, so a mocked Prisma would be testing the mock. Docker
 * is the part that adds nothing here — whether exactly one container appears
 * is decided entirely by how many callers get past the compare-and-swap, and
 * counting `createSession` calls measures that directly and in milliseconds.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const USER_ID = 'usr_crewaid_singleton_v1';
const OTHER_USER_ID = 'usr_m2be04_other';

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M2-BE-04 sandbox lifecycle (real db)',
  () => {
    let app: INestApplication;
    let bots: BotsService;
    let prisma: PrismaService;
    let sandboxes: SandboxService;
    let provider: FakeProvider;
    let botId: string;

    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      provider = new FakeProvider();
      const moduleRef = await Test.createTestingModule({
        imports: [
          (await import('../src/sandbox/sandbox.module.js')).SandboxModule,
          // SandboxModule no longer pulls in the whole of bots (M5-BE-14 moved
          // TurnEventBus out to break the cycle), so a suite that reaches for
          // BotsService imports it itself.
          (await import('../src/bots/bots.module.js')).BotsModule,
        ],
      })
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(provider)
        .compile();

      app = moduleRef.createNestApplication();
      await app.init();
      bots = app.get(BotsService);
      prisma = app.get(PrismaService);
      sandboxes = app.get(SandboxService);
      await prisma.user.upsert({
        where: { id: USER_ID },
        create: { id: USER_ID, name: 'Test User', email: `${USER_ID}@test.invalid` },
        update: {},
      });
    });

    afterAll(async () => {
      // OTHER_USER_ID exists only to exercise the cross-principal 404. Remove
      // it, and its cascade, because a suite should not leave rows behind —
      // not because a second User is illegal any more. `pnpm db:seed` used to
      // fail the build on the count, and that is how CI caught this leak;
      // V1-08 retired the check, so from here the cleanup stands on its own.
      await prisma?.user.deleteMany({ where: { id: OTHER_USER_ID } }).catch(() => undefined);
      await app?.close();
    });

    beforeEach(async () => {
      const bot = await privateComputerBot(prisma, provider, USER_ID, {
        name: `m2be04-${randomUUID().slice(0, 8)}`,
        role: 'R',
        avatarColor: '#123456',
        systemPrompt: 'x',
      });
      botId = bot.id;
      provider.reset();
    });

    describe('the concurrent-start lock', () => {
      it('destroys the runtime before deleting rows and preserves rows on failure', async () => {
        await sandboxes.start(USER_ID, botId);
        provider.failDestroyWith = new Error('daemon unavailable');
        await expect(bots.remove(USER_ID, botId)).rejects.toThrow('daemon unavailable');
        expect(await prisma.bot.findUnique({ where: { id: botId } })).not.toBeNull();
        expect(
          await prisma.sandbox.findFirst({ where: { bots: { some: { id: botId } } } }),
        ).not.toBeNull();
        provider.failDestroyWith = null;
        await bots.remove(USER_ID, botId);
        expect(provider.destroyCalls).toBe(2);
        expect(await prisma.bot.findUnique({ where: { id: botId } })).toBeNull();
        expect(
          await prisma.sandbox.findFirst({ where: { bots: { some: { id: botId } } } }),
        ).toBeNull();
      });

      it('refuses deletion during an active start and succeeds after it settles', async () => {
        provider.createDelayMs = 200;
        const starting = sandboxes.start(USER_ID, botId);
        while (provider.createCalls === 0) await new Promise((resolve) => setTimeout(resolve, 5));
        await expect(bots.remove(USER_ID, botId)).rejects.toThrow('lifecycle is in progress');
        expect(provider.destroyCalls).toBe(0);
        await starting;
        await bots.remove(USER_ID, botId);
        expect(provider.destroyCalls).toBe(1);
      });

      it('fences a concurrent start until runtime destruction and deletion commit', async () => {
        await sandboxes.start(USER_ID, botId);
        await sandboxes.stop(USER_ID, botId);
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        provider.onDestroy = () => held;
        const deleting = bots.remove(USER_ID, botId);
        while (provider.destroyCalls === 0) await new Promise((resolve) => setTimeout(resolve, 5));
        const starting = sandboxes.start(USER_ID, botId).then(
          () => 'started',
          () => 'refused',
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(provider.createCalls).toBe(1);
        release();
        await deleting;
        expect(await starting).toBe('refused');
        expect(provider.createCalls).toBe(1);
      });
      it('produces exactly one container for five simultaneous starts', async () => {
        // §5's acceptance criterion, and M2-QA-02's five callers. The delay
        // widens the window the lock has to cover; without a lock every caller
        // would find the row STOPPED and create its own desktop.
        provider.createDelayMs = 150;

        const results = await Promise.all(
          Array.from({ length: 5 }, () => sandboxes.start(USER_ID, botId)),
        );

        expect(provider.createCalls).toBe(1);
        // Every caller gets the same answer, not just the winner.
        expect(results.every((r) => r.state === 'RUNNING')).toBe(true);
        expect(new Set(results.map((r) => r.botId)).size).toBe(1);
      });

      it('keeps the lock per bot, so one bot starting does not block another', async () => {
        const other = await privateComputerBot(prisma, provider, USER_ID, {
          name: `m2be04-other-${randomUUID().slice(0, 8)}`,
          role: 'R',
          avatarColor: '#123456',
          systemPrompt: 'x',
        });
        provider.createDelayMs = 100;

        await Promise.all([sandboxes.start(USER_ID, botId), sandboxes.start(USER_ID, other.id)]);

        expect(provider.createCalls).toBe(2);
      });

      it('reclaims a lock whose holder died, instead of wedging the bot forever', async () => {
        // A crashed starter leaves STARTING set. Without a lease the bot can
        // never be started again for the life of the database row.
        await sandboxes.start(USER_ID, botId);
        await prisma.sandbox.update({
          where: { id: await computerId(prisma, botId) },
          data: {
            state: 'STARTING',
            lastStartedAt: new Date(Date.now() - 10 * 60_000),
            lastActiveAt: new Date(Date.now() - 10 * 60_000),
          },
        });
        provider.createCalls = 0;

        const status = await sandboxes.start(USER_ID, botId);

        expect(status.state).toBe('RUNNING');
        expect(provider.resumeCalls + provider.createCalls).toBe(1);
      });

      it('does not steal a lock that is merely slow', async () => {
        // Reclaiming an in-flight start is how the second container appears.
        await prisma.sandbox.update({
          where: { id: await computerId(prisma, botId) },
          data: { state: 'STARTING', lastStartedAt: new Date() },
        });

        const following = sandboxes.start(USER_ID, botId);
        await expect(
          Promise.race([
            following,
            new Promise((resolve) => setTimeout(() => resolve('still waiting'), 300)),
          ]),
        ).resolves.toBe('still waiting');
        expect(provider.createCalls).toBe(0);
        await prisma.sandbox.update({
          where: { id: await computerId(prisma, botId) },
          data: { state: 'RUNNING' },
        });
        await following;
      });
    });

    describe('idempotence (§4.1)', () => {
      it('start on a RUNNING sandbox returns its status without touching Docker', async () => {
        await sandboxes.start(USER_ID, botId);
        provider.createCalls = 0;
        provider.resumeCalls = 0;

        const status = await sandboxes.start(USER_ID, botId);

        expect(status.state).toBe('RUNNING');
        expect(provider.createCalls + provider.resumeCalls).toBe(0);
      });

      it('stop on a STOPPED sandbox is a no-op, not an error', async () => {
        const status = await sandboxes.stop(USER_ID, botId);
        expect(status.state).toBe('STOPPED');
        expect(provider.attachCalls).toBe(0);
      });

      it('stop twice settles STOPPED both times', async () => {
        await sandboxes.start(USER_ID, botId);
        await expect(sandboxes.stop(USER_ID, botId)).resolves.toMatchObject({ state: 'STOPPED' });
        await expect(sandboxes.stop(USER_ID, botId)).resolves.toMatchObject({ state: 'STOPPED' });
        expect(provider.stopCalls).toBe(1);
      });

      it('start after stop resumes the same session rather than creating a second', async () => {
        await sandboxes.start(USER_ID, botId);
        await sandboxes.stop(USER_ID, botId);
        provider.createCalls = 0;

        await sandboxes.start(USER_ID, botId);

        expect(provider.resumeCalls).toBe(1);
        expect(provider.createCalls).toBe(0);
      });
    });

    describe('stopping a sandbox that is not healthy', () => {
      it('attaches rather than resuming, so an UNHEALTHY sandbox can still be stopped', async () => {
        // D-028 makes resumeSession wait for the bridge. Routing stop through
        // it would mean an unhealthy desktop has to become healthy before it
        // can be shut down — a deadlock dressed as a timeout, and unhealthy is
        // exactly when an operator reaches for stop.
        await sandboxes.start(USER_ID, botId);
        await prisma.sandbox.update({
          where: { id: await computerId(prisma, botId) },
          data: { state: 'UNHEALTHY' },
        });
        provider.resumeCalls = 0;
        provider.attachCalls = 0;

        const status = await sandboxes.stop(USER_ID, botId);

        expect(status.state).toBe('STOPPED');
        expect(provider.attachCalls).toBe(1);
        expect(provider.resumeCalls).toBe(0);
      });

      it('still records STOPPED when the container is already gone', async () => {
        // `docker rm` behind our back must not leave the row stuck RUNNING.
        await sandboxes.start(USER_ID, botId);
        provider.attachReturnsNull = true;

        await expect(sandboxes.stop(USER_ID, botId)).resolves.toMatchObject({ state: 'STOPPED' });
      });
    });

    describe('resume and its fallback (§5)', () => {
      it('falls back to createSession when the stored container is gone', async () => {
        // The normal path after `docker rm` or a host reboot with restart: no.
        // A stored id whose container vanished must still produce a desktop.
        await sandboxes.start(USER_ID, botId);
        await sandboxes.stop(USER_ID, botId);
        provider.failResumeWith = new Error('no container carries crewaid.sessionId=...');
        provider.existing = false;
        provider.createCalls = 0;

        const status = await sandboxes.start(USER_ID, botId);

        expect(status.state).toBe('RUNNING');
        expect(provider.createCalls).toBe(1);
      });

      it('persists the session id and the published ports', async () => {
        await sandboxes.start(USER_ID, botId);

        const row = await prisma.sandbox.findFirstOrThrow({
          where: { bots: { some: { id: botId } } },
        });
        expect(row.sessionId).toBe(botId);
        expect(row.containerId).toBe(`container-${botId}`);
        expect(row).toMatchObject({ widthPx: 1024, heightPx: 768 });
        expect(row).toMatchObject({ vncPort: 32768, cdpPort: 32769, bridgePort: 32770 });
      });
    });

    describe('overlapping lifecycle requests', () => {
      it('stop waits for an initial start and leaves the sandbox stopped', async () => {
        provider.createDelayMs = 150;
        const starting = sandboxes.start(USER_ID, botId);
        await viWaitFor(() => provider.createCalls === 1);
        const stopped = sandboxes.stop(USER_ID, botId);
        await starting;
        await expect(stopped).resolves.toMatchObject({ state: 'STOPPED' });
        expect(provider.stopCalls).toBe(1);
        expect(await sandboxes.status(USER_ID, botId)).toMatchObject({ state: 'STOPPED' });
      });

      it('a start arriving during stop waits then resumes the sandbox', async () => {
        await sandboxes.start(USER_ID, botId);
        provider.stopDelayMs = 150;
        const stopping = sandboxes.stop(USER_ID, botId);
        await viWaitFor(() => provider.stopCalls === 1);
        const starting = sandboxes.start(USER_ID, botId);
        await stopping;
        await expect(starting).resolves.toMatchObject({ state: 'RUNNING' });
        expect(provider.resumeCalls).toBe(1);
        expect(await sandboxes.status(USER_ID, botId)).toMatchObject({ state: 'RUNNING' });
      });

      it('recovers a container created before its session id was persisted', async () => {
        provider.existing = true;
        await prisma.sandbox.update({
          where: { id: await computerId(prisma, botId) },
          data: {
            state: 'STARTING',
            lastStartedAt: new Date(0),
          },
        });
        await expect(sandboxes.start(USER_ID, botId)).resolves.toMatchObject({ state: 'RUNNING' });
        expect(provider.createCalls).toBe(0);
        expect(provider.resumeCalls).toBe(1);
      });

      it('stop reclaims an abandoned lease even before session persistence', async () => {
        provider.existing = true;
        await prisma.sandbox.update({
          where: { id: await computerId(prisma, botId) },
          data: {
            state: 'STARTING',
            lastStartedAt: new Date(0),
          },
        });
        await expect(sandboxes.stop(USER_ID, botId)).resolves.toMatchObject({ state: 'STOPPED' });
        expect(provider.stopCalls).toBe(1);
      });

      it.each([false, true])(
        'an expired holder cannot overwrite its successor (failure=%s)',
        async (fail) => {
          provider.createDelayMs = 150;
          if (fail) provider.failCreateWith = new Error('old holder failed');
          const starting = sandboxes.start(USER_ID, botId);
          const rejected = expect(starting).rejects.toThrow(
            fail ? 'old holder failed' : 'lease expired',
          );
          await viWaitFor(() => provider.createCalls === 1);
          await prisma.sandbox.update({
            where: { id: await computerId(prisma, botId) },
            data: {
              state: 'STOPPED',
              lastStartedAt: new Date(Date.now() + 1000),
              lastError: null,
            },
          });
          await rejected;
          expect(await sandboxes.status(USER_ID, botId)).toMatchObject({
            state: 'STOPPED',
            lastError: null,
          });
        },
      );

      it('does not try to create over an existing unhealthy container', async () => {
        await sandboxes.start(USER_ID, botId);
        await sandboxes.stop(USER_ID, botId);
        provider.failResumeWith = new Error('bridge is unhealthy');
        provider.createCalls = 0;
        await expect(sandboxes.start(USER_ID, botId)).rejects.toThrow('bridge is unhealthy');
        expect(provider.createCalls).toBe(0);
      });
    });

    describe('Runtime allocation and failure recovery', () => {
      it('attaches concurrent bots without allocating and creates one computer on admitted start', async () => {
        const userId = randomUUID();
        await prisma.user.create({
          data: { id: userId, name: 'Compute test', email: `${userId}@test.invalid` },
        });
        provider.workspaceOnFirstStart = true;
        try {
          const input = { name: 'Bot', role: 'R', avatarColor: '#123456', systemPrompt: 'test' };
          const [a, b] = await Promise.all([
            bots.create(userId, input),
            bots.create(userId, input),
          ]);
          const machine = await computerId(prisma, a.id);
          expect(await computerId(prisma, b.id)).toBe(machine);
          expect(provider.provisionCalls).toBe(0);
          const denied = new SandboxService(
            prisma,
            provider,
            app.get(TurnEventBus),
            app.get(SandboxWorkspaceService),
            {
              admit: () => Promise.reject(new Error('subscription required')),
              idleStops: () => Promise.resolve(true),
              covers: () => Promise.resolve(false),
              record: () => Promise.resolve({ stop: true }),
            },
          );
          await expect(denied.start(userId, a.id)).rejects.toThrow('subscription required');
          expect(provider.createCalls).toBe(0);
          expect(await prisma.sandbox.findUnique({ where: { id: machine } })).toMatchObject({
            workspacePending: true,
            state: 'STOPPED',
          });
          await Promise.all([sandboxes.start(userId, a.id), sandboxes.start(userId, b.id)]);
          expect(provider.createCalls).toBe(1);
          expect(await prisma.sandbox.findUnique({ where: { id: machine } })).toMatchObject({
            workspacePending: false,
            pausePending: false,
            state: 'RUNNING',
          });
        } finally {
          provider.reset();
          await prisma.user.delete({ where: { id: userId } });
        }
      });

      it('keeps a failed pause counted until a later recovery pass succeeds', async () => {
        provider.workspaceOnFirstStart = true;
        provider.existing = true;
        provider.failResumeWith = new Error('bridge timeout');
        provider.failStopWith = new Error('temporary pause failure');
        await expect(sandboxes.start(USER_ID, botId)).rejects.toThrow('bridge timeout');
        const id = await computerId(prisma, botId);
        expect(await prisma.sandbox.findUnique({ where: { id } })).toMatchObject({
          pausePending: true,
          state: 'UNHEALTHY',
        });
        provider.failStopWith = null;
        await sandboxes.recoverPendingPauses();
        expect(provider.stopCalls).toBe(2);
        expect(await prisma.sandbox.findUnique({ where: { id } })).toMatchObject({
          pausePending: false,
          state: 'ERROR',
        });
      });
    });

    describe('failure', () => {
      it('records the reason and releases the lock', async () => {
        // Leaving STARTING set would wedge the bot until the lease expired,
        // and lastError is the only place the operator sees what went wrong.
        provider.failCreateWith = new Error('image crewaid/sandbox:dev not found');

        await expect(sandboxes.start(USER_ID, botId)).rejects.toThrow(/not found/);

        const row = await prisma.sandbox.findFirstOrThrow({
          where: { bots: { some: { id: botId } } },
        });
        expect(row.state).toBe('ERROR');
        expect(row.lastError).toMatch(/not found/);

        // And the next start is allowed to try again.
        provider.failCreateWith = null;
        await expect(sandboxes.start(USER_ID, botId)).resolves.toMatchObject({ state: 'RUNNING' });
      });
    });

    describe('ownership (R7)', () => {
      it('404s another user’s bot on every route, without leaking existence', async () => {
        await prisma.user.upsert({
          where: { id: OTHER_USER_ID },
          create: { id: OTHER_USER_ID, name: 'Test User', email: `${OTHER_USER_ID}@test.invalid` },
          update: {},
        });

        for (const call of [
          () => sandboxes.status(OTHER_USER_ID, botId),
          () => sandboxes.start(OTHER_USER_ID, botId),
          () => sandboxes.stop(OTHER_USER_ID, botId),
        ]) {
          await expect(call()).rejects.toBeInstanceOf(NotFoundException);
        }
        expect(provider.createCalls).toBe(0);
      });

      it('reports STOPPED for a bot that has never had a sandbox', async () => {
        // A missing row is a stopped sandbox, not a 404. §4.1 promises a state.
        await expect(sandboxes.status(USER_ID, botId)).resolves.toMatchObject({
          botId,
          state: 'STOPPED',
          widthPx: 1280,
          heightPx: 800,
        });
      });
    });
  },
);

async function viWaitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for provider call');
    await new Promise((r) => setTimeout(r, 5));
  }
}
