import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  ListMcpDirectoryResponseSchema,
  ListMcpServersResponseSchema,
  McpServerSummarySchema,
  type McpServerSummary,
} from '@crewaid/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { McpServersService } from '../src/mcp/mcp-servers.service.js';
import { storeMcpCredential } from '../src/mcp/mcp-credentials.js';
import { signIn, type SignedInUser } from './auth-fixture.js';
import { startStubMcpServer, stubFetchTo, type StubMcpServer } from './mcp-stub.js';

/**
 * M6-BE-02 over real HTTP, through the real guard chain (D-010, D-085).
 *
 * Two users throughout, for the same reason every D-010 suite has two: a
 * one-user suite passes whether or not the `where` clauses scope anything, so
 * the foreign rows exist for the whole run and every refusal is asserted
 * against a presence — the row the caller must not reach is fetched by its
 * owner in the same test.
 *
 * ── THE STUB AND THE TWO SEAMS ─────────────────────────────────────────────
 *
 * The server below speaks the actual protocol (modern `server/discover`, then
 * `tools/list`), because a mocked fetch cannot catch the wiring failures that
 * matter: content types, capabilities, the shape `toToolDescriptor` accepts.
 *
 * It listens on plain `http://127.0.0.1`, which is exactly what production
 * refuses for BOTH halves of the URL story: `admitEndpoint` refuses a private
 * address at install, and the guarded fetch refuses it again at request time
 * (D-085, D-099). So the suite uses the two seams the service exposes for
 * precisely this and states what each stands in for:
 *
 *   - `setAddressResolverForTests` — DNS. `stub.example.test` and
 *     `mcp.deepwiki.com` resolve to a public address, so install is exercised
 *     without the internet. `blocked.example.test` resolves to a
 *     link-local-range address, which is the refusal case.
 *   - `setMcpFetchForTests` — a caller that has already admitted the URL. It
 *     rewrites scheme and host onto the stub, which is the same promise the
 *     parameter makes in production code.
 *
 * Needs DATABASE_URL. Without it every case skips and the run still reports
 * green (CLAUDE.md: a silently skipped test is a dormant guard).
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);

let app: INestApplication;
let prisma: PrismaService;
let servers: McpServersService;
let ACTOR: SignedInUser;
let FOREIGN: SignedInUser;
let stub: StubMcpServer;

const api = (path: string): string => `/api/v1${path}`;
const http = (): request.Test => request(app.getHttpServer()) as unknown as request.Test;

const SEARCH_TOOL = {
  name: 'search_invoices',
  description: 'Search invoices',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  annotations: { readOnlyHint: true },
};

const SEND_TOOL = {
  name: 'send_invoice',
  description: 'Send one invoice',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
};

const DEFAULT_TOOLS = [SEARCH_TOOL, SEND_TOOL];

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M6-BE-02 — the plugin directory and installed MCP servers',
  () => {
    let seedCount = 0;

    beforeAll(async () => {
      // Credentials in this suite are written through the production seam, so
      // it needs the key that seam uses (M6-BE-04).
      process.env['CREDENTIAL_KEY'] = '22'.repeat(32);

      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module.js');
      const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      // Keep one loopback listener for the suite, including concurrent refreshes.
      await app.listen(0, '127.0.0.1');

      prisma = app.get(PrismaService);
      ACTOR = await signIn(prisma, { label: 'mcp' });
      FOREIGN = await signIn(prisma, { label: 'mcp-foreign' });

      stub = await startStubMcpServer();
      servers = app.get(McpServersService);
      servers.setAddressResolverForTests((hostname) =>
        hostname === 'blocked.example.test'
          ? Promise.resolve(['169.254.169.254'])
          : Promise.resolve(['93.184.216.34']),
      );
      servers.setMcpFetchForTests(stubFetchTo(stub, STUB_HOSTS));
      // Same reason as the OAuth suite's hook: the app boot and the two
      // sign-ins are host-load, and 10s is not a statement about this code.
    }, 60_000);

    /** The union of both list routes, so a case can assert "nothing of mine". */
    async function listServers(actor: SignedInUser = ACTOR): Promise<McpServerSummary[]> {
      const response = await http().get(api('/mcp/servers')).set(actor.headers).expect(200);
      return ListMcpServersResponseSchema.parse(response.body);
    }

    async function install(body: unknown, actor: SignedInUser = ACTOR): Promise<McpServerSummary> {
      const response = await http()
        .post(api('/mcp/servers'))
        .set(actor.headers)
        .send(body)
        .expect(201);
      return McpServerSummarySchema.parse(response.body);
    }

    /** An install that must be refused; the body is asserted by the caller. */
    async function installRefused(
      body: unknown,
      status: number,
      actor: SignedInUser = ACTOR,
    ): Promise<{ body: Record<string, unknown> }> {
      // The response is returned rather than discarded so a case can assert on
      // the SENTENCE as well as the status: D-093 is that a refusal has to say
      // what to do next, and a status code says nothing.
      const response = await http()
        .post(api('/mcp/servers'))
        .set(actor.headers)
        .send(body)
        .expect(status);
      return { body: response.body as Record<string, unknown> };
    }

    const refresh = (id: string, actor: SignedInUser = ACTOR): request.Test =>
      http()
        .post(api(`/mcp/servers/${id}/refresh-tools`))
        .set(actor.headers);

    /** A row written directly, which is the only way a row can point at the stub. */
    async function seedServer(overrides: Record<string, unknown> = {}) {
      seedCount += 1;
      return prisma.mcpServer.create({
        data: {
          userId: ACTOR.userId,
          name: `Seeded ${seedCount}`,
          slug: `seeded-${RUN_ID}-${seedCount}`,
          transport: 'HTTP',
          url: `${stub.origin}/mcp`,
          isPrivate: true,
          authType: 'NONE',
          ...overrides,
        },
      });
    }

    async function clearFixtures(): Promise<void> {
      // Cascades to McpTool, McpCredential and BotMcpServer.
      await prisma.mcpServer.deleteMany({
        where: { userId: { in: [ACTOR.userId, FOREIGN.userId] } },
      });
      await prisma.bot.deleteMany({ where: { userId: { in: [ACTOR.userId, FOREIGN.userId] } } });
    }

    beforeEach(async () => {
      stub.tools = DEFAULT_TOOLS;
      stub.listings = undefined;
      // D-114's cases make the stub demand a bearer. One stub serves the whole
      // file, so a demand left standing turns the next case's request into a
      // 401 it never asked for — which arrives as a 502 and reads exactly like
      // a refresh regression.
      stub.requireBearer = undefined;
      stub.authorizations.length = 0;
      await clearFixtures();
    });

    afterAll(async () => {
      await clearFixtures();
      servers.setMcpFetchForTests(undefined);
      servers.setAddressResolverForTests(undefined);
      await stub.close();
      await app.close();
      await prisma.user.deleteMany({ where: { id: { in: [ACTOR.userId, FOREIGN.userId] } } });
    }, 60_000);

    describe('the curated directory', () => {
      it('lists the catalog in the §4.1 shape, with no endpoint in it', async () => {
        const response = await http().get(api('/mcp/directory')).set(ACTOR.headers).expect(200);
        const entries = ListMcpDirectoryResponseSchema.parse(response.body);

        const deepwiki = entries.find((entry) => entry.slug === 'deepwiki');
        expect(deepwiki).toBeDefined();
        expect(deepwiki?.authType).toBe('NONE');
        expect(deepwiki?.category).toBe('Documentation');
        // The installer resolves the endpoint server-side; §4.1's entry has no
        // field one could travel in, and this is the assertion that says so.
        expect(JSON.stringify(response.body)).not.toContain('mcp.deepwiki.com');
      });
    });

    describe('installing', () => {
      it('installs a directory entry in one action, disconnected and empty', async () => {
        const installed = await install({ slug: 'deepwiki' });

        expect(installed.slug).toBe('deepwiki');
        expect(installed.name).toBe('DeepWiki');
        expect(installed.category).toBe('Documentation');
        expect(installed.transport).toBe('HTTP');
        expect(installed.url).toBe('https://mcp.deepwiki.com/mcp');
        expect(installed.isPrivate).toBe(false);
        expect(installed.authType).toBe('NONE');
        // §4.1's two routes split the work: install writes the row, refresh
        // connects. Nothing a user clicks to ADD a plugin depends on somebody
        // else's server answering.
        expect(installed.status).toBe('DISCONNECTED');
        expect(installed.toolCount).toBe(0);
        expect(installed.lastError).toBeNull();
      });

      it('installs a private server by URL, with a slug read from its name', async () => {
        const installed = await install({
          name: 'Stub  Server!',
          url: 'https://stub.example.test/mcp',
          transport: 'HTTP',
        });

        expect(installed.slug).toBe('stub-server');
        expect(installed.name).toBe('Stub  Server!');
        expect(installed.isPrivate).toBe(true);
        expect(installed.category).toBeNull();
        expect(installed.iconUrl).toBeNull();
        // The only claim available for a URL nobody curated (see the service).
        expect(installed.authType).toBe('NONE');
        expect(installed.status).toBe('DISCONNECTED');
      });

      it('refuses a slug the directory does not ship', async () => {
        await installRefused({ slug: 'not-in-this-build' }, 400);
        expect(await listServers()).toEqual([]);
      });

      it('refuses a second server on a slug an install already used', async () => {
        await install({ slug: 'deepwiki' });

        await installRefused(
          { name: 'DeepWiki', url: 'https://stub.example.test/mcp', transport: 'HTTP' },
          409,
        );
        // …and the refusal left the first one alone.
        const listed = await listServers();
        expect(listed).toHaveLength(1);
        expect(listed[0]?.isPrivate).toBe(false);
      });

      it('refuses a private URL this orchestrator will not open a socket to', async () => {
        // Plaintext: the row would put an OAuth token on the wire in the clear.
        await installRefused(
          { name: 'Insecure', url: 'http://stub.example.test/mcp', transport: 'HTTP' },
          400,
        );
        // A public-looking name that resolves into a private range (D-085).
        await installRefused(
          { name: 'Internal', url: 'https://blocked.example.test/mcp', transport: 'HTTP' },
          400,
        );
        expect(await listServers()).toEqual([]);
      });

      it('refuses a name with no namespace in it', async () => {
        await installRefused(
          { name: '!!!', url: 'https://stub.example.test/mcp', transport: 'HTTP' },
          400,
        );
        expect(await listServers()).toEqual([]);
      });

      it('refuses a name whose slug would shadow a built-in tool (M6-BE-06)', async () => {
        // §6/M6: "The registry rejects a server whose slug collides with a
        // built-in tool prefix." Refused at install, where the operator is
        // there to read it, rather than at the first turn that would have
        // offered `browser__click` beside this build's own `browser_click`.
        const refusal = await installRefused(
          { name: 'Browser', url: 'https://stub.example.test/mcp', transport: 'HTTP' },
          400,
        );
        expect(String(refusal.body.message)).toContain('browser_');
        expect(await listServers()).toEqual([]);

        // …and the check is against the LIVE registry, including the tools that
        // register in onModuleInit rather than in the module factory. A list
        // snapshotted at construction would be missing `send_message`, and a
        // server slugged `send` would install cleanly and shadow delivery.
        await installRefused(
          { name: 'Send', url: 'https://stub.example.test/mcp', transport: 'HTTP' },
          400,
        );
        expect(await listServers()).toEqual([]);

        // The falsification: a name one letter away installs, so the refusal
        // above is the collision rule and not a blanket refusal of short names.
        const installed = await install({
          name: 'Browsers',
          url: 'https://stub.example.test/mcp',
          transport: 'HTTP',
        });
        expect(installed.slug).toBe('browsers');
      });
    });

    describe('D-114 a private server with a bearer token', () => {
      const TOKEN = 'sk-private-abcdefghijklmnop';

      async function installWithToken(token: string = TOKEN): Promise<McpServerSummary> {
        return install({
          name: `Bearer ${RUN_ID}`,
          url: 'https://stub.example.test/mcp',
          transport: 'HTTP',
          bearerToken: token,
        });
      }

      it('installs as HEADER rather than NONE, and says nothing about the token', async () => {
        const installed = await installWithToken();

        expect(installed.authType).toBe('HEADER');
        expect(installed.isPrivate).toBe(true);
        // §7.3, asserted on the SERIALIZED body rather than the parsed type:
        // a field that does not exist in the schema can still be sent.
        expect(JSON.stringify(installed)).not.toContain(TOKEN);
      });

      it('stores it encrypted, so the column is not the token', async () => {
        const installed = await installWithToken();

        const row = await prisma.mcpCredential.findFirstOrThrow({
          where: { serverId: installed.id },
        });
        expect(row.accessToken).not.toContain(TOKEN);
        expect(row.accessToken.length).toBeGreaterThan(0);
        // A bearer an operator typed has no second half and no grant.
        expect(row.refreshToken).toBeNull();
        expect(row.expiresAt).toBeNull();
        expect(row.scopes).toEqual([]);
      });

      it('connects by sending the token, without a browser trip', async () => {
        stub.requireBearer = TOKEN;
        stub.tools = [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }];
        const installed = await installWithToken();

        const response = await http()
          .post(api(`/mcp/servers/${installed.id}/connect`))
          .set(ACTOR.headers)
          .expect(200);

        // `{connected: true}`, not an authorize URL: there is nothing to
        // authorize, and a browser trip here would be one that cannot finish.
        expect(response.body).toEqual({ connected: true });
        expect(stub.authorizations).toContain(`Bearer ${TOKEN}`);
        const [listed] = await listServers();
        expect(listed?.status).toBe('CONNECTED');
        expect(listed?.toolCount).toBe(1);
      });

      it('refuses to connect when the stored token is the wrong one', async () => {
        stub.requireBearer = TOKEN;
        const installed = await installWithToken('sk-private-wrongwrongwrong');

        await http()
          .post(api(`/mcp/servers/${installed.id}/connect`))
          .set(ACTOR.headers)
          .expect(409);

        // NEEDS_REAUTH, not ERROR: the server answered, and what it rejected
        // is fixable by pasting a new value.
        const [listed] = await listServers();
        expect(listed?.status).toBe('NEEDS_REAUTH');
      });

      it('spends no refresh on a rejected bearer, because there is none', async () => {
        stub.requireBearer = TOKEN;
        const installed = await installWithToken('sk-private-wrongwrongwrong');
        const before = await prisma.mcpCredential.findFirstOrThrow({
          where: { serverId: installed.id },
        });

        await http()
          .post(api(`/mcp/servers/${installed.id}/connect`))
          .set(ACTOR.headers)
          .expect(409);

        // Not a request count — one connection attempt makes several HTTP
        // requests below this code. What the OAuth ladder does on a 401 is
        // REWRITE the credential and try the new one; a header credential has
        // nothing to rewrite, so an untouched row is the ladder not running.
        const after = await prisma.mcpCredential.findFirstOrThrow({
          where: { serverId: installed.id },
        });
        expect(after.accessToken).toBe(before.accessToken);
        expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
        // And every attempt carried the one token that was stored.
        expect(new Set(stub.authorizations).size).toBe(1);
      });

      it('replaces the token, and clears the state the old one earned', async () => {
        stub.requireBearer = TOKEN;
        const installed = await installWithToken('sk-private-wrongwrongwrong');
        await http()
          .post(api(`/mcp/servers/${installed.id}/connect`))
          .set(ACTOR.headers)
          .expect(409);

        const response = await http()
          .put(api(`/mcp/servers/${installed.id}/credential`))
          .set(ACTOR.headers)
          .send({ bearerToken: TOKEN })
          .expect(200);

        const updated = McpServerSummarySchema.parse(response.body);
        expect(updated.status).toBe('DISCONNECTED');
        expect(updated.lastError).toBeNull();
        expect(JSON.stringify(updated)).not.toContain(TOKEN);

        // And the replacement is the one that gets sent.
        stub.requireBearer = TOKEN;
        await http()
          .post(api(`/mcp/servers/${installed.id}/connect`))
          .set(ACTOR.headers)
          .expect(200);
        expect(stub.authorizations).toContain(`Bearer ${TOKEN}`);
      });

      it('refuses a blank token rather than storing one', async () => {
        const installed = await installWithToken();

        await http()
          .put(api(`/mcp/servers/${installed.id}/credential`))
          .set(ACTOR.headers)
          .send({ bearerToken: '' })
          .expect(400);
      });

      it('refuses to set a bearer on a server that does not use one', async () => {
        const installed = await install({ slug: 'deepwiki' });

        const response = await http()
          .put(api(`/mcp/servers/${installed.id}/credential`))
          .set(ACTOR.headers)
          .send({ bearerToken: TOKEN })
          .expect(409);

        expect(String((response.body as { message?: string }).message)).toContain(
          'nothing here to replace',
        );
      });

      it('answers 404 for another user\u2019s server, the same as an absent one', async () => {
        const installed = await installWithToken();

        // D-010's non-leaking shape, asserted against a presence: the row
        // exists and its owner can reach it, which is what makes the 404 a
        // statement about the caller rather than about the id.
        await http()
          .put(api(`/mcp/servers/${installed.id}/credential`))
          .set(FOREIGN.headers)
          .send({ bearerToken: TOKEN })
          .expect(404);
        await http()
          .put(api(`/mcp/servers/${installed.id}/credential`))
          .set(ACTOR.headers)
          .send({ bearerToken: TOKEN })
          .expect(200);
      });
    });

    describe('listing', () => {
      it('lists this user’s servers and nobody else’s', async () => {
        await install({ slug: 'deepwiki' });
        await install({ slug: 'deepwiki' }, FOREIGN);

        const mine = await listServers();
        const theirs = await listServers(FOREIGN);

        expect(mine).toHaveLength(1);
        expect(theirs).toHaveLength(1);
        expect(mine[0]?.id).not.toBe(theirs[0]?.id);
      });

      it('says nothing token-shaped, whatever is in the credential row', async () => {
        const installed = await install({ slug: 'deepwiki' });
        // Written through the production seam, so the row holds real
        // ciphertext: the claim is that nothing token-shaped leaves by the
        // API, and a fixture holding plaintext would not have to be tested
        // against the encryption the API never sees (M6-BE-04).
        await storeMcpCredential(prisma, {
          userId: ACTOR.userId,
          serverId: installed.id,
          accessToken: 'tok_m6be02_do_not_leak',
          refreshToken: 'ref_m6be02_do_not_leak',
          scopes: [],
        });

        const response = await http().get(api('/mcp/servers')).set(ACTOR.headers).expect(200);
        // §7.3, asserted against the serialized body rather than the type: a
        // field added to the summary would be invisible to a type-level check.
        const body = JSON.stringify(response.body);
        expect(body).not.toContain('do_not_leak');
        // ⚠️ AND NOT THE CIPHERTEXT EITHER. The plaintext assertion above
        // passes against a response that spreads the WHOLE credential row,
        // because the columns hold AES-256-GCM output and carry no marker.
        // §7.3 says token MATERIAL, and ciphertext is material: it is what a
        // key compromise turns into a token, and a response with a field for
        // it is one careless change from carrying the plaintext.
        const stored = await prisma.mcpCredential.findUniqueOrThrow({
          where: { serverId: installed.id },
          select: { accessToken: true, refreshToken: true },
        });
        expect(body).not.toContain(stored.accessToken);
        expect(body).not.toContain(stored.refreshToken ?? 'ref_m6be02_do_not_leak');
        expect(McpServerSummarySchema.parse(response.body[0]).toolCount).toBe(0);
      });
    });

    describe('refreshing tools', () => {
      it('lists the tools, caches them, and marks the server connected', async () => {
        const server = await seedServer();

        const response = await refresh(server.id).expect(200);
        const summary = McpServerSummarySchema.parse(response.body);
        expect(summary.status).toBe('CONNECTED');
        expect(summary.toolCount).toBe(2);
        expect(summary.lastError).toBeNull();

        const cached = await prisma.mcpTool.findMany({
          where: { serverId: server.id },
          orderBy: { name: 'asc' },
        });
        expect(cached.map((tool) => tool.name)).toEqual(['search_invoices', 'send_invoice']);
        expect(cached[0]?.description).toBe('Search invoices');
        expect(cached[0]?.inputSchema).toEqual({
          type: 'object',
          properties: { query: { type: 'string' } },
        });
        // The annotation rung: a server that says a tool is read-only is
        // believed, and one that says nothing about a tool whose name matches
        // nothing is not classified as one.
        expect(cached[0]?.readOnly).toBe(true);
        expect(cached[1]?.readOnly).toBe(false);
      });

      it('classifies an unannotated tool by its name, at list time (M6-BE-08)', async () => {
        // The rung the case above cannot reach: §6/M6's ladder is annotation,
        // then name pattern, then treat as a write, and the first case only
        // exercises tools that carry an annotation or match no pattern. All
        // three tools here are unannotated, so the only thing that can tell
        // them apart is the name.
        const server = await seedServer();
        stub.tools = [
          { name: 'list_invoices', description: 'List them', inputSchema: { type: 'object' } },
          { name: 'archive_invoice', description: 'Archive one', inputSchema: { type: 'object' } },
          // Deliberately a bare verb: the pattern is `search_*`, and widening
          // it to the verb is the unsafe direction (see mcp-readonly.ts).
          { name: 'search', description: 'Search', inputSchema: { type: 'object' } },
        ];

        await refresh(server.id).expect(200);

        const cached = await prisma.mcpTool.findMany({
          where: { serverId: server.id },
          orderBy: { name: 'asc' },
          select: { name: true, readOnly: true },
        });
        expect(cached).toEqual([
          { name: 'archive_invoice', readOnly: false },
          { name: 'list_invoices', readOnly: true },
          { name: 'search', readOnly: false },
        ]);
      });

      it('lets a server overrule its own name pattern with readOnlyHint: false', async () => {
        const server = await seedServer();
        stub.tools = [
          {
            name: 'get_report',
            description: 'Generates and bills for a report',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: false },
          },
        ];

        await refresh(server.id).expect(200);

        // The whole reason `readOnlyHint` is carried as `boolean | undefined`
        // rather than defaulted (D-099): absent falls through to the pattern,
        // `false` does not. A ladder that folded them together would classify
        // this one as a read and run it without asking.
        const cached = await prisma.mcpTool.findFirst({ where: { serverId: server.id } });
        expect(cached?.readOnly).toBe(false);
      });

      it('makes a private server behave exactly like a directory entry', async () => {
        const fromDirectory = await install({ slug: 'deepwiki' });
        const byUrl = await install({
          name: 'Stub Server',
          url: 'https://stub.example.test/mcp',
          transport: 'HTTP',
        });

        // Both rows now point at the stub through the test fetch, which is the
        // point: after install, nothing downstream can tell them apart.
        const directory = McpServerSummarySchema.parse(
          (await refresh(fromDirectory.id).expect(200)).body,
        );
        const private_ = McpServerSummarySchema.parse((await refresh(byUrl.id).expect(200)).body);

        expect(directory.status).toBe('CONNECTED');
        expect(private_.status).toBe('CONNECTED');
        expect(directory.toolCount).toBe(private_.toolCount);
        expect(private_.isPrivate).toBe(true);
        expect(directory.isPrivate).toBe(false);
        expect(private_.lastError).toBeNull();
      });

      it('drops a tool the server stopped offering', async () => {
        const server = await seedServer();
        await refresh(server.id).expect(200);

        stub.tools = [SEARCH_TOOL];
        const response = await refresh(server.id).expect(200);

        expect(McpServerSummarySchema.parse(response.body).toolCount).toBe(1);
        const names = (
          await prisma.mcpTool.findMany({ where: { serverId: server.id }, select: { name: true } })
        ).map((tool) => tool.name);
        // A stale row is a name the bot would still be offered, and it can
        // only fail — and it would count against M6-BE-07's budget.
        expect(names).toEqual(['search_invoices']);
      });

      it('keeps one complete listing when refreshes overlap', async () => {
        const server = await seedServer();
        const listings = Array.from({ length: 4 }, (_, page) =>
          Array.from({ length: 20 }, (_, tool) => ({
            ...SEARCH_TOOL,
            name: `listing_${page}_tool_${tool}`,
          })),
        );
        stub.listings = [...listings];

        await Promise.all(listings.map(() => refresh(server.id).expect(200)));

        const cached = await prisma.mcpTool.findMany({
          where: { serverId: server.id },
          orderBy: { name: 'asc' },
        });
        const names = cached.map((tool) => tool.name);
        expect(listings.map((listing) => listing.map((tool) => tool.name).sort())).toContainEqual(
          names,
        );
      });

      it('records a server that does not answer as ERROR, then says so', async () => {
        const server = await seedServer({ url: 'http://127.0.0.1:1/mcp' });

        await refresh(server.id).expect(502);

        const row = await prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id } });
        expect(row.status).toBe('ERROR');
        expect(row.lastError).toBeTruthy();
        // The list the modal polls agrees with the error it was just shown.
        const listed = (await listServers()).find((entry) => entry.id === server.id);
        expect(listed?.status).toBe('ERROR');
        expect(listed?.lastError).toBe(row.lastError);
        // The cached tools survive: the status is what keeps them out of a
        // turn (M6-BE-10), and dropping them would lose the only record of
        // what this server offers for no gain.
        expect(listed?.toolCount).toBe(0);
      });

      it('refuses to dial a server that needs a credential', async () => {
        const server = await seedServer({ authType: 'OAUTH2' });

        await refresh(server.id).expect(409);

        // Untouched: nothing was attempted, so nothing is marked failed. The
        // OAuth flow that fills this in is M6-BE-03's.
        const row = await prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id } });
        expect(row.status).toBe('DISCONNECTED');
        expect(row.lastError).toBeNull();
      });

      it('says reconnect for a credential it cannot read, not "connect it first"', async () => {
        // The row M6-BE-03 wrote before M6-BE-04 encrypted anything: the token
        // itself, in the column. A read of it fails, and that is a THIRD answer
        // — not "never connected" (which would send the user to a button that
        // is not the problem) and not a dial with no header (which would cache
        // the server's 401 as the server's fault). Only the credential read
        // answers 409 on this route, and it answers before any socket is
        // opened.
        const server = await seedServer({ authType: 'OAUTH2' });
        await prisma.mcpCredential.create({
          data: { serverId: server.id, accessToken: 'tok_m6be02_plaintext', scopes: [] },
        });

        const response = await refresh(server.id).expect(409);
        const message = (response.body as { message: string }).message;
        expect(message).toContain('cannot be read');
        expect(message).toContain('reconnect');

        // Nothing was attempted against the server and nothing was demoted:
        // the credential is the thing that needs replacing, not the status.
        const row = await prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id } });
        expect(row.status).toBe('DISCONNECTED');
        expect(row.lastError).toBeNull();
      });

      it('answers a misconfigured keyring with 503, not a demoted server', async () => {
        // The key is a fact about THIS orchestrator, not about the server: a
        // deployment with no CREDENTIAL_KEY cannot decrypt any credential, and
        // the filter for it answers 503 naming the variable (M6-BE-04). The
        // refresh route reads a credential before it dials, so this failure
        // arrives from inside the operation's own guard — and marking the row
        // ERROR would turn one deployment mistake into a per-server fault that
        // only a successful refresh could clear.
        const server = await seedServer({ authType: 'OAUTH2' });
        await storeMcpCredential(prisma, {
          userId: ACTOR.userId,
          serverId: server.id,
          accessToken: 'tok_keyring_probe',
          scopes: [],
        });

        const key = process.env['CREDENTIAL_KEY'];
        delete process.env['CREDENTIAL_KEY'];
        try {
          const response = await refresh(server.id).expect(503);
          expect((response.body as { message: string }).message).toContain('CREDENTIAL_KEY');
        } finally {
          process.env['CREDENTIAL_KEY'] = key;
        }

        const row = await prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id } });
        expect(row.status).toBe('DISCONNECTED');
        expect(row.lastError).toBeNull();
      });

      it('cannot refresh somebody else’s server', async () => {
        const server = await seedServer();

        await refresh(server.id, FOREIGN).expect(404);

        const row = await prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id } });
        expect(row.status).toBe('DISCONNECTED');
      });
    });

    describe('uninstalling', () => {
      it('takes the credential, the tool cache and every bot link with it', async () => {
        const server = await seedServer();
        await refresh(server.id).expect(200);
        const bot = await prisma.bot.create({
          data: {
            userId: ACTOR.userId,
            name: `mcp-${RUN_ID}`,
            role: 'test',
            avatarColor: '#8B6F47',
            systemPrompt: 'test',
          },
        });
        await prisma.botMcpServer.create({ data: { botId: bot.id, serverId: server.id } });
        await storeMcpCredential(prisma, {
          userId: ACTOR.userId,
          serverId: server.id,
          accessToken: 'tok_m6be02_do_not_leak',
          scopes: [],
        });

        await http()
          .delete(api(`/mcp/servers/${server.id}`))
          .set(ACTOR.headers)
          .expect(204);

        expect(await prisma.mcpServer.count({ where: { id: server.id } })).toBe(0);
        expect(await prisma.mcpTool.count({ where: { serverId: server.id } })).toBe(0);
        expect(await prisma.mcpCredential.count({ where: { serverId: server.id } })).toBe(0);
        expect(await prisma.botMcpServer.count({ where: { serverId: server.id } })).toBe(0);
        expect(await listServers()).toEqual([]);
      });

      it('cannot uninstall somebody else’s server', async () => {
        const server = await seedServer();

        await http()
          .delete(api(`/mcp/servers/${server.id}`))
          .set(FOREIGN.headers)
          .expect(404);

        expect(await prisma.mcpServer.count({ where: { id: server.id } })).toBe(1);
      });
    });
  },
);

/**
 * The hostnames this suite installs by URL: a curated one, and a private one.
 *
 * `stubFetchTo` rewrites only these onto the loopback stub, so a row can hold
 * an installable `https://…` address while its socket lands on the fixture.
 * Everything else passes through untouched, which is what keeps the row that
 * is SUPPOSED to fail pointing at a genuinely dead address — rewriting it too
 * would make the "does not answer" case reach a server that answers.
 */
const STUB_HOSTS = new Set(['mcp.deepwiki.com', 'stub.example.test']);
