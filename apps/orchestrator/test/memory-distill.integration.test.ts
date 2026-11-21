import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  MemoryDistillService,
  type DistilledCandidate,
  type Extractor,
  type ExtractorFor,
} from '../src/memory/memory-distill.service.js';
import { MemoryService, claimHashOf } from '../src/memory/memory.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  DEFAULT_MEMORY_DISTILL_INTERVAL_MS,
  readMemoryDistillIntervalMs,
} from '../src/agent/agent-loop.config.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'usr_crewaid_singleton_v1';
const RUN_ID = randomUUID().slice(0, 8);

/**
 * CC-38 / D-078 — the extraction sweep.
 *
 * Driven directly, never on a timer: asserting an interval policy by waiting
 * for the interval measures the clock. The extractor is a fake throughout, so
 * these cases are about the SWEEP — what it reads, what it refuses to write,
 * and whether it can be run twice — not about how good a model's judgement is.
 */
describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'CC-38 memory distillation',
  () => {
    let prisma: PrismaService;
    let memories: MemoryService;
    let service: MemoryDistillService;
    let botId: string;
    let conversationId: string;

    /**
     * Counts only the calls that saw THIS bot's window.
     *
     * The sweep is system-wide by design — `botsDue` walks every bot — so a
     * plain call counter measures whatever other suites left in the shared
     * database. It passed locally against a truncated database and failed in
     * CI, where a dozen suites leave bots with conversations behind. Matching
     * on RUN_ID is what makes "was MY bot distilled" answerable without
     * assuming this suite is alone.
     */
    function extractor(candidates: DistilledCandidate[]): Extractor & { calls: number } {
      const fn = (async (window) => {
        if (window.some((m) => m.text.includes(RUN_ID))) {
          (fn as unknown as { calls: number }).calls += 1;
          return candidates;
        }
        // Another suite's bot. Propose nothing for it.
        return [];
      }) as Extractor & { calls: number };
      fn.calls = 0;
      return fn;
    }

    /**
     * The same extractor for whoever asks.
     *
     * V1-06 made the sweep ask for one per owner, and these cases are about what
     * the sweep READS and WRITES rather than about which model served it — so
     * they answer every owner identically, and the ownership question gets its
     * own case below.
     */
    const everyOwner =
      (extract: Extractor): ExtractorFor =>
      () =>
        Promise.resolve(extract);

    async function say(n: number): Promise<void> {
      for (let i = 0; i < n; i += 1) {
        await prisma.message.create({
          data: {
            conversationId,
            author: i % 2 === 0 ? 'USER' : 'BOT',
            content: `line ${i} ${RUN_ID}`,
          },
        });
      }
    }

    beforeAll(async () => {
      prisma = new PrismaService();
      await prisma.$connect();
      memories = new MemoryService(prisma);
      // Every case drives `sweep` with its own extractor, so nothing here may
      // reach a provider. A resolver that throws is the assertion: if a future
      // change resolves at construction or inside the sweep, these fail loudly
      // rather than quietly opening a connection from the test suite.
      service = new MemoryDistillService(prisma, memories, {
        resolve: () => {
          throw new Error('the sweep resolved a model when it should not have');
        },
        resolveText: () => {
          throw new Error('the sweep resolved a model when it should not have');
        },
      } as never);

      const bot = await prisma.bot.create({
        data: {
          userId: OWNER,
          name: `cc38-${RUN_ID}`,
          role: 'fixture',
          avatarColor: '#8B6F47',
          systemPrompt: '',
          modelId: 'default',
          conversation: { create: {} },
        },
        include: { conversation: true },
      });
      botId = bot.id;
      conversationId = bot.conversation!.id;
    });

    afterEach(async () => {
      await prisma.memory.deleteMany({ where: { userId: OWNER } });
      await prisma.memoryTombstone.deleteMany({ where: { userId: OWNER } });
      await prisma.memoryDistillation.deleteMany({ where: { botId } });
      await prisma.message.deleteMany({ where: { conversationId } });
    });

    afterAll(async () => {
      await prisma.bot.deleteMany({ where: { id: botId } });
      await prisma.$disconnect();
    });

    it('is disabled by default, and that is a policy not a precaution', () => {
      // D-064 puts remember/forget on the `ask` fallthrough, so the operator was
      // promised memory writes are approved. A background worker writing them
      // silently revokes that promise, which makes switching this on a
      // product decision rather than a tuning one.
      expect(DEFAULT_MEMORY_DISTILL_INTERVAL_MS).toBe(0);
      expect(readMemoryDistillIntervalMs(undefined)).toBe(0);
    });

    it('does not call the model until a bot has accumulated enough', async () => {
      // Triggered by WORK, not by the clock. A sweep that fires on an interval
      // alone spends a model call to read "thanks".
      await say(3);
      const extract = extractor([]);
      await service.sweep(everyOwner(extract));
      expect(extract.calls).toBe(0);
    });

    it('writes what it finds as CANDIDATE, never ACTIVE', async () => {
      // The whole reason this is safe to switch on: a wrong inference becomes a
      // search result, not a standing truth in a trim-proof prompt.
      await say(10);
      await service.sweep(
        everyOwner(
          extractor([
            {
              text: `Deploys run from the repo root ${RUN_ID}`,
              kind: 'CONVENTION',
              scope: 'workspace',
            },
          ]),
        ),
      );
      const rows = await prisma.memory.findMany({ where: { userId: OWNER } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('CANDIDATE');
      expect(rows[0]?.source).toBe('DISTILLED');
    });

    it('refuses to re-derive a claim the user erased', async () => {
      // Without this the sweep re-derives a fact removed by `forget` from the
      // very transcript that established it, and the user's correction silently
      // undoes itself on the next pass.
      const text = `Verbose logs are wanted ${RUN_ID}`;
      await prisma.memoryTombstone.create({
        data: { userId: OWNER, claimHash: claimHashOf(text) },
      });
      await say(10);
      await service.sweep(
        everyOwner(extractor([{ text, kind: 'PREFERENCE', scope: 'workspace' }])),
      );
      expect(await prisma.memory.count({ where: { userId: OWNER } })).toBe(0);
    });

    it('does not duplicate a fact that is already held', async () => {
      const text = `Tests run with pnpm ${RUN_ID}`;
      await prisma.memory.create({
        data: { userId: OWNER, botId: null, kind: 'CONVENTION', source: 'TOLD', text },
      });
      await say(10);
      // Differs only in case and a full stop — the same claim, normalised.
      await service.sweep(
        everyOwner(
          extractor([{ text: `${text.toLowerCase()}.`, kind: 'CONVENTION', scope: 'workspace' }]),
        ),
      );
      expect(await prisma.memory.count({ where: { userId: OWNER } })).toBe(1);
    });

    it('advances the watermark so a second pass reads nothing new', async () => {
      await say(10);
      const first = extractor([
        { text: `First finding ${RUN_ID}`, kind: 'FACT', scope: 'workspace' },
      ]);
      await service.sweep(everyOwner(first));
      expect(first.calls).toBe(1);

      const second = extractor([]);
      await service.sweep(everyOwner(second));
      // No new messages, so the bot is not due and the model is never called.
      expect(second.calls).toBe(0);

      const mark = await prisma.memoryDistillation.findUnique({ where: { botId } });
      expect(mark?.throughCreatedAt).not.toBeNull();
      expect(mark?.candidatesWritten).toBe(1);
    });

    it('re-reads a window rather than skipping it when a pass produced nothing', async () => {
      // A pass that finds nothing worth remembering must still advance, or the
      // same window is re-read and re-charged forever. That is the reason the
      // watermark is a stored row rather than derived from what was written.
      await say(10);
      await service.sweep(everyOwner(extractor([])));
      const mark = await prisma.memoryDistillation.findUnique({ where: { botId } });
      expect(mark?.throughCreatedAt, 'an empty pass left no watermark').not.toBeUndefined();
      expect(mark?.candidatesWritten).toBe(0);

      const again = extractor([]);
      await service.sweep(everyOwner(again));
      expect(again.calls).toBe(0);
    });

    it('is idempotent across a repeated pass, as a restarted worker would be', async () => {
      await say(10);
      const text = `Staging is crewaid-staging ${RUN_ID}`;
      await service.sweep(everyOwner(extractor([{ text, kind: 'FACT', scope: 'workspace' }])));

      // Simulate a crash AFTER the writes and BEFORE the watermark: roll the
      // mark back and run the same window again.
      await prisma.memoryDistillation.update({
        where: { botId },
        data: { throughMessageId: null, throughCreatedAt: null },
      });
      await service.sweep(everyOwner(extractor([{ text, kind: 'FACT', scope: 'workspace' }])));

      expect(await prisma.memory.count({ where: { userId: OWNER, text } })).toBe(1);
    });

    it('honours the requested scope', async () => {
      await say(10);
      await service.sweep(
        everyOwner(
          extractor([
            { text: `Everyone ${RUN_ID}`, kind: 'FACT', scope: 'workspace' },
            { text: `Only me ${RUN_ID}`, kind: 'FACT', scope: 'bot' },
          ]),
        ),
      );
      const rows = await prisma.memory.findMany({
        where: { userId: OWNER },
        orderBy: { text: 'asc' },
      });
      expect(rows.find((r) => r.text.startsWith('Everyone'))?.botId).toBeNull();
      expect(rows.find((r) => r.text.startsWith('Only me'))?.botId).toBe(botId);
    });

    it('survives one bot failing, so another still gets read', async () => {
      await say(10);
      const exploding: Extractor = async () => {
        throw new Error('provider is down');
      };
      await expect(service.sweep(everyOwner(exploding))).resolves.toBeUndefined();
      // The watermark did NOT advance, so the window is read again next time
      // rather than lost.
      expect(await prisma.memoryDistillation.findUnique({ where: { botId } })).toBeNull();
    });

    /**
     * V1-06 / D-086 — the sweep spans every user, so it must resolve per user.
     *
     * Asserted as a PAIRING rather than a call count: a sweep that resolves once
     * for a constant owner still calls the factory, and a count cannot tell that
     * apart from resolving correctly. This records which owner each extractor
     * was built for alongside whose transcript it then read, so the only way to
     * pass is for the two to agree — which is the property that decides whose
     * key pays for the call.
     */
    it("resolves with the bot's own owner, not one owner for the whole pass", async () => {
      const stranger = `usr_distill_other_${RUN_ID}`;
      await prisma.user.create({
        data: { id: stranger, name: 'Stranger', email: `${stranger}@test.invalid` },
      });
      const theirBot = await prisma.bot.create({
        data: {
          userId: stranger,
          name: `cc38-other-${RUN_ID}`,
          role: 'fixture',
          avatarColor: '#8B6F47',
          systemPrompt: '',
          modelId: 'default',
          conversation: { create: {} },
        },
        include: { conversation: true },
      });

      try {
        await say(10);
        for (let i = 0; i < 10; i += 1) {
          await prisma.message.create({
            data: {
              conversationId: theirBot.conversation!.id,
              author: i % 2 === 0 ? 'USER' : 'BOT',
              content: `line ${i} ${RUN_ID} STRANGER`,
            },
          });
        }

        // Built for → whose transcript it was then handed.
        const seen: Array<{ builtFor: string; read: string }> = [];
        const recording: ExtractorFor = (userId) =>
          Promise.resolve(async (window) => {
            const text = window.map((m) => m.text).join('\n');
            // Other suites leave bots behind, so only this run's two are named.
            if (!text.includes(RUN_ID)) return [];
            seen.push({ builtFor: userId, read: text.includes('STRANGER') ? stranger : OWNER });
            return [];
          });

        await service.sweep(recording);

        const mine = seen.filter((e) => e.read === OWNER);
        const theirs = seen.filter((e) => e.read === stranger);
        expect(mine, "this run's own bot was not distilled").toHaveLength(1);
        expect(theirs, "the second user's bot was not distilled").toHaveLength(1);
        expect(mine[0]!.builtFor).toBe(OWNER);
        expect(theirs[0]!.builtFor).toBe(stranger);
      } finally {
        await prisma.memoryDistillation.deleteMany({ where: { botId: theirBot.id } });
        await prisma.message.deleteMany({ where: { conversationId: theirBot.conversation!.id } });
        await prisma.memory.deleteMany({ where: { userId: stranger } });
        await prisma.bot.deleteMany({ where: { id: theirBot.id } });
        await prisma.user.deleteMany({ where: { id: stranger } });
      }
    });

    it('does not stack passes on top of a slow one', async () => {
      await say(10);
      let running = 0;
      let overlapped = false;
      const slow: Extractor = async () => {
        running += 1;
        if (running > 1) overlapped = true;
        await new Promise((r) => setTimeout(r, 30));
        running -= 1;
        return [];
      };
      await Promise.all([
        service.sweep(everyOwner(slow)),
        service.sweep(everyOwner(slow)),
        service.sweep(everyOwner(slow)),
      ]);
      expect(overlapped).toBe(false);
    });
  },
);
