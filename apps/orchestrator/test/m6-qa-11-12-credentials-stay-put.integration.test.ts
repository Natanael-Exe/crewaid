import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { BotPluginSchema, McpStatusPayloadSchema } from '@crewaid/shared';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { McpServersService } from '../src/mcp/mcp-servers.service.js';
import { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { storeMcpCredential } from '../src/mcp/mcp-credentials.js';
import { seatEnv } from '../src/agent/seat-env.js';
import { signIn, type SignedInUser } from './auth-fixture.js';

/**
 * M6-QA-11 and M6-QA-12 — where a plugin credential is, and everywhere it is not.
 *
 * §7.3 and §6/M6 ask two different questions and the tests have to be shaped
 * differently for each.
 *
 *   QA-11  "no API response anywhere in the app contains access or refresh
 *          token material." That is a question about BYTES, so every assertion
 *          here is against a serialized body or frame — never against a DTO
 *          type, which cannot see a field somebody added to a row and spread
 *          into a response.
 *
 *   QA-12  "no MCP credential is reachable from inside a sandbox." That is a
 *          question about REACHABILITY, and a behavioural test alone cannot
 *          answer it: proving a particular command did not see a token says
 *          nothing about the next command. So it is answered twice — once
 *          structurally (which files can read a credential at all) and once
 *          behaviourally (the entire environment a bot's command runs in).
 *
 * Needs DATABASE_URL. Without it every case skips and the run still reports
 * green (CLAUDE.md: a silently skipped test is a dormant guard).
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);

/** A string no legitimate response has any reason to contain. */
const ACCESS_MARKER = `tok_access_never_leaves_${RUN_ID}`;
const REFRESH_MARKER = `tok_refresh_never_leaves_${RUN_ID}`;

const SOURCE_ROOT = join(import.meta.dirname, '..', 'src');
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

let app: INestApplication;
let prisma: PrismaService;
let servers: McpServersService;
let ACTOR: SignedInUser;

const api = (path: string): string => `/api/v1${path}`;
const http = (): request.Test => request(app.getHttpServer()) as unknown as request.Test;

/** Every .ts file under a directory, recursively. */
function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M6-QA-11 / M6-QA-12 — a plugin credential leaves by no door',
  () => {
    beforeAll(async () => {
      process.env['CREDENTIAL_KEY'] = '55'.repeat(32);
      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module.js');
      const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      await app.init();

      prisma = app.get(PrismaService);
      servers = app.get(McpServersService);
      ACTOR = await signIn(prisma, { label: 'no-leak' });
    }, 60_000);

    afterAll(async () => {
      await prisma?.mcpServer.deleteMany({ where: { userId: ACTOR.userId } });
      await prisma?.bot.deleteMany({ where: { userId: ACTOR.userId } });
      await app?.close();
      await prisma?.user.deleteMany({ where: { id: ACTOR.userId } });
    });

    /**
     * A connected server holding a REAL credential, written through the
     * production seam.
     *
     * Through `storeMcpCredential` rather than a raw insert, because the claim
     * is about what leaves by the API — and a fixture holding plaintext would
     * be testing a row shape the API never produces. The row here is genuine
     * AES-256-GCM ciphertext under the same key production uses.
     */
    let seed = 0;

    async function serverWithCredential(): Promise<{
      id: string;
      name: string;
      botId: string;
      /** The CIPHERTEXT columns, which are token material too (see below). */
      readonly ciphertext: readonly string[];
    }> {
      seed += 1;
      const server = await prisma.mcpServer.create({
        data: {
          userId: ACTOR.userId,
          name: `Leaky ${RUN_ID} ${seed}`,
          slug: `leaky-${RUN_ID}-${seed}`,
          transport: 'HTTP',
          url: 'https://leaky.example.test/mcp',
          isPrivate: true,
          authType: 'OAUTH2',
          status: 'CONNECTED',
          tools: {
            create: [
              {
                name: 'list_things',
                description: 'List things',
                inputSchema: { type: 'object' },
                readOnly: true,
              },
            ],
          },
        },
      });
      await storeMcpCredential(prisma, {
        userId: ACTOR.userId,
        serverId: server.id,
        accessToken: ACCESS_MARKER,
        refreshToken: REFRESH_MARKER,
        scopes: ['things.read'],
      });
      const bot = await prisma.bot.create({
        data: {
          userId: ACTOR.userId,
          name: `Leak Subject ${RUN_ID}`,
          role: 'Tester',
          avatarColor: '#8B6F47',
          systemPrompt: '',
        },
      });
      await prisma.botMcpServer.create({
        data: { botId: bot.id, serverId: server.id, enabled: true },
      });
      // ⚠️ THE CIPHERTEXT IS PART OF THE CLAIM, and leaving it out is how this
      // test passed a mutation that spread the whole credential row into a
      // response: the columns hold AES-256-GCM output, so a leaked credential
      // carries no plaintext marker at all. §7.3 says "no API response
      // anywhere contains access or refresh token MATERIAL", and ciphertext is
      // material — it is the thing a key compromise turns into a token, and a
      // response with a field for it is a response a plaintext token can reach
      // by one careless change.
      const column = await prisma.mcpCredential.findUniqueOrThrow({
        where: { serverId: server.id },
        select: { accessToken: true, refreshToken: true },
      });
      return {
        id: server.id,
        name: server.name,
        botId: bot.id,
        ciphertext: [column.accessToken, column.refreshToken].filter(
          (value): value is string => typeof value === 'string' && value !== '',
        ),
      };
    }

    describe('M6-QA-11 — no token material on any response', () => {
      it('says nothing token-shaped on GET /bots/:id/plugins', async () => {
        const server = await serverWithCredential();

        const response = await http()
          .get(api(`/bots/${server.botId}/plugins`))
          .set(ACTOR.headers)
          .expect(200);

        // Against the SERIALIZED body, not the DTO type: a field added to the
        // row and spread into a response would be invisible to a type check,
        // and that is the shape this class of defect actually takes.
        const body = JSON.stringify(response.body);
        expect(body).not.toContain(ACCESS_MARKER);
        expect(body).not.toContain(REFRESH_MARKER);
        for (const stored of server.ciphertext) expect(body).not.toContain(stored);
        // …and the route did answer about the server holding it, so the
        // absence above is asserted against a presence rather than against an
        // empty list.
        const plugins = BotPluginSchema.array().parse(response.body);
        expect(plugins.map((row) => row.serverId)).toContain(server.id);
      });

      it('says nothing token-shaped on GET /mcp/servers, credential and all', async () => {
        const server = await serverWithCredential();

        const response = await http().get(api('/mcp/servers')).set(ACTOR.headers).expect(200);

        const body = JSON.stringify(response.body);
        expect(body).not.toContain(ACCESS_MARKER);
        expect(body).not.toContain(REFRESH_MARKER);
        for (const stored of server.ciphertext) expect(body).not.toContain(stored);
        expect(body).toContain(server.id);
      });

      it('says nothing token-shaped on the route that ACCEPTS one (D-114)', async () => {
        // The newest surface, and the one where a leak would be most natural:
        // this route's whole subject is a secret, so echoing what was just
        // stored is a one-line mistake that looks like a confirmation.
        const server = await serverWithCredential();
        const SUBMITTED = `sk-rotated-${ACCESS_MARKER}`;

        await prisma.mcpServer.update({
          where: { id: server.id },
          data: { authType: 'HEADER' },
        });

        const response = await http()
          .put(api(`/mcp/servers/${server.id}/credential`))
          .set(ACTOR.headers)
          .send({ bearerToken: SUBMITTED })
          .expect(200);

        const body = JSON.stringify(response.body);
        // Not the value that went in, one request ago and by this very route.
        expect(body).not.toContain(SUBMITTED);
        expect(body).not.toContain(ACCESS_MARKER);
        expect(body).not.toContain(REFRESH_MARKER);
        for (const stored of server.ciphertext) expect(body).not.toContain(stored);
        // Nor what it was turned into on the way to the column.
        const written = await prisma.mcpCredential.findUniqueOrThrow({
          where: { serverId: server.id },
          select: { accessToken: true },
        });
        expect(body).not.toContain(written.accessToken);
        // Asserted against a presence: the route did answer about this server.
        expect(body).toContain(server.id);
      });

      // The OTHER door a bearer enters by — `POST /mcp/servers` with a
      // `bearerToken` — is asserted in `mcp-servers.integration.test.ts`
      // instead of here. Installing over HTTP needs the DNS seam that suite
      // sets up (`admitEndpoint` resolves the host before a row exists), and
      // standing a second one up here to re-assert one absence would buy
      // duplication rather than coverage.
      it('says nothing token-shaped on the §4.2 mcp.status frame', async () => {
        // The frame is the third surface §6/M6 names, and the one that is
        // easiest to widen by accident: it carries a `lastError`, which is
        // built from whatever went wrong — and what went wrong is sometimes an
        // authorization server quoting the token back.
        const server = await serverWithCredential();
        const bus = app.get(TurnEventBus);
        const emitted = vi.spyOn(bus, 'emitMcpStatus');

        // A credential with coordinates but an unreachable endpoint: the
        // refresh is refused, which is the path that writes NEEDS_REAUTH and
        // announces it (D-103).
        await prisma.mcpCredential.update({
          where: { serverId: server.id },
          data: {
            expiresAt: new Date(Date.now() - 1_000),
            authMetadata: {
              tokenEndpoint: `https://token.invalid.test/${ACCESS_MARKER}`,
              clientId: 'client-under-test',
              resource: 'https://leaky.example.test/mcp',
            },
          },
        });

        await expect(servers.refreshTools(ACTOR.userId, server.id)).rejects.toThrow();

        expect(emitted).toHaveBeenCalled();
        const [owner, serverId, status, toolCount, lastError] = emitted.mock.calls[0] ?? [];
        // To the server's owner only (the bus delivers nowhere else).
        expect(owner).toBe(ACTOR.userId);
        // The payload is exactly §4.2's shape — a status, a count and a
        // sentence, with no field token material could travel in.
        const payload = McpStatusPayloadSchema.parse({
          serverId,
          status,
          toolCount,
          ...(lastError === undefined ? {} : { lastError }),
        });
        const frame = JSON.stringify(payload);
        expect(frame).not.toContain(ACCESS_MARKER);
        expect(frame).not.toContain(REFRESH_MARKER);
        for (const stored of server.ciphertext) expect(frame).not.toContain(stored);
        expect(payload.status).toBe('NEEDS_REAUTH');
        emitted.mockRestore();
      }, 30_000);
    });

    describe('M6-QA-12 — no credential is reachable from inside a sandbox', () => {
      it('has exactly one reader of the credential seam, and it is not near a sandbox', () => {
        // The STRUCTURAL half. A behavioural test can only say that one
        // command did not see a token; this says which files could hand one to
        // anything at all, and it fails the moment a new one does.
        const readers = sourceFiles(SOURCE_ROOT)
          .filter((path) => readFileSync(path, 'utf8').includes("from './mcp-credentials.js'"))
          .map((path) => relative(REPO_ROOT, path));

        expect(readers).toEqual(['apps/orchestrator/src/mcp/mcp-servers.service.ts']);
      });

      it('keeps the credential seam out of every module a tool can reach', () => {
        // The complement of the case above, asserted from the other side: the
        // packages a container runs code from, and the orchestrator modules
        // that hold a session, must not import it under ANY spelling. R10's
        // lint rule fences the packages; this covers the orchestrator side,
        // where there is no import to restrict because the file is local.
        const reachable = [
          join(SOURCE_ROOT, 'sandbox'),
          join(SOURCE_ROOT, 'agent'),
          join(SOURCE_ROOT, 'skills'),
        ].flatMap(sourceFiles);
        expect(reachable.length).toBeGreaterThan(20);

        const offenders = reachable.filter((path) => {
          const source = readFileSync(path, 'utf8');
          return (
            source.includes('mcp-credentials') ||
            source.includes('readMcpCredential') ||
            source.includes('CREDENTIAL_KEY')
          );
        });

        expect(offenders.map((path) => relative(REPO_ROOT, path))).toEqual([]);
      });

      it('gives a command on a bot’s desktop exactly two environment variables', () => {
        // The BEHAVIOURAL half, and the reason it is an allowlist rather than
        // a denylist: "the token is not in here" is true of any env until
        // somebody adds one, while "these two and nothing else" fails the
        // moment anything is threaded through. `seatEnv` is the only thing
        // that supplies an environment to a bot's exec, and `createSession`
        // supplies none at all.
        const env = seatEnv({ display: ':10', dbusAddress: 'unix:path=/run/seat' });

        expect(Object.keys(env).sort()).toEqual(['DBUS_SESSION_BUS_ADDRESS', 'DISPLAY']);
        expect(JSON.stringify(env)).not.toContain('tok_');
      });

      it('creates a container with no environment of its own', () => {
        // `CREDENTIAL_KEY` decrypts every plugin credential this orchestrator
        // holds, so its presence inside a container would make every other
        // assertion here beside the point. Nothing passes an environment to
        // `createSession`, and the provider builds a container's env from
        // `spec.env` — so "no env at the one call that creates one" is the
        // statement, and a future `env: {...}` there is the single edit that
        // could carry a secret in.
        const service = readFileSync(join(SOURCE_ROOT, 'sandbox', 'sandbox.service.ts'), 'utf8');
        const at = service.indexOf('this.provider.createSession({');
        expect(at).toBeGreaterThan(-1);
        const call = service.slice(at, service.indexOf('});', at));
        expect(call).not.toContain('env');
        expect(call).not.toContain('CREDENTIAL_KEY');
      });
    });
  },
);
