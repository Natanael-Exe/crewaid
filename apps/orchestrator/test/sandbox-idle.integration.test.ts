import { computerId, privateComputerBot } from './computer-fixtures.js';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';

import { BotsService } from '../src/bots/bots.service.js';
import { SeatService } from '../src/sandbox/seat.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SINGLETON_USER_ID } from '../src/auth/singleton-user.js';
import { SandboxService } from '../src/sandbox/sandbox.service.js';
import { SandboxIdleService } from '../src/sandbox/sandbox-idle.service.js';
import { SandboxActivityService } from '../src/sandbox/sandbox-activity.service.js';
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
import { conversationIdOf } from './turn-fixtures.js';

/**
 * M2-BE-11 — idle stop (§8, D-039).
 *
 * Real database, because every input to the decision is a row: the sandbox's
 * own clock, the bot's turns, its recordings. A mocked Prisma would be
 * asserting that the query I wrote is the query I wrote.
 *
 * The idle period is 60 s here and the clocks are written into the past, so
 * the suite tests the DECISION rather than the wait. `SandboxIdleService` is
 * constructed by hand rather than pulled out of the Nest container for the
 * same reason: `onApplicationBootstrap` is never called, so no background
 * timer can fire in the middle of an assertion and stop a sandbox some other
 * test is still using.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const BOT_PREFIX = 'm2be11idle';
const IDLE_MS = 60_000;
/** Comfortably past the idle period, so nothing here depends on clock skew. */
const LONG_AGO = () => new Date(Date.now() - 10 * IDLE_MS);

/** Enough of an upstream for a subscription to exist and stay open. */
class FakeUpstream implements ScreenUpstream {
  isStreaming = true;
  screen: ScreenGeometry | null = { widthPx: 1280, heightPx: 800 };
  readonly sentInput: Buffer[] = [];
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
  sendInput(bytes: Uint8Array): boolean {
    this.sentInput.push(Buffer.from(bytes));
    return true;
  }
  close(): void {}
}

class FakeClient extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  readonly frames: Buffer[] = [];
  send(data: Buffer, _o?: unknown, callback?: (error?: Error | null) => void): void {
    this.frames.push(Buffer.from(data));
    callback?.(null);
  }
  terminate(): void {
    this.readyState = 3;
  }
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M2-BE-11 idle stop (real db)',
  () => {
    let app: INestApplication;
    let bots: BotsService;
    let prisma: PrismaService;
    let sandboxes: SandboxService;
    let screens: ScreenService;
    let activity: SandboxActivityService;
    let idle: SandboxIdleService;
    let provider: FakeProvider;
    let botId: string;

    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      provider = new FakeProvider();
      const moduleRef = await Test.createTestingModule({
        // ScreenModule, not SandboxModule: §8's load-bearing claim is about a
        // screen subscription, and it cannot be tested against a screen
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
      screens = app.get(ScreenService);
      activity = app.get(SandboxActivityService);
      await prisma.user.upsert({
        where: { id: SINGLETON_USER_ID },
        create: {
          id: SINGLETON_USER_ID,
          name: 'Test User',
          email: `${SINGLETON_USER_ID}@test.invalid`,
        },
        update: {},
      });

      const previous = process.env['SANDBOX_IDLE_STOP_MS'];
      process.env['SANDBOX_IDLE_STOP_MS'] = String(IDLE_MS);
      idle = new SandboxIdleService(prisma, sandboxes, activity);
      if (previous === undefined) delete process.env['SANDBOX_IDLE_STOP_MS'];
      else process.env['SANDBOX_IDLE_STOP_MS'] = previous;
    });

    afterAll(async () => {
      await prisma?.bot
        .deleteMany({ where: { userId: SINGLETON_USER_ID, name: { startsWith: BOT_PREFIX } } })
        .catch(() => undefined);
      await app?.close();
    });

    beforeEach(async () => {
      const bot = await privateComputerBot(prisma, provider, SINGLETON_USER_ID, {
        name: `${BOT_PREFIX}-${randomUUID().slice(0, 8)}`,
        role: 'R',
        avatarColor: '#123456',
        systemPrompt: 'x',
      });
      botId = bot.id;
      provider.reset();
      await sandboxes.start(SINGLETON_USER_ID, botId);
    });

    afterEach(async () => {
      // The sweep walks EVERY running sandbox, so a row this suite leaves
      // RUNNING with an ancient clock would be stopped by the next test's
      // sweep and counted as its result.
      await prisma.sandbox
        .updateMany({ where: { bots: { some: { id: botId } } }, data: { state: 'STOPPED' } })
        .catch(() => undefined);
    });

    /** Put this bot's clock far enough back that it is due to stop. */
    async function goQuiet(): Promise<void> {
      await prisma.sandbox.update({
        where: { id: await computerId(prisma, botId) },
        data: { lastActiveAt: LONG_AGO() },
      });
    }

    async function stateOf(): Promise<string | undefined> {
      return (await prisma.sandbox.findFirst({ where: { bots: { some: { id: botId } } } }))?.state;
    }

    it('stops a sandbox that has been quiet for the idle period', async () => {
      await goQuiet();

      await idle.sweep();

      expect(await stateOf()).toBe('STOPPED');
      expect(provider.stopCallsFor(botId)).toBe(1);
    });

    it('leaves one that has not been quiet long enough', async () => {
      await prisma.sandbox.update({
        where: { id: await computerId(prisma, botId) },
        data: { lastActiveAt: new Date(Date.now() - IDLE_MS / 2) },
      });

      await idle.sweep();

      expect(await stateOf()).toBe('RUNNING');
      expect(provider.stopCallsFor(botId)).toBe(0);
    });

    it('stops one whose only company is a screen subscription', async () => {
      // §8's load-bearing half, and D-039 §12 rule 5. The rail thumbnail is one
      // subscription held open for as long as the app is, so a subscription
      // that counted as activity would mean idle stop never fires for any bot
      // the operator can see — which is every bot.
      const client = new FakeClient();
      await screens.subscribe(SINGLETON_USER_ID, client as never, botId);
      expect(screens.subscriberCount(botId)).toBe(1);
      await goQuiet();

      await idle.sweep();

      expect(await stateOf()).toBe('STOPPED');
      screens.detach(client as never);
    });

    it('leaves one with a turn still running', async () => {
      await goQuiet();
      await startTurn('running');

      await idle.sweep();

      expect(await stateOf()).toBe('RUNNING');
      expect(provider.stopCallsFor(botId)).toBe(0);
    });

    it('stops one whose turn has been waiting on a human since long ago', async () => {
      // M5-BE-13, and the inversion of what this case used to assert. A
      // suspension is not the turn being over — it will want a desktop again
      // the moment somebody answers — but it is the turn not USING one, and it
      // lasts as long as the person takes. Holding 2 GiB for however long that
      // is, on behalf of every bot attached to the same computer under D-046,
      // was the cost.
      //
      // Safe only because of the other half: `TurnComputer.release()` hands
      // the lease back when the turn suspends and forgets its memoised
      // readiness, so the machine this stops is genuinely unclaimed and the
      // turn that resumes asks for it again. Either half alone is a bug.
      await goQuiet();
      await startTurn('interrupted', { startedAt: LONG_AGO() });

      await idle.sweep();

      expect(await stateOf()).toBe('STOPPED');
    });

    it('leaves one that suspended a moment ago', async () => {
      // The idle period starts at the SUSPENSION, not at the machine's last
      // unrelated activity. An operator who is reading the command they were
      // asked about has the full period to answer before the desktop goes,
      // and the turn's own timestamp is what says so.
      await goQuiet();
      await startTurn('interrupted');

      await idle.sweep();

      expect(await stateOf()).toBe('RUNNING');
    });

    it('gives a full idle period back after the turn ends', async () => {
      // The sandbox's own clock is ancient, but work finished a moment ago.
      // Reading the turn's timestamps rather than a touched column is what
      // makes this true without the agent loop having to remember anything.
      await goQuiet();
      await startTurn('completed', { endedAt: new Date() });

      await idle.sweep();

      expect(await stateOf()).toBe('RUNNING');
    });

    it('stops one whose last turn ended long ago', async () => {
      await goQuiet();
      await startTurn('completed', { startedAt: LONG_AGO(), endedAt: LONG_AGO() });

      await idle.sweep();

      expect(await stateOf()).toBe('STOPPED');
    });

    it('leaves one with a recording in progress', async () => {
      await goQuiet();
      await prisma.recording.create({ data: { botId, state: 'RECORDING' } });

      await idle.sweep();

      expect(await stateOf()).toBe('RUNNING');
    });

    it('finds an active recording even when a newer recording has finished', async () => {
      await goQuiet();
      await prisma.recording.create({
        data: { botId, state: 'RECORDING', startedAt: LONG_AGO() },
      });
      await prisma.recording.create({
        data: { botId, state: 'READY', startedAt: new Date(), endedAt: new Date() },
      });

      await idle.sweep();

      expect(await stateOf()).toBe('RUNNING');
      expect(provider.stopCallsFor(botId)).toBe(0);
    });

    it('stops one whose recording has finished', async () => {
      await goQuiet();
      await prisma.recording.create({
        data: { botId, state: 'READY', startedAt: LONG_AGO(), endedAt: LONG_AGO() },
      });

      await idle.sweep();

      expect(await stateOf()).toBe('STOPPED');
    });

    /**
     * A compile reads events that are already stored and needs no desktop, so
     * `COMPILING` deliberately does not own one — the state is excluded from
     * the active-recording query rather than by listing terminal states, and
     * only these two cases say which way that was meant. Without them, moving
     * `COMPILING` into the owning set (or out of the clock below) is a silent
     * change: one direction pins a container open for as long as a wedged
     * model call lasts, the other stops a desktop the operator is still
     * looking at seconds after they hit stop.
     */
    it('stops one whose recording is COMPILING', async () => {
      await goQuiet();
      await prisma.recording.create({
        data: {
          botId,
          state: 'COMPILING',
          startedAt: LONG_AGO(),
          endedAt: LONG_AGO(),
        },
      });

      await idle.sweep();

      expect(await stateOf()).toBe('STOPPED');
    });

    it('still gives a COMPILING recording the idle period after capture ended', async () => {
      await goQuiet();
      await prisma.recording.create({
        data: { botId, state: 'COMPILING', startedAt: LONG_AGO(), endedAt: new Date() },
      });

      await idle.sweep();

      // Not because COMPILING owns the desktop — because `endedAt` is a clock
      // mark, and capture stopped a moment ago.
      expect(await stateOf()).toBe('RUNNING');
      expect(provider.stopCallsFor(botId)).toBe(0);
    });

    it('leaves one whose keep-running lease has not expired', async () => {
      await prisma.sandbox.update({
        where: { id: await computerId(prisma, botId) },
        data: { lastActiveAt: LONG_AGO(), keepRunningUntil: new Date(Date.now() + 60_000) },
      });

      await idle.sweep();

      expect(await stateOf()).toBe('RUNNING');
    });

    it('stops one whose lease has run out', async () => {
      // A lease with no expiry is a leak (D-039 §10), so an expired one has to
      // stop protecting the sandbox the moment it passes.
      await prisma.sandbox.update({
        where: { id: await computerId(prisma, botId) },
        data: { lastActiveAt: LONG_AGO(), keepRunningUntil: LONG_AGO() },
      });

      await idle.sweep();

      expect(await stateOf()).toBe('STOPPED');
    });

    it('clears the lease when the sandbox goes down', async () => {
      await prisma.sandbox.update({
        where: { id: await computerId(prisma, botId) },
        data: { keepRunningUntil: new Date(Date.now() + 3_600_000) },
      });

      await sandboxes.stop(SINGLETON_USER_ID, botId);

      // A lease promises to keep a RUNNING sandbox up. Carrying it past a stop
      // would make the next start unstoppable on the strength of a promise
      // made about a session that no longer exists.
      const row = await prisma.sandbox.findFirst({ where: { bots: { some: { id: botId } } } });
      expect(row?.keepRunningUntil).toBeNull();
    });

    it('resets the clock when the operator drives the desktop', async () => {
      await goQuiet();

      activity.touch(botId);
      await waitFor(async () => {
        const row = await prisma.sandbox.findFirst({ where: { bots: { some: { id: botId } } } });
        return (row?.lastActiveAt?.getTime() ?? 0) > Date.now() - IDLE_MS;
      });
      await idle.sweep();

      expect(await stateOf()).toBe('RUNNING');
    });

    it('counts input the operator sends, through the real §4.3 path', async () => {
      // The wiring, not the service: `screen.input` is the only place manual
      // takeover is observable, and a `touch` that is never called from it
      // would leave every hand-driven desktop looking idle. Subscribing alone
      // must not do it — that is the thumbnail case above — so the clock is
      // checked before and after the message.
      const client = new FakeClient();
      await screens.subscribe(SINGLETON_USER_ID, client as never, botId);
      await screens.control(client as never, botId, { botId, action: 'take' });
      await goQuiet();
      const before = (await prisma.sandbox.findFirst({ where: { bots: { some: { id: botId } } } }))
        ?.lastActiveAt;

      // RFC 6143 §7.5.5 PointerEvent: type, button mask, x, y.
      screens.input(client as never, botId, new Uint8Array([5, 1, 0, 40, 0, 60]), 1);
      await waitFor(async () => {
        const row = await prisma.sandbox.findFirst({ where: { bots: { some: { id: botId } } } });
        return row?.lastActiveAt?.getTime() !== before?.getTime();
      });
      await idle.sweep();

      expect(await stateOf()).toBe('RUNNING');
      screens.detach(client as never);
    });

    it('does not lose input that races a lifecycle claim', async () => {
      await goQuiet();
      await prisma.sandbox.update({
        where: { id: await computerId(prisma, botId) },
        data: { state: 'STARTING' },
      });

      // The durable write is deliberately pinned to RUNNING and therefore
      // matches zero rows here. The synchronous activity mark must still keep
      // the sandbox up once the competing lifecycle operation releases it.
      activity.touch(botId);
      await prisma.sandbox.update({
        where: { id: await computerId(prisma, botId) },
        data: { state: 'RUNNING' },
      });

      await idle.sweep();

      expect(await stateOf()).toBe('RUNNING');
      expect(provider.stopCallsFor(botId)).toBe(0);
    });

    it('never stops a sandbox it has no clock for', async () => {
      // Both columns null is what a row written before D-039 looks like.
      // "No evidence" must not read as "idle since the epoch": stopping a
      // sandbox on no evidence is how a background policy destroys work it
      // never observed.
      await prisma.sandbox.update({
        where: { id: await computerId(prisma, botId) },
        data: { lastActiveAt: null, lastStartedAt: null },
      });

      await idle.sweep();

      expect(await stateOf()).toBe('RUNNING');
    });

    it('does nothing at all when idle stop is disabled', async () => {
      const previous = process.env['SANDBOX_IDLE_STOP_MS'];
      process.env['SANDBOX_IDLE_STOP_MS'] = '0';
      const disabled = new SandboxIdleService(prisma, sandboxes, activity);
      if (previous === undefined) delete process.env['SANDBOX_IDLE_STOP_MS'];
      else process.env['SANDBOX_IDLE_STOP_MS'] = previous;
      await goQuiet();

      await disabled.sweep();

      expect(await stateOf()).toBe('RUNNING');
    });

    describe('the lease held across the decision', () => {
      it('puts the sandbox back when the confirmation says no', async () => {
        // The window this closes: the sweep decided a moment ago, and a turn
        // or a keystroke arriving since must still win. `confirm` runs with
        // the lifecycle lease held, so from the claim onward the answer cannot
        // go stale between the question and the stop.
        const stopped = await sandboxes.stopIdle({ botId, computerId: botId }, () =>
          Promise.resolve(false),
        );

        expect(stopped).toBe(false);
        expect(await stateOf()).toBe('RUNNING');
        expect(provider.stopCallsFor(botId)).toBe(0);
      });

      it('puts it back when the confirmation itself fails', async () => {
        await expect(
          sandboxes.stopIdle({ botId, computerId: botId }, () =>
            Promise.reject(new Error('database blip')),
          ),
        ).rejects.toThrow('database blip');

        // A sweep that threw must not leave the row STARTING: that is the
        // start lock, and a sandbox wedged in it is unstartable for a lease.
        expect(await stateOf()).toBe('RUNNING');
      });

      it('does not fight a lifecycle operation that already holds the lock', async () => {
        await prisma.sandbox.update({
          where: { id: await computerId(prisma, botId) },
          data: { state: 'STARTING', lastStartedAt: new Date() },
        });

        const stopped = await sandboxes.stopIdle({ botId, computerId: botId }, () =>
          Promise.resolve(true),
        );

        expect(stopped).toBe(false);
        expect(await stateOf()).toBe('STARTING');
      });

      it('leaves an unhealthy row for reconciliation without rewriting it', async () => {
        await prisma.sandbox.update({
          where: { id: await computerId(prisma, botId) },
          data: { state: 'UNHEALTHY', lastError: 'bridge did not answer' },
        });

        const stopped = await sandboxes.stopIdle({ botId, computerId: botId }, () =>
          Promise.resolve(false),
        );

        expect(stopped).toBe(false);
        await expect(
          prisma.sandbox.findFirst({ where: { bots: { some: { id: botId } } } }),
        ).resolves.toMatchObject({
          state: 'UNHEALTHY',
          lastError: 'bridge did not answer',
        });
        expect(provider.stopCallsFor(botId)).toBe(0);
      });
    });

    describe('sweepIntervalFor', () => {
      it('checks about ten times per idle period, within bounds', () => {
        expect(SandboxIdleService.sweepIntervalFor(1_800_000)).toBe(60_000);
        expect(SandboxIdleService.sweepIntervalFor(300_000)).toBe(30_000);
        // Floor: a very short period must not turn the sweep into a busy loop.
        expect(SandboxIdleService.sweepIntervalFor(1_000)).toBe(10_000);
      });
    });

    async function startTurn(
      status: 'running' | 'interrupted' | 'completed',
      extra: { startedAt?: Date; endedAt?: Date } = {},
    ): Promise<void> {
      await prisma.agentTurn.create({
        data: {
          botId,
          conversationId: await conversationIdOf(prisma, botId),
          triggerMessageId: `trigger-${randomUUID()}`,
          status,
          ...extra,
        },
      });
    }
  },
);

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition was never met');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
