import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DeleteMessagesResponseSchema, MessageWithAttachmentsSchema } from '@crewaid/shared';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

/**
 * D-147 over HTTP: the three routes answer under the global prefix, parse
 * `forget` as the literal strings, and refuse a foreign bot or message with
 * the same non-leaking 404. The behaviour behind them is in
 * `d147-clear-delete-topic.integration.test.ts`.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);

let app: INestApplication;
let prisma: PrismaService;
let ACTOR: SignedInUser;
let FOREIGN: SignedInUser;

const api = (path: string): string => `/api/v1${path}`;
const http = (): request.Agent => request(app.getHttpServer()) as unknown as request.Agent;

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'D-147 — message deletion and /new routes',
  () => {
    let seed = 0;

    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module.js');
      const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      await app.init();

      prisma = app.get(PrismaService);
      ACTOR = await signIn(prisma, { label: 'd147' });
      FOREIGN = await signIn(prisma, { label: 'd147-foreign' });
    }, 60_000);

    afterAll(async () => {
      if (prisma !== undefined) {
        await signOutAndDelete(prisma, ACTOR.userId);
        await signOutAndDelete(prisma, FOREIGN.userId);
      }
      await app?.close();
    });

    /** A bot and its conversation holding two USER messages. */
    async function makeBot(owner: SignedInUser = ACTOR) {
      seed += 1;
      const bot = await prisma.bot.create({
        data: {
          userId: owner.userId,
          name: `D147 Bot ${RUN_ID}-${seed}`,
          role: 'Tester',
          avatarColor: '#8B6F47',
          systemPrompt: '',
        },
      });
      const conversation = await prisma.conversation.create({ data: { botId: bot.id } });
      const first = await prisma.message.create({
        data: { conversationId: conversation.id, author: 'USER', content: 'first' },
      });
      const second = await prisma.message.create({
        data: { conversationId: conversation.id, author: 'USER', content: 'second' },
      });
      return { botId: bot.id, first: first.id, second: second.id };
    }

    it('DELETE /bots/:id/messages/:messageId removes one message', async () => {
      const { botId, first, second } = await makeBot();
      const res = await http()
        .delete(api(`/bots/${botId}/messages/${first}`))
        .set(ACTOR.headers)
        .expect(200);

      expect(DeleteMessagesResponseSchema.parse(res.body)).toEqual({
        deletedCount: 1,
        forgottenCount: 0,
      });
      expect(await prisma.message.findUnique({ where: { id: first } })).toBeNull();
      expect(await prisma.message.findUnique({ where: { id: second } })).not.toBeNull();
    });

    it('DELETE /bots/:id/messages?forget=true clears the conversation', async () => {
      const { botId } = await makeBot();
      const res = await http()
        .delete(api(`/bots/${botId}/messages?forget=true`))
        .set(ACTOR.headers)
        .expect(200);

      expect(DeleteMessagesResponseSchema.parse(res.body).deletedCount).toBe(2);
      expect(await prisma.message.count({ where: { conversation: { botId } } })).toBe(0);
    });

    it('rejects a forget value that is not the literal string', async () => {
      const { botId } = await makeBot();
      await http()
        .delete(api(`/bots/${botId}/messages?forget=yes`))
        .set(ACTOR.headers)
        .expect(400);
      expect(await prisma.message.count({ where: { conversation: { botId } } })).toBe(2);
    });

    it('POST /bots/:id/topics returns the boundary', async () => {
      const { botId } = await makeBot();
      const res = await http()
        .post(api(`/bots/${botId}/topics`))
        .set(ACTOR.headers)
        .expect(201);

      const boundary = MessageWithAttachmentsSchema.parse(res.body);
      expect(boundary.startsTopic).toBe(true);
      expect(boundary.author).toBe('SYSTEM');
    });

    it('refuses a foreign bot, and a message that is not in the named bot', async () => {
      const mine = await makeBot();
      const theirs = await makeBot(FOREIGN);

      // Each foreign row is proven reachable by its owner first, so the 404s
      // below are the fence and not an absent row.
      await http()
        .post(api(`/bots/${theirs.botId}/topics`))
        .set(FOREIGN.headers)
        .expect(201);

      await http()
        .delete(api(`/bots/${theirs.botId}/messages`))
        .set(ACTOR.headers)
        .expect(404);
      await http()
        .post(api(`/bots/${theirs.botId}/topics`))
        .set(ACTOR.headers)
        .expect(404);
      await http()
        .delete(api(`/bots/${mine.botId}/messages/${theirs.first}`))
        .set(ACTOR.headers)
        .expect(404);
      expect(await prisma.message.count({ where: { conversation: { botId: theirs.botId } } })).toBe(
        3,
      );
    });
  },
);
