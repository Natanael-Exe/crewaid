import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { z } from 'zod';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TelegramAccountsService } from '../src/telegram/telegram-accounts.service.js';
import { TelegramBotsService } from '../src/telegram/telegram-bots.service.js';
import { TelegramMessagingService } from '../src/telegram/telegram-messaging.service.js';
import { TelegramQueueService } from '../src/telegram/telegram-queue.service.js';
import {
  TELEGRAM_CLIENTS,
  TelegramApiError,
  type TelegramApi,
  type TelegramClients,
  type TelegramManagerApi,
} from '../src/telegram/telegram-api.js';
import { TELEGRAM_CONFIG, telegramDigest } from '../src/telegram/telegram.config.js';
import {
  TELEGRAM_MANAGER,
  TelegramUpdateSchema,
  type TelegramJob,
  type TelegramUpdate,
} from '../src/telegram/telegram.protocol.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { ModelResolutionService } from '../src/models/model-resolution.service.js';
import { ToolRegistry, SENSITIVE_BUILTIN } from '../src/agent/tool-registry.js';
import { VoiceService } from '../src/voice/voice.service.js';
import { ChatSendService } from '../src/chat/chat-send.service.js';
import { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { TELEGRAM_LANES } from '../src/telegram/telegram-queue.service.js';
import { StructuredLogger } from '../src/logging/structured-logger.js';
import { AttachmentsService } from '../src/attachments/attachments.service.js';
import { tool } from '../src/agent/tool-contract.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import { ScriptedAdapter } from './mod-02-tanstack-harness.js';
import { FakeProvider } from './sandbox-fakes.js';

// Owned temporary database supplied by the test command; never touches a provider.
describe.skipIf(!process.env['DATABASE_URL'])(
  'Telegram channel (real auth, persistence and agent)',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let accounts: TelegramAccountsService;
    let bots: TelegramBotsService;
    let messaging: TelegramMessagingService;
    let owner: SignedInUser;
    let stranger: SignedInUser;
    let sequence = 100;
    let nextBot = 7000;
    const telegramId = 123456789;
    const managerSecret = 'm'.repeat(32);
    const tokenFor = (botId: string) => `${botId}:${'t'.repeat(35)}`;
    const queued: TelegramJob[] = [];
    const tokensUsed: string[] = [];
    const effect = vi.fn(async () => 'sent');
    const api = {
      me: vi
        .fn<TelegramApi['me']>()
        .mockResolvedValue({ id: 9001, username: 'mine_crew_bot', canManageBots: false }),
      text: vi.fn<TelegramApi['text']>().mockResolvedValue(undefined),
      answer: vi.fn<TelegramApi['answer']>().mockResolvedValue(undefined),
      download: vi.fn<TelegramApi['download']>().mockResolvedValue(Buffer.from('file contents')),
      document: vi.fn<TelegramApi['document']>().mockResolvedValue(undefined),
      setWebhook: vi.fn<TelegramApi['setWebhook']>().mockResolvedValue(undefined),
      deleteWebhook: vi.fn<TelegramApi['deleteWebhook']>().mockResolvedValue(undefined),
      setCommands: vi.fn<TelegramApi['setCommands']>().mockResolvedValue(undefined),
    } satisfies TelegramApi;
    const manager = {
      ...api,
      me: vi
        .fn<TelegramApi['me']>()
        .mockResolvedValue({ id: 5000, username: 'CrewaidTestBot', canManageBots: true }),
      text: vi.fn<TelegramApi['text']>().mockResolvedValue(undefined),
      managedBotToken: vi
        .fn<TelegramManagerApi['managedBotToken']>()
        .mockImplementation(async (botId) => tokenFor(botId)),
      revokeManagedBotToken: vi
        .fn<TelegramManagerApi['revokeManagedBotToken']>()
        .mockResolvedValue(undefined),
      restrictManagedBot: vi
        .fn<TelegramManagerApi['restrictManagedBot']>()
        .mockResolvedValue(undefined),
    } satisfies TelegramManagerApi;
    const clients: TelegramClients = {
      forToken: (token) => {
        tokensUsed.push(token);
        return api;
      },
      manager: () => manager,
    };

    beforeAll(async () => {
      vi.stubEnv('CREDENTIAL_KEY', 'c4'.repeat(32));
      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module.js');
      const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');
      const adapter = new ScriptedAdapter();
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(TELEGRAM_CONFIG)
        .useValue({
          publicUrl: 'https://crew.example',
          manager: { token: tokenFor('5000'), secret: managerSecret },
          connection: { url: 'redis://127.0.0.1:1', maxRetriesPerRequest: null },
          worker: false,
        })
        .overrideProvider(TELEGRAM_CLIENTS)
        .useValue(clients)
        .overrideProvider(TelegramQueueService)
        .useValue({
          enqueue: async (job: TelegramJob) => {
            queued.push(job);
          },
        })
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(new FakeProvider())
        .overrideProvider(ModelResolutionService)
        .useValue({
          resolveText: async () => ({
            adapter,
            kind: 'custom',
            modelId: 'scripted:test',
            connectionId: 'fixture',
            connectionName: 'Fixture',
            upstreamModelId: 'scripted',
            label: 'Scripted',
            contextWindow: 100000,
            capabilities: { tools: true, vision: false, reasoning: false },
          }),
        })
        .compile();
      app = module.createNestApplication();
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      app.setGlobalPrefix('api/v1');
      await app.listen(0, '127.0.0.1');
      prisma = app.get(PrismaService);
      accounts = app.get(TelegramAccountsService);
      bots = app.get(TelegramBotsService);
      messaging = app.get(TelegramMessagingService);
      app.get(ToolRegistry).register({
        name: 'send_email',
        behavior: SENSITIVE_BUILTIN,
        build: () => tool({ inputSchema: z.object({ to: z.string() }), execute: effect }),
      });
      owner = await signIn(prisma, { label: 'telegram' });
      stranger = await signIn(prisma, { label: 'telegramx' });
    });
    beforeEach(async () => {
      await accounts.disconnect(owner.userId);
      await accounts.disconnect(stranger.userId);
      await prisma.telegramPendingBot.deleteMany({
        where: { telegramBotId: { in: Array.from({ length: 400 }, (_, n) => String(7000 + n)) } },
      });
      await prisma.telegramRetiredBot.deleteMany({
        where: { telegramBotId: { in: Array.from({ length: 400 }, (_, n) => String(7000 + n)) } },
      });
      for (const mock of [api, manager]) for (const fn of Object.values(mock)) fn.mockClear();
      effect.mockClear();
      queued.length = 0;
      tokensUsed.length = 0;
    });
    afterAll(async () => {
      if (prisma && owner) await signOutAndDelete(prisma, owner.userId);
      if (prisma && stranger) await signOutAndDelete(prisma, stranger.userId);
      if (prisma)
        await prisma.telegramRetiredBot.deleteMany({
          where: { telegramBotId: { in: Array.from({ length: 400 }, (_, n) => String(7000 + n)) } },
        });
      await app?.close();
      vi.unstubAllEnvs();
    });

    const person = (id: number, first_name = 'Mobile') => ({ id, is_bot: false, first_name });
    const update = (text: string, id = telegramId, first_name = 'Mobile'): TelegramUpdate => ({
      update_id: sequence++,
      message: {
        message_id: sequence,
        chat: { id, type: 'private' },
        from: person(id, first_name),
        text,
      },
    });
    const callback = (data: string, id = telegramId): TelegramUpdate => ({
      update_id: sequence++,
      callback_query: {
        id: `callback-${sequence}`,
        from: person(id),
        data,
        message: { message_id: sequence, chat: { id, type: 'private' } },
      },
    });
    /** The bot the person's chat runs through; set by `connect`, overridable per call. */
    let bot = '7000';
    const handle = async (u: TelegramUpdate, telegramBotId = bot) => {
      const job = await accounts.prepare(u, telegramBotId);
      if (job) await messaging.handle(job);
      return job;
    };
    /** The manager hears that `creator` made a bot through it. */
    async function created(creator = telegramId, telegramBotId = String(nextBot++)) {
      await messaging.handle({
        telegramBotId: TELEGRAM_MANAGER,
        connectionId: null,
        update: {
          update_id: sequence++,
          managed_bot: {
            user: person(creator),
            bot: {
              id: Number(telegramBotId),
              is_bot: true,
              first_name: 'Crew',
              username: `crew_${telegramBotId}_bot`,
            },
          },
        },
      });
      return telegramBotId;
    }
    const confirm = (actor = owner) =>
      request(app.getHttpServer()).post('/api/v1/channels/telegram/confirm').set(actor.headers);
    /** Scan → create → code → Confirm: the whole managed path. */
    async function connect(actor = owner, id = telegramId) {
      const link = await accounts.link(actor.userId);
      const telegramBotId = await created(id);
      await handle(update(link.code, id), telegramBotId);
      expect((await confirm(actor)).status).toBe(201);
      bot = telegramBotId;
      return prisma.telegramConnection.findUniqueOrThrow({ where: { userId: actor.userId } });
    }
    async function crewMember(actor = owner, name = `Telegram ${randomUUID()}`) {
      return prisma.bot.create({
        data: {
          userId: actor.userId,
          name,
          role: 'fixture',
          avatarColor: '#8B6F47',
          systemPrompt: '',
          conversation: { create: {} },
        },
        include: { conversation: true },
      });
    }
    /** How many of these rows say exactly `text`. Read, then compared: stored text is sealed (D-236). */
    async function said(where: Prisma.MessageWhereInput, text: string) {
      const rows = await prisma.message.findMany({ where, select: { content: true } });
      return rows.filter((row) => row.content === text).length;
    }

    async function idle(botId: string) {
      await vi.waitFor(
        async () => {
          const runs = await prisma.agentTurn.findMany({ where: { botId } });
          expect(runs.length).toBeGreaterThan(0);
          expect(runs.every((run) => run.status !== 'running')).toBe(true);
        },
        { timeout: 10000 },
      );
    }
    const lastWebhookSecret = () => {
      const call = api.setWebhook.mock.calls.at(-1);
      if (!call) throw new Error('no webhook was registered');
      return { url: call[0], secret: call[1] };
    };

    it('requires a session for account controls, and each webhook’s own secret', async () => {
      const server = app.getHttpServer();
      for (const [method, path] of [
        ['get', '/channels/telegram'],
        ['post', '/channels/telegram/link'],
        ['post', '/channels/telegram/bot'],
        ['post', '/channels/telegram/confirm'],
        ['delete', '/channels/telegram'],
      ] as const)
        expect((await request(server)[method](`/api/v1${path}`)).status).toBe(401);
      expect((await request(server).get('/api/v1/channels/telegram/bots/1/webhook')).status).toBe(
        404,
      );
      const hook = (botId: string) => `/api/v1/channels/telegram/bots/${botId}/webhook`;
      expect((await request(server).post(hook('1')).send(update('hello'))).status).toBe(401);
      await connect();
      const { url, secret } = lastWebhookSecret();
      expect(url).toBe(`https://crew.example${hook(bot)}`);
      expect(
        (
          await request(server)
            .post(hook(bot))
            .set('X-Telegram-Bot-Api-Secret-Token', 'x'.repeat(43))
            .send(update('hello'))
        ).status,
      ).toBe(401);
      expect(
        (
          await request(server)
            .post(hook('99999'))
            .set('X-Telegram-Bot-Api-Secret-Token', secret)
            .send(update('hello'))
        ).status,
      ).toBe(401);
      expect(
        (
          await request(server)
            .post(hook(bot))
            .set('X-Telegram-Bot-Api-Secret-Token', secret)
            .send({ update_id: 'bad' })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(server)
            .post(hook(bot))
            .set('X-Telegram-Bot-Api-Secret-Token', secret)
            .send(update('hello'))
        ).status,
      ).toBe(200);
      expect(queued.at(-1)).toMatchObject({ telegramBotId: bot });
      const managerHook = '/api/v1/channels/telegram/manager/webhook';
      expect((await request(server).post(managerHook).send(update('hi'))).status).toBe(401);
      expect(
        (
          await request(server)
            .post(managerHook)
            .set('X-Telegram-Bot-Api-Secret-Token', managerSecret)
            .send(update('hi'))
        ).status,
      ).toBe(200);
      expect(queued.at(-1)).toMatchObject({ telegramBotId: TELEGRAM_MANAGER });
    });
    it('creates a restricted, sealed pending bot, and links it only after Confirm', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/channels/telegram/link')
        .set(owner.headers);
      expect(response.status).toBe(201);
      const { code, createUrl } = response.body as { code: string; createUrl: string };
      expect(createUrl).toMatch(
        /^https:\/\/t\.me\/newbot\/CrewaidTestBot\/[a-z]+_crew_[a-z2-9]{4}_bot\?name=/,
      );
      expect(
        (await prisma.telegramLinkTicket.findUniqueOrThrow({ where: { userId: owner.userId } }))
          .tokenHash,
      ).toBe(telegramDigest(code));
      const telegramBotId = await created();
      expect(manager.restrictManagedBot).toHaveBeenCalledWith(telegramBotId);
      const pending = await prisma.telegramPendingBot.findUniqueOrThrow({
        where: { telegramBotId },
      });
      expect(pending).toMatchObject({
        managed: true,
        userId: null,
        ownerTelegramUserId: String(telegramId),
      });
      expect(pending.tokenCiphertext).not.toContain(tokenFor(telegramBotId).split(':')[1]);
      expect(pending.webhookSecretHash).toBe(telegramDigest(lastWebhookSecret().secret));

      const job = await accounts.prepare(update(`/start ${code}`), telegramBotId);
      expect(JSON.stringify(job)).not.toContain(code);
      await messaging.handle(job!);
      expect(await prisma.telegramConnection.count({ where: { userId: owner.userId } })).toBe(0);
      expect((await accounts.status(owner.userId)).pending).toMatchObject({
        botUsername: `crew_${telegramBotId}_bot`,
        telegramName: 'Mobile',
      });
      expect(api.text.mock.calls.at(-1)?.[1]).toContain('Confirm the connection in Crewaid');

      expect((await confirm()).status).toBe(201);
      const connection = await prisma.telegramConnection.findUniqueOrThrow({
        where: { userId: owner.userId },
      });
      expect(connection).toMatchObject({
        telegramBotId,
        managed: true,
        chatId: String(telegramId),
      });
      expect(connection.tokenCiphertext).not.toBe(pending.tokenCiphertext);
      expect(tokensUsed.at(-1)).toBe(tokenFor(telegramBotId));
      expect(await prisma.telegramPendingBot.count({ where: { telegramBotId } })).toBe(0);
      expect(api.setCommands).toHaveBeenCalled();
      expect((await confirm()).status).toBe(404);
    });
    it('leaves a bot made with someone else’s code waiting for that account to Confirm or Cancel', async () => {
      const link = await accounts.link(owner.userId);
      const attacker = telegramId + 5;
      const theirs = await created(attacker);
      await handle(update(link.code, attacker, 'Mallory'), theirs);
      expect(await prisma.telegramConnection.count({ where: { userId: owner.userId } })).toBe(0);
      expect((await accounts.status(owner.userId)).pending?.telegramName).toBe('Mallory');
      const cancelled = await request(app.getHttpServer())
        .delete('/api/v1/channels/telegram')
        .set(owner.headers);
      expect(cancelled.status).toBe(200);
      expect(await prisma.telegramPendingBot.count({ where: { telegramBotId: theirs } })).toBe(0);
      expect(api.deleteWebhook).toHaveBeenCalled();
      expect(manager.revokeManagedBotToken).toHaveBeenCalledWith(theirs);
      expect((await confirm()).status).toBe(404);
    });
    it('hears only a managed bot’s creator, and retires it after five wrong codes', async () => {
      const link = await accounts.link(owner.userId);
      const telegramBotId = await created();
      await handle(update(link.code, telegramId + 9), telegramBotId);
      expect(
        (await prisma.telegramPendingBot.findUniqueOrThrow({ where: { telegramBotId } })).claimedAt,
      ).toBeNull();
      for (let attempt = 0; attempt < 5; attempt++)
        await handle(update('AAAA-AAAA'), telegramBotId);
      expect(await prisma.telegramPendingBot.count({ where: { telegramBotId } })).toBe(0);
      expect(api.text.mock.calls.at(-1)?.[1]).toContain('Too many wrong codes');
      expect(manager.revokeManagedBotToken).toHaveBeenCalledWith(telegramBotId);
      await handle(update(link.code), telegramBotId);
      expect((await accounts.status(owner.userId)).pending).toBeNull();
    });
    it('links a pasted BotFather token through its Start link, for its own account only', async () => {
      api.me.mockResolvedValueOnce({ id: 7301, username: 'mine_crew_bot', canManageBots: false });
      const response = await request(app.getHttpServer())
        .post('/api/v1/channels/telegram/bot')
        .set(owner.headers)
        .send({ token: tokenFor('7301') });
      expect(response.status).toBe(201);
      const { code, openUrl } = response.body as { code: string; openUrl: string };
      expect(openUrl).toBe(`https://t.me/mine_crew_bot?start=${code}`);
      expect(lastWebhookSecret().url).toBe(
        'https://crew.example/api/v1/channels/telegram/bots/7301/webhook',
      );
      const strangerCode = (await accounts.link(stranger.userId)).code;
      await handle(update(`/start ${strangerCode}`), '7301');
      expect((await accounts.status(owner.userId)).pending?.telegramName).toBeNull();
      await handle(update(`/start ${code}`), '7301');
      expect((await confirm()).status).toBe(201);
      expect(
        await prisma.telegramConnection.findUniqueOrThrow({ where: { userId: owner.userId } }),
      ).toMatchObject({ telegramBotId: '7301', managed: false, botUsername: 'mine_crew_bot' });
      await request(app.getHttpServer()).delete('/api/v1/channels/telegram').set(owner.headers);
      expect(manager.revokeManagedBotToken).not.toHaveBeenCalled();
      expect(api.deleteWebhook).toHaveBeenCalled();
    });
    it('turns a token Telegram refuses into 400, and an unreachable Telegram into 503', async () => {
      const send = () =>
        request(app.getHttpServer())
          .post('/api/v1/channels/telegram/bot')
          .set(owner.headers)
          .send({ token: tokenFor('7302') });
      api.me.mockRejectedValueOnce(new TelegramApiError(401));
      expect((await send()).status).toBe(400);
      api.me.mockRejectedValueOnce(new TelegramApiError(502));
      expect((await send()).status).toBe(503);
      expect(
        (
          await request(app.getHttpServer())
            .post('/api/v1/channels/telegram/bot')
            .set(owner.headers)
            .send({ token: 'not a token' })
        ).status,
      ).toBe(400);
    });
    it('refuses an expired code, and a new code once the account has a bot', async () => {
      const link = await accounts.link(owner.userId);
      await prisma.telegramLinkTicket.update({
        where: { userId: owner.userId },
        data: { expiresAt: new Date(0) },
      });
      const telegramBotId = await created();
      await handle(update(link.code), telegramBotId);
      expect(api.text.mock.calls.at(-1)?.[1]).toContain('isn’t right or has expired');
      await connect();
      await expect(accounts.link(owner.userId)).rejects.toMatchObject({ status: 409 });
    });
    it('refreshes a managed bot’s token, and disconnects when Telegram moves its owner', async () => {
      const connection = await connect();
      await created(telegramId, bot);
      const refreshed = await prisma.telegramConnection.findUniqueOrThrow({
        where: { userId: owner.userId },
      });
      expect(refreshed.id).toBe(connection.id);
      expect(refreshed.tokenCiphertext).not.toBe(connection.tokenCiphertext);
      expect(refreshed.webhookSecretHash).toBe(telegramDigest(lastWebhookSecret().secret));
      await created(telegramId + 1, bot);
      expect(await prisma.telegramConnection.count({ where: { userId: owner.userId } })).toBe(0);
    });
    it('retires bots that waited too long, and clears expired codes', async () => {
      await accounts.link(owner.userId);
      const telegramBotId = await created();
      await prisma.telegramPendingBot.update({
        where: { telegramBotId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await prisma.telegramLinkTicket.update({
        where: { userId: owner.userId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await bots.cleanup();
      expect(await prisma.telegramPendingBot.count({ where: { telegramBotId } })).toBe(0);
      expect(await prisma.telegramLinkTicket.count({ where: { userId: owner.userId } })).toBe(0);
      expect(manager.revokeManagedBotToken).toHaveBeenCalledWith(telegramBotId);
    });
    it('sends `/name text` to that crew member and lists the crew in the menu', async () => {
      await connect();
      const emma = await crewMember(owner, `Emma ${randomUUID().slice(0, 4)}`);
      await crewMember(owner, `Noah ${randomUUID().slice(0, 4)}`);
      const command = emma.name.toLowerCase().replace(' ', '_');
      await handle(update('/help'));
      const menu = api.setCommands.mock.calls.at(-1)?.[0].map((entry) => entry.command);
      expect(menu).toContain(command);
      await handle(update(`/${command} hello there`));
      await idle(emma.id);
      expect((await accounts.status(owner.userId)).connection?.selectedBotId).toBe(emma.id);
      expect(
        await said({ conversationId: emma.conversation!.id, author: 'USER' }, 'hello there'),
      ).toBe(1);
    });
    it('announces a message from Telegram before its run, so an open window shows it', async () => {
      await connect();
      const crew = await crewMember();
      await handle(callback(`b:${crew.id}`));
      const bus = app.get(TurnEventBus);
      const created = vi.spyOn(bus, 'emitCreated');
      const started = vi.spyOn(bus, 'emitRunStarted');
      try {
        await handle(update('from my phone'));
        await idle(crew.id);
        const index = created.mock.calls.findIndex(
          ([botId, row]) => botId === crew.id && row.content === 'from my phone',
        );
        expect(created.mock.calls[index]?.[1].author).toBe('USER');
        const run = started.mock.calls.findIndex(([botId]) => botId === crew.id);
        expect(run).toBeGreaterThanOrEqual(0);
        expect(created.mock.invocationCallOrder[index]).toBeLessThan(
          started.mock.invocationCallOrder[run]!,
        );
      } finally {
        created.mockRestore();
        started.mockRestore();
      }
    });
    it('starts a new topic on `/new`, and opens one with the text after it once', async () => {
      await connect();
      const crew = await crewMember();
      await handle(callback(`b:${crew.id}`));
      const conversationId = crew.conversation!.id;
      const topics = () => prisma.message.count({ where: { conversationId, startsTopic: true } });
      await handle(update('/new'));
      expect(await topics()).toBe(1);
      expect(api.text.mock.calls.at(-1)?.[1]).toBe(
        `New topic with ${crew.name}. Earlier messages stay in Crewaid but are no longer sent to ${crew.name}.`,
      );
      await handle(update('before the next topic'));
      await idle(crew.id);
      const job = await handle(update('/new plan the launch'));
      await idle(crew.id);
      await messaging.handle(job!);
      expect(await topics()).toBe(2);
      const opened = (
        await prisma.message.findMany({ where: { conversationId, author: 'USER' } })
      ).filter((row) => row.content === 'plan the launch');
      expect(opened).toHaveLength(1);
      const topic = await prisma.message.findFirst({
        where: { conversationId, startsTopic: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      expect(topic!.createdAt.getTime()).toBeLessThanOrEqual(opened[0]!.createdAt.getTime());
    });
    it('ignores group chats and never selects another account’s bot', async () => {
      const connection = await connect();
      const foreign = await crewMember(stranger);
      await handle(callback(`b:${foreign.id}`));
      expect((await accounts.status(owner.userId)).connection?.selectedBotId).toBeNull();
      const group = update('hello');
      group.message!.chat = { id: -123, type: 'supergroup' };
      expect(await accounts.prepare(group, bot)).toBeNull();
      expect(await accounts.owned(stranger.userId, connection.id)).toBeNull();
    });
    it('uses the real agent once for a retried update, and delivers only public reply text', async () => {
      const connection = await connect();
      const crew = await crewMember();
      await handle(callback(`b:${crew.id}`));
      api.text.mockClear();
      const job = await handle(update('hello there'));
      await idle(crew.id);
      await messaging.handle(job!);
      expect(api.text).not.toHaveBeenCalled();
      expect(
        await prisma.message.count({
          where: { conversationId: crew.conversation!.id, author: 'USER' },
        }),
      ).toBe(1);
      api.text.mockClear();
      await messaging.deliver(owner.userId, connection.id);
      expect(api.text.mock.calls.some(([, text]) => text.includes('hello from the script'))).toBe(
        true,
      );
      const count = api.text.mock.calls.length;
      await messaging.deliver(owner.userId, connection.id);
      expect(api.text).toHaveBeenCalledTimes(count);
    });
    it('explains when a message is queued while the crew member is working', async () => {
      await connect();
      const crew = await crewMember();
      await handle(callback(`b:${crew.id}`));
      api.text.mockClear();
      const admission = vi
        .spyOn(app.get(ChatSendService), 'admit')
        .mockResolvedValueOnce({ kind: 'deferred' });
      try {
        await handle(update('one more thing'));
        expect(api.text).toHaveBeenCalledExactlyOnceWith(
          String(telegramId),
          `${crew.name} is working. Your message is queued for the next reply.`,
        );
      } finally {
        admission.mockRestore();
      }
    });
    it('routes approval buttons through native chat admission, refuses stale/foreign clicks, and dispatches once', async () => {
      const connection = await connect();
      const crew = await crewMember();
      await handle(callback(`b:${crew.id}`));
      await handle(update('gated please'));
      await idle(crew.id);
      expect(effect).not.toHaveBeenCalled();
      await messaging.deliver(owner.userId, connection.id);
      const buttons = api.text.mock.calls.flatMap(([, , rows]) => rows?.flat() ?? []);
      const approve = buttons.find((button) => button.callback_data.startsWith('a:'))!;
      expect(approve).toBeDefined();
      await handle(callback(approve.callback_data, telegramId + 1));
      await handle(callback(approve.callback_data.slice(0, -1) + 'x'));
      expect(effect).not.toHaveBeenCalled();
      await handle(callback(approve.callback_data));
      await vi.waitFor(() => expect(effect).toHaveBeenCalledTimes(1), { timeout: 10000 });
      await idle(crew.id);
      await handle(callback(approve.callback_data));
      expect(effect).toHaveBeenCalledTimes(1);
    });
    it('imports a Telegram file through owned attachment storage', async () => {
      await connect();
      const crew = await crewMember();
      await handle(callback(`b:${crew.id}`));
      const media = update('read this file');
      media.message!.document = {
        file_id: 'file-1',
        file_name: 'note.txt',
        mime_type: 'text/plain',
        file_size: 12,
      };
      await handle(TelegramUpdateSchema.parse(media));
      await idle(crew.id);
      const files = await prisma.attachment.findMany({
        where: { ownerId: owner.userId, message: { conversationId: crew.conversation!.id } },
      });
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ filename: 'note.txt', mimeType: 'text/plain' });
    });
    it('rejects a native approval without executing the tool', async () => {
      const connection = await connect();
      const crew = await crewMember();
      await handle(callback(`b:${crew.id}`));
      await handle(update('gated please'));
      await idle(crew.id);
      await messaging.deliver(owner.userId, connection.id);
      const reject = api.text.mock.calls
        .flatMap(([, , rows]) => rows?.flat() ?? [])
        .find((button) => button.callback_data.startsWith('r:'))!;
      await handle(callback(reject.callback_data));
      await idle(crew.id);
      expect(effect).not.toHaveBeenCalled();
      expect(
        await prisma.runInterrupt.count({
          where: { userId: owner.userId, conversationId: crew.conversation!.id, status: 'pending' },
        }),
      ).toBe(0);
    });
    it('uses the existing voice-note service and stores its transcript in normal chat', async () => {
      await connect();
      const crew = await crewMember();
      await handle(callback(`b:${crew.id}`));
      const voice = vi
        .spyOn(app.get(VoiceService), 'storeNote')
        .mockImplementationOnce(async (userId, clip) => {
          const attachment = await app
            .get(AttachmentsService)
            .store(
              { userId },
              { ...clip, size: clip.buffer?.length },
              { kind: 'VOICE_NOTE', durationMs: 1000 },
            );
          return { attachment, transcript: 'hello from my phone' };
        });
      const note = update('');
      note.message!.voice = { file_id: 'voice-1', mime_type: 'audio/ogg', duration: 1 };
      await handle(note);
      await idle(crew.id);
      expect(voice).toHaveBeenCalledOnce();
      voice.mockRestore();
      expect(
        await said(
          { conversationId: crew.conversation!.id, author: 'USER' },
          'hello from my phone',
        ),
      ).toBe(1);
    });
    it('delivers an owned output file and retains the cursor when sending fails', async () => {
      const connection = await connect();
      const crew = await crewMember();
      await handle(callback(`b:${crew.id}`));
      await handle(update('hello'));
      await idle(crew.id);
      const reply = await prisma.message.findFirstOrThrow({
        where: {
          conversationId: crew.conversation!.id,
          author: 'BOT',
        },
      });
      const attachment = await app.get(AttachmentsService).store(
        { userId: owner.userId },
        {
          originalname: 'result.txt',
          mimetype: 'text/plain',
          size: 6,
          buffer: Buffer.from('result'),
        },
      );
      await app.get(AttachmentsService).claimForMessage(owner.userId, attachment.id, reply.id);
      const before = (await accounts.owned(owner.userId, connection.id))!.lastMessageSequence;
      api.text.mockRejectedValueOnce(new Error('transient send failure'));
      await expect(messaging.deliver(owner.userId, connection.id)).rejects.toThrow();
      expect((await accounts.owned(owner.userId, connection.id))!.lastMessageSequence).toBe(before);
      await messaging.deliver(owner.userId, connection.id);
      expect(api.document).toHaveBeenCalledWith(
        String(telegramId),
        Buffer.from('result'),
        'result.txt',
        'text/plain',
      );
      await messaging.deliver(owner.userId, connection.id);
      expect(api.document).toHaveBeenCalledOnce();
    });
    it('delivers a late spoken reply once without repeating text, including after same-bot selection', async () => {
      const connection = await connect();
      const crew = await crewMember();
      await handle(callback(`b:${crew.id}`));
      await handle(update('hello'));
      await idle(crew.id);
      await messaging.deliver(owner.userId, connection.id);
      const reply = await prisma.message.findFirstOrThrow({
        where: { conversationId: crew.conversation!.id, author: 'BOT' },
      });
      api.text.mockClear();
      const attachment = await app.get(AttachmentsService).store(
        { userId: owner.userId },
        {
          originalname: 'reply.mp3',
          mimetype: 'audio/mpeg',
          size: 5,
          buffer: Buffer.from('audio'),
        },
      );
      await app.get(AttachmentsService).claimForMessage(owner.userId, attachment.id, reply.id);
      const selectedAt = (await accounts.owned(owner.userId, connection.id))!.selectedAt;
      await handle(callback(`b:${crew.id}`));
      expect((await accounts.owned(owner.userId, connection.id))!.selectedAt).toEqual(selectedAt);
      api.text.mockClear();
      api.document.mockRejectedValueOnce(new Error('transient file send failure'));
      await expect(messaging.deliver(owner.userId, connection.id)).rejects.toThrow();
      await messaging.deliver(owner.userId, connection.id);
      await messaging.deliver(owner.userId, connection.id);
      expect(api.text).not.toHaveBeenCalled();
      expect(api.document).toHaveBeenCalledTimes(2);
      expect(api.document).toHaveBeenLastCalledWith(
        String(telegramId),
        Buffer.from('audio'),
        'reply.mp3',
        'audio/mpeg',
      );
      expect(
        await prisma.telegramAttachmentDelivery.count({ where: { connectionId: connection.id } }),
      ).toBe(1);
    });
    it('lets one code claim one bot, even when two of the creator’s bots race for it', async () => {
      const link = await accounts.link(owner.userId);
      const [first, second] = [await created(), await created()];
      const claimant = {
        telegramUserId: String(telegramId),
        chatId: String(telegramId),
        displayName: 'Mobile',
      };
      const claims = await Promise.all([
        accounts.claim(first, claimant, telegramDigest(link.code)),
        accounts.claim(second, claimant, telegramDigest(link.code)),
      ]);
      expect(claims.filter((claim) => claim.outcome === 'claimed')).toHaveLength(1);
      expect(await prisma.telegramPendingBot.count({ where: { userId: owner.userId } })).toBe(1);
    });
    it('holds at most three unclaimed bots per creator', async () => {
      for (let made = 0; made < 4; made++) await created(telegramId + 20);
      expect(
        await prisma.telegramPendingBot.count({
          where: { ownerTelegramUserId: String(telegramId + 20) },
        }),
      ).toBe(3);
    });
    it('invalidates queued work after disconnect/reconnect and refuses a banned account', async () => {
      const old = await connect();
      const job = await accounts.prepare(update('old message'), old.telegramBotId);
      await accounts.disconnect(owner.userId);
      const current = await connect();
      expect(current.id).not.toBe(old.id);
      await messaging.handle(job!);
      expect(await said({ conversation: { bot: { userId: owner.userId } } }, 'old message')).toBe(
        0,
      );
      await prisma.user.update({ where: { id: owner.userId }, data: { banned: true } });
      expect(
        await accounts.resolve(current.telegramBotId, String(telegramId), String(telegramId)),
      ).toBeNull();
      await prisma.user.update({ where: { id: owner.userId }, data: { banned: false } });
    });
    it('still gives a code when the manager is unreachable, just without the QR link', async () => {
      manager.me.mockRejectedValueOnce(new TelegramApiError(502));
      const response = await request(app.getHttpServer())
        .post('/api/v1/channels/telegram/link')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(201);
      expect(response.body).toMatchObject({ createUrl: null });
    });
    it('records a reply or file Telegram refuses, and keeps delivering what follows', async () => {
      const connection = await connect();
      const crew = await crewMember();
      await handle(callback(`b:${crew.id}`));
      await handle(update('hello'));
      await idle(crew.id);
      const reply = await prisma.message.findFirstOrThrow({
        where: { conversationId: crew.conversation!.id, author: 'BOT' },
      });
      const attachment = await app
        .get(AttachmentsService)
        .store(
          { userId: owner.userId },
          { originalname: 'bad.bin', mimetype: 'text/plain', size: 3, buffer: Buffer.from('bad') },
        );
      await app.get(AttachmentsService).claimForMessage(owner.userId, attachment.id, reply.id);
      api.text.mockClear();
      api.text.mockRejectedValueOnce(new TelegramApiError(400));
      api.document.mockRejectedValueOnce(new TelegramApiError(400));
      await messaging.deliver(owner.userId, connection.id);
      const sent = api.text.mock.calls.map(([, text]) => text);
      expect(
        sent.some((text) => text.includes('couldn’t be sent to Telegram. Open Crewaid to read')),
      ).toBe(true);
      expect(sent.some((text) => text.includes('bad.bin couldn’t be sent'))).toBe(true);
      const after = (await accounts.owned(owner.userId, connection.id))!;
      expect(after.lastMessageSequence).toBe(reply.sequence);
      expect(
        await prisma.telegramAttachmentDelivery.count({ where: { connectionId: connection.id } }),
      ).toBe(1);
      api.text.mockClear();
      await messaging.deliver(owner.userId, connection.id);
      expect(api.text).not.toHaveBeenCalled();
      expect(api.document).toHaveBeenCalledOnce();
    });
    it('refuses media for a thread awaiting a decision before downloading or transcribing it', async () => {
      const connection = await connect();
      const crew = await crewMember();
      await handle(callback(`b:${crew.id}`));
      await handle(update('gated please'));
      await idle(crew.id);
      await messaging.deliver(owner.userId, connection.id);
      api.download.mockClear();
      const voice = vi.spyOn(app.get(VoiceService), 'storeNote');
      const note = update('');
      note.message!.voice = { file_id: 'voice-2', mime_type: 'audio/ogg', duration: 1 };
      api.text.mockClear();
      await handle(note);
      expect(api.download).not.toHaveBeenCalled();
      expect(voice).not.toHaveBeenCalled();
      voice.mockRestore();
      expect(api.text.mock.calls.some(([, text]) => text.includes('waiting for a decision'))).toBe(
        true,
      );
    });
    it('reuses stored media when admission fails and the update is retried', async () => {
      await connect();
      const crew = await crewMember();
      await handle(callback(`b:${crew.id}`));
      const media = update('read this');
      media.message!.document = { file_id: 'file-r', file_name: 'r.txt', mime_type: 'text/plain' };
      const job = (await accounts.prepare(TelegramUpdateSchema.parse(media)))!;
      const admit = vi
        .spyOn(app.get(ChatSendService), 'admit')
        .mockRejectedValueOnce(new Error('database blip'));
      const remembered: NonNullable<TelegramJob['incoming']>[] = [];
      api.download.mockClear();
      await expect(
        messaging.handle(job, async (incoming) => {
          remembered.push(incoming);
        }),
      ).rejects.toThrow('database blip');
      expect(remembered).toHaveLength(1);
      await messaging.handle({ ...job, incoming: remembered[0] });
      admit.mockRestore();
      await idle(crew.id);
      expect(api.download).toHaveBeenCalledOnce();
      const files = await prisma.attachment.findMany({
        where: { ownerId: owner.userId, filename: 'r.txt' },
      });
      expect(files).toHaveLength(1);
      expect(files[0]!.messageId).not.toBeNull();
    });
    it('offers a reject for an approval it cannot display, and explains one it cannot answer', async () => {
      const connection = await connect();
      const crew = await crewMember();
      await handle(callback(`b:${crew.id}`));
      await handle(update('gated please'));
      await idle(crew.id);
      const pending = await prisma.runInterrupt.findFirstOrThrow({
        where: { userId: owner.userId, conversationId: crew.conversation!.id, status: 'pending' },
      });
      await prisma.runInterrupt.update({ where: { id: pending.id }, data: { payload: {} } });
      api.text.mockClear();
      await messaging.deliver(owner.userId, connection.id);
      const prompt = api.text.mock.calls.find(([, text]) => text.includes('Approval requested'));
      expect(prompt?.[1]).toContain('An action Telegram can’t display');
      const buttons = prompt?.[2]?.flat() ?? [];
      expect(buttons.map((button) => button.text)).toEqual(['Reject']);
      await prisma.runInterrupt.update({
        where: { id: pending.id },
        // A row with no native facet: still blocks admission, but has nothing to resume.
        data: {
          nativeInterruptId: null,
          nativePayload: Prisma.DbNull,
          nativeStatus: null,
          nativeRequestedAt: null,
        },
      });
      api.text.mockClear();
      await handle(update('/approvals'));
      expect(api.text.mock.calls.at(-1)?.[1]).toContain('Telegram can’t show');
      await prisma.runInterrupt.update({
        where: { id: pending.id },
        data: { status: 'cancelled', resolvedAt: new Date() },
      });
    });
    it('writes the announced approval batch only when it changes', async () => {
      const connection = await connect();
      const crew = await crewMember();
      await handle(callback(`b:${crew.id}`));
      await handle(update('hello'));
      await idle(crew.id);
      await messaging.deliver(owner.userId, connection.id);
      const before = (await accounts.owned(owner.userId, connection.id))!.updatedAt;
      await messaging.deliver(owner.userId, connection.id);
      expect((await accounts.owned(owner.userId, connection.id))!.updatedAt).toEqual(before);
    });
    it('scans only connections with something to deliver', async () => {
      const connection = await connect();
      const crew = await crewMember();
      await handle(callback(`b:${crew.id}`));
      const lanes = Array.from({ length: TELEGRAM_LANES }, () => ({ add: vi.fn() }));
      const scanner = new TelegramQueueService(
        null,
        messaging,
        accounts,
        bots,
        prisma,
        app.get(StructuredLogger),
      ) as unknown as { lanes: typeof lanes; scan: () => Promise<void> };
      scanner.lanes = lanes;
      const scanned = async () => {
        for (const lane of lanes) lane.add.mockClear();
        await scanner.scan();
        return lanes.flatMap((lane) => lane.add.mock.calls.map(([, data]) => data.connectionId));
      };
      expect(await scanned()).not.toContain(connection.id);
      await handle(update('hello'));
      await idle(crew.id);
      expect(await scanned()).toContain(connection.id);
      await messaging.deliver(owner.userId, connection.id);
      expect(await scanned()).not.toContain(connection.id);
      await handle(update('gated please'));
      await idle(crew.id);
      expect(await scanned()).toContain(connection.id);
      await messaging.deliver(owner.userId, connection.id);
      expect(await scanned()).not.toContain(connection.id);
      await prisma.bot.delete({ where: { id: crew.id } });
      expect(await scanned()).not.toContain(connection.id);
    });

    it.each(['connection', 'pending'] as const)(
      'retries a failed %s webhook move after a worker restart',
      async (kind) => {
        const telegramBotId =
          kind === 'connection' ? (await connect()).telegramBotId : await created();
        const move = () =>
          new TelegramBotsService(
            prisma,
            {
              publicUrl: 'https://moved.example',
              manager: null,
              worker: false,
              connection: { url: 'redis://127.0.0.1:1', maxRetriesPerRequest: null },
            },
            { forToken: clients.forToken, manager: () => null },
            app.get(StructuredLogger),
          );
        api.setWebhook.mockRejectedValueOnce(new TelegramApiError(502));
        await move().reconcile();
        const registered = async () =>
          kind === 'connection'
            ? prisma.telegramConnection.findUniqueOrThrow({ where: { telegramBotId } })
            : prisma.telegramPendingBot.findUniqueOrThrow({ where: { telegramBotId } });
        expect((await registered()).webhookUrl).toBe('');
        api.setWebhook.mockClear();
        await move().reconcile();
        const row = await registered();
        expect(api.setWebhook).toHaveBeenCalledOnce();
        expect(row.webhookUrl).toBe(
          `https://moved.example/api/v1/channels/telegram/bots/${telegramBotId}/webhook`,
        );
        expect(row.webhookSecretHash).toBe(telegramDigest(lastWebhookSecret().secret));
        api.setWebhook.mockClear();
        await move().reconcile();
        expect(api.setWebhook).not.toHaveBeenCalled();
      },
    );
    it.each(['disconnect', 'expiry'] as const)(
      'ignores token-change updates after managed bot %s, including after restart',
      async (reason) => {
        const telegramBotId =
          reason === 'disconnect' ? (await connect()).telegramBotId : await created();
        if (reason === 'disconnect') await accounts.disconnect(owner.userId);
        else {
          await prisma.telegramPendingBot.update({
            where: { telegramBotId },
            data: { expiresAt: new Date(0) },
          });
          await bots.cleanup();
        }
        expect(manager.revokeManagedBotToken).toHaveBeenCalledWith(telegramBotId);
        expect(
          await prisma.telegramRetiredBot.findUnique({ where: { telegramBotId } }),
        ).not.toBeNull();
        manager.managedBotToken.mockClear();
        api.setWebhook.mockClear();
        const restarted = new TelegramBotsService(
          prisma,
          {
            publicUrl: 'https://crew.example',
            manager: { token: tokenFor('5000'), secret: managerSecret },
            worker: false,
            connection: { url: 'redis://127.0.0.1:1', maxRetriesPerRequest: null },
          },
          clients,
          app.get(StructuredLogger),
        );
        await restarted.onManagedBot({
          user: person(telegramId),
          bot: {
            id: Number(telegramBotId),
            is_bot: true,
            first_name: 'Crew',
            username: `crew_${telegramBotId}_bot`,
          },
        });
        expect(await prisma.telegramPendingBot.count({ where: { telegramBotId } })).toBe(0);
        expect(manager.managedBotToken).not.toHaveBeenCalled();
        expect(api.setWebhook).not.toHaveBeenCalled();
        // A tombstone does not occupy one of the creator's pending-bot slots.
        for (let index = 0; index < 3; index++) await created();
        expect(
          await prisma.telegramPendingBot.count({
            where: { ownerTelegramUserId: String(telegramId) },
          }),
        ).toBe(3);
      },
    );
    it('retries bare /new without resetting newer context or another selected crew member', async () => {
      await connect();
      const crew = await crewMember();
      const other = await crewMember();
      await handle(callback(`b:${crew.id}`));
      const job = (await accounts.prepare(update('/new'), bot))!;
      const connection = (await accounts.owned(owner.userId, job.connectionId!))!;
      job.targetBotId = await messaging.targetFor(connection, '/new');
      expect(job.targetBotId).toBe(crew.id);
      api.text.mockRejectedValueOnce(new TelegramApiError(502));
      await expect(messaging.handle(job)).rejects.toThrow();
      await handle(update('message after the new topic'));
      await idle(crew.id);
      await handle(callback(`b:${other.id}`));
      await messaging.handle(job);
      const topics = await prisma.message.findMany({
        where: { conversationId: crew.conversation!.id, startsTopic: true },
      });
      expect(topics).toHaveLength(1);
      expect(
        await prisma.message.count({
          where: { conversationId: other.conversation!.id, startsTopic: true },
        }),
      ).toBe(0);
      const newest = await prisma.message.findFirst({
        where: { conversationId: crew.conversation!.id },
        orderBy: { sequence: 'desc' },
      });
      expect(newest!.sequence).toBeGreaterThan(topics[0]!.sequence);
      expect(newest!.startsTopic).toBe(false);
    });
    it('retries /new text without inserting another boundary after failed admission', async () => {
      await connect();
      const crew = await crewMember();
      await handle(callback(`b:${crew.id}`));
      const job = (await accounts.prepare(update('/new plan the launch'), bot))!;
      const admission = vi
        .spyOn(app.get(ChatSendService), 'admit')
        .mockRejectedValueOnce(new Error('temporary failure'));
      try {
        await expect(messaging.handle(job)).rejects.toThrow('temporary failure');
      } finally {
        admission.mockRestore();
      }
      await handle(update('keep this context'));
      await idle(crew.id);
      await messaging.handle(job);
      await idle(crew.id);
      const rows = await prisma.message.findMany({
        where: { conversationId: crew.conversation!.id },
        orderBy: { sequence: 'asc' },
      });
      expect(rows.filter((row) => row.startsTopic)).toHaveLength(1);
      const boundary = rows.find((row) => row.startsTopic)!;
      expect(rows.find((row) => row.content === 'keep this context')!.sequence).toBeGreaterThan(
        boundary.sequence,
      );
      expect(
        rows.filter((row) => row.author === 'USER' && row.content === 'plan the launch'),
      ).toHaveLength(1);
    });
  },
);
