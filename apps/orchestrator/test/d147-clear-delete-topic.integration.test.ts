import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { FakeProvider } from './sandbox-fakes.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MockLanguageModelV4,
  scriptModel,
  simulateReadableStream,
} from './model-resolution-fake.js';
import type { ScriptPart as LanguageModelV4StreamPart } from './model-resolution-fake.js';
import { ConflictException, NotFoundException, type INestApplication } from '@nestjs/common';
import { TanStackTurns } from '../src/agent/tanstack-turns.js';
import { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { AttachmentsService } from '../src/attachments/attachments.service.js';
import { AttachmentReaperService } from '../src/attachments/reaper.service.js';
import { UNCLAIMED_TTL_MS } from '../src/attachments/attachments.config.js';
import { BotsService } from '../src/bots/bots.service.js';
import { MessagesService, NEW_TOPIC_TEXT } from '../src/messages/messages.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { conversationIdOf } from './turn-fixtures.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const USER_ID = 'usr_crewaid_singleton_v1';

/**
 * D-147 — clearing a chat, deleting a message, and `/new`.
 *
 * The seed cases assert on the PROMPT the provider receives, as M5-BE-29's
 * do: a boundary the seed honours but the runner does not send through is the
 * same bug with more code. The deletion cases assert on the rows that must
 * survive as much as on the ones that must go, because "keep memory" and
 * "keep deliverables" are the half of the feature a naive delete gets wrong.
 */

const prompts: Array<Array<{ role: string; content: unknown }>> = [];

function recordingModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'd147-model',
    doStream: async (options) => {
      prompts.push(structuredClone(options.prompt) as Array<{ role: string; content: unknown }>);
      const chunks: LanguageModelV4StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'noted' },
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
  'D-147 clear chat, delete message, /new (real db)',
  () => {
    let app: INestApplication;
    let bots: BotsService;
    let messages: MessagesService;
    let prisma: PrismaService;
    let turns: TanStackTurns;
    let attachments: AttachmentsService;
    const deletedFrames: Array<{ botId: string; messageIds: string[]; cleared: boolean }> = [];
    const created: string[] = [];
    let artifactDir: string;
    const priorArtifactDir = process.env['ARTIFACT_DIR'];

    beforeAll(async () => {
      artifactDir = await mkdtemp(path.join(tmpdir(), 'crewaid-d147-'));
      process.env['ARTIFACT_DIR'] = artifactDir;
      const { Test } = await import('@nestjs/testing');
      const moduleRef = await Test.createTestingModule({
        imports: [
          (await import('../src/bots/bots.module.js')).BotsModule,
          // The producer a stored trigger's run is handed to (D-199).
          (await import('../src/chat/chat-delivery.module.js')).ChatDeliveryModule,
        ],
      })
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(new FakeProvider())
        .compile();
      app = moduleRef.createNestApplication();
      await app.init();
      bots = app.get(BotsService);
      messages = app.get(MessagesService);
      prisma = app.get(PrismaService);
      turns = app.get(TanStackTurns);
      attachments = app.get(AttachmentsService);
      const events = app.get(TurnEventBus);
      const emit = events.emitMessagesDeleted.bind(events);
      events.emitMessagesDeleted = (botId, messageIds, cleared) => {
        deletedFrames.push({ botId, messageIds: [...messageIds], cleared });
        emit(botId, messageIds, cleared);
      };
      await prisma.user.upsert({
        where: { id: USER_ID },
        create: { id: USER_ID, name: 'Test User', email: `${USER_ID}@test.invalid` },
        update: {},
      });
    });

    afterAll(async () => {
      for (const id of created) {
        await prisma.bot.delete({ where: { id } }).catch(() => undefined);
      }
      await app?.close();
      if (priorArtifactDir === undefined) delete process.env['ARTIFACT_DIR'];
      else process.env['ARTIFACT_DIR'] = priorArtifactDir;
      await rm(artifactDir, { recursive: true, force: true });
    });

    beforeEach(() => {
      scriptModel(app, () => recordingModel());
      prompts.length = 0;
      deletedFrames.length = 0;
    });

    async function makeBot(prefix: string) {
      const bot = await bots.create(USER_ID, {
        name: `${prefix}-${randomUUID().slice(0, 8)}`,
        role: 'R',
        avatarColor: '#123456',
        systemPrompt: 'you are a test bot',
      });
      created.push(bot.id);
      return bot;
    }

    /** One settled exchange; returns the USER row and the BOT reply's id. */
    async function say(botId: string, content: string) {
      const trigger = await messages.createUserMessage(USER_ID, botId, { content });
      await turns.startStored(USER_ID, botId, {
        id: trigger.id,
        content: trigger.content,
        chainId: trigger.chainId,
        hopCount: 0,
      });
      const reply = await prisma.message.findFirstOrThrow({
        where: { author: 'BOT', run: { triggerMessageId: trigger.id } },
        select: { id: true },
      });
      return { trigger, replyId: reply.id };
    }

    const lastExchange = () =>
      (prompts[prompts.length - 1] ?? [])
        .filter((message) => message.role !== 'system')
        .map((message) => {
          const text = Array.isArray(message.content)
            ? (message.content as Array<{ text?: string }>).map((p) => p.text ?? '').join('')
            : String(message.content);
          return `${message.role}: ${text}`;
        });

    async function rememberOn(botId: string, messageId: string, text: string) {
      return prisma.memory.create({
        data: { userId: USER_ID, botId, kind: 'FACT', source: 'TOLD', text, messageId },
      });
    }

    describe('/new', () => {
      it('sends nothing from before the boundary, and the transcript keeps it', async () => {
        const bot = await makeBot('d147-topic');
        await say(bot.id, 'The launch is on Friday.');
        const boundary = await messages.startTopic(USER_ID, bot.id);
        await say(bot.id, 'Draft the release notes.');

        expect(boundary.startsTopic).toBe(true);
        expect(boundary.author).toBe('SYSTEM');
        expect(boundary.content).toBe(NEW_TOPIC_TEXT);
        expect(lastExchange()).toEqual(['user: Draft the release notes.']);
        // Nothing was removed: the old subject is still on screen.
        // Compared here, not in the query: stored text is sealed (D-236).
        const kept = await prisma.message.findMany({
          where: { conversation: { botId: bot.id } },
          select: { content: true },
        });
        expect(kept.filter((row) => row.content === 'The launch is on Friday.')).toHaveLength(1);
      });

      it('makes no model call', async () => {
        const bot = await makeBot('d147-topic-free');
        await say(bot.id, 'hello');
        const before = prompts.length;
        await messages.startTopic(USER_ID, bot.id);
        expect(prompts.length).toBe(before);
      });

      it('does not stack a second boundary directly on the first', async () => {
        const bot = await makeBot('d147-topic-idem');
        await say(bot.id, 'hello');
        const first = await messages.startTopic(USER_ID, bot.id);
        const second = await messages.startTopic(USER_ID, bot.id);
        expect(second.id).toBe(first.id);
        const boundaries = await prisma.message.count({
          where: { conversation: { botId: bot.id }, startsTopic: true },
        });
        expect(boundaries).toBe(1);
      });

      it('starts from the NEWEST boundary when there are several', async () => {
        const bot = await makeBot('d147-topic-newest');
        await say(bot.id, 'topic one');
        await messages.startTopic(USER_ID, bot.id);
        await say(bot.id, 'topic two');
        await messages.startTopic(USER_ID, bot.id);
        await say(bot.id, 'topic three');
        expect(lastExchange()).toEqual(['user: topic three']);
      });

      it('restores the earlier context when the boundary is deleted', async () => {
        const bot = await makeBot('d147-topic-undo');
        await say(bot.id, 'My favourite colour is blue.');
        const boundary = await messages.startTopic(USER_ID, bot.id);
        await messages.deleteMessages(USER_ID, bot.id, { messageId: boundary.id, forget: false });
        await say(bot.id, 'What is my favourite colour?');
        expect(lastExchange()).toEqual([
          'user: My favourite colour is blue.',
          'assistant: noted',
          'user: What is my favourite colour?',
        ]);
      });
    });

    describe('delete one message', () => {
      it('removes it from the conversation and the next prompt, and says so', async () => {
        const bot = await makeBot('d147-delete');
        const { trigger } = await say(bot.id, 'Ignore this one.');
        await say(bot.id, 'Keep this one.');

        const result = await messages.deleteMessages(USER_ID, bot.id, {
          messageId: trigger.id,
          forget: false,
        });
        await say(bot.id, 'next');

        expect(result).toEqual({ deletedCount: 1, forgottenCount: 0 });
        expect(await prisma.message.findUnique({ where: { id: trigger.id } })).toBeNull();
        expect(lastExchange()).not.toContain('user: Ignore this one.');
        expect(lastExchange()).toContain('user: Keep this one.');
        expect(deletedFrames).toEqual([
          { botId: bot.id, messageIds: [trigger.id], cleared: false },
        ]);
      });

      it('keeps what was learned from it unless asked to forget', async () => {
        const bot = await makeBot('d147-keep-memory');
        const { replyId } = await say(bot.id, 'I deploy from main.');
        const memory = await rememberOn(bot.id, replyId, 'The user deploys from main.');

        const result = await messages.deleteMessages(USER_ID, bot.id, {
          messageId: replyId,
          forget: false,
        });

        const row = await prisma.memory.findUniqueOrThrow({ where: { id: memory.id } });
        expect(result.forgottenCount).toBe(0);
        expect(row.status).toBe('ACTIVE');
        expect(row.messageId).toBeNull();
      });

      it('forgets what the reply to a USER message learned, and tombstones it', async () => {
        // `remember` links a memory to the reply it was written during, so
        // deleting the user's message has to reach the reply's memories.
        const bot = await makeBot('d147-forget');
        const { trigger, replyId } = await say(bot.id, 'My dog is called Rex.');
        const memory = await rememberOn(bot.id, replyId, "The user's dog is called Rex.");
        const unrelated = await say(bot.id, 'I like tea.');
        const other = await rememberOn(bot.id, unrelated.replyId, 'The user likes tea.');

        const result = await messages.deleteMessages(USER_ID, bot.id, {
          messageId: trigger.id,
          forget: true,
        });

        expect(result).toEqual({ deletedCount: 1, forgottenCount: 1 });
        const forgotten = await prisma.memory.findUniqueOrThrow({ where: { id: memory.id } });
        expect(forgotten.status).toBe('FORGOTTEN');
        const tombstones = await prisma.memoryTombstone.count({
          where: { userId: USER_ID, botId: bot.id },
        });
        expect(tombstones).toBe(1);
        const kept = await prisma.memory.findUniqueOrThrow({ where: { id: other.id } });
        expect(kept.status).toBe('ACTIVE');
      });

      // D-159 §3.7, §3.10: a deleted message cannot come back by replay.
      it('takes the event log of the run that wrote a message, and a clear takes them all', async () => {
        const bot = await makeBot('d147-events');
        const first = await say(bot.id, 'one');
        const second = await say(bot.id, 'two');
        const runOf = async (triggerId: string) =>
          prisma.agentTurn.findFirstOrThrow({
            where: { triggerMessageId: triggerId },
            select: { id: true, conversationId: true },
          });
        const runs = [await runOf(first.trigger.id), await runOf(second.trigger.id)];
        for (const run of runs) {
          await prisma.runEvent.create({
            data: {
              runId: run.id,
              conversationId: run.conversationId,
              userId: USER_ID,
              chunk: { type: 'RUN_STARTED' },
            },
          });
        }
        await prisma.runInterrupt.create({
          data: {
            runId: runs[1]!.id,
            conversationId: runs[1]!.conversationId,
            userId: USER_ID,
            payload: { kind: 'crewaid.tool-approval' },
          },
        });

        // A run writes its own log too, so the second run's is measured, not assumed.
        const secondLog = await prisma.runEvent.count({ where: { runId: runs[1]!.id } });
        expect(secondLog).toBeGreaterThan(0);
        await messages.deleteMessages(USER_ID, bot.id, { messageId: first.replyId, forget: false });
        expect(await prisma.runEvent.count({ where: { runId: runs[0]!.id } })).toBe(0);
        expect(await prisma.runEvent.count({ where: { runId: runs[1]!.id } })).toBe(secondLog);

        await messages.deleteMessages(USER_ID, bot.id, { forget: false });
        expect(await prisma.runEvent.count({ where: { runId: runs[1]!.id } })).toBe(0);
        expect(
          await prisma.runInterrupt.count({ where: { runId: runs[1]!.id, status: 'pending' } }),
        ).toBe(0);
      });

      it('is a 404 for a message in another bot’s conversation', async () => {
        const bot = await makeBot('d147-own');
        const other = await makeBot('d147-other');
        const { trigger } = await say(other.id, 'not yours');

        await expect(
          messages.deleteMessages(USER_ID, bot.id, { messageId: trigger.id, forget: false }),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(await prisma.message.findUnique({ where: { id: trigger.id } })).not.toBeNull();
      });

      it('is refused while a turn is running', async () => {
        const bot = await makeBot('d147-running');
        const { trigger } = await say(bot.id, 'hello');
        await prisma.agentTurn.create({
          data: {
            botId: bot.id,
            conversationId: await conversationIdOf(prisma, bot.id),
            triggerMessageId: trigger.id,
            activeKey: bot.id,
          },
        });

        await expect(
          messages.deleteMessages(USER_ID, bot.id, { messageId: trigger.id, forget: false }),
        ).rejects.toBeInstanceOf(ConflictException);
        await expect(
          messages.deleteMessages(USER_ID, bot.id, { forget: false }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(await prisma.message.findUnique({ where: { id: trigger.id } })).not.toBeNull();
      });
    });

    describe('clear chat', () => {
      it('removes every message, and the next turn starts cold', async () => {
        const bot = await makeBot('d147-clear');
        await say(bot.id, 'one');
        await say(bot.id, 'two');

        const result = await messages.deleteMessages(USER_ID, bot.id, { forget: false });
        await say(bot.id, 'fresh start');

        expect(result.deletedCount).toBe(4);
        expect(lastExchange()).toEqual(['user: fresh start']);
        expect(deletedFrames).toEqual([{ botId: bot.id, messageIds: [], cleared: true }]);
      });

      it('leaves other bots’ conversations alone', async () => {
        const bot = await makeBot('d147-clear-scope');
        const other = await makeBot('d147-clear-other');
        await say(bot.id, 'mine');
        await say(other.id, 'theirs');

        await messages.deleteMessages(USER_ID, bot.id, { forget: false });

        expect(await prisma.message.count({ where: { conversation: { botId: other.id } } })).toBe(
          2,
        );
      });

      it('keeps a deliverable and the file it holds; other files go', async () => {
        const bot = await makeBot('d147-deliverable');
        const { replyId } = await say(bot.id, 'make me a report');
        const upload = {
          originalname: 'report.csv',
          mimetype: 'text/csv',
          buffer: Buffer.from('a,b\n1,2\n'),
        };
        const kept = await attachments.store({ userId: USER_ID }, upload);
        const dropped = await attachments.store({ userId: USER_ID }, upload);
        await attachments.claimForMessage(USER_ID, kept.id, replyId);
        await attachments.claimForMessage(USER_ID, dropped.id, replyId);
        const deliverable = await prisma.deliverable.create({
          data: {
            userId: USER_ID,
            kind: 'FILE',
            title: 'Report',
            botId: bot.id,
            attachmentId: kept.id,
            messageId: replyId,
          },
        });

        await messages.deleteMessages(USER_ID, bot.id, { forget: false });

        const survivor = await prisma.deliverable.findUniqueOrThrow({
          where: { id: deliverable.id },
        });
        expect(survivor.messageId).toBeNull();
        const file = await prisma.attachment.findUniqueOrThrow({ where: { id: kept.id } });
        expect(file.messageId).toBeNull();
        expect(existsSync(path.join(artifactDir, kept.storageKey))).toBe(true);
        expect(await prisma.attachment.findUnique({ where: { id: dropped.id } })).toBeNull();
        expect(existsSync(path.join(artifactDir, dropped.storageKey))).toBe(false);

        // Held, not abandoned: past the unclaimed TTL the reaper leaves it,
        // it still downloads, and it cannot be claimed by a new message or
        // deleted as a stray upload.
        await prisma.attachment.update({
          where: { id: kept.id },
          data: { createdAt: new Date(Date.now() - UNCLAIMED_TTL_MS - 60_000) },
        });
        await app.get(AttachmentReaperService).sweep();
        expect(await prisma.attachment.findUnique({ where: { id: kept.id } })).not.toBeNull();
        expect(existsSync(path.join(artifactDir, kept.storageKey))).toBe(true);
        await expect(attachments.openForDownload(USER_ID, kept.id)).resolves.toMatchObject({
          attachment: { id: kept.id },
        });
        await expect(
          messages.createUserMessage(USER_ID, bot.id, { content: 'x', attachmentIds: [kept.id] }),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          attachments.removeUnclaimed(USER_ID, kept.id, UNCLAIMED_TTL_MS),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('deletes a held file with its bot', async () => {
        const bot = await makeBot('d147-bot-delete');
        const { replyId } = await say(bot.id, 'make me a report');
        const upload = { originalname: 'r.csv', mimetype: 'text/csv', buffer: Buffer.from('a\n') };
        const held = await attachments.store({ userId: USER_ID }, upload);
        await attachments.claimForMessage(USER_ID, held.id, replyId);
        await prisma.deliverable.create({
          data: {
            userId: USER_ID,
            kind: 'FILE',
            title: 'R',
            botId: bot.id,
            attachmentId: held.id,
            messageId: replyId,
          },
        });
        await messages.deleteMessages(USER_ID, bot.id, { forget: false });

        await bots.remove(USER_ID, bot.id);

        expect(await prisma.attachment.findUnique({ where: { id: held.id } })).toBeNull();
        expect(existsSync(path.join(artifactDir, held.storageKey))).toBe(false);
      });

      it('with forget, forgets everything the conversation established', async () => {
        const bot = await makeBot('d147-clear-forget');
        const first = await say(bot.id, 'a');
        const second = await say(bot.id, 'b');
        await rememberOn(bot.id, first.replyId, 'Claim A.');
        await rememberOn(bot.id, second.replyId, 'Claim B.');
        // A memory written with no message is not the conversation's to take.
        const standalone = await prisma.memory.create({
          data: { userId: USER_ID, botId: bot.id, kind: 'FACT', source: 'TOLD', text: 'Claim C.' },
        });

        const result = await messages.deleteMessages(USER_ID, bot.id, { forget: true });

        expect(result.forgottenCount).toBe(2);
        const left = await prisma.memory.findUniqueOrThrow({ where: { id: standalone.id } });
        expect(left.status).toBe('ACTIVE');
      });
    });
  },
);
