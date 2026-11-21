import { computerId, privateComputerBot } from './computer-fixtures.js';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';

import { BotsService } from '../src/bots/bots.service.js';
import { SeatService } from '../src/sandbox/seat.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SINGLETON_USER_ID } from '../src/auth/singleton-user.js';
import { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { OCCUPIES_A_SLOT, SandboxService } from '../src/sandbox/sandbox.service.js';
import { SandboxController } from '../src/sandbox/sandbox.controller.js';
import { SandboxIdleService } from '../src/sandbox/sandbox-idle.service.js';
import { SandboxActivityService } from '../src/sandbox/sandbox-activity.service.js';
import { SandboxLeaseService } from '../src/sandbox/sandbox-lease.service.js';
import { SandboxReadinessService } from '../src/sandbox/sandbox-readiness.service.js';
import { SandboxWorkspaceService } from '../src/sandbox/sandbox-workspace.service.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { ScreenService } from '../src/screen/screen.service.js';
import {
  RFB_UPSTREAM_FACTORY,
  type ScreenUpstream,
  type ScreenUpstreamOptions,
} from '../src/screen/screen-upstream.port.js';
import type { ScreenGeometry } from '@crewaid/screen-stream';
import type { ServerMessageMeta } from '@crewaid/screen-stream';
import { FakeProvider, FakeSeatService } from './sandbox-fakes.js';

/**
 * M3-BE-11 — ensure-ready and activity ownership (D-039 §16–§17, D-041).
 *
 * Real database, fake provider: every claim here is about the ORDER of writes
 * against rows two background policies also write to, and Docker decides none
 * of it. The idle sweep is driven by hand for the same reason M2-BE-11's suite
 * does it — asserting a 30-minute policy by waiting 30 minutes measures the
 * clock rather than the decision.
 *
 * ── WHY SOME TESTS RUN A ONE-SECOND LEASE ───────────────────────────────────
 *
 * Expiry is the whole safety story: it is what stops a crashed owner from
 * pinning a container forever, and D-041 asks for a documented bound rather
 * than a promise. The bound is derived from the idle sweep, so configuring a
 * one-second idle period yields a one-second lease and the expiry can be
 * measured in real time instead of asserted by moving a column — which would
 * prove the test can write a date, not that protection lapses on its own.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const BOT_PREFIX = 'm3be11ready';
const IDLE_MS = 60_000;
/** Comfortably past the idle period, so nothing here depends on clock skew. */
const LONG_AGO = () => new Date(Date.now() - 10 * IDLE_MS);

/** Enough of an upstream for a subscription to exist and stay open. */
class FakeUpstream implements ScreenUpstream {
  isStreaming = true;
  screen: ScreenGeometry | null = { widthPx: 1280, heightPx: 800 };
  private readyFn: ((geometry: ScreenGeometry) => void) | null = null;

  constructor(readonly options: ScreenUpstreamOptions) {
    setTimeout(() => this.readyFn?.(this.screen as ScreenGeometry), 0);
  }
  onReady(fn: (geometry: ScreenGeometry) => void): void {
    this.readyFn = fn;
  }
  onMessage(_fn: (m: Buffer, meta: ServerMessageMeta) => void): void {}
  onClose(_fn: (reason: Error | null) => void): void {}
  resume(): void {}
  pause(): void {}
  requestFullRepaint(): void {}
  setQuality(_quality: number): void {}
  sendInput(_bytes: Uint8Array): boolean {
    return true;
  }
  close(): void {}
}

class FakeClient extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  send(data: Buffer, _o?: unknown, callback?: (error?: Error | null) => void): void {
    void data;
    callback?.(null);
  }
  terminate(): void {
    this.readyState = 3;
  }
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M3-BE-11 ensure ready (real db)',
  () => {
    let app: INestApplication;
    let bots: BotsService;
    let prisma: PrismaService;
    let sandboxes: SandboxService;
    let readiness: SandboxReadinessService;
    let leases: SandboxLeaseService;
    let screens: ScreenService;
    let idle: SandboxIdleService;
    let provider: FakeProvider;
    /** Ensure-ready wired to a one-second lease; see the header. */
    let brief: { readiness: SandboxReadinessService; leases: SandboxLeaseService };
    let botId: string;
    const created: string[] = [];

    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      provider = new FakeProvider();
      const moduleRef = await Test.createTestingModule({
        // ScreenModule, not SandboxModule: two of §16's claims are about what
        // a viewer does NOT do, and neither can be tested against a screen
        // subsystem that is not wired in.
        imports: [(await import('../src/screen/screen.module.js')).ScreenModule],
      })
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(provider)
        .overrideProvider(RFB_UPSTREAM_FACTORY)
        .useValue((options: ScreenUpstreamOptions) => new FakeUpstream(options))
        .overrideProvider(SeatService)
        // D-046 / M5-BE-23: the §4.3 stream is the bot's seat, and resolving
        // one is an HTTP call into the machine. This suite's provider is a
        // fake with no bridge behind it.
        .useValue(new FakeSeatService())
        .compile();

      app = moduleRef.createNestApplication();
      await app.init();
      bots = app.get(BotsService);
      prisma = app.get(PrismaService);
      sandboxes = app.get(SandboxService);
      readiness = app.get(SandboxReadinessService);
      leases = app.get(SandboxLeaseService);
      screens = app.get(ScreenService);
      await prisma.user.upsert({
        where: { id: SINGLETON_USER_ID },
        create: {
          id: SINGLETON_USER_ID,
          name: 'Test User',
          email: `${SINGLETON_USER_ID}@test.invalid`,
        },
        update: {},
      });

      idle = withIdlePeriod(IDLE_MS, () => new SandboxIdleService(prisma, sandboxes, activity()));
      brief = withIdlePeriod(1_000, () => {
        const briefLeases = new SandboxLeaseService(prisma);
        return {
          leases: briefLeases,
          readiness: new SandboxReadinessService(sandboxes, briefLeases),
        };
      });
    });

    afterAll(async () => {
      await prisma?.bot
        .deleteMany({ where: { userId: SINGLETON_USER_ID, name: { startsWith: BOT_PREFIX } } })
        .catch(() => undefined);
      brief?.leases.onModuleDestroy();
      await app?.close();
    });

    beforeEach(async () => {
      botId = await newBot();
      provider.reset();
    });

    afterEach(async () => {
      // The sweep walks EVERY running sandbox, so a row this suite leaves
      // RUNNING with an ancient clock would be stopped by the next test's
      // sweep and counted as its result.
      await prisma.sandbox
        .updateMany({
          where: { bots: { some: { id: { in: created } } } },
          data: { state: 'STOPPED', keepRunningUntil: null },
        })
        .catch(() => undefined);
    });

    async function newBot(): Promise<string> {
      const bot = await privateComputerBot(prisma, provider, SINGLETON_USER_ID, {
        name: `${BOT_PREFIX}-${randomUUID().slice(0, 8)}`,
        role: 'R',
        avatarColor: '#123456',
        systemPrompt: 'x',
      });
      created.push(bot.id);
      return bot.id;
    }

    /** The activity service the container built, for the idle sweep's clock. */
    function activity(): SandboxActivityService {
      return app.get(SandboxActivityService);
    }

    /** Construct something whose lifecycle constants are read at construction. */
    function withIdlePeriod<T>(idleMs: number, build: () => T): T {
      const previous = process.env['SANDBOX_IDLE_STOP_MS'];
      process.env['SANDBOX_IDLE_STOP_MS'] = String(idleMs);
      try {
        return build();
      } finally {
        if (previous === undefined) delete process.env['SANDBOX_IDLE_STOP_MS'];
        else process.env['SANDBOX_IDLE_STOP_MS'] = previous;
      }
    }

    async function rowOf(id = botId) {
      return prisma.sandbox.findFirst({ where: { bots: { some: { id: id } } } });
    }

    async function stateOf(id = botId): Promise<string | undefined> {
      return (await rowOf(id))?.state;
    }

    /** Put this bot's activity clock far enough back that it is due to stop. */
    async function goQuiet(): Promise<void> {
      await prisma.sandbox.update({
        where: { id: await computerId(prisma, botId) },
        data: { lastActiveAt: LONG_AGO() },
      });
    }

    /** How many times readiness actually reached the provider for a runtime. */
    function acquisitions(): number {
      return provider.createCalls + provider.resumeCalls;
    }

    describe('waking a computer', () => {
      it('starts a provisioned bot that has never run', async () => {
        const ready = await readiness.ensureReady(SINGLETON_USER_ID, botId, 'skill');

        expect(ready.status.state).toBe('RUNNING');
        expect(acquisitions()).toBe(1);
        await ready.lease.release();
      });

      it('gives simultaneous callers one runtime and one answer', async () => {
        // §16: screen, recording and skill callers arriving together receive
        // the same ready runtime rather than a container each. Ensure-ready
        // owns none of that — it inherits the M2-BE-04 start lock — and this
        // is the test that says the wrapper did not lose it.
        provider.createDelayMs = 100;

        const ready = await Promise.all([
          readiness.ensureReady(SINGLETON_USER_ID, botId, 'explicit-open'),
          readiness.ensureReady(SINGLETON_USER_ID, botId, 'recording'),
          readiness.ensureReady(SINGLETON_USER_ID, botId, 'skill'),
          readiness.ensureReady(SINGLETON_USER_ID, botId, 'agent-tool'),
          readiness.ensureReady(SINGLETON_USER_ID, botId, 'managed-job'),
        ]);

        expect(ready.every((r) => r.status.state === 'RUNNING')).toBe(true);
        expect(acquisitions()).toBe(1);
        for (const r of ready) await r.lease.release();
      });

      it('is the path §4.1 start takes', async () => {
        // The wiring, not the service. A route that called the lifecycle
        // directly would still pass every assertion above and would wake a
        // computer with no ownership at all, which is the one thing §17 says
        // must not happen.
        const status = await app
          .get(SandboxController)
          .start(botId, { userId: SINGLETON_USER_ID, scopes: ['*'] });

        expect(status.state).toBe('RUNNING');
        expect((await rowOf())?.keepRunningUntil).not.toBeNull();
      });

      it('refuses a bot the caller does not own, and writes nothing to it', async () => {
        const other = `${SINGLETON_USER_ID.slice(0, -4)}zzzz`;

        await expect(readiness.ensureReady(other, botId, 'skill')).rejects.toThrow('Bot not found');

        // R7 across the lease too: the deadline is claimed before ownership is
        // resolved by the lifecycle, so its own write has to be scoped or it
        // is an IDOR that happens to have no reply body.
        const row = await rowOf();
        expect(row?.keepRunningUntil).toBeNull();
        expect(row?.state).toBe('STOPPED');
      });
    });

    describe('ownership before the runtime (§17)', () => {
      it('claims ownership before it asks for a runtime', async () => {
        // The ordering §17 requires, asserted where it is deterministic: the
        // desktop never comes up at all, and the deadline is still there. Move
        // the claim after the start and this is the assertion that goes red —
        // which matters because the window it protects (a `RUNNING` sandbox
        // the sweep has already judged idle, handed back by an idempotent
        // start that touches no Docker) is too narrow to catch by racing.
        provider.failCreateWith = new Error('no room on the daemon');

        await expect(readiness.ensureReady(SINGLETON_USER_ID, botId, 'skill')).rejects.toThrow(
          'no room on the daemon',
        );

        expect((await rowOf())?.keepRunningUntil).not.toBeNull();
      });

      it('survives a sweep that had already decided the sandbox was idle', async () => {
        // The race ensure-ready exists to close, and the dangerous case is the
        // one that looks safe: the sandbox is ALREADY running and already past
        // its deadline, so `start` returns instantly without touching Docker
        // and the sweep is entitled to stop it in the next tick. Claiming the
        // lease first is the only thing standing between the caller and a
        // desktop that is being torn down.
        await sandboxes.start(SINGLETON_USER_ID, botId);
        await goQuiet();

        const ready = await readiness.ensureReady(SINGLETON_USER_ID, botId, 'agent-tool');
        await idle.sweep();

        expect(await stateOf()).toBe('RUNNING');
        expect(provider.stopCallsFor(botId)).toBe(0);
        expect(ready.status.state).toBe('RUNNING');
        await ready.lease.release();
      });

      it('protects work whose viewer has gone away', async () => {
        // Switching bots and closing the app detach presentation only (§16).
        // The socket that started the work is not what owns it.
        const ready = await readiness.ensureReady(SINGLETON_USER_ID, botId, 'managed-job');
        const client = new FakeClient();
        await screens.subscribe(SINGLETON_USER_ID, client as never, botId);
        await goQuiet();

        screens.detach(client as never);
        await idle.sweep();

        expect(screens.subscriberCount(botId)).toBe(0);
        expect(await stateOf()).toBe('RUNNING');
        expect(provider.stopCallsFor(botId)).toBe(0);
        await ready.lease.release();
      });

      it('starts the idle period again when the work releases', async () => {
        await sandboxes.start(SINGLETON_USER_ID, botId);
        await goQuiet();
        const ready = await readiness.ensureReady(SINGLETON_USER_ID, botId, 'skill');

        await ready.lease.release();

        // §17: release records final activity, so the ordinary idle interval
        // begins when the work ended rather than when it started — a finished
        // owner must not cause an immediate stop.
        const lastActiveAt = (await rowOf())?.lastActiveAt?.getTime() ?? 0;
        expect(Date.now() - lastActiveAt).toBeLessThan(IDLE_MS);
      });

      it('releases on the failure path too', async () => {
        const ready = await readiness.ensureReady(SINGLETON_USER_ID, botId, 'skill');
        await ready.lease.release();
        const before = (await rowOf())?.keepRunningUntil;

        await expect(
          readiness.withComputer(SINGLETON_USER_ID, botId, 'skill', () => {
            throw new Error('the skill blew up');
          }),
        ).rejects.toThrow('the skill blew up');

        // Nothing is renewing any more, so the only thing still standing is
        // the deadline already bought — which expires on its own.
        expect((await rowOf())?.keepRunningUntil?.getTime()).toBeGreaterThanOrEqual(
          before?.getTime() ?? 0,
        );
      });

      it('hands a capacity refusal back unchanged, with the workspace intact', async () => {
        // §16.1 and D-041: bot creation never returns SANDBOX_CAPACITY, but an
        // interactive wake on a full host does — and it must read as "come back
        // later", not as a broken bot. Admission is read once at construction,
        // so the full host is built rather than configured.
        //
        // The ceiling is measured rather than chosen, because capacity counts
        // every sandbox in the database — including the ones other suites
        // leave behind (D-039 §7). One occupied slot is put there by this
        // suite so the number is never zero, which is not a host at all.
        await sandboxes.start(SINGLETON_USER_ID, await newBot());
        const occupied = await prisma.sandbox.count({
          where: { state: { in: [...OCCUPIES_A_SLOT] } },
        });
        const full = withIdlePeriod(
          IDLE_MS,
          () =>
            new SandboxReadinessService(
              withMaxRunning(
                occupied,
                () =>
                  new SandboxService(
                    prisma,
                    provider,
                    app.get(TurnEventBus),
                    app.get(SandboxWorkspaceService),
                  ),
              ),
              leases,
            ),
        );

        await expect(
          full.ensureReady(SINGLETON_USER_ID, botId, 'explicit-open'),
        ).rejects.toMatchObject({ response: { code: 'SANDBOX_CAPACITY' } });

        const row = await rowOf();
        expect(row?.state).toBe('STOPPED');
        expect(row?.lastStartedAt).toBeNull();
        // One acquisition, and it is the one that filled the host — the
        // refusal never reached the provider at all (D-039 §12 rule 6).
        expect(acquisitions()).toBe(1);
        // The workspace is the point: capacity is about the host having room
        // to RUN something, and a bot refused a slot has lost no bytes.
        await expect(provider.inspectWorkspace({ botId })).resolves.toMatchObject({ exists: true });

        // The identical request succeeds once there is room.
        const retried = await readiness.ensureReady(SINGLETON_USER_ID, botId, 'explicit-open');
        expect(retried.status.state).toBe('RUNNING');
        await retried.lease.release();
      });
    });

    describe('the lease is one column and many owners', () => {
      it('never shortens a deadline another owner is depending on', async () => {
        const long = await leases.acquire(SINGLETON_USER_ID, botId, 'recording');
        await prisma.sandbox.update({
          where: { id: await computerId(prisma, botId) },
          data: { keepRunningUntil: new Date(Date.now() + 3_600_000) },
        });

        const short = await leases.acquire(SINGLETON_USER_ID, botId, 'skill');
        await short.release();

        // Acquiring must not pull the deadline back to its own bound, and
        // releasing must not clear it: the recording is still running.
        const until = (await rowOf())?.keepRunningUntil?.getTime() ?? 0;
        expect(until - Date.now()).toBeGreaterThan(3_000_000);
        await long.release();
      });

      it('does not drag the activity clock backwards on release', async () => {
        await sandboxes.start(SINGLETON_USER_ID, botId);
        const lease = await leases.acquire(SINGLETON_USER_ID, botId, 'managed-job');
        const later = new Date(Date.now() + 60_000);
        await prisma.sandbox.update({
          where: { id: await computerId(prisma, botId) },
          data: { lastActiveAt: later },
        });

        await lease.release();

        // A slow release must not undo an input the operator sent while it
        // was completing.
        expect((await rowOf())?.lastActiveAt?.getTime()).toBe(later.getTime());
      });
    });

    describe('expiry is the bound (§17)', () => {
      it('stops protecting a sandbox whose owner crashed', async () => {
        await sandboxes.start(SINGLETON_USER_ID, botId);
        await brief.readiness.ensureReady(SINGLETON_USER_ID, botId, 'managed-job');
        await goQuiet();

        // The crash: renewal stops without anybody releasing, exactly as it
        // would if the process holding the handle went away.
        brief.leases.onModuleDestroy();
        expect(await stateOf()).toBe('RUNNING');
        await sleep(brief.leases.boundMs + 250);
        await idle.sweep();

        expect(await stateOf()).toBe('STOPPED');
      });

      it('keeps renewing while its owner is alive', async () => {
        await sandboxes.start(SINGLETON_USER_ID, botId);
        const ready = await brief.readiness.ensureReady(SINGLETON_USER_ID, botId, 'managed-job');
        await goQuiet();

        // Twice the bound with nothing but the timer holding it up. A lease
        // that only survives because it was written once would be gone.
        await sleep(brief.leases.boundMs * 2);
        await idle.sweep();

        expect(await stateOf()).toBe('RUNNING');
        expect(provider.stopCallsFor(botId)).toBe(0);
        await ready.lease.release();
      });

      it('lets a watched but unowned computer stop on schedule', async () => {
        // Opening the computer and looking at it is not work: `open` releases
        // as soon as the desktop is up, and a subscription held open for as
        // long as the app is must not become a perpetual keep-alive (D-031).
        await brief.readiness.open(SINGLETON_USER_ID, botId);
        const client = new FakeClient();
        await screens.subscribe(SINGLETON_USER_ID, client as never, botId);

        await sleep(brief.leases.boundMs + 250);
        await goQuiet();
        await idle.sweep();

        expect(await stateOf()).toBe('STOPPED');
        screens.detach(client as never);
      });
    });

    describe('leaseMsFor', () => {
      it('outlives three sweeps and never the idle period itself', () => {
        // Two consecutive missed renewals still leave protection standing, so
        // a database blip cannot stop a sandbox that is working.
        expect(SandboxLeaseService.leaseMsFor(1_800_000)).toBe(180_000);
        expect(SandboxLeaseService.leaseMsFor(1_800_000)).toBe(
          3 * SandboxIdleService.sweepIntervalFor(1_800_000),
        );
        // A crashed owner must not buy a sandbox more uptime than doing
        // nothing would have.
        expect(SandboxLeaseService.leaseMsFor(20_000)).toBe(20_000);
        // Idle stop disabled: nothing to protect against, but a lease still
        // has to expire, so the bound stays defined.
        expect(SandboxLeaseService.leaseMsFor(0)).toBe(30_000);
      });

      it('renews three times per bound', () => {
        expect(SandboxLeaseService.renewMsFor(1_800_000)).toBe(60_000);
        expect(SandboxLeaseService.renewMsFor(1_000)).toBe(333);
      });
    });

    /** Build something whose ceiling is read once, in its constructor. */
    function withMaxRunning<T>(limit: number, build: () => T): T {
      const previous = process.env['SANDBOX_MAX_RUNNING'];
      process.env['SANDBOX_MAX_RUNNING'] = String(limit);
      try {
        return build();
      } finally {
        if (previous === undefined) delete process.env['SANDBOX_MAX_RUNNING'];
        else process.env['SANDBOX_MAX_RUNNING'] = previous;
      }
    }
  },
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
