import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { WebSocket } from 'ws';
import request from 'supertest';
import { SCREEN_STREAM_PATH } from '@crewaid/shared';
import { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { WsGateway } from '../src/ws/ws.gateway.js';
import { WsPrincipals } from '../src/ws/ws-principals.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

/**
 * V1-09 — the §4.2 socket authenticates a session, and keeps checking.
 *
 * Two properties, and they fail in different directions:
 *
 * 1. THE HANDSHAKE resolves a session during the HTTP Upgrade, so a bad
 *    credential is an HTTP 401 and never becomes a socket (D-024). Tested by
 *    reading the status off the failed upgrade — the thing a client can
 *    actually see.
 * 2. THE FRAMES act as the connection's own principal, re-checked rather than
 *    trusted from the handshake. A socket outlives a sign-out, so a session
 *    revoked at 10:05 must not keep driving a desktop until the client happens
 *    to reconnect.
 *
 * The second is the one that cannot be proven at connect time, and it is why
 * these cases open a socket, revoke underneath it, and then send a frame.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);

let app: INestApplication;
let prisma: PrismaService;
let port: number;
let actor: SignedInUser;

function wsUrl(token: string | undefined): string {
  return token === undefined
    ? `ws://127.0.0.1:${port}/ws`
    : `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`;
}

/**
 * Open a socket, reporting what the UPGRADE did rather than throwing.
 *
 * The status comes off `unexpected-response` and not off the `error` event:
 * `ws` emits the error without a `statusCode`, so reading it there returns
 * undefined and a case asserting 401 fails while the refusal is working
 * perfectly. `unexpected-response` carries the real HTTP response, which is
 * the whole point of refusing during the Upgrade.
 */
function handshake(url: string): Promise<{ opened: boolean; status?: number; socket?: WebSocket }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    const settle = (result: { opened: boolean; status?: number; socket?: WebSocket }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.terminate();
      reject(new Error('handshake timeout'));
    }, 4_000);
    socket.once('open', () => settle({ opened: true, socket }));
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      settle({ opened: false, status: response.statusCode });
    });
    socket.once('error', () => settle({ opened: false }));
  });
}

/** Wait for one frame, or give up — a silent socket is a failure here. */
function nextFrame(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no frame arrived')), 4_000);
    socket.once('message', (data: Buffer) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

/**
 * Resolve once the gateway has registered `socket`: a malformed frame is
 * answered by its catch-all, which only a socket on its lists can receive.
 */
async function registered(socket: WebSocket): Promise<void> {
  socket.send('not a frame');
  await nextFrame(socket);
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fixtureBot(userId: string, label: string) {
  return prisma.bot.create({
    data: {
      userId,
      name: `ws109-${label}-${RUN_ID}`,
      role: 'fixture',
      avatarColor: '#8B6F47',
      systemPrompt: '',
    },
  });
}

function subscribeFrame(botId: string): string {
  return JSON.stringify({
    id: randomUUID(),
    type: 'screen.subscribe',
    ts: Date.now(),
    payload: { botId },
  });
}

function cancelFrame(botId: string): string {
  return JSON.stringify({
    id: randomUUID(),
    type: 'bot.cancel',
    ts: Date.now(),
    payload: { botId },
  });
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'V1-09 — the §4.2 socket carries a session',
  () => {
    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module.js');
      const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      await app.listen(0);
      port = (app.getHttpServer().address() as { port: number }).port;

      prisma = app.get(PrismaService);
      actor = await signIn(prisma, { label: `ws109_${RUN_ID}` });
    });

    afterAll(async () => {
      if (prisma !== undefined && actor !== undefined) {
        await signOutAndDelete(prisma, actor.userId);
      }
      await app?.close();
    });

    it('admits a socket carrying a live session token', async () => {
      const result = await handshake(wsUrl(actor.token));
      try {
        expect(result.opened).toBe(true);
      } finally {
        result.socket?.close();
      }
    });

    it('refuses a token that is not a session, before a socket exists', async () => {
      // The shape the handshake used to accept: a secret from configuration.
      // The 401 is the point — a post-connect close would be indistinguishable
      // from the server going away, which is why D-024 puts this in the
      // Upgrade.
      const result = await handshake(wsUrl('orch-api-token-style-shared-secret'));
      expect(result.opened).toBe(false);
      expect(result.status).toBe(401);
    });

    it('refuses a missing token', async () => {
      const result = await handshake(wsUrl(undefined));
      expect(result.opened).toBe(false);
      expect(result.status).toBe(401);
    });

    it('refuses a session that expired before the handshake', async () => {
      const stale = await signIn(prisma, { label: `stale_${RUN_ID}` });
      try {
        await prisma.session.updateMany({
          where: { userId: stale.userId },
          data: { expiresAt: new Date(Date.now() - 1_000) },
        });
        const result = await handshake(wsUrl(stale.token));
        expect(result.opened).toBe(false);
        expect(result.status).toBe(401);
      } finally {
        await signOutAndDelete(prisma, stale.userId);
      }
    });

    it('refuses a session revoked between connecting and the next frame', async () => {
      // THE CASE THAT ONLY A LIVE SOCKET CAN SHOW. Everything above is decided
      // at connect time; this one is about a credential that was good then and
      // is not now, which is exactly what a sign-out is.
      const doomed = await signIn(prisma, { label: `doomed_${RUN_ID}` });
      const bot = await prisma.bot.create({
        data: {
          userId: doomed.userId,
          name: `ws109-${RUN_ID}`,
          role: 'fixture',
          avatarColor: '#8B6F47',
          systemPrompt: '',
        },
      });
      const result = await handshake(wsUrl(doomed.token));
      try {
        // Asserted against a presence: the socket really did open on this
        // credential, so the refusal below is the revocation rather than a
        // token that never worked.
        expect(result.opened).toBe(true);
        const socket = result.socket!;

        await prisma.session.deleteMany({ where: { userId: doomed.userId } });

        socket.send(cancelFrame(bot.id));
        const frame = await nextFrame(socket);

        expect(frame).toMatchObject({
          type: 'error',
          payload: { code: 'VALIDATION_ERROR' },
        });
        expect(JSON.stringify(frame)).toMatch(/no longer valid/i);
      } finally {
        result.socket?.close();
        await prisma.bot.deleteMany({ where: { id: bot.id } });
        await signOutAndDelete(prisma, doomed.userId);
      }
    });

    it('closes the socket it refused, rather than leaving it half-alive', async () => {
      const doomed = await signIn(prisma, { label: `closed_${RUN_ID}` });
      const result = await handshake(wsUrl(doomed.token));
      try {
        expect(result.opened).toBe(true);
        const socket = result.socket!;
        const closed = new Promise<number>((resolve) => {
          socket.once('close', (code: number) => resolve(code));
        });

        await prisma.session.deleteMany({ where: { userId: doomed.userId } });
        socket.send(cancelFrame('bot_does_not_matter'));

        // 1008 is `ws`'s policy-violation code, which is what an expired
        // credential is — and a client can tell it apart from a dropped
        // connection, which is the whole reason the frame is answered first.
        await expect(closed).resolves.toBe(1008);
      } finally {
        await signOutAndDelete(prisma, doomed.userId);
      }
    });

    it('stops streaming to a socket whose session expired, at its next frame', async () => {
      // A window that only LISTENS never sends the control frame that would
      // otherwise have been refused, so the bus asks at the moment of sending.
      const listener = await signIn(prisma, { label: `expiring_${RUN_ID}` });
      const bot = await fixtureBot(listener.userId, 'expiring');
      const principals = app.get(WsPrincipals);
      const result = await handshake(wsUrl(listener.token));
      try {
        expect(result.opened).toBe(true);
        const socket = result.socket!;
        await registered(socket);
        const bus = app.get(TurnEventBus);

        // The presence: before expiry, the same frame does arrive.
        bus.emitError(bot.id, 'UNKNOWN', 'before');
        expect(await nextFrame(socket)).toMatchObject({ type: 'error', botId: bot.id });

        const closed = new Promise<number>((resolve) => {
          socket.once('close', (code: number) => resolve(code));
        });
        principals.useClockForTests(() => Date.now() + 366 * 24 * 60 * 60 * 1000);
        bus.emitError(bot.id, 'UNKNOWN', 'after');

        const frame = await nextFrame(socket);
        expect(frame).toMatchObject({ type: 'error' });
        expect(JSON.stringify(frame)).toMatch(/no longer valid/i);
        expect(JSON.stringify(frame)).not.toContain('after');
        await expect(closed).resolves.toBe(1008);
      } finally {
        principals.useClockForTests(() => Date.now());
        result.socket?.close();
        await prisma.bot.deleteMany({ where: { id: bot.id } });
        await signOutAndDelete(prisma, listener.userId);
      }
    });

    it('closes a listening socket whose session was revoked, at the next sweep', async () => {
      const listener = await signIn(prisma, { label: `revoked_${RUN_ID}` });
      const result = await handshake(wsUrl(listener.token));
      try {
        expect(result.opened).toBe(true);
        const socket = result.socket!;
        await registered(socket);
        const gateway = app.get(WsGateway);
        let closedWith: number | null = null;
        socket.once('close', (code: number) => {
          closedWith = code;
        });

        // The presence: a sweep over a live session leaves the socket alone.
        await gateway.sweepRevoked();
        await registered(socket);
        expect(closedWith).toBeNull();

        await prisma.session.deleteMany({ where: { userId: listener.userId } });
        await gateway.sweepRevoked();

        await until(() => closedWith !== null);
        expect(closedWith).toBe(1008);
      } finally {
        result.socket?.close();
        await signOutAndDelete(prisma, listener.userId);
      }
    });

    it('resolves two sockets on one server to two different principals', async () => {
      // THE PROPERTY THE OLD GATEWAY COULD NOT HAVE: every frame it handled
      // passed SINGLETON_USER_ID, so with two accounts one person's subscribe
      // carried the other person's id.
      //
      // `screen.subscribe` is the probe because it REPORTS which principal it
      // ran as. The service looks the bot up scoped by userId and answers
      // "Bot not found" when it is somebody else's; a bot that IS yours gets
      // past that and fails on the sandbox instead. Two different sentences,
      // so the frame says whose request it was — where asserting that both
      // sockets merely stay open would pass just as well under one shared
      // principal, which is the version of this case that proves nothing.
      const other = await signIn(prisma, { label: `other_${RUN_ID}` });
      const theirBot = await prisma.bot.create({
        data: {
          userId: other.userId,
          name: `ws109-other-${RUN_ID}`,
          role: 'fixture',
          avatarColor: '#8B6F47',
          systemPrompt: '',
        },
      });
      const mine = await handshake(wsUrl(actor.token));
      const theirs = await handshake(wsUrl(other.token));
      try {
        expect(mine.opened).toBe(true);
        expect(theirs.opened).toBe(true);

        theirs.socket!.send(subscribeFrame(theirBot.id));
        const owner = await nextFrame(theirs.socket!);

        mine.socket!.send(subscribeFrame(theirBot.id));
        const stranger = await nextFrame(mine.socket!);

        // The owner got past the ownership check and failed on the sandbox.
        expect(JSON.stringify(owner)).toMatch(/sandbox for bot/i);
        expect(JSON.stringify(owner)).not.toMatch(/not found/i);

        // The stranger did not, and is told nothing about whether it exists.
        expect(JSON.stringify(stranger)).toMatch(/not found/i);
      } finally {
        mine.socket?.close();
        theirs.socket?.close();
        await prisma.bot.deleteMany({ where: { id: theirBot.id } });
        await signOutAndDelete(prisma, other.userId);
      }
    });

    it('routes the screen stream path to its own server, which wants a ticket', async () => {
      // Nest's adapter DESTROYS every Upgrade on a path it has no server for,
      // which a client sees as a hang-up with no status. A 401 is only possible
      // if the stream route is mounted — and it must be the ticket that is
      // checked there: a live session token in its place opens nothing.
      const base = `ws://127.0.0.1:${port}${SCREEN_STREAM_PATH}`;
      const bogus = await handshake(`${base}?ticket=not-a-ticket`);
      expect(bogus).toEqual({ opened: false, status: 401 });
      const session = await handshake(`${base}?token=${encodeURIComponent(actor.token)}`);
      expect(session).toEqual({ opened: false, status: 401 });
    });

    it('grants a screen only to the bot’s owner, and only while its computer runs', async () => {
      const other = await signIn(prisma, { label: `grant_${RUN_ID}` });
      const bot = await fixtureBot(actor.userId, 'grant');
      try {
        const grant = (token: string) =>
          request(app.getHttpServer())
            .post(`/api/v1/bots/${bot.id}/screen/grant`)
            .set('Authorization', `Bearer ${token}`);

        // Someone else's bot is not found, exactly like a missing one (R7).
        expect((await grant(other.token)).status).toBe(404);

        // The owner's bot has no running computer, and opening the panel is not
        // a reason to start one (D-039 §16): refused, never woken.
        const stopped = await grant(actor.token);
        expect(stopped.status).toBe(409);
        expect(stopped.body).toMatchObject({ code: 'SCREEN_NOT_RUNNING' });
      } finally {
        await prisma.bot.deleteMany({ where: { id: bot.id } });
        await signOutAndDelete(prisma, other.userId);
      }
    });
  },
);
