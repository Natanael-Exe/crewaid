import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { WebSocket } from 'ws';
import { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

/**
 * V1-14 — two signed-in users, and nothing crosses between them.
 *
 * ── WHY THIS COULD NOT EXIST BEFORE ─────────────────────────────────────────
 *
 * Until V1-08 there was one user. Every "is this yours" check in the codebase
 * compared a row's `userId` against the only value it could ever hold, so a
 * test could assert the comparison HAPPENED and never that it decided
 * anything. This is the first suite with a real second account to be refused.
 *
 * ── THE SURFACE THIS AIMS AT ────────────────────────────────────────────────
 *
 * D-010 closed ten IDOR-shaped routes with `ResourceOwnershipGuard`, and
 * `ownership-route-coverage.test.ts` proves every parameterised route carries
 * a marker or a written exemption. The EXEMPTIONS are the interesting half:
 * routes whose only fence is a service scoping its own query. There is no
 * guard to point at, no marker to assert, and nothing that fails the build if
 * `findOwned` quietly becomes `findUnique`. That is what this drives. (D-199
 * removed the AI SDK `GET/POST /bots/:id/messages` routes this suite used to
 * probe; the transcript now lives behind the guard-marked `GET/POST
 * /bots/:id/chat`.)
 *
 * ── THE CONTROL, WHICH IS WHAT MAKES IT EVIDENCE ────────────────────────────
 *
 * Every route is called TWICE BY THE SAME USER: once against the other
 * account's row, once against their own. The first must be refused and the
 * second must not.
 *
 * Without that second half, a route that is simply broken — a typo in the
 * path, a service that throws on every id — passes the isolation assertion
 * perfectly. It is the failure this file is most likely to have, because
 * "refused" and "does not work" are the same 404 when you only ever look at
 * refusals.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);

let app: INestApplication;
let prisma: PrismaService;
let port: number;
let owner: SignedInUser;
let stranger: SignedInUser;
let ownerRows: Fixture;
let strangerRows: Fixture;

/** One account's rows. Both users get the same shape, which is what makes the control possible. */
type Fixture = {
  readonly botId: string;
  readonly recordingId: string;
  readonly connectionId: string;
  readonly modelId: string;
};

async function fixtureFor(userId: string, label: string): Promise<Fixture> {
  const sandbox = await prisma.sandbox.create({
    data: { userId, state: 'RUNNING', widthPx: 1280, heightPx: 800 },
  });
  const bot = await prisma.bot.create({
    data: {
      userId,
      name: `v114-${label}-${RUN_ID}`,
      role: 'fixture',
      avatarColor: '#8B6F47',
      systemPrompt: '',
      modelId: 'default',
      sandboxId: sandbox.id,
    },
  });
  const recording = await prisma.recording.create({
    data: { botId: bot.id, intent: 'do the thing', state: 'RECORDING' },
  });
  const connection = await prisma.providerConnection.create({
    data: { userId, kind: 'OPENAI', name: `v114-${label}-${RUN_ID}`, state: 'NEEDS_CREDENTIAL' },
  });
  const model = await prisma.providerModel.create({
    data: {
      connectionId: connection.id,
      upstreamModelId: 'gpt-5.1',
      label: `GPT-5.1 ${label}`,
      contextWindow: 400_000,
    },
  });
  return {
    botId: bot.id,
    recordingId: recording.id,
    connectionId: connection.id,
    modelId: model.id,
  };
}

/**
 * Every direct-by-id route this suite drives, as a request builder.
 *
 * `readOnly` marks the ones safe to call in BOTH directions. The rest do real
 * work for whoever is let through — wake a container, start a turn, delete a
 * row — so they are driven only at the other account's rows, and their control
 * is a read on the same resource: if `GET /bots/:id` answers this user's own
 * bot, the credentials and the route are both fine, so a refusal on the write
 * is about ownership and not about the request being broken.
 */
type Route = {
  readonly key: string;
  readonly readOnly?: boolean;
  readonly call: (agent: request.Agent, fixture: Fixture) => request.Test;
};

const ROUTES: readonly Route[] = [
  // ── The eight with no guard: only a service scoping its own query ─────────
  {
    key: 'PATCH /bots/:id',
    readOnly: true, // A rename is reversible and touches nothing else.
    call: (agent, f) => agent.patch(`/api/v1/bots/${f.botId}`).send({ role: `v114-${RUN_ID}` }),
  },
  { key: 'DELETE /bots/:id', call: (agent, f) => agent.delete(`/api/v1/bots/${f.botId}`) },
  {
    key: 'POST /bots/:id/duplicate',
    call: (agent, f) => agent.post(`/api/v1/bots/${f.botId}/duplicate`),
  },
  // D-199: `GET/POST /bots/:id/messages` were probed here and are gone — the
  // AI SDK thread they served was deleted, and a 404 on a deleted route would
  // pass the refusal half while failing the control below, which is exactly
  // the confusion the control exists to prevent.
  {
    key: 'GET /bots/:id/turns',
    readOnly: true,
    call: (agent, f) => agent.get(`/api/v1/bots/${f.botId}/turns`),
  },
  {
    key: 'GET /bots/:id/sandbox',
    readOnly: true,
    call: (agent, f) => agent.get(`/api/v1/bots/${f.botId}/sandbox`),
  },
  {
    key: 'POST /bots/:id/sandbox/start',
    call: (agent, f) => agent.post(`/api/v1/bots/${f.botId}/sandbox/start`),
  },
  {
    key: 'POST /bots/:id/sandbox/stop',
    call: (agent, f) => agent.post(`/api/v1/bots/${f.botId}/sandbox/stop`),
  },
  {
    key: 'POST /bots/:id/recordings',
    call: (agent, f) => agent.post(`/api/v1/bots/${f.botId}/recordings`).send({ intent: 'x' }),
  },

  // ── Guard-marked routes, driven with real rows rather than a fake resolver ─
  {
    key: 'GET /recordings/:id',
    readOnly: true,
    call: (agent, f) => agent.get(`/api/v1/recordings/${f.recordingId}`),
  },
  {
    key: 'POST /recordings/:id/discard',
    call: (agent, f) => agent.post(`/api/v1/recordings/${f.recordingId}/discard`),
  },
  {
    key: 'PATCH /providers/connections/:id',
    readOnly: true,
    call: (agent, f) =>
      agent.patch(`/api/v1/providers/connections/${f.connectionId}`).send({ name: `n-${RUN_ID}` }),
  },
  {
    key: 'DELETE /providers/connections/:id',
    call: (agent, f) => agent.delete(`/api/v1/providers/connections/${f.connectionId}`),
  },
  {
    key: 'PUT /providers/connections/:id/credential',
    call: (agent, f) =>
      agent
        .put(`/api/v1/providers/connections/${f.connectionId}/credential`)
        .send({ apiKey: 'sk-this-is-not-yours' }),
  },
  {
    key: 'DELETE /providers/connections/:id/credential',
    call: (agent, f) => agent.delete(`/api/v1/providers/connections/${f.connectionId}/credential`),
  },
  {
    key: 'POST /providers/connections/:id/models',
    call: (agent, f) =>
      agent.post(`/api/v1/providers/connections/${f.connectionId}/models`).send({
        upstreamModelId: 'gpt-4o',
        label: 'Smuggled',
        contextWindow: 1000,
        capabilities: { tools: false, vision: false, reasoning: false },
      }),
  },
  {
    key: 'PATCH /providers/models/:modelId',
    readOnly: true,
    call: (agent, f) =>
      agent.patch(`/api/v1/providers/models/${f.modelId}`).send({ label: `l-${RUN_ID}` }),
  },
  {
    key: 'DELETE /providers/models/:modelId',
    call: (agent, f) => agent.delete(`/api/v1/providers/models/${f.modelId}`),
  },
];

/**
 * 404 and 403 are both refusals, and which one arrives is deliberately not
 * asserted: `BotsService` answers 404 for absent AND foreign on purpose — a
 * 403 would confirm the row exists — while the ownership guard answers 404
 * too. Pinning the exact code here would make a legitimate change to that
 * policy look like a security regression.
 */
const REFUSED = [403, 404];

function agentFor(actor: SignedInUser): request.Agent {
  return request.agent(app.getHttpServer()).set(actor.headers) as request.Agent;
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'V1-14 — two users, one orchestrator',
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
      owner = await signIn(prisma, { label: `owner_${RUN_ID}` });
      stranger = await signIn(prisma, { label: `stranger_${RUN_ID}` });
      ownerRows = await fixtureFor(owner.userId, 'owner');
      strangerRows = await fixtureFor(stranger.userId, 'stranger');
    });

    afterAll(async () => {
      if (prisma !== undefined) {
        if (owner !== undefined) await signOutAndDelete(prisma, owner.userId);
        if (stranger !== undefined) await signOutAndDelete(prisma, stranger.userId);
      }
      await app?.close();
    });

    it('refuses every direct-by-id route against another account', async () => {
      const allowed: string[] = [];

      for (const route of ROUTES) {
        const response = await route.call(agentFor(stranger), ownerRows);
        if (!REFUSED.includes(response.status)) {
          allowed.push(`${route.key} → ${response.status}`);
        }
      }

      // Listed rather than asserted one at a time so a regression names every
      // route it opened, not just the first alphabetically.
      expect(allowed).toEqual([]);
    });

    it('and answers the same requests against their own rows', async () => {
      // THE CONTROL. Same user, same request shape, different owner. A route
      // that is broken for everybody refuses the case above exactly as well as
      // a route that is working — this is what tells them apart.
      const refused: string[] = [];

      for (const route of ROUTES.filter((candidate) => candidate.readOnly === true)) {
        const response = await route.call(agentFor(stranger), strangerRows);
        if (REFUSED.includes(response.status)) {
          refused.push(`${route.key} → ${response.status}`);
        }
      }

      expect(refused).toEqual([]);
    });

    it('answers a read on the resources whose writes are only tested one way', async () => {
      // The control for the side-effectful routes. Waking a container or
      // starting a turn to prove a point would be a test doing real work for
      // no extra evidence, so the id and the credentials are validated by a
      // read on the same row instead.
      const strangerAgent = agentFor(stranger);
      await strangerAgent.get(`/api/v1/bots/${strangerRows.botId}/sandbox`).expect(200);
      await strangerAgent.get(`/api/v1/recordings/${strangerRows.recordingId}`).expect(200);

      const connections = await strangerAgent.get('/api/v1/providers/connections').expect(200);
      const ids = (connections.body as { connections: { id: string }[] }).connections.map(
        (connection) => connection.id,
      );
      expect(ids).toContain(strangerRows.connectionId);
    });

    it('lists only the caller’s own provider connections', async () => {
      const response = await agentFor(stranger).get('/api/v1/providers/connections').expect(200);
      const body = response.body as { connections: { id: string; models: { id: string }[] }[] };

      expect(body.connections.map((connection) => connection.id)).not.toContain(
        ownerRows.connectionId,
      );
      // The nested models too: a connection filtered at the top level whose
      // models were fetched globally would leak the labels and the upstream
      // ids of everybody's models through one honest-looking response.
      const models = body.connections.flatMap((connection) => connection.models.map((m) => m.id));
      expect(models).not.toContain(ownerRows.modelId);
    });

    it('resolves models per caller, so one account’s list is not the other’s', async () => {
      const mine = await agentFor(stranger).get('/api/v1/models').expect(200);
      const theirs = await agentFor(owner).get('/api/v1/models').expect(200);

      const idsOf = (response: { body: unknown }): string[] =>
        (response.body as { models: { id: string }[] }).models.map((model) => model.id);

      expect(idsOf(mine)).toContain(strangerRows.modelId);
      expect(idsOf(mine)).not.toContain(ownerRows.modelId);
      expect(idsOf(theirs)).toContain(ownerRows.modelId);
      expect(idsOf(theirs)).not.toContain(strangerRows.modelId);
    });

    it('refuses to point a bot at another account’s model', async () => {
      // The one that does not look like an IDOR. Both ids belong to the
      // caller — their own bot — except the model, and `Bot.modelId` is a
      // plain string column rather than a foreign key (D-082), so the database
      // cannot refuse this. If resolution accepted it, every turn would run on
      // somebody else's key.
      const response = await agentFor(stranger)
        .patch(`/api/v1/bots/${strangerRows.botId}`)
        .send({ modelId: ownerRows.modelId });

      expect(REFUSED.concat([400, 409])).toContain(response.status);

      const row = await prisma.bot.findUniqueOrThrow({ where: { id: strangerRows.botId } });
      expect(row.modelId).not.toBe(ownerRows.modelId);
    });

    it('refuses a socket the other account’s bot, and answers its own', async () => {
      // §4.2 is a separate door with its own principal (V1-09), so HTTP
      // isolation says nothing about it. `screen.subscribe` is the probe
      // because its refusals are distinguishable: "Bot not found" is the
      // ownership answer, and anything about a sandbox means the gateway
      // resolved the bot first.
      const socket = await openSocket(stranger.token);
      try {
        socket.send(subscribeFrame(ownerRows.botId));
        const foreign = (await nextFrame(socket)) as { payload?: { message?: string } };
        expect(JSON.stringify(foreign)).toMatch(/not found/i);

        socket.send(subscribeFrame(strangerRows.botId));
        const own = (await nextFrame(socket)) as unknown;
        // Not asserted as a success: the fixture sandbox has no container
        // behind it, so this legitimately fails — on the SANDBOX, which is
        // proof the gateway got past ownership.
        expect(JSON.stringify(own)).not.toMatch(/not found/i);
      } finally {
        socket.close();
      }
    });

    it('streams a bot’s frames and a user’s Work frames only to that account', async () => {
      // The §4.2 bus is the one door that PUSHES rather than answers, so
      // nothing above covers it: no route is called, no ownership check runs.
      // It used to send every frame to every socket — a stranger's window
      // received the owner's transcript, tool arguments and approval prompts.
      //
      // Each account gets frames of its own AFTER the owner's, as the control:
      // a socket receives in send order, so once the stranger's own frames
      // arrive, anything leaked to it earlier would already be there.
      const bus = app.get(TurnEventBus);
      const ownerSocket = await openSocket(owner.token);
      const strangerSocket = await openSocket(stranger.token);
      try {
        const ownerFrames = await listening(ownerSocket);
        const strangerFrames = await listening(strangerSocket);

        bus.emitError(ownerRows.botId, 'UNKNOWN', 'the owner’s reply');
        bus.emitWorkChanged(owner.userId, 'task.changed', { taskId: 'cm-owner-task' });
        await until(() => ownerFrames.length >= 2);

        bus.emitError(strangerRows.botId, 'UNKNOWN', 'the stranger’s reply');
        bus.emitWorkChanged(stranger.userId, 'goal.changed', { goalId: 'cm-stranger-goal' });
        await until(() => strangerFrames.length >= 2);

        // Sorted: a bot's first frame waits on a read of its owner, so the
        // order BETWEEN a bot frame and a user's Work frame is not promised.
        const typesOf = (frames: Array<{ type: string }>) => frames.map((f) => f.type).sort();
        expect(typesOf(ownerFrames)).toEqual(['error', 'task.changed']);
        expect(typesOf(strangerFrames)).toEqual(['error', 'goal.changed']);
        const botOf = (frames: Array<{ type: string; botId?: string }>) =>
          frames.find((frame) => frame.type === 'error')?.botId;
        expect(botOf(ownerFrames)).toBe(ownerRows.botId);
        expect(botOf(strangerFrames)).toBe(strangerRows.botId);
        expect(JSON.stringify(strangerFrames)).not.toContain('the owner’s reply');
      } finally {
        ownerSocket.close();
        strangerSocket.close();
      }
    });

    it('answers a foreign bot’s approvals as an empty list, not as someone else’s prompts', async () => {
      // NOT a refusal, and deliberately so: `listPendingApprovals` filters an
      // in-process map by `principal.userId`, so a foreign bot id yields
      // nothing rather than a 404. `ownership-route-coverage.test.ts` carries
      // that as a written exemption; this is the behaviour behind it.
      const response = await agentFor(stranger)
        .get(`/api/v1/bots/${ownerRows.botId}/approvals`)
        .expect(200);

      // A bare array, not an envelope (`ListApprovalsResponseSchema`).
      expect(response.body).toEqual([]);
      // ⚠️ WHAT THIS DOES NOT PROVE. The owner has no pending approval here, so
      // an empty list is also what a filter that never ran would return. A real
      // one needs a suspended turn, which `approval-respond.test.ts` owns — the
      // gap is named rather than papered over.
    });
  },
);

// ── §4.2 helpers ────────────────────────────────────────────────────────────

function openSocket(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('handshake timeout'));
    }, 4_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error('socket error'));
    });
  });
}

/**
 * Record every frame a socket receives from here on, once the gateway has
 * registered it: a malformed frame is answered by the gateway's catch-all, so
 * its reply proves the socket is on the bus's list before anything is emitted.
 */
async function listening(socket: WebSocket): Promise<Array<{ type: string; botId?: string }>> {
  socket.send('not a frame');
  await nextFrame(socket);
  const frames: Array<{ type: string; botId?: string }> = [];
  socket.on('message', (data: Buffer) => {
    frames.push(JSON.parse(data.toString()) as { type: string; botId?: string });
  });
  return frames;
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

function subscribeFrame(botId: string): string {
  return JSON.stringify({
    id: randomUUID(),
    type: 'screen.subscribe',
    ts: Date.now(),
    payload: { botId },
  });
}
