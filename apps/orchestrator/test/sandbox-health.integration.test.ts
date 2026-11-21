import { privateComputerBot } from './computer-fixtures.js';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';

import { BotsService } from '../src/bots/bots.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { SandboxService } from '../src/sandbox/sandbox.service.js';
import { SandboxHealthService } from '../src/sandbox/sandbox-health.service.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { FakeProvider } from './sandbox-fakes.js';

/**
 * M2-BE-05 — health polling into `SandboxState`.
 *
 * Real database, fake provider, and `sweep()` driven by hand. The interval
 * timer is not what these tests are about: "UNHEALTHY within one poll
 * interval" is a claim about what ONE pass does, and sleeping through a real
 * ten-second interval would measure `setInterval` instead. The timer is one
 * line; the state machine underneath it is the part that can be wrong, and it
 * is wrong in ways only a real Postgres shows — every guarantee here is a
 * compare-and-swap row count.
 *
 * Every assertion is scoped to a session id this suite created. The sweep is
 * global by design, so it also walks whatever rows other suites left in a
 * shared database, and a global counter would be measuring those.
 *
 * The suite the D-029 rules exist for is 'the lock it does not hold'.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const USER_ID = 'usr_crewaid_singleton_v1';
const BOT_PREFIX = 'm2be05';

class FakeClient extends EventEmitter {
  readonly readyState = 1;
  readonly frames: string[] = [];

  send(frame: string): void {
    this.frames.push(frame);
  }
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M2-BE-05 sandbox health polling (real db)',
  () => {
    let app: INestApplication;
    let bots: BotsService;
    let prisma: PrismaService;
    let sandboxes: SandboxService;
    let health: SandboxHealthService;
    let provider: FakeProvider;
    let client: FakeClient;
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
      health = app.get(SandboxHealthService);
      await prisma.user.upsert({
        where: { id: USER_ID },
        create: { id: USER_ID, name: 'Test User', email: `${USER_ID}@test.invalid` },
        update: {},
      });
      await dropOwnBots();
    });

    afterAll(async () => {
      // Every sweep walks every sandbox row, so bots left behind here are work
      // this suite adds to its own next run, forever. Sandbox rows cascade
      // from Bot, so removing the bot removes the row it polls.
      await dropOwnBots();
      await app?.close();
    });

    /** Only ever this suite's own rows — other suites' leftovers are not ours to delete. */
    const dropOwnBots = async (): Promise<void> => {
      await prisma.bot
        .deleteMany({ where: { userId: USER_ID, name: { startsWith: `${BOT_PREFIX}-` } } })
        .catch(() => undefined);
    };

    const newBot = async (): Promise<string> => {
      const bot = await privateComputerBot(prisma, provider, USER_ID, {
        name: `${BOT_PREFIX}-${randomUUID().slice(0, 8)}`,
        role: 'R',
        avatarColor: '#123456',
        systemPrompt: 'x',
      });
      return bot.id;
    };

    beforeEach(async () => {
      botId = await newBot();
      provider.reset();
      client = new FakeClient();
      app
        .get(TurnEventBus)
        .add(client as never, { userId: () => USER_ID, expired: () => undefined });
    });

    /**
     * Start the machine and wait for its first frame to reach the client.
     *
     * The bus reads a bot's owner before delivering its first frame, so that
     * frame lands a round trip after `start()` resolves — after a
     * `client.frames.length = 0` that meant to clear it. Waiting for it here
     * also caches the owner, so every later frame for this bot is delivered
     * synchronously and each case's assertions read what they always did.
     */
    const startAndSettle = async (): Promise<void> => {
      await sandboxes.start(USER_ID, botId);
      await vi.waitFor(() => expect(stateFrames().length).toBeGreaterThan(0));
    };

    /** §4.2 `sandbox.state` frames for the bot under test, in order. */
    const stateFrames = (): { botId: string; state: string }[] =>
      client.frames
        .map((raw) => JSON.parse(raw) as { type: string; botId: string; payload: never })
        .filter((frame) => frame.type === 'sandbox.state' && frame.botId === botId)
        .map((frame) => frame.payload);

    const row = (id: string = botId) =>
      prisma.sandbox.findFirstOrThrow({ where: { bots: { some: { id: id } } } });
    /** Nullable: `start()` creates the row, so a poll can look before it exists. */
    const stateOf = async (id: string): Promise<string | undefined> =>
      (await prisma.sandbox.findFirst({ where: { bots: { some: { id: id } } } }))?.state;

    describe('detection', () => {
      it('marks a running sandbox UNHEALTHY in a single sweep, with the reason', async () => {
        await startAndSettle();
        client.frames.length = 0;

        // What `docker kill` looks like from the probe's side.
        provider.healthBySession.set(botId, {
          ok: false,
          reason: 'container c1 is not running (exit 137)',
        });
        await health.sweep();

        const after = await row();
        expect(after.state).toBe('UNHEALTHY');
        // The reason reaches the operator, not just the log: §4.1 hands
        // lastError back on the status route, and "unhealthy" with no cause is
        // a support ticket rather than an answer.
        expect(after.lastError).toBe('container c1 is not running (exit 137)');
        expect(stateFrames()).toEqual([
          { botId, state: 'UNHEALTHY', widthPx: 1024, heightPx: 768 },
        ]);
      });

      it('brings a recovered sandbox back to RUNNING and clears the error', async () => {
        await startAndSettle();
        provider.healthBySession.set(botId, { ok: false, reason: 'bridge did not answer' });
        await health.sweep();
        client.frames.length = 0;

        // A bridge that was briefly unreachable must not leave the bot needing
        // a manual start — the poll that noticed is the poll that recovers it.
        provider.healthBySession.set(botId, { ok: true });
        await health.sweep();

        const after = await row();
        expect(after.state).toBe('RUNNING');
        expect(after.lastError).toBeNull();
        expect(stateFrames()).toEqual([{ botId, state: 'RUNNING', widthPx: 1024, heightPx: 768 }]);
      });

      it('writes nothing and says nothing when the state has not changed', async () => {
        await startAndSettle();
        const before = await row();
        client.frames.length = 0;

        await health.sweep();
        await health.sweep();

        expect(await row()).toStrictEqual(before);
        // A frame per sandbox per interval forever is a heartbeat §4.2 never
        // asked for, and every client would have to learn to ignore it.
        expect(stateFrames()).toEqual([]);
        expect(provider.healthCallsFor(botId)).toBe(2);
      });
    });

    describe('the lock it does not hold (D-029)', () => {
      it('never probes or moves a STARTING row', async () => {
        // STARTING in this column IS the start lock. A poll that wrote here
        // would release a lease mid-create, which is exactly how a second
        // container appears for one bot.
        provider.createDelayMs = 300;
        const starting = sandboxes.start(USER_ID, botId);
        await waitFor(async () => (await stateOf(botId)) === 'STARTING');

        provider.healthBySession.set(botId, { ok: false, reason: 'should never be asked' });
        await health.sweep();

        expect(provider.healthCallsFor(botId)).toBe(0);
        expect(await stateOf(botId)).toBe('STARTING');
        await expect(starting).resolves.toMatchObject({ state: 'RUNNING' });
        expect(provider.createCalls).toBe(1);
      });

      it('leaves a STOPPED row alone — it was stopped deliberately', async () => {
        await startAndSettle();
        await sandboxes.stop(USER_ID, botId);

        await health.sweep();

        // Resurrecting a sandbox the operator stopped would be the poll
        // deciding policy, and it has no idea why it was stopped.
        expect(provider.healthCallsFor(botId)).toBe(0);
        expect(await stateOf(botId)).toBe('STOPPED');
      });

      it('leaves an ERROR row alone — its failure is the record', async () => {
        // Created before anything else starts: the fake reports an existing
        // container once ANY session has been created, and a resume would
        // never reach the create this test needs to fail.
        provider.failCreateWith = new Error('image crewaid/sandbox:dev not found');
        await expect(sandboxes.start(USER_ID, botId)).rejects.toThrow();
        provider.failCreateWith = null;
        expect(await stateOf(botId)).toBe('ERROR');

        await health.sweep();

        expect(provider.healthCallsFor(botId)).toBe(0);
        expect(await stateOf(botId)).toBe('ERROR');
        expect((await row()).lastError).toBe('image crewaid/sandbox:dev not found');
      });

      it('loses the write to a lifecycle claim that lands mid-probe', async () => {
        await startAndSettle();
        client.frames.length = 0;

        // The read-probe-write window, forced open. A stop takes the lease
        // while the probe is in flight, so the poll's compare-and-swap is
        // pinned to a (state, lastStartedAt) pair that no longer exists.
        provider.healthBySession.set(botId, { ok: false, reason: 'stale observation' });
        provider.onHealthProbe.set(botId, async () => {
          provider.onHealthProbe.delete(botId);
          await sandboxes.stop(USER_ID, botId);
        });

        await health.sweep();

        const after = await row();
        expect(after.state).toBe('STOPPED');
        expect(after.lastError).toBeNull();
        // The poll matched zero rows, so it must not announce a state either.
        expect(stateFrames().map((frame) => frame.state)).toEqual(['STOPPED']);
      });

      it('leaves the row untouched when the daemon itself cannot be reached', async () => {
        await startAndSettle();
        const before = await row();
        client.frames.length = 0;

        // A rejected probe says nothing about THIS sandbox. Treating it as
        // unhealthy would turn one Docker hiccup into a fleet-wide state change.
        provider.failHealthFor.add(botId);
        await health.sweep();

        expect(await row()).toStrictEqual(before);
        expect(stateFrames()).toEqual([]);
      });
    });

    describe('recovery (M2-QA-04)', () => {
      it('starts successfully after a sweep marked the sandbox UNHEALTHY', async () => {
        await startAndSettle();
        provider.healthBySession.set(botId, {
          ok: false,
          reason: 'container is not running (exit 137)',
        });
        await health.sweep();
        expect(await stateOf(botId)).toBe('UNHEALTHY');

        provider.healthBySession.set(botId, { ok: true });
        await expect(sandboxes.start(USER_ID, botId)).resolves.toMatchObject({
          state: 'RUNNING',
          lastError: null,
        });
      });

      it('answers a start that raced a sweep, and lets the probe own the row (M4-RV-01)', async () => {
        // ── WHAT THIS TEST USED TO CLAIM, AND WHY IT COULD NOT ──────────────
        //
        // It was written as "starts successfully even when a sweep flips the
        // row mid-claim" and asserted the row ended RUNNING. Both halves were
        // wrong about this scenario, and it failed roughly a third of the time
        // because of it.
        //
        // There is no mid-claim race here: `start` is idempotent, and on a row
        // that is already RUNNING it claims nothing and writes nothing — the
        // row's `state` and `lastStartedAt` are byte-identical before and
        // after. So the sweep's compare-and-swap, which is against the row it
        // read, still matches, and it records what it probed. Whether the row
        // ended RUNNING or UNHEALTHY was therefore decided by which of the two
        // unsynchronised operations the scheduler ran first, not by anything
        // the product promises.
        //
        // What IS promised, and is what this asserts: the caller gets a
        // truthful answer from the read it made, and an unhealthy probe is not
        // silently discarded because a start happened to be in flight.
        // Recovery from the UNHEALTHY row is the test above this one.
        await startAndSettle();
        provider.healthBySession.set(botId, { ok: false, reason: 'flipped mid-claim' });

        // Hold the sweep inside its probe: it has read the row by now, and has
        // not yet written. That is the ordering the scheduler used to pick at
        // random.
        let releaseProbe = (): void => undefined;
        const probing = new Promise<void>((probeStarted) => {
          provider.onHealthProbe.set(botId, () => {
            probeStarted();
            return new Promise<void>((release) => {
              releaseProbe = release;
            });
          });
        });

        const flip = health.sweep();
        await probing;
        const started = await sandboxes.start(USER_ID, botId);
        releaseProbe();
        await flip;

        // The start answered from the row it read, which said RUNNING.
        expect(started).toMatchObject({ state: 'RUNNING' });
        // And the probe's finding survived: an idempotent start neither
        // refreshes the row nor suppresses the sweep that is judging it.
        expect(await stateOf(botId)).toBe('UNHEALTHY');
        expect((await row()).lastError).toBe('flipped mid-claim');
      });
    });

    describe('the sweep itself', () => {
      it('covers every settled sandbox in one pass, not just one', async () => {
        const peers = await Promise.all([newBot(), newBot()]);
        for (const id of [...peers, botId]) {
          await sandboxes.start(USER_ID, id);
          provider.healthBySession.set(id, { ok: false, reason: 'all down' });
        }

        await health.sweep();

        const states = await Promise.all([botId, ...peers].map(stateOf));
        expect(states).toEqual(['UNHEALTHY', 'UNHEALTHY', 'UNHEALTHY']);
      });

      it('skips a tick that arrives while a sweep is still running', async () => {
        await startAndSettle();

        // A slow daemon must not stack ticks: overlapping sweeps would probe
        // the same rows concurrently and race each other's writes.
        let release = (): void => undefined;
        provider.onHealthProbe.set(
          botId,
          () => new Promise<void>((resolve) => (release = resolve)),
        );

        const first = health.sweep();
        await waitFor(async () => provider.healthCallsFor(botId) === 1);
        await health.sweep();
        expect(provider.healthCallsFor(botId)).toBe(1);

        release();
        await first;
      });

      it('survives a probe that throws for one sandbox and still checks the rest', async () => {
        const peer = await newBot();
        await sandboxes.start(USER_ID, peer);
        await startAndSettle();

        // One rejection must not abandon the pass — the other sandbox is still
        // owed an answer, and the sweep only runs again in a full interval.
        provider.failHealthFor.add(botId);
        provider.healthBySession.set(peer, { ok: false, reason: 'down' });

        await expect(health.sweep()).resolves.toBeUndefined();

        expect(await stateOf(botId)).toBe('RUNNING');
        expect(await stateOf(peer)).toBe('UNHEALTHY');
      });
    });
  },
);

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}
