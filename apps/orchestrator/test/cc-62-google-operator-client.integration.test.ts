import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { McpServerSummarySchema, type McpServerSummary } from '@crewaid/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { McpServersService } from '../src/mcp/mcp-servers.service.js';
import { readMcpCredential, storeMcpCredential } from '../src/mcp/mcp-credentials.js';
import { signIn, type SignedInUser } from './auth-fixture.js';
import { startStubMcpServer, type StubMcpServer } from './mcp-stub.js';

/**
 * CC-62 / D-118 — Google's Workspace MCP servers, connected with the operator's
 * own OAuth client: the one Better Auth already signs people in with.
 *
 * ── WHY GOOGLE NEEDED ITS OWN PATH ─────────────────────────────────────────
 *
 * Every other OAuth entry is discovered (RFC 9728 metadata) and registers its
 * own public client (RFC 7591). Google's servers publish no metadata, never
 * challenge, and its authorization server has no registration endpoint. The
 * stub below reproduces exactly that shape: the protected-resource and RFC
 * 8414 paths 404, the OIDC document names no `registration_endpoint`, and the
 * token endpoint REFUSES any request that does not carry the client secret —
 * which is Google's behaviour for a Web-application client, and the thing that
 * makes "the secret was sent" observable rather than assumed.
 *
 * ── NOTHING HERE REACHES GOOGLE ────────────────────────────────────────────
 *
 * All three hostnames are served from loopback, and any OTHER host throws
 * rather than falling through to the network. A suite that could quietly dial
 * accounts.google.com would pass on a laptop with internet and fail in CI for
 * a reason that has nothing to do with the code.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);

const CLIENT_ID = `crewaid-test-${RUN_ID}.apps.googleusercontent.com`;
const CLIENT_SECRET = `GOCSPX-test-secret-${RUN_ID}`;
const ISSUER = 'https://accounts.google.com';
const GOOGLE_HOSTS = new Set(['accounts.google.com', 'oauth2.googleapis.com']);
const MCP_HOST = 'drivemcp.googleapis.com';
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
];

type OAuthStub = {
  readonly origin: string;
  /** Every path the OAuth hosts were asked for, in order. */
  readonly paths: string[];
  /** Every token request's form, in order. */
  readonly tokenForms: URLSearchParams[];
  pendingChallenge: string | undefined;
  close(): Promise<void>;
};

let app: INestApplication;
let prisma: PrismaService;
let servers: McpServersService;
let ACTOR: SignedInUser;
let oauth: OAuthStub;
let mcp: StubMcpServer;

const api = (path: string): string => `/api/v1${path}`;
const http = (): request.Test => request(app.getHttpServer()) as unknown as request.Test;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readBody(stream: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** accounts.google.com and oauth2.googleapis.com, as the shapes this build meets. */
async function startGoogleStub(): Promise<OAuthStub> {
  const state: OAuthStub = {
    origin: '',
    paths: [],
    tokenForms: [],
    pendingChallenge: undefined,
    close: () => Promise.resolve(),
  };
  const server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = new URL(incoming.url ?? '/', 'http://stub');
      const body = await readBody(incoming);
      state.paths.push(url.pathname);

      if (url.pathname === '/.well-known/openid-configuration') {
        // Google's real document, in the fields this build reads — and
        // WITHOUT `registration_endpoint`, which is the whole reason D-118
        // exists.
        sendJson(response, 200, {
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/o/oauth2/v2/auth`,
          token_endpoint: 'https://oauth2.googleapis.com/token',
          response_types_supported: ['code', 'token', 'id_token'],
          code_challenge_methods_supported: ['plain', 'S256'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        });
        return;
      }

      if (url.pathname === '/token') {
        const form = new URLSearchParams(body);
        state.tokenForms.push(form);
        // A Web-application client is CONFIDENTIAL: no secret, no token.
        if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) {
          sendJson(response, 401, {
            error: 'invalid_client',
            error_description: 'The OAuth client was not found.',
          });
          return;
        }
        if (form.get('grant_type') === 'authorization_code') {
          const verifier = form.get('code_verifier') ?? '';
          const digest = createHash('sha256').update(verifier).digest('base64url');
          if (digest !== state.pendingChallenge) {
            sendJson(response, 400, { error: 'invalid_grant', error_description: 'PKCE failed' });
            return;
          }
        }
        sendJson(response, 200, {
          access_token: `ya29.access-${RUN_ID}-${String(state.tokenForms.length)}`,
          refresh_token: `1//refresh-${RUN_ID}`,
          expires_in: 3599,
          scope: GMAIL_SCOPES.join(' '),
          token_type: 'Bearer',
        });
        return;
      }

      // The two metadata paths Google does not serve, and anything else.
      response.writeHead(404);
      response.end('Not Found');
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    origin: `http://127.0.0.1:${String(port)}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

/** Google's hostnames onto loopback; every other host is a test failure. */
function googleFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const original = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  const path = `${original.pathname}${original.search}`;
  if (GOOGLE_HOSTS.has(original.hostname)) return fetch(new URL(path, oauth.origin), init);
  if (original.hostname === MCP_HOST) return fetch(new URL(path, mcp.origin), init);
  return Promise.reject(new Error(`the suite would have dialled ${original.hostname}`));
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'CC-62 — Google Workspace plugins, on the operator’s own OAuth client',
  () => {
    beforeAll(async () => {
      process.env['CREDENTIAL_KEY'] = '11'.repeat(32);
      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module.js');
      const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      // The gateway is in AppModule whether or not a case uses a socket, and
      // Nest exits the process at boot when no WebSocket driver is registered.
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      await app.listen(0, '127.0.0.1');

      prisma = app.get(PrismaService);
      ACTOR = await signIn(prisma, { label: 'cc-62-google' });
      oauth = await startGoogleStub();
      mcp = await startStubMcpServer();
      servers = app.get(McpServersService);
      servers.setAddressResolverForTests(() => Promise.resolve(['93.184.216.34']));
      servers.setMcpFetchForTests(googleFetch);
    }, 60_000);

    afterAll(async () => {
      await prisma.mcpServer.deleteMany({ where: { userId: ACTOR.userId } });
      servers.setMcpFetchForTests(undefined);
      servers.setAddressResolverForTests(undefined);
      await oauth.close();
      await mcp.close();
      await app.close();
      await prisma.user.deleteMany({ where: { id: ACTOR.userId } });
    }, 60_000);

    beforeEach(async () => {
      await prisma.mcpServer.deleteMany({ where: { userId: ACTOR.userId } });
      oauth.paths.length = 0;
      oauth.tokenForms.length = 0;
      oauth.pendingChallenge = undefined;
      mcp.clear();
      mcp.tools = [
        {
          name: 'search_threads',
          description: 'Search the mailbox',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true },
        },
      ];
      process.env['GOOGLE_CLIENT_ID'] = CLIENT_ID;
      process.env['GOOGLE_CLIENT_SECRET'] = CLIENT_SECRET;
    });

    afterEach(() => {
      delete process.env['GOOGLE_CLIENT_ID'];
      delete process.env['GOOGLE_CLIENT_SECRET'];
    });

    async function installDrive(): Promise<McpServerSummary> {
      const response = await http()
        .post(api('/mcp/servers'))
        .set(ACTOR.headers)
        .send({ slug: 'google-drive' })
        .expect(201);
      return McpServerSummarySchema.parse(response.body);
    }

    async function connect(id: string): Promise<URL> {
      const response = await http()
        .post(api(`/mcp/servers/${id}/connect`))
        .set(ACTOR.headers)
        .expect(200);
      return new URL((response.body as { authorizeUrl: string }).authorizeUrl);
    }

    async function completeTrip(id: string): Promise<void> {
      const authorize = await connect(id);
      oauth.pendingChallenge = authorize.searchParams.get('code_challenge') ?? undefined;
      const state = authorize.searchParams.get('state') ?? '';
      await http()
        .get(
          api(
            `/mcp/oauth/callback?${new URLSearchParams({ state, code: 'google-code' }).toString()}`,
          ),
        )
        .expect(200);
    }

    it('refuses to connect until the client is configured, and says how', async () => {
      delete process.env['GOOGLE_CLIENT_ID'];
      delete process.env['GOOGLE_CLIENT_SECRET'];
      const drive = await installDrive();

      const response = await http()
        .post(api(`/mcp/servers/${drive.id}/connect`))
        .set(ACTOR.headers)
        .expect(409);

      const message = String((response.body as { message?: string }).message);
      // The sentence IS the setup: which variables, which redirect URI, which
      // API. A browser trip ending on Google's invalid_client page would have
      // taught the operator none of it.
      expect(message).toContain('GOOGLE_CLIENT_ID');
      expect(message).toContain('GOOGLE_CLIENT_SECRET');
      expect(message).toContain('http://localhost:3000/api/v1/mcp/oauth/callback');
      expect(message).toContain('Drive API');
      // And refused before anything was dialled.
      expect(oauth.paths).toEqual([]);
    });

    it('builds Google’s authorize URL from the configured client, not a registration', async () => {
      const drive = await installDrive();

      const authorize = await connect(drive.id);

      expect(authorize.origin).toBe(ISSUER);
      expect(authorize.pathname).toBe('/o/oauth2/v2/auth');
      expect(authorize.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(authorize.searchParams.get('scope')).toBe(GMAIL_SCOPES.join(' '));
      // Without these two Google issues no refresh token, and the connection
      // would stop working an hour after it was made. `select_account` makes
      // Google ask which account, rather than taking the browser's current one.
      expect(authorize.searchParams.get('access_type')).toBe('offline');
      expect(authorize.searchParams.get('prompt')).toBe('select_account consent');
      expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
      // The secret is a token-endpoint value. It never goes near a browser.
      expect(authorize.href).not.toContain(CLIENT_SECRET);
      // The issuer is NAMED, so there is no resource-metadata walk and no
      // registration — only the issuer's own metadata, found at its OIDC path
      // after the RFC 8414 one 404s, exactly as for any issuer.
      expect(oauth.paths).toContain('/.well-known/openid-configuration');
      expect(oauth.paths.some((path) => path.includes('oauth-protected-resource'))).toBe(false);
      expect(oauth.paths.some((path) => path.includes('register'))).toBe(false);
      expect(oauth.tokenForms).toEqual([]);
    });

    it('sends the secret on the code exchange and ends up connected', async () => {
      const drive = await installDrive();

      await completeTrip(drive.id);

      const exchange = oauth.tokenForms.find(
        (form) => form.get('grant_type') === 'authorization_code',
      );
      expect(exchange?.get('client_secret')).toBe(CLIENT_SECRET);
      expect(exchange?.get('client_id')).toBe(CLIENT_ID);
      const listed = await prisma.mcpServer.findUniqueOrThrow({
        where: { id: drive.id },
        include: { _count: { select: { tools: true } } },
      });
      expect(listed.status).toBe('CONNECTED');
      expect(listed._count.tools).toBe(1);
      // The grant is stored like any other; the SECRET is not stored at all —
      // it lives in the environment and is read at use.
      const stored = await prisma.mcpCredential.findUniqueOrThrow({
        where: { serverId: drive.id },
      });
      expect(JSON.stringify(stored)).not.toContain(CLIENT_SECRET);
    });

    it('sends the secret on a refresh, where Google demands it too', async () => {
      const drive = await installDrive();
      await completeTrip(drive.id);
      // Expire it, so the next operation has to renew before it dials.
      const current = await readMcpCredential(prisma, { userId: ACTOR.userId, serverId: drive.id });
      if (current === null) throw new Error('the trip stored no credential');
      await storeMcpCredential(prisma, {
        userId: ACTOR.userId,
        serverId: drive.id,
        accessToken: current.accessToken,
        refreshToken: current.refreshToken ?? undefined,
        expiresAt: new Date(Date.now() - 60_000),
        scopes: current.scopes,
        authMetadata: current.authMetadata ?? undefined,
      });

      await http()
        .post(api(`/mcp/servers/${drive.id}/refresh-tools`))
        .set(ACTOR.headers)
        .expect(200);

      const refresh = oauth.tokenForms.find((form) => form.get('grant_type') === 'refresh_token');
      expect(refresh?.get('client_secret')).toBe(CLIENT_SECRET);
    });

    it('does not send a new secret with the old client id after the client rotates', async () => {
      const drive = await installDrive();
      await completeTrip(drive.id);
      const current = await readMcpCredential(prisma, { userId: ACTOR.userId, serverId: drive.id });
      if (current?.authMetadata == null) throw new Error('the trip stored no refresh coordinates');
      await storeMcpCredential(prisma, {
        userId: ACTOR.userId,
        serverId: drive.id,
        accessToken: current.accessToken,
        refreshToken: current.refreshToken ?? undefined,
        expiresAt: new Date(Date.now() - 60_000),
        scopes: current.scopes,
        authMetadata: {
          ...current.authMetadata,
          clientId: 'an-earlier-client.apps.googleusercontent.com',
        },
      });

      await http()
        .post(api(`/mcp/servers/${drive.id}/refresh-tools`))
        .set(ACTOR.headers)
        .expect(409);

      // A secret travels only with the id it belongs to. Google refuses the
      // request either way; the property is what LEFT this process.
      const refresh = oauth.tokenForms.find((form) => form.get('grant_type') === 'refresh_token');
      expect(refresh?.has('client_secret')).toBe(false);
    });

    it('never gives the secret to a private server that merely calls itself Drive', async () => {
      // A private install is named by its operator, so one named "Drive" gets
      // the slug `drive`. If the slug alone chose the configuration, a server
      // at any URL could have Google's secret sent where it pleased. It is
      // asserted against a presence: the configuration IS set right now.
      await prisma.mcpServer.create({
        data: {
          userId: ACTOR.userId,
          name: 'Drive',
          slug: 'google-drive',
          transport: 'HTTP',
          url: `https://${MCP_HOST}/mcp/v1`,
          isPrivate: true,
          authType: 'OAUTH2',
        },
      });
      const row = await prisma.mcpServer.findFirstOrThrow({
        where: { userId: ACTOR.userId, slug: 'google-drive' },
      });

      const response = await http()
        .post(api(`/mcp/servers/${row.id}/connect`))
        .set(ACTOR.headers);

      // It takes the ordinary discovery path, which Google's servers cannot
      // satisfy — so it fails, and it fails WITHOUT an authorize URL built
      // from the operator's client.
      expect(response.status).toBe(502);
      expect(JSON.stringify(response.body)).not.toContain(CLIENT_ID);
      expect(oauth.tokenForms).toEqual([]);
    });
  },
);
