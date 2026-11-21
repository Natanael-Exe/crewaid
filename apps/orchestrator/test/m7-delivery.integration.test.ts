import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { FakeProvider } from './sandbox-fakes.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  scriptModel,
  MockLanguageModelV4,
  simulateReadableStream,
} from './model-resolution-fake.js';
import type { ScriptPart as LanguageModelV4StreamPart } from './model-resolution-fake.js';
import type { INestApplication } from '@nestjs/common';
import { BotsService } from '../src/bots/bots.service.js';
import { MessagesService } from '../src/messages/messages.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TanStackTurns } from '../src/agent/tanstack-turns.js';
import { BotMessageDeliveryService } from '../src/interbot/bot-message.delivery.service.js';
import { CHAIN_LIMITS } from '../src/interbot/chain.config.js';
import { ChainBudgetService } from '../src/interbot/chain-budget.service.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const USER_ID = 'usr_crewaid_singleton_v1';
const OTHER_USER_ID = 'usr_m7_be_01_other';

/**
 * §6/M7's delivery, one hop at a time, against a real database.
 *
 * Renamed from `m7-be-01-…` once it carried four tasks' evidence: M7-BE-01
 * (the hop itself), M7-BE-02 (the hop ceiling), M7-BE-03 (the token budget
 * and the per-pair cap) and M7-BE-05 (a participant deleted mid-chain). They
 * belong in one file because they are one code path seen under different
 * configuration, and a file per ceiling would boot four Nest contexts to
 * assert four branches of the same function.
 *
 * The core claim is M7-BE-01's: §6/M7 says the receiving bot's turn
 * "triggers as if a user had messaged it, with `author: BOT` and the
 * originating `fromBotId`". Both halves of
 * that sentence are load-bearing and they pull in opposite directions, which
 * is what these cases are for: the row has to look like a BOT message and
 * the TURN has to behave like a user message, and the place the two meet is
 * the prompt the receiving bot is handed.
 *
 * The model is a mock that records its prompt; everything else — the rows,
 * the turn, the chain columns — is real.
 *
 * Every ceiling case has to CONFIGURE its ceiling: D-047 ships all three off,
 * so "configured" is the only way to see one fire at all.
 */

const prompts: Array<Array<{ role: string; content: unknown }>> = [];

function recordingModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'delivery-model',
    doStream: async (options) => {
      prompts.push(structuredClone(options.prompt) as Array<{ role: string; content: unknown }>);
      const chunks: LanguageModelV4StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'on it' },
        { type: 'text-end', id: 't' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        },
      ];
      return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }) };
    },
  });
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M7 inter-bot delivery (real db)',
  () => {
    let app: INestApplication;
    let bots: BotsService;
    let messages: MessagesService;
    let prisma: PrismaService;
    let delivery: BotMessageDeliveryService;
    let budget: ChainBudgetService;
    const created: string[] = [];
    /**
     * D-047 ships every ceiling off, so a case proving one FIRES has to set
     * it. Mutable and injected rather than an environment variable: the
     * service reads `maxHops` per delivery, so one context serves both the
     * configured and the unconfigured case without a second boot or a global
     * the rest of the run can see.
     */
    const limits = { maxHops: 0, maxTokens: 0, maxRepeatSends: 0 };

    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const moduleRef = await Test.createTestingModule({
        imports: [
          (await import('../src/interbot/interbot.module.js')).InterbotModule,
          // The producer a delivered message's run is handed to (D-199).
          (await import('../src/chat/chat-delivery.module.js')).ChatDeliveryModule,
        ],
      })
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(new FakeProvider())
        .overrideProvider(CHAIN_LIMITS)
        .useValue(limits)
        .compile();
      app = moduleRef.createNestApplication();
      await app.init();
      bots = app.get(BotsService);
      messages = app.get(MessagesService);
      prisma = app.get(PrismaService);
      delivery = app.get(BotMessageDeliveryService);
      budget = app.get(ChainBudgetService);
      for (const id of [USER_ID, OTHER_USER_ID]) {
        await prisma.user.upsert({
          where: { id },
          create: { id, name: 'Test User', email: `${id}@test.invalid` },
          update: {},
        });
      }
    });

    afterAll(async () => {
      for (const id of created) {
        await prisma.bot.delete({ where: { id } }).catch(() => undefined);
      }
      await prisma.user.delete({ where: { id: OTHER_USER_ID } }).catch(() => undefined);
      await app?.close();
    });

    beforeEach(() => {
      // Per case: a suite that restores spies would otherwise leave this one
      // pointing at a restored (real) resolver after its first test.
      scriptModel(app, () => recordingModel());
      prompts.length = 0;
      limits.maxHops = 0;
      limits.maxTokens = 0;
      limits.maxRepeatSends = 0;
    });

    async function makeBot(prefix: string, userId = USER_ID) {
      const bot = await bots.create(userId, {
        name: `${prefix}-${randomUUID().slice(0, 8)}`,
        role: 'R',
        avatarColor: '#123456',
        systemPrompt: 'you are a test bot',
      });
      created.push(bot.id);
      return bot;
    }

    /** The last prompt, without the system message, as `role: text` pairs. */
    const lastExchange = () =>
      (prompts[prompts.length - 1] ?? [])
        .filter((message) => message.role !== 'system')
        .map((message) => {
          const text = Array.isArray(message.content)
            ? (message.content as Array<{ text?: string }>).map((p) => p.text ?? '').join('')
            : String(message.content);
          return `${message.role}: ${text}`;
        });

    async function messagesOf(botId: string) {
      return prisma.message.findMany({
        where: { conversation: { botId } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          author: true,
          content: true,
          fromBotId: true,
          chainId: true,
          hopCount: true,
        },
      });
    }

    it('lands as a BOT row carrying the SENDER id, and starts the receiver turning', async () => {
      const sender = await makeBot('m7be01-sender');
      const receiver = await makeBot('m7be01-receiver');

      const outcome = await delivery.deliver({
        userId: USER_ID,
        fromBotId: sender.id,
        toBotId: receiver.id,
        toBotName: receiver.name,
        content: 'please check the invoice',
        chainId: 'chain_delivery_1',
        hopCount: 1,
      });

      expect(outcome.kind).toBe('delivered');

      const rows = await messagesOf(receiver.id);
      // §6/M7's shape: the arriving message is BOT-authored and names the
      // bot that sent it, in the RECEIVER's conversation.
      expect(rows[0]).toMatchObject({
        author: 'BOT',
        content: 'please check the invoice',
        fromBotId: sender.id,
        chainId: 'chain_delivery_1',
        hopCount: 1,
      });
      // The turn ran and answered — the reply is in the same chain, at the
      // same hop, because nothing was delivered by it.
      expect(rows[1]).toMatchObject({
        author: 'BOT',
        fromBotId: receiver.id,
        chainId: 'chain_delivery_1',
        hopCount: 1,
      });
      // The sender gets its receipt, and nothing else. The MESSAGE is one
      // direction, but "queued" was never the last sentence a sender should
      // hear about its own send: the receipt is what makes a delivery
      // provable from a transcript, and its absence is the question the
      // operator used to have to guess at.
      const senderRows = await messagesOf(sender.id);
      expect(senderRows.map((row) => row.author)).toEqual(['SYSTEM']);
      expect(senderRows[0]?.content).toContain(receiver.name);
      expect(senderRows[0]?.content).toContain('was delivered');
    });

    it('reaches the model as a USER turn that names the bot it came from', async () => {
      const sender = await makeBot('m7be01-attrib-from');
      const receiver = await makeBot('m7be01-attrib-to');

      await delivery.deliver({
        userId: USER_ID,
        fromBotId: sender.id,
        toBotId: receiver.id,
        toBotName: receiver.name,
        content: 'can you confirm the totals',
        chainId: 'chain_attrib',
        hopCount: 1,
      });

      const exchange = lastExchange();
      // ONE user message, not an assistant one: §6/M7 delivers "as if a user
      // had messaged it", and the role is what makes the model answer rather
      // than continue.
      expect(exchange).toHaveLength(1);
      expect(exchange[0]).toContain('user:');
      expect(exchange[0]).toContain('can you confirm the totals');
      // And attributed, or the receiving bot answers a teammate as if it
      // were the operator — it would say "you" to a person who is not there.
      expect(exchange[0]).toContain(sender.name);
      expect(exchange[0]).toContain('another bot on this team');
    });

    it('remembers a teammate as a teammate, not as something it said itself', async () => {
      const sender = await makeBot('m7be01-seed-from');
      const receiver = await makeBot('m7be01-seed-to');

      await delivery.deliver({
        userId: USER_ID,
        fromBotId: sender.id,
        toBotId: receiver.id,
        toBotName: receiver.name,
        content: 'the invoice is wrong',
        chainId: 'chain_seed',
        hopCount: 1,
      });
      // A second, ordinary message so the first one is now HISTORY.
      const followUp = await messages.createUserMessage(USER_ID, receiver.id, {
        content: 'what did the other bot say?',
      });
      await app.get(TanStackTurns).startStored(USER_ID, receiver.id, {
        id: followUp.id,
        content: followUp.content,
        chainId: followUp.chainId,
        hopCount: 0,
      });

      const exchange = lastExchange();
      const inbound = exchange.find((line) => line.includes('the invoice is wrong'));
      // The row is `author: BOT`, so the seed's author-only mapping made this
      // `assistant` — the receiving bot read its own history and found itself
      // having said things it never said.
      expect(inbound).toBeDefined();
      expect(inbound).toMatch(/^user:/);
      expect(inbound).toContain(sender.name);
      // Its OWN reply is still its own.
      expect(exchange.some((line) => line.startsWith('assistant:'))).toBe(true);
    });

    it('ends the chain when the receiving bot is gone, and tells the sender so', async () => {
      const sender = await makeBot('m7be01-gone-from');
      const receiver = await makeBot('m7be01-gone-to');
      await prisma.bot.delete({ where: { id: receiver.id } });

      const outcome = await delivery.deliver({
        userId: USER_ID,
        fromBotId: sender.id,
        toBotId: receiver.id,
        toBotName: receiver.name,
        content: 'anyone there',
        chainId: 'chain_gone',
        hopCount: 1,
      });

      expect(outcome).toEqual({ kind: 'bot-gone', missing: 'receiver' });
      // M7-BE-05: clean is not silent. The sender is holding a plan whose
      // next step is a reply that can never arrive, and it is the one bot
      // still here to tell.
      const senderRows = await messagesOf(sender.id);
      expect(senderRows.map((row) => row.author)).toEqual(['SYSTEM']);
      // Named from the job's snapshot — the row it would otherwise be read
      // from is exactly the row that no longer exists.
      expect(senderRows[0]?.content).toContain(receiver.name);
      expect(senderRows[0]?.content).toContain('no longer on this team');
    });

    it('says nothing to a bot that never knew, when the SENDER is the one deleted', async () => {
      const sender = await makeBot('m7be05-sender-gone-from');
      const receiver = await makeBot('m7be05-sender-gone-to');
      await prisma.bot.delete({ where: { id: sender.id } });

      const outcome = await delivery.deliver({
        userId: USER_ID,
        fromBotId: sender.id,
        toBotId: receiver.id,
        toBotName: receiver.name,
        content: 'from beyond',
        chainId: 'chain_sender_gone',
        hopCount: 1,
      });

      expect(outcome).toEqual({ kind: 'bot-gone', missing: 'sender' });
      // The intended recipient never knew a message existed. A note here
      // would be the first it heard of a conversation that never happened.
      expect(await messagesOf(receiver.id)).toEqual([]);
    });

    it('ends a chain the same way when a deletion lands between two real hops', async () => {
      const first = await makeBot('m7be05-mid-a');
      const second = await makeBot('m7be05-mid-b');

      const delivered = await delivery.deliver({
        userId: USER_ID,
        fromBotId: first.id,
        toBotId: second.id,
        toBotName: second.name,
        content: 'start something',
        chainId: 'chain_mid_delete',
        hopCount: 1,
      });
      expect(delivered.kind).toBe('delivered');

      // The reply hop is in flight when the originator is removed — the
      // shape M7-QA-05 drives through a real queue.
      await prisma.bot.delete({ where: { id: first.id } });

      const outcome = await delivery.deliver({
        userId: USER_ID,
        fromBotId: second.id,
        toBotId: first.id,
        toBotName: first.name,
        content: 'here is your answer',
        chainId: 'chain_mid_delete',
        hopCount: 2,
      });

      expect(outcome).toEqual({ kind: 'bot-gone', missing: 'receiver' });
      // The survivor is told, and nothing is left waiting on the dead bot.
      const rows = await messagesOf(second.id);
      expect(rows.at(-1)?.author).toBe('SYSTEM');
      expect(rows.at(-1)?.content).toContain(first.name);
    });

    it('will not deliver across principals, and says the bot is absent (R7)', async () => {
      const sender = await makeBot('m7be01-r7-from');
      const foreign = await makeBot('m7be01-r7-to', OTHER_USER_ID);

      const outcome = await delivery.deliver({
        userId: USER_ID,
        fromBotId: sender.id,
        toBotId: foreign.id,
        toBotName: foreign.name,
        content: 'not for you',
        chainId: 'chain_r7',
        hopCount: 1,
      });

      // Absent and foreign are the same answer everywhere else (D-010), and
      // they are the same answer here: nothing about another user's bots is
      // observable from the outcome.
      expect(outcome).toEqual({ kind: 'bot-gone', missing: 'receiver' });
      expect(await messagesOf(foreign.id)).toEqual([]);
    });

    it('refuses a hop past a configured ceiling and tells BOTH bots why', async () => {
      limits.maxHops = 4;
      const sender = await makeBot('m7be01-hops-from');
      const receiver = await makeBot('m7be01-hops-to');

      const outcome = await delivery.deliver({
        userId: USER_ID,
        fromBotId: sender.id,
        toBotId: receiver.id,
        toBotName: receiver.name,
        content: 'round and round',
        chainId: 'chain_hops',
        hopCount: 5,
      });

      // The send path checks too, but the two are separated by a queue: this
      // is the check that holds when a chain went over while a job waited.
      expect(outcome).toEqual({ kind: 'hop-limit', maxHops: 4 });

      // §6/M7: "a system message posted to both bots" — and the message the
      // chain was carrying is NOT delivered.
      const receiverRows = await messagesOf(receiver.id);
      expect(receiverRows.map((row) => row.author)).toEqual(['SYSTEM']);
      expect(receiverRows[0]?.content).toContain('CHAIN_MAX_HOPS');
      const senderRows = await messagesOf(sender.id);
      expect(senderRows.map((row) => row.author)).toEqual(['SYSTEM']);
      expect(senderRows[0]?.content).toContain('CHAIN_MAX_HOPS');
    });

    it('counts what a chain spent, which is the half a budget cannot work without', async () => {
      const sender = await makeBot('m7be03-spend-from');
      const receiver = await makeBot('m7be03-spend-to');

      // Nothing has run on this chain yet.
      expect(await budget.spentTokens(USER_ID, 'chain_spend')).toBe(0);

      await delivery.deliver({
        userId: USER_ID,
        fromBotId: sender.id,
        toBotId: receiver.id,
        toBotName: receiver.name,
        content: 'do some work',
        chainId: 'chain_spend',
        hopCount: 1,
      });

      // A POSITIVE number, asserted against a measured zero a moment ago. A
      // budget whose meter reads 0 forever never fires, and every case that
      // configures a ceiling still passes — so the presence is the assertion
      // that matters here, not the refusal it later enables.
      const spent = await budget.spentTokens(USER_ID, 'chain_spend');
      expect(spent).toBeGreaterThan(0);
      // And it is this chain's spend, not every chain's.
      expect(await budget.spentTokens(USER_ID, 'chain_spend_other')).toBe(0);
    });

    it('stops a chain that has spent its budget, and tells both bots what it cost', async () => {
      const sender = await makeBot('m7be03-budget-from');
      const receiver = await makeBot('m7be03-budget-to');

      // One real hop, which runs a real turn and spends real (mock) tokens.
      await delivery.deliver({
        userId: USER_ID,
        fromBotId: sender.id,
        toBotId: receiver.id,
        toBotName: receiver.name,
        content: 'first',
        chainId: 'chain_budget',
        hopCount: 1,
      });
      const spent = await budget.spentTokens(USER_ID, 'chain_budget');
      expect(spent).toBeGreaterThan(0);

      // Now set a ceiling the chain has already passed (D-047: a suite
      // proving a limit fires has to configure one).
      limits.maxTokens = 1;

      const outcome = await delivery.deliver({
        userId: USER_ID,
        fromBotId: receiver.id,
        toBotId: sender.id,
        toBotName: sender.name,
        content: 'and back',
        chainId: 'chain_budget',
        hopCount: 2,
      });

      expect(outcome).toEqual({ kind: 'token-budget', spent, budget: 1 });
      // Nothing was delivered into the sender's conversation but notices —
      // the receipt for the hop that DID land, then the ceiling that stopped
      // the one that did not. The ceiling's sentence is found by its content
      // rather than by its position, because the receipt arrived first.
      const senderRows = await messagesOf(sender.id);
      expect(senderRows.map((row) => row.author)).toEqual(['SYSTEM', 'SYSTEM']);
      const ceiling = senderRows.find((row) => row.content.includes('CHAIN_MAX_TOKENS'));
      // §6/M7: reports ACTUAL tokens spent.
      expect(ceiling?.content).toContain(spent.toLocaleString('en-US'));
      const receiverRows = await messagesOf(receiver.id);
      expect(receiverRows.at(-1)?.author).toBe('SYSTEM');
      expect(receiverRows.at(-1)?.content).toContain('CHAIN_MAX_TOKENS');
    });

    it('counts one bots messages to one peer, per chain, from the delivered rows', async () => {
      const sender = await makeBot('m7be04-count-from');
      const receiver = await makeBot('m7be04-count-to');
      const bystander = await makeBot('m7be04-count-other');

      expect(await budget.sendsBetween(USER_ID, 'chain_count', sender.id, receiver.id)).toBe(0);

      for (const content of ['one', 'two']) {
        await delivery.deliver({
          userId: USER_ID,
          fromBotId: sender.id,
          toBotId: receiver.id,
          toBotName: receiver.name,
          content,
          chainId: 'chain_count',
          hopCount: 1,
        });
      }

      // Positive, against the zero measured a moment ago — a counter stuck
      // at 0 never fires and every configured-cap case still passes.
      expect(await budget.sendsBetween(USER_ID, 'chain_count', sender.id, receiver.id)).toBe(2);
      // Per PAIR: a different peer is a different count.
      expect(await budget.sendsBetween(USER_ID, 'chain_count', sender.id, bystander.id)).toBe(0);
      // Per CHAIN: the same pair in another chain starts again.
      expect(await budget.sendsBetween(USER_ID, 'chain_other', sender.id, receiver.id)).toBe(0);
      // And it does not count the receiver's own replies back as sends.
      expect(await budget.sendsBetween(USER_ID, 'chain_count', receiver.id, receiver.id)).toBe(0);
    });

    it('stops one bot pestering one peer without stopping the chain', async () => {
      limits.maxRepeatSends = 2;
      const sender = await makeBot('m7be04-cap-from');
      const receiver = await makeBot('m7be04-cap-to');
      const other = await makeBot('m7be04-cap-other');

      for (const content of ['one', 'two']) {
        const ok = await delivery.deliver({
          userId: USER_ID,
          fromBotId: sender.id,
          toBotId: receiver.id,
          toBotName: receiver.name,
          content,
          chainId: 'chain_cap',
          hopCount: 1,
        });
        expect(ok.kind).toBe('delivered');
      }

      const refused = await delivery.deliver({
        userId: USER_ID,
        fromBotId: sender.id,
        toBotId: receiver.id,
        toBotName: receiver.name,
        content: 'three',
        chainId: 'chain_cap',
        hopCount: 1,
      });
      expect(refused).toEqual({ kind: 'repeat-cap', alreadySent: 2, cap: 2 });

      // The CHAIN is still alive — this ceiling is about a pair, and saying
      // otherwise would end a delegation because one leg of it got noisy.
      const elsewhere = await delivery.deliver({
        userId: USER_ID,
        fromBotId: sender.id,
        toBotId: other.id,
        toBotName: other.name,
        content: 'over to you instead',
        chainId: 'chain_cap',
        hopCount: 1,
      });
      expect(elsewhere.kind).toBe('delivered');
    });

    it('delivers a long chain when no ceiling is configured, which is the default', async () => {
      // D-047's shipped behaviour, asserted rather than assumed: `maxHops` 0
      // is no ceiling. Read the other way this suite would still be green and
      // the product would refuse every message.
      const sender = await makeBot('m7be01-nolimit-from');
      const receiver = await makeBot('m7be01-nolimit-to');

      const outcome = await delivery.deliver({
        userId: USER_ID,
        fromBotId: sender.id,
        toBotId: receiver.id,
        toBotName: receiver.name,
        content: 'still going',
        chainId: 'chain_unbounded',
        hopCount: 500,
      });

      expect(outcome.kind).toBe('delivered');
      const rows = await messagesOf(receiver.id);
      expect(rows[0]).toMatchObject({ author: 'BOT', hopCount: 500, fromBotId: sender.id });
    });
  },
);
