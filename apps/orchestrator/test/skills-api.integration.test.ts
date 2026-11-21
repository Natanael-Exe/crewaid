import { toolInputJsonSchema } from '../src/agent/tool-contract.js';
import { ToolApprovalHub } from '../src/agent/policy/approval-hub.js';
import { TurnControlService } from '../src/agent/turn-control.service.js';
import { ToolRegistry } from '../src/agent/tool-registry.js';
import { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { SeatControlService } from '../src/screen/seat-control.service.js';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import request from 'supertest';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { SkillRunService } from '../src/skills/skill-run.service.js';
import { SeatService } from '../src/sandbox/seat.service.js';
import { FakeSeatService } from './sandbox-fakes.js';
import { FakeProvider } from './sandbox-fakes.js';
import { signIn } from './auth-fixture.js';

/**
 * M3-BE-09 — the skill review surface over the real stack.
 *
 * PRD §6/M3's two behavioural acceptance criteria, as tests:
 *
 *   - "Editing and saving a script bumps `version` and keeps the previous
 *     version queryable." PATCH is the edit; the cases below assert the
 *     response is a NEW row one version up, the row that was patched still
 *     answers by its own id with its own bytes, and the list offers only the
 *     newest version of the name.
 *   - "A `DRAFT` skill cannot be run. Only `APPROVED`." The gate cases assert
 *     409 and — the half a status code alone cannot show — that no `SkillRun`
 *     row was minted for a refused request.
 *
 * Real HTTP through the real guards and a real database: the contract here is
 * rows and status codes, and a service-level call would prove none of the
 * wiring (`@OwnedResource` markers, the validation pipes, the async shape the
 * UI polls). The sandbox is the suite's usual `FakeProvider`, and the
 * "bridge" is a real HTTP server bound to the port its session advertises
 * (SANDBOX_PORTS.bridge 7070 → 32770), so a run exercises the actual fetch,
 * outcome parsing, and settle fence rather than a mocked transport.
 *
 * Runs are asynchronous by design — `POST` answers before the work does — so
 * the run cases poll the status route the way the UI will.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);
let TOKEN: string;
const BOT_PREFIX = `m3be09-${RUN_ID}`;
/** Not the singleton: rows this principal must never reach. */
const FOREIGN_USER = `usr_skills_api_${RUN_ID}`;
/**
 * Where `FakeProvider`'s session says the bridge is — chosen by the kernel,
 * not by this file.
 *
 * It used to be the fake's hard-coded 32770, which is the third port of
 * Linux's default ephemeral range (`ip_local_port_range` is `32768 60999` on
 * ubuntu-latest). This suite runs late, after ~90 others have opened Postgres
 * and Redis connections, so the kernel has usually handed 32770 to one of
 * them by now and `listen` fails with `EADDRINUSE: address already in use
 * 127.0.0.1:32770` — a red main with nothing wrong in the code. macOS starts
 * its ephemeral range at 49152, which is why it never reproduced locally.
 *
 * Binding port 0 asks the kernel for one it knows is free; the fake is then
 * told what it got, so the session advertises the port the stub is actually
 * on.
 */
let bridgePort = 0;

const PARAMS_SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string', description: 'what to search for' } },
  required: ['query'],
  additionalProperties: false,
};

let app: INestApplication;
let prisma: PrismaService;
/** The signed-in user this suite acts as, and owns its rows with. */
let ACTOR: string;
let runs: SkillRunService;
let botId: string;
let bridgeServer: Server;

/** One recorded `POST /skill/run`, as the stub saw it. */
interface BridgeCall {
  readonly url: string | undefined;
  readonly script: string;
  readonly params: Record<string, unknown>;
}
const bridgeCalls: BridgeCall[] = [];
/** What the stub answers next; each run case sets what it needs. */
let bridgeReply: () => { status: number; body: unknown } = () => ({
  status: 200,
  body: { ok: true, result: null, logs: ['bridge stub: finished'], durationMs: 5 },
});

function readBody(request_: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request_.on('data', (chunk: Buffer) => chunks.push(chunk));
    request_.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request_.on('error', reject);
  });
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M3-BE-09 — skill review: versioning, approval, running (real db, real http)',
  () => {
    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module.js');
      const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');

      bridgeServer = createServer((incoming, outgoing) => {
        void (async () => {
          if (incoming.method === 'POST' && incoming.url?.startsWith('/skill/run?botId=')) {
            const parsed = JSON.parse(await readBody(incoming)) as {
              script: string;
              params: Record<string, unknown>;
            };
            bridgeCalls.push({ url: incoming.url, script: parsed.script, params: parsed.params });
            const reply = bridgeReply();
            outgoing.writeHead(reply.status, { 'content-type': 'application/json' });
            outgoing.end(JSON.stringify(reply.body));
            return;
          }
          outgoing.writeHead(404, { 'content-type': 'application/json' });
          outgoing.end(JSON.stringify({ code: 'NOT_FOUND' }));
        })();
      });
      await new Promise<void>((resolve, reject) => {
        bridgeServer.once('error', reject);
        bridgeServer.listen(0, '127.0.0.1', () => resolve());
      });
      const bound = bridgeServer.address();
      if (bound === null || typeof bound === 'string') {
        throw new Error('bridge stub did not bind a TCP port');
      }
      bridgePort = bound.port;

      const provider = new FakeProvider();
      // The session must advertise where the stub actually landed.
      provider.bridgePort = bridgePort;
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(provider)
        .overrideProvider(SeatService)
        .useValue(new FakeSeatService())
        .compile();
      app = moduleRef.createNestApplication();
      // AppModule carries WsGateway; without the §4.2 adapter the socket
      // module hard-exits during init (same boot as the other HTTP suites).
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      await app.init();

      prisma = app.get(PrismaService);
      // V1-08: a real session for a real user. The suite owns its rows with
      // ACTOR, so nothing here depends on a user somebody else seeded.
      ({ token: TOKEN, userId: ACTOR } = await signIn(prisma, { label: 'skills' }));
      runs = app.get(SkillRunService);

      await prisma.user.upsert({
        where: { id: ACTOR },
        create: { id: ACTOR, name: 'Test User', email: `${ACTOR}@test.invalid` },
        update: {},
      });
      await prisma.user.upsert({
        where: { id: FOREIGN_USER },
        create: {
          id: FOREIGN_USER,
          name: 'Test User',
          email: `skills-api-${RUN_ID}@test.local`,
        },
        update: {},
      });
      const bot = await prisma.bot.create({
        data: {
          userId: ACTOR,
          name: `${BOT_PREFIX}-bot`,
          role: 'skill review test',
          avatarColor: '#8B6F47',
          systemPrompt: 'test',
        },
      });
      botId = bot.id;
      await prisma.conversation.create({ data: { botId } });
      // The fixture desktop starts from a known observation.
      app.get(SeatControlService).seats.observed(botId);
      await prisma.sandbox.create({
        data: { id: botId, userId: ACTOR, bots: { connect: { id: botId } } },
      });
      await provider.provisionWorkspace({ botId });
    });

    afterAll(async () => {
      // Cascades clean up this suite's bot, skills, runs and sandbox; the
      // foreign user exists only for the ownership cases.
      await prisma?.bot
        .deleteMany({ where: { userId: ACTOR, name: { startsWith: BOT_PREFIX } } })
        .catch(() => undefined);
      await prisma?.user.deleteMany({ where: { id: FOREIGN_USER } }).catch(() => undefined);
      await app?.close();
      bridgeServer?.closeAllConnections();
      await new Promise<void>((resolve) => bridgeServer?.close(() => resolve()));
    });

    const authed = (): string => `Bearer ${TOKEN}`;
    const at = (path: string) =>
      request(app.getHttpServer()).get(path).set('authorization', authed());

    type SkillSeed = {
      botId?: string | null;
      name?: string;
      description?: string;
      paramsSchema?: Prisma.InputJsonValue;
      script?: string;
      version?: number;
      status?: 'DRAFT' | 'APPROVED' | 'ARCHIVED';
      sourceRecordingId?: string | null;
    };

    async function createSkill(over: SkillSeed = {}) {
      return prisma.skill.create({
        data: {
          botId,
          name: `skill_${randomUUID().slice(0, 8)}`,
          description: 'a recorded skill',
          paramsSchema: PARAMS_SCHEMA,
          script: 'export default async function run(ctx) { ctx.log("original"); }',
          version: 1,
          status: 'DRAFT',
          sourceRecordingId: null,
          ...over,
        },
      });
    }

    /** Poll the status route until the run is terminal, the way the UI will. */
    async function settledRun(skillId: string, runId: string): Promise<Record<string, unknown>> {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const res = await at(`/api/v1/skills/${skillId}/runs/${runId}`);
        expect(res.status).toBe(200);
        const status = (res.body as { status?: unknown }).status;
        if (status === 'SUCCEEDED' || status === 'FAILED')
          return res.body as Record<string, unknown>;
        if (Date.now() > deadline) {
          throw new Error(`run ${runId} never settled (still ${String(status)})`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    describe('editing saves the next version and keeps the old one (M3-BE-09)', () => {
      it('answers the new version, untouched on the patched row, listed as latest', async () => {
        const recording = await prisma.recording.create({ data: { botId } });
        const v1 = await createSkill({
          status: 'APPROVED',
          sourceRecordingId: recording.id,
        });

        const res = await request(app.getHttpServer())
          .patch(`/api/v1/skills/${v1.id}`)
          .set('authorization', authed())
          .send({ script: 'export default async function run(ctx) { ctx.log("edited"); }' });

        expect(res.status).toBe(200);
        // §6/M3: a save bumps the version as a NEW row — the client switches
        // to the returned id, everything unauthored carries forward, and the
        // bytes nobody has re-reviewed come back DRAFT (§7.3).
        expect(res.body.id).not.toBe(v1.id);
        expect(res.body).toMatchObject({
          botId,
          name: v1.name,
          version: 2,
          status: 'DRAFT',
          description: v1.description,
          sourceRecordingId: recording.id,
          script: 'export default async function run(ctx) { ctx.log("edited"); }',
        });
        expect(res.body.paramsSchema).toEqual(v1.paramsSchema);

        // "keeps the previous version queryable" — by its own id, unchanged.
        const old = await at(`/api/v1/skills/${v1.id}`);
        expect(old.status).toBe(200);
        expect(old.body).toMatchObject({ id: v1.id, version: 1, status: 'APPROVED' });
        expect(old.body.script).toBe(v1.script);

        // The list offers the row a reviewer acts on: the latest version of
        // the name, and not the source (§4.1 puts the source on the detail
        // route; a page of scripts must not ride on every list render).
        const list = await at(`/api/v1/skills?botId=${botId}`);
        expect(list.status).toBe(200);
        const mine = (list.body as { id: string; name: string; script?: string }[]).filter(
          (row) => row.name === v1.name,
        );
        expect(mine).toHaveLength(1);
        expect(mine[0]?.id).toBe(res.body.id);
        expect(mine[0] === undefined || 'script' in mine[0]).toBe(false);
        expect((list.body as { id: string }[]).some((row) => row.id === v1.id)).toBe(false);
      });

      it('numbers the next version above the highest that exists, not above the row patched', async () => {
        const v1 = await createSkill();

        const first = await request(app.getHttpServer())
          .patch(`/api/v1/skills/${v1.id}`)
          .set('authorization', authed())
          .send({ script: 'export default async function run(ctx) { ctx.log("edit one"); }' });
        expect(first.body.version).toBe(2);

        // Editing the ORIGINAL row again must not reuse v2: the version it
        // writes has to be free for [botId, name] or the schema's unique key
        // is violated.
        const second = await request(app.getHttpServer())
          .patch(`/api/v1/skills/${v1.id}`)
          .set('authorization', authed())
          .send({ script: 'export default async function run(ctx) { ctx.log("edit two"); }' });
        expect(second.status).toBe(200);
        expect(second.body).toMatchObject({ version: 3, status: 'DRAFT' });
      });

      it('refuses an edit with no fields', async () => {
        const skill = await createSkill();

        const res = await request(app.getHttpServer())
          .patch(`/api/v1/skills/${skill.id}`)
          .set('authorization', authed())
          .send({});

        expect(res.status).toBe(400);
      });

      it('refuses an edit of a skill the caller does not own', async () => {
        const foreignBot = await prisma.bot.create({
          data: {
            userId: FOREIGN_USER,
            name: `${BOT_PREFIX}-foreign`,
            role: 'r',
            avatarColor: '#111111',
            systemPrompt: 'x',
          },
        });
        const foreignSkill = await prisma.skill.create({
          data: {
            botId: foreignBot.id,
            name: 'foreign_skill',
            description: 'not yours',
            paramsSchema: {},
            script: 'export default async function run() {}',
          },
        });

        const get = await at(`/api/v1/skills/${foreignSkill.id}`);
        expect(get.status).toBe(404);
        const patch = await request(app.getHttpServer())
          .patch(`/api/v1/skills/${foreignSkill.id}`)
          .set('authorization', authed())
          .send({ script: 'no' });
        expect(patch.status).toBe(404);
        const run = await request(app.getHttpServer())
          .post(`/api/v1/skills/${foreignSkill.id}/run`)
          .set('authorization', authed())
          .send({ params: {} });
        expect(run.status).toBe(404);

        await prisma.user.delete({ where: { id: FOREIGN_USER } }).catch(() => undefined);
      });
    });

    describe('approval is a per-version human act (M3-BE-09)', () => {
      it('flips DRAFT to APPROVED and stays idempotent', async () => {
        const skill = await createSkill();

        const first = await request(app.getHttpServer())
          .post(`/api/v1/skills/${skill.id}/approve`)
          .set('authorization', authed())
          .send();
        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ id: skill.id, status: 'APPROVED' });

        // A double-clicked Approve button gets the same row back, not an
        // error about a state the client is looking at.
        const second = await request(app.getHttpServer())
          .post(`/api/v1/skills/${skill.id}/approve`)
          .set('authorization', authed())
          .send();
        expect(second.status).toBe(200);
        expect(second.body).toMatchObject({ id: skill.id, status: 'APPROVED' });
      });

      it('refuses to approve an ARCHIVED skill', async () => {
        const skill = await createSkill({ status: 'ARCHIVED' });

        const res = await request(app.getHttpServer())
          .post(`/api/v1/skills/${skill.id}/approve`)
          .set('authorization', authed())
          .send();

        expect(res.status).toBe(409);
        expect(String((res.body as { message?: unknown }).message)).toContain('ARCHIVED');
      });
    });

    describe('a draft can be thrown away (D-098)', () => {
      it('deletes a DRAFT with 204, and the list no longer offers it', async () => {
        const skill = await createSkill();

        const res = await request(app.getHttpServer())
          .delete(`/api/v1/skills/${skill.id}`)
          .set('authorization', authed());

        expect(res.status).toBe(204);
        expect(res.body).toEqual({});
        await expect(prisma.skill.findUnique({ where: { id: skill.id } })).resolves.toBeNull();

        // The half a status code cannot show: a deleted draft is gone from the
        // surface that announced it, not merely unreachable by its old id.
        const list = await at('/api/v1/skills');
        expect(list.status).toBe(200);
        expect((list.body as { id: string }[]).some((row) => row.id === skill.id)).toBe(false);
      });

      it('refuses anything that is not a draft, and leaves the row', async () => {
        // An approved version's runs point at the row, and M3-BE-09 promises
        // the previous version stays queryable — deleting one would break both.
        for (const status of ['APPROVED', 'ARCHIVED'] as const) {
          const skill = await createSkill({ status });

          const res = await request(app.getHttpServer())
            .delete(`/api/v1/skills/${skill.id}`)
            .set('authorization', authed());

          expect(res.status).toBe(409);
          expect(String((res.body as { message?: unknown }).message)).toContain(status);
          await expect(
            prisma.skill.findUnique({ where: { id: skill.id } }),
          ).resolves.not.toBeNull();
        }
      });

      it('answers 404 for a skill the caller does not own, and leaves it', async () => {
        const foreign = await prisma.user.create({
          data: {
            id: `usr_skills_d98_${RUN_ID}`,
            name: 'Test User',
            email: `skills-d98-${RUN_ID}@test.local`,
          },
        });
        const foreignBot = await prisma.bot.create({
          data: {
            userId: foreign.id,
            name: `${BOT_PREFIX}-foreign`,
            role: 'not this caller',
            avatarColor: '#111111',
            systemPrompt: 'test',
          },
        });
        const skill = await createSkill({ botId: foreignBot.id });

        const res = await request(app.getHttpServer())
          .delete(`/api/v1/skills/${skill.id}`)
          .set('authorization', authed());

        // D-010: absent and foreign are the same answer, and the row the
        // caller cannot see is also a row they cannot remove.
        expect(res.status).toBe(404);
        await expect(prisma.skill.findUnique({ where: { id: skill.id } })).resolves.not.toBeNull();

        await prisma.bot.delete({ where: { id: foreignBot.id } });
        await prisma.user.delete({ where: { id: foreign.id } });
      });
    });

    describe('only an APPROVED skill can run (M3-BE-09)', () => {
      it('refuses a DRAFT with 409 and writes no run row', async () => {
        const skill = await createSkill({ status: 'DRAFT' });

        const res = await request(app.getHttpServer())
          .post(`/api/v1/skills/${skill.id}/run`)
          .set('authorization', authed())
          .send({ params: {} });

        expect(res.status).toBe(409);
        expect(String((res.body as { message?: unknown }).message)).toContain(
          'only an APPROVED skill can be run',
        );
        // The gate is before the row, not after: a refused request must not
        // mint work the UI would then poll forever.
        await expect(prisma.skillRun.count({ where: { skillId: skill.id } })).resolves.toBe(0);
      });

      it('refuses an ARCHIVED skill', async () => {
        const skill = await createSkill({ status: 'ARCHIVED' });

        const res = await request(app.getHttpServer())
          .post(`/api/v1/skills/${skill.id}/run`)
          .set('authorization', authed())
          .send({ params: {} });

        expect(res.status).toBe(409);
      });

      it('rejects params that are not an object with 400', async () => {
        const skill = await createSkill({ status: 'APPROVED' });

        const res = await request(app.getHttpServer())
          .post(`/api/v1/skills/${skill.id}/run`)
          .set('authorization', authed())
          .send({ params: 'not-an-object' });

        // The bridge accepts nothing but an object (`validate_skill_request`),
        // so this boundary refuses one hop earlier — before a run row exists.
        expect(res.status).toBe(400);
        await expect(prisma.skillRun.count({ where: { skillId: skill.id } })).resolves.toBe(0);
      });
    });

    describe('running an APPROVED skill through the bridge (M3-BE-09)', () => {
      it('forwards script and params, then settles SUCCEEDED with the logs on the status route', async () => {
        bridgeCalls.length = 0;
        bridgeReply = () => ({
          status: 200,
          body: { ok: true, result: null, logs: ['opened the page'], durationMs: 12 },
        });
        const script = 'export default async function run(ctx, params) { ctx.log(params.query); }';
        const skill = await createSkill({ status: 'APPROVED', script });

        const started = await request(app.getHttpServer())
          .post(`/api/v1/skills/${skill.id}/run`)
          .set('authorization', authed())
          .send({ params: { query: 'paper towels' } });

        expect(started.status).toBe(201);
        const runId = (started.body as { runId: string }).runId;
        expect(typeof runId).toBe('string');

        const settled = await settledRun(skill.id, runId);
        expect(settled).toMatchObject({
          id: runId,
          skillId: skill.id,
          status: 'SUCCEEDED',
          logs: 'opened the page',
          error: null,
          params: { query: 'paper towels' },
        });
        expect(settled.startedAt).not.toBeNull();
        expect(settled.endedAt).not.toBeNull();

        // The bridge saw the skill's bytes and arguments verbatim.
        expect(bridgeCalls).toHaveLength(1);
        expect(bridgeCalls[0]?.url).toBe(`/skill/run?botId=${botId}`);
        expect(bridgeCalls[0]?.script).toBe(script);
        expect(bridgeCalls[0]?.params).toEqual({ query: 'paper towels' });
      });

      it('reports a script that threw as FAILED with the bridge detail and its logs', async () => {
        bridgeCalls.length = 0;
        bridgeReply = () => ({
          status: 200,
          body: {
            ok: false,
            code: 'SKILL_EXECUTION_FAILED',
            detail: 'Error: boom',
            logs: ['typed hello'],
            durationMs: 3,
          },
        });
        const skill = await createSkill({ status: 'APPROVED' });

        const started = await request(app.getHttpServer())
          .post(`/api/v1/skills/${skill.id}/run`)
          .set('authorization', authed())
          .send({ params: { query: 'failure fixture' } });
        expect(started.status).toBe(201);

        // A run that executed — even one whose script threw — is an outcome,
        // and the row carries it verbatim rather than blaming the sandbox.
        const settled = await settledRun(skill.id, (started.body as { runId: string }).runId);
        expect(settled).toMatchObject({
          status: 'FAILED',
          error: 'Error: boom',
          logs: 'typed hello',
        });
      });

      it('reports a bridge refusal as the infrastructure failure it is', async () => {
        bridgeCalls.length = 0;
        bridgeReply = () => ({
          status: 500,
          body: {
            ok: false,
            code: 'SKILL_TIMEOUT',
            detail: 'the skill did not finish within 600s',
          },
        });
        const skill = await createSkill({ status: 'APPROVED' });

        const started = await request(app.getHttpServer())
          .post(`/api/v1/skills/${skill.id}/run`)
          .set('authorization', authed())
          .send({ params: { query: 'failure fixture' } });
        expect(started.status).toBe(201);

        const settled = await settledRun(skill.id, (started.body as { runId: string }).runId);
        expect(settled.status).toBe('FAILED');
        const error = String(settled.error);
        // Names the status AND the bridge's code: a refused transport is not
        // a script failure, and the sentence must not pretend otherwise.
        expect(error).toContain('HTTP 500');
        expect(error).toContain('SKILL_TIMEOUT');
      });

      async function pendingSkill() {
        let pending: Awaited<ReturnType<ToolApprovalHub['list']>>[number] | undefined;
        await vi.waitFor(
          async () => {
            [pending] = await app.get(ToolApprovalHub).list(ACTOR, botId);
            expect(pending?.toolName).toBe('run_skill');
          },
          { timeout: 5000 },
        );
        return pending!;
      }
      const successReply = () => ({
        status: 200,
        body: { ok: true, result: null, logs: ['controlled replay'], durationMs: 5 },
      });
      it('direct HTTP execution in ASK records exact operator approval without fabricating chat', async () => {
        bridgeCalls.length = 0;
        bridgeReply = successReply;
        await prisma.bot.update({ where: { id: botId }, data: { approvalMode: 'ASK' } });
        const skill = await createSkill({ status: 'APPROVED' });
        const messageCount = await prisma.message.count({ where: { conversation: { botId } } });
        const resolved = vi.spyOn(app.get(TurnEventBus), 'emitApprovalResolved');
        try {
          const started = await request(app.getHttpServer())
            .post(`/api/v1/skills/${skill.id}/run`)
            .set('authorization', authed())
            .send({ params: { query: 'owned exact request' } })
            .expect(201);
          expect(await settledRun(skill.id, started.body.runId)).toMatchObject({
            status: 'SUCCEEDED',
          });
          const run = await prisma.agentTurn.findFirstOrThrow({
            where: { botId },
            orderBy: { startedAt: 'desc' },
            include: { interrupts: true },
          });
          expect(run).toMatchObject({ status: 'completed', activeKey: null });
          expect(run.interrupts[0]?.response).toMatchObject({
            approved: true,
            args: { name: skill.name, params: { query: 'owned exact request' } },
          });
          expect(resolved).toHaveBeenCalledWith(botId, expect.objectContaining({ approved: true }));
          expect(resolved).not.toHaveBeenCalledWith(
            botId,
            expect.objectContaining({ approved: false }),
          );
          expect(await prisma.message.count({ where: { conversation: { botId } } })).toBe(
            messageCount,
          );
        } finally {
          resolved.mockRestore();
          await prisma.bot.update({ where: { id: botId }, data: { approvalMode: 'AUTO' } });
        }
      });
      it('a scheduled skill waits on owned approval and runs validated operator edits once', async () => {
        bridgeCalls.length = 0;
        bridgeReply = successReply;
        await prisma.bot.update({ where: { id: botId }, data: { approvalMode: 'ASK' } });
        const skill = await createSkill({ status: 'APPROVED' });
        const running = runs.runToCompletion(ACTOR, skill.id, { query: 'proposed' });
        try {
          const pending = await pendingSkill();
          expect(bridgeCalls).toEqual([]);
          expect(
            await app
              .get(ToolApprovalHub)
              .respond(FOREIGN_USER, pending.toolCallId, { approved: true }),
          ).toBe(false);
          // Waiting for the person must hold no action admission.
          const admitted = await app.get(SeatControlService).seats.admit(botId, 'exclusive');
          expect(admitted.ok).toBe(true);
          if (admitted.ok) admitted.release();
          expect(
            await app.get(ToolApprovalHub).respond(ACTOR, pending.toolCallId, {
              approved: true,
              editedArgs: { name: skill.name, params: { query: 'reviewed' } },
            }),
          ).toBe(true);
          expect(await running).toMatchObject({ status: 'SUCCEEDED' });
          expect(bridgeCalls).toHaveLength(1);
          expect(bridgeCalls[0]?.params).toEqual({ query: 'reviewed' });
          expect(
            (await prisma.agentTurn.findUniqueOrThrow({ where: { id: pending.turnId } })).activeKey,
          ).toBeNull();
          expect(await app.get(ToolApprovalHub).list(ACTOR, botId)).toEqual([]);
        } finally {
          app.get(TurnControlService).cancelTurn(ACTOR, botId);
          await running;
          await prisma.bot.update({ where: { id: botId }, data: { approvalMode: 'AUTO' } });
        }
      });
      it.each(['script', 'paramsSchema', 'status'] as const)(
        'refuses a scheduled skill whose %s changes while the operator reviews it',
        async (field) => {
          bridgeCalls.length = 0;
          bridgeReply = successReply;
          await prisma.bot.update({ where: { id: botId }, data: { approvalMode: 'ASK' } });
          const skill = await createSkill({ status: 'APPROVED' });
          const running = runs.runToCompletion(ACTOR, skill.id, { query: 'proposed' });
          try {
            const pending = await pendingSkill();
            await prisma.skill.update({
              where: { id: skill.id },
              data:
                field === 'script'
                  ? { script: 'changed approved bytes' }
                  : field === 'paramsSchema'
                    ? { paramsSchema: { type: 'object', additionalProperties: false } }
                    : { status: 'ARCHIVED' },
            });
            expect(
              await app.get(ToolApprovalHub).respond(ACTOR, pending.toolCallId, { approved: true }),
            ).toBe(true);
            expect(await running).toMatchObject({ status: 'FAILED' });
            expect(bridgeCalls).toEqual([]);
            const stored = await prisma.runInterrupt.findUniqueOrThrow({
              where: { id: pending.toolCallId },
            });
            expect(stored.response).toMatchObject({ approved: false });
            expect(
              (await prisma.agentTurn.findUniqueOrThrow({ where: { id: pending.turnId } }))
                .activeKey,
            ).toBeNull();
          } finally {
            app.get(TurnControlService).cancelTurn(ACTOR, botId);
            await running;
            await prisma.bot.update({ where: { id: botId }, data: { approvalMode: 'AUTO' } });
          }
        },
      );
      it('bot cancellation settles a pending scheduled replay without a model controller', async () => {
        bridgeCalls.length = 0;
        bridgeReply = successReply;
        await prisma.bot.update({ where: { id: botId }, data: { approvalMode: 'ASK' } });
        const skill = await createSkill({ status: 'APPROVED' });
        const running = runs.runToCompletion(ACTOR, skill.id, { query: 'proposed' });
        try {
          const pending = await pendingSkill();
          expect(app.get(TurnControlService).cancelTurn(ACTOR, botId)).toBe(true);
          expect(await running).toMatchObject({ status: 'FAILED' });
          expect(bridgeCalls).toEqual([]);
          expect(
            (await prisma.runInterrupt.findUniqueOrThrow({ where: { id: pending.toolCallId } }))
              .status,
          ).toBe('cancelled');
          expect(
            (await prisma.agentTurn.findUniqueOrThrow({ where: { id: pending.turnId } })).activeKey,
          ).toBeNull();
          expect(
            await app.get(ToolApprovalHub).respond(ACTOR, pending.toolCallId, { approved: true }),
          ).toBe(false);
        } finally {
          app.get(TurnControlService).cancelTurn(ACTOR, botId);
          await running;
          await prisma.bot.update({ where: { id: botId }, data: { approvalMode: 'AUTO' } });
        }
      });
      it('no builtin model input can change policy or create an approval', () => {
        const set = app
          .get(ToolRegistry)
          .toolSetFor({ botId, userId: ACTOR, groupId: null } as never);
        const forbidden = new Set([
          'approvalMode',
          'autoReviewRules',
          'grantRevision',
          'pluginGrantRevision',
          'approved',
          'binding',
          'commitAdapter',
        ]);
        function inspect(value: unknown) {
          if (value === null || typeof value !== 'object') return;
          for (const [key, child] of Object.entries(value)) {
            if (key === 'properties' && child !== null && typeof child === 'object') {
              for (const name of Object.keys(child)) expect(forbidden.has(name), name).toBe(false);
            }
            inspect(child);
          }
        }
        expect(Object.keys(set).length).toBeGreaterThan(20);
        for (const definition of Object.values(set))
          inspect(toolInputJsonSchema(definition.inputSchema));
      });
      it('answers 404 when the run does not belong to the skill in the path', async () => {
        bridgeCalls.length = 0;
        bridgeReply = () => ({
          status: 200,
          body: { ok: true, result: null, logs: [], durationMs: 1 },
        });
        const ran = await createSkill({ status: 'APPROVED' });
        const other = await createSkill({ status: 'APPROVED' });

        const started = await request(app.getHttpServer())
          .post(`/api/v1/skills/${ran.id}/run`)
          .set('authorization', authed())
          .send({ params: {} });
        expect(started.status).toBe(201);
        const runId = (started.body as { runId: string }).runId;
        await settledRun(ran.id, runId);

        // The run id alone is not a capability: reading it through another of
        // the caller's skills must not work either.
        const wrong = await at(`/api/v1/skills/${other.id}/runs/${runId}`);
        expect(wrong.status).toBe(404);
      });
    });

    describe('runs interrupted by a restart are settled at boot (M3-BE-09)', () => {
      it('settles PENDING and RUNNING rows FAILED, and leaves terminal rows alone', async () => {
        const skill = await createSkill({ status: 'APPROVED' });
        const pending = await prisma.skillRun.create({
          data: { skillId: skill.id, params: {}, status: 'PENDING' },
        });
        const running = await prisma.skillRun.create({
          data: { skillId: skill.id, params: {}, status: 'RUNNING', startedAt: new Date() },
        });
        const done = await prisma.skillRun.create({
          data: {
            skillId: skill.id,
            params: {},
            status: 'SUCCEEDED',
            error: null,
            endedAt: new Date(),
          },
        });

        // A PENDING/RUNNING run is claimed in memory by one process and
        // executed by it alone, so at boot those states can only mean the
        // owner is gone — and nothing else ever revisits the row (§8 does
        // not count run rows as work, so no sweep would). The count is
        // `>= 2` because the shared database may still hold other suites'
        // rows; the assertions below pin this suite's.
        await expect(runs.recoverInterruptedRuns()).resolves.toBeGreaterThanOrEqual(2);

        for (const row of [pending, running]) {
          const settled = await prisma.skillRun.findUniqueOrThrow({ where: { id: row.id } });
          expect(settled.status).toBe('FAILED');
          expect(settled.error).toBe('the run did not survive an orchestrator restart');
          expect(settled.endedAt).not.toBeNull();
        }

        const untouched = await prisma.skillRun.findUniqueOrThrow({ where: { id: done.id } });
        expect(untouched.status).toBe('SUCCEEDED');
      });
    });
  },
);
