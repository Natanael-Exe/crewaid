import { computerId, privateComputerBot } from './computer-fixtures.js';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';

import { BotsService } from '../src/bots/bots.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SINGLETON_USER_ID } from '../src/auth/singleton-user.js';
import { OCCUPIES_A_SLOT, SandboxService } from '../src/sandbox/sandbox.service.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { FakeProvider } from './sandbox-fakes.js';

/**
 * M2-BE-11 — host capacity admission (§7, D-039).
 *
 * Real database, fake provider, for the same reason M2-BE-04's suite splits
 * that way: the ceiling is a `count` over rows under Postgres' concurrency
 * semantics, and Docker decides none of it.
 *
 * ── WHY THE LIMIT IS RELATIVE ───────────────────────────────────────────────
 *
 * Capacity is deliberately global — it is a claim about the HOST, so it counts
 * every sandbox row, including the ones every other integration suite left
 * behind (a local database carries hundreds). Rather than delete other suites'
 * rows to get a clean number, this suite measures what is already occupied and
 * sets its ceiling two above it. The assertions are then about the two starts
 * this suite makes, while still proving the count is genuinely global: if
 * admission counted only this suite's bots, `base` would be irrelevant and the
 * third start would succeed.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const BOT_PREFIX = 'm2be11cap';

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M2-BE-11 capacity admission (real db)',
  () => {
    let app: INestApplication;
    let bots: BotsService;
    let prisma: PrismaService;
    let sandboxes: SandboxService;
    let provider: FakeProvider;
    /** Occupied slots this suite did not create. */
    let base: number;
    let limit: number;
    const created: string[] = [];

    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');

      // Counted BEFORE the module is built: `SANDBOX_MAX_RUNNING` is read once,
      // in the constructor (D-039 §11), which is the behaviour under test as
      // much as the count is — a ceiling re-read per request could be changed
      // by an operator halfway through a start. `PrismaService` rather than a
      // bare `PrismaClient` because it is what carries the pg driver adapter.
      const probe = new PrismaService();
      base = await probe.sandbox.count({ where: { state: { in: [...OCCUPIES_A_SLOT] } } });
      await probe.$disconnect();

      limit = base + 2;
      process.env['SANDBOX_MAX_RUNNING'] = String(limit);

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
        where: { id: SINGLETON_USER_ID },
        create: {
          id: SINGLETON_USER_ID,
          name: 'Test User',
          email: `${SINGLETON_USER_ID}@test.invalid`,
        },
        update: {},
      });
    });

    afterEach(async () => {
      // Park this suite's rows so every test starts from `base` again. Without
      // this the second test would begin at the ceiling and refuse everything,
      // which is a true statement about the previous test and not about the
      // code.
      if (created.length > 0) {
        await prisma.sandbox.updateMany({
          where: { bots: { some: { id: { in: created } } } },
          data: { state: 'STOPPED', keepRunningUntil: null },
        });
      }
      provider.reset();
    });

    afterAll(async () => {
      // Delete this suite's bots rather than leaving them RUNNING: a leftover
      // occupied row is exactly what this suite had to work around, and
      // leaving more of them behind would push the next run's `base` up.
      await prisma?.bot
        .deleteMany({ where: { userId: SINGLETON_USER_ID, name: { startsWith: BOT_PREFIX } } })
        .catch(() => undefined);
      await app?.close();
      delete process.env['SANDBOX_MAX_RUNNING'];
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

    /** How many times a start actually reached the provider. */
    function acquisitions(): number {
      return provider.createCalls + provider.resumeCalls;
    }

    /** The §7 refusal, unwrapped from the Nest exception it travels in. */
    function bodyOf(error: unknown): Record<string, unknown> {
      const response = (error as { getResponse?: () => unknown }).getResponse?.();
      return response as Record<string, unknown>;
    }

    it('refuses the start that would exceed the ceiling, and says why', async () => {
      await sandboxes.start(SINGLETON_USER_ID, await newBot());
      await sandboxes.start(SINGLETON_USER_ID, await newBot());
      const refused = await newBot();

      const error = await sandboxes.start(SINGLETON_USER_ID, refused).catch((e: unknown) => e);

      expect((error as { getStatus: () => number }).getStatus()).toBe(503);
      expect(bodyOf(error)).toMatchObject({
        statusCode: 503,
        code: 'SANDBOX_CAPACITY',
        detail: { running: limit, limit },
      });
      // 503, not 409: the identical request succeeds once something stops, and
      // the client's correct response is to retry rather than to reconcile.
      expect(String(bodyOf(error)['message'])).toContain(`${limit}`);
    });

    it('leaves the refused bot exactly as it found it', async () => {
      await sandboxes.start(SINGLETON_USER_ID, await newBot());
      await sandboxes.start(SINGLETON_USER_ID, await newBot());
      const refused = await newBot();

      await expect(sandboxes.start(SINGLETON_USER_ID, refused)).rejects.toThrow();

      // D-039 §12 rule 6. A refusal that claimed the lock first would leave
      // STARTING behind, and the bot would then be unstartable for a whole
      // lease — turning "come back in a minute" into a manual recovery.
      const row = await prisma.sandbox.findFirst({ where: { bots: { some: { id: refused } } } });
      expect(row?.state).toBe('STOPPED');
      expect(row?.lastStartedAt).toBeNull();
      expect(row?.lastError).toBeNull();
      // And it never reached Docker. Create plus resume, because the fake
      // provider models one shared "a container exists" flag rather than a
      // container per bot: what matters is that the provider was asked twice,
      // not which of the two ways it was asked.
      expect(acquisitions()).toBe(2);
    });

    it('holds the ceiling when the starts arrive together', async () => {
      // The case a plain check-then-claim gets wrong. Admission spans rows, so
      // Read Committed gives it nothing: five starts for five different bots
      // block on nothing, all read the same count, and all pass. Only the
      // advisory lock makes count-then-occupy atomic, and only this test can
      // tell the difference — measured by removing the lock, every sequential
      // assertion in this file still passed and all FIVE of these starts were
      // admitted against a ceiling of two. A ceiling that holds for every
      // start except a burst is a ceiling that holds except when it matters.
      const botIds = await Promise.all([newBot(), newBot(), newBot(), newBot(), newBot()]);

      const results = await Promise.allSettled(
        botIds.map((botId) => sandboxes.start(SINGLETON_USER_ID, botId)),
      );

      const started = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter((r) => r.status === 'rejected');
      expect(started).toHaveLength(2);
      expect(refused).toHaveLength(3);
      expect(refused.every((r) => bodyOf(r.reason)['code'] === 'SANDBOX_CAPACITY')).toBe(true);
      expect(acquisitions()).toBe(2);
    });

    it('counts a start in flight, not just a running one', async () => {
      // A start that has claimed the lock is already consuming the host: the
      // container is being created right now. Counting only RUNNING would let
      // a burst of starts all pass while none of them had finished.
      provider.createDelayMs = 200;
      const slow = sandboxes.start(SINGLETON_USER_ID, await newBot());
      await waitFor(() => provider.createCalls === 1);
      await sandboxes.start(SINGLETON_USER_ID, await newBot());

      await expect(sandboxes.start(SINGLETON_USER_ID, await newBot())).rejects.toMatchObject({
        response: { code: 'SANDBOX_CAPACITY' },
      });
      await slow;
    });

    it('counts an unhealthy sandbox, whose container is still holding memory', async () => {
      const sick = await newBot();
      await sandboxes.start(SINGLETON_USER_ID, sick);
      await prisma.sandbox.update({
        where: { id: await computerId(prisma, sick) },
        data: { state: 'UNHEALTHY' },
      });
      await sandboxes.start(SINGLETON_USER_ID, await newBot());

      await expect(sandboxes.start(SINGLETON_USER_ID, await newBot())).rejects.toMatchObject({
        response: { code: 'SANDBOX_CAPACITY' },
      });
    });

    it('still lets a bot that already holds a slot restart on a full host', async () => {
      // The reason admission excludes the caller's own occupied row. Restarting
      // an UNHEALTHY sandbox adds no sandbox — the container is already there
      // and already counted — so charging it for a slot it holds would make a
      // full host one where the sick ones can never be recovered.
      const sick = await newBot();
      await sandboxes.start(SINGLETON_USER_ID, sick);
      await sandboxes.start(SINGLETON_USER_ID, await newBot());
      await prisma.sandbox.update({
        where: { id: await computerId(prisma, sick) },
        data: { state: 'UNHEALTHY' },
      });

      const status = await sandboxes.start(SINGLETON_USER_ID, sick);

      expect(status.state).toBe('RUNNING');
      // Admitted AND acted on: a third acquisition on a host whose ceiling is
      // two, because the sick sandbox was already one of the two.
      expect(acquisitions()).toBe(3);
    });

    it('never refuses the idempotent start of a sandbox that is already up', async () => {
      const running = await newBot();
      await sandboxes.start(SINGLETON_USER_ID, running);
      await sandboxes.start(SINGLETON_USER_ID, await newBot());

      // §4.1 calls start idempotent. Answering "the host is full" to a request
      // whose intent is already satisfied would make a client reconcile a
      // desktop that is, in fact, up.
      await expect(sandboxes.start(SINGLETON_USER_ID, running)).resolves.toMatchObject({
        state: 'RUNNING',
      });
    });

    it('gives the slot back when a sandbox stops', async () => {
      const first = await newBot();
      await sandboxes.start(SINGLETON_USER_ID, first);
      await sandboxes.start(SINGLETON_USER_ID, await newBot());
      const waiting = await newBot();
      await expect(sandboxes.start(SINGLETON_USER_ID, waiting)).rejects.toThrow();

      await sandboxes.stop(SINGLETON_USER_ID, first);

      // The half that makes the refusal honest: 503 promises the same request
      // works later, and nothing else in this system frees a slot.
      await expect(sandboxes.start(SINGLETON_USER_ID, waiting)).resolves.toMatchObject({
        state: 'RUNNING',
      });
    });
  },
);

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition was never met');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
