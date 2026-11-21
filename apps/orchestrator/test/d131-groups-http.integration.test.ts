import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  BotGroupSchema,
  ListBotGroupsResponseSchema,
  ListBotsResponseSchema,
  MarkBotReadResponseSchema,
} from '@crewaid/shared';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

/**
 * D-131 — bot groups and unread counts, over HTTP.
 *
 * Two users throughout, so every refusal of a foreign row is asserted against
 * rows that exist and that their owner can reach in the same case.
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
  'D-131 — /groups and unread counts',
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
      ACTOR = await signIn(prisma, { label: 'groups' });
      FOREIGN = await signIn(prisma, { label: 'groups-foreign' });
    }, 60_000);

    afterAll(async () => {
      if (prisma !== undefined) {
        await signOutAndDelete(prisma, ACTOR.userId);
        await signOutAndDelete(prisma, FOREIGN.userId);
      }
      await app?.close();
    });

    /** A bot with its conversation, the way `POST /bots` makes one. */
    async function makeBot(
      owner: SignedInUser = ACTOR,
      lastReadAt: Date | null = null,
    ): Promise<{ botId: string; conversationId: string }> {
      seed += 1;
      const bot = await prisma.bot.create({
        data: {
          userId: owner.userId,
          name: `Group Bot ${RUN_ID}-${seed}`,
          role: 'Tester',
          avatarColor: '#8B6F47',
          systemPrompt: '',
        },
      });
      const conversation = await prisma.conversation.create({
        data: { botId: bot.id, lastReadAt },
      });
      return { botId: bot.id, conversationId: conversation.id };
    }

    const createGroup = (owner: SignedInUser, body: Record<string, unknown>) =>
      http().post(api('/groups')).set(owner.headers).send(body);

    async function listBots(owner: SignedInUser = ACTOR) {
      const res = await http().get(api('/bots')).set(owner.headers).expect(200);
      return ListBotsResponseSchema.parse(res.body);
    }

    describe('groups', () => {
      it('creates, lists in order, renames and collapses a group', async () => {
        const first = BotGroupSchema.parse(
          (await createGroup(ACTOR, { name: 'Sales team' }).expect(201)).body,
        );
        const second = BotGroupSchema.parse(
          (await createGroup(ACTOR, { name: 'Support', instructions: 'Be kind.' }).expect(201))
            .body,
        );
        expect(first).toMatchObject({ name: 'Sales team', instructions: '', collapsed: false });
        expect(second.sortOrder).toBeGreaterThan(first.sortOrder);

        const listed = ListBotGroupsResponseSchema.parse(
          (await http().get(api('/groups')).set(ACTOR.headers).expect(200)).body,
        );
        const ids = listed.map((group) => group.id);
        expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));

        const renamed = BotGroupSchema.parse(
          (
            await http()
              .patch(api(`/groups/${first.id}`))
              .set(ACTOR.headers)
              .send({ name: 'Sales', collapsed: true })
              .expect(200)
          ).body,
        );
        expect(renamed).toMatchObject({ name: 'Sales', collapsed: true });
      });

      it("never shows or changes another user's group", async () => {
        const group = BotGroupSchema.parse(
          (await createGroup(ACTOR, { name: 'Private' }).expect(201)).body,
        );

        const theirs = ListBotGroupsResponseSchema.parse(
          (await http().get(api('/groups')).set(FOREIGN.headers).expect(200)).body,
        );
        expect(theirs.map((g) => g.id)).not.toContain(group.id);

        await http()
          .patch(api(`/groups/${group.id}`))
          .set(FOREIGN.headers)
          .send({ name: 'Taken' })
          .expect(404);
        await http()
          .delete(api(`/groups/${group.id}`))
          .set(FOREIGN.headers)
          .expect(404);

        const row = await prisma.botGroup.findUnique({ where: { id: group.id } });
        expect(row?.name).toBe('Private');
      });

      it('refuses a blank name', async () => {
        await createGroup(ACTOR, { name: '   ' }).expect(400);
      });
    });

    describe('moving a bot', () => {
      it('moves a bot into a group and back out', async () => {
        const { botId } = await makeBot();
        const group = BotGroupSchema.parse(
          (await createGroup(ACTOR, { name: 'Movers' }).expect(201)).body,
        );

        await http()
          .patch(api(`/bots/${botId}`))
          .set(ACTOR.headers)
          .send({ groupId: group.id })
          .expect(200);
        expect((await listBots()).find((bot) => bot.id === botId)?.groupId).toBe(group.id);

        await http()
          .patch(api(`/bots/${botId}`))
          .set(ACTOR.headers)
          .send({ groupId: null })
          .expect(200);
        expect((await listBots()).find((bot) => bot.id === botId)?.groupId).toBeNull();
      });

      it("refuses to move a bot into another user's group", async () => {
        const { botId } = await makeBot();
        const theirs = BotGroupSchema.parse(
          (await createGroup(FOREIGN, { name: 'Not yours' }).expect(201)).body,
        );

        await http()
          .patch(api(`/bots/${botId}`))
          .set(ACTOR.headers)
          .send({ groupId: theirs.id })
          .expect(404);
        const row = await prisma.bot.findUnique({ where: { id: botId } });
        expect(row?.groupId).toBeNull();
      });

      it('deleting a group moves its bots to Unassigned and deletes none', async () => {
        const { botId } = await makeBot();
        const group = BotGroupSchema.parse(
          (await createGroup(ACTOR, { name: 'Short-lived' }).expect(201)).body,
        );
        await prisma.bot.update({ where: { id: botId }, data: { groupId: group.id } });

        await http()
          .delete(api(`/groups/${group.id}`))
          .set(ACTOR.headers)
          .expect(204);

        const bot = await prisma.bot.findUnique({ where: { id: botId } });
        expect(bot).not.toBeNull();
        expect(bot?.groupId).toBeNull();
        expect(await prisma.botGroup.findUnique({ where: { id: group.id } })).toBeNull();
      });
    });

    describe('unread', () => {
      async function botSays(conversationId: string, at: Date, author: 'BOT' | 'USER' = 'BOT') {
        await prisma.message.create({
          data: { conversationId, author, content: 'hello', createdAt: at },
        });
      }

      it("counts the bot's messages since the last read, and nobody else's", async () => {
        const read = new Date(Date.now() - 60_000);
        const { botId, conversationId } = await makeBot(ACTOR, read);
        await botSays(conversationId, new Date(read.getTime() - 1_000)); // before: read
        await botSays(conversationId, new Date(read.getTime() + 1_000));
        await botSays(conversationId, new Date(read.getTime() + 2_000));
        await botSays(conversationId, new Date(read.getTime() + 3_000), 'USER');

        expect((await listBots()).find((bot) => bot.id === botId)?.unreadCount).toBe(2);
      });

      // D-165: a TANSTACK reply is an assistant row per step, all of one run.
      it('counts a run once, however many assistant rows it wrote', async () => {
        const read = new Date(Date.now() - 60_000);
        const { botId, conversationId } = await makeBot(ACTOR, read);
        const run = await prisma.agentTurn.create({
          data: { botId, conversationId, triggerMessageId: 'trigger', status: 'completed' },
        });
        for (const offset of [1_000, 2_000, 3_000]) {
          await prisma.message.create({
            data: {
              conversationId,
              author: 'BOT',
              fromBotId: botId,
              runId: run.id,
              content: 'step',
              createdAt: new Date(read.getTime() + offset),
            },
          });
        }
        await botSays(conversationId, new Date(read.getTime() + 4_000));

        expect((await listBots()).find((bot) => bot.id === botId)?.unreadCount).toBe(2);
      });

      it('marks read, then puts the newest message back to unread', async () => {
        const { botId, conversationId } = await makeBot();
        await botSays(conversationId, new Date(Date.now() - 2_000));
        await botSays(conversationId, new Date(Date.now() - 1_000));
        expect((await listBots()).find((bot) => bot.id === botId)?.unreadCount).toBe(2);

        const read = MarkBotReadResponseSchema.parse(
          (
            await http()
              .post(api(`/bots/${botId}/read`))
              .set(ACTOR.headers)
              .send({})
              .expect(200)
          ).body,
        );
        expect(read.unreadCount).toBe(0);
        expect((await listBots()).find((bot) => bot.id === botId)?.unreadCount).toBe(0);

        const unread = MarkBotReadResponseSchema.parse(
          (
            await http()
              .post(api(`/bots/${botId}/read`))
              .set(ACTOR.headers)
              .send({ unread: true })
              .expect(200)
          ).body,
        );
        expect(unread.unreadCount).toBe(1);
      });

      it("refuses to mark another user's bot", async () => {
        const { botId, conversationId } = await makeBot(FOREIGN);
        await botSays(conversationId, new Date());
        await http()
          .post(api(`/bots/${botId}/read`))
          .set(ACTOR.headers)
          .send({})
          .expect(404);
        expect((await listBots(FOREIGN)).find((bot) => bot.id === botId)?.unreadCount).toBe(1);
      });
    });
  },
);
