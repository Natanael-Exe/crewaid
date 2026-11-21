import { ToolRegistry } from '../src/agent/tool-registry.js';
import { ComposioService } from '../src/integrations/composio/composio.service.js';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { WebSocket } from 'ws';
import {
  ListMcpServersResponseSchema,
  ServerFrameSchema,
  type McpServerSummary,
  type ServerFrame,
} from '@crewaid/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { McpServersService } from '../src/mcp/mcp-servers.service.js';
import { readMcpCredential, storeMcpCredential } from '../src/mcp/mcp-credentials.js';
import { signIn, type SignedInUser } from './auth-fixture.js';

/**
 * M6-BE-03 and M6-BE-05 over real HTTP: connect, the browser trip, the
 * callback, and the bearer's lifecycle after it.
 *
 * ── WHAT IS REAL HERE ──────────────────────────────────────────────────────
 *
 * The Nest app, the guard chain, the OAuth state row in Postgres, the PKCE
 * verifier, the redirect_uri, the token request, the credential row, and the
 * tool listing that follows it. The two things that are not real are the ones
 * a test cannot have: a THIRD PARTY's authorization server, and the public DNS
 * names the row holds. The stub below speaks the protocol the six curated
 * servers actually speak — protected-resource metadata, RFC 8414 metadata, RFC
 * 7591 registration, an RFC 6749 token endpoint that CHECKS THE PKCE and
 * ENFORCES ROTATION on its second grant — and the fetch seam rewrites the two
 * `*.example.test` names onto its loopback socket, which is the same promise
 * `setMcpFetchForTests` makes in production code.
 *
 * ── THE ASSERTIONS THAT WOULD NOTICE A BROKEN FLOW ─────────────────────────
 *
 *  - the token endpoint verifies `S256(code_verifier)` against the challenge
 *    that was in the authorize URL (§6/M6's whole reason for PKCE);
 *  - the MCP server refuses anything but the bearer the token endpoint issued,
 *    so "the credential was stored" and "the credential was used" are separate
 *    facts, both asserted;
 *  - the state is single-use: the same callback URL is replayed and refused;
 *  - two users, because a one-user isolation suite passes whether or not
 *    anything is scoped (D-010);
 *  - and, for M6-BE-05: the refresh grant really carried the coordinates the
 *    CALLBACK stored (the endpoint checks the grant against the one it last
 *    issued, so a rotated token that was not persisted fails the next refresh
 *    as a 409), the resource server really saw the renewed bearer, and a
 *    terminal refusal left one durable status and exactly one frame on the
 *    §4.2 socket.
 *
 * Needs DATABASE_URL. Without it every case skips (CLAUDE.md: a silently
 * skipped test is a dormant guard).
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);

const MCP_ORIGIN = 'https://mcp.example.test';
const AS_ORIGIN = 'https://auth.example.test';
const RESOURCE = `${MCP_ORIGIN}/mcp`;
const ISSUER = `${AS_ORIGIN}/tenant`;
const ACCESS_TOKEN = `tok_m6be03_${RUN_ID}`;
const REFRESH_TOKEN = `ref_m6be03_${RUN_ID}`;

/** What the REFRESH grant mints. Distinct from the code exchange's token, so
 * "the renewed credential was used" cannot pass by accident, and numbered, so
 * two successive renewals are distinguishable. */
const REFRESHED_ACCESS_TOKEN = `tok_m6be05_${RUN_ID}`;
/** What a rotating token endpoint issues in place of `REFRESH_TOKEN`. */
const ROTATED_REFRESH_TOKEN = `ref_m6be05_${RUN_ID}`;
/** The client id a credential seeded without a trip was registered under. */
const SEEDED_CLIENT_ID = `client-seeded-${RUN_ID}`;

let app: INestApplication;
/** Where the app listens, for the §4.2 socket the frame cases need. */
let port: number;
let prisma: PrismaService;
let servers: McpServersService;
let ACTOR: SignedInUser;
let FOREIGN: SignedInUser;
let stub: StubAuthorizationServer;

const api = (path: string): string => `/api/v1${path}`;
const http = (): request.Test => request(app.getHttpServer()) as unknown as request.Test;

/** How the stub behaves for one case. Reset in `beforeEach`. */
type StubBehavior = {
  /** The challenge from the last authorize URL, as the token endpoint checks it. */
  pendingChallenge: string | undefined;
  /** What the MCP server demands as its bearer, once one has been issued. */
  bearer: string | undefined;
  /** Whether the MCP server insists on that bearer (every OAuth case does). */
  requireBearer: boolean;
  /** The `authorization` header of the last MCP request, whatever it was. */
  sawAuthorization: string | undefined;
  /** Force the token endpoint to refuse the CODE EXCHANGE, whatever was sent. */
  refuseTokenWith: number | undefined;
  /** Tools the MCP server lists, replaced per case. */
  tools: readonly unknown[];
  /** Refuse the next `tools/list` with a 502, to exercise `tools-failed`. */
  failListing: boolean;
  registrations: number;
  lastTokenForm: URLSearchParams | undefined;
  lastRegistration: Record<string, unknown> | undefined;

  // ── The refresh grant (M6-BE-05) ────────────────────────────────────────
  /** Refuse the REFRESH grant (only) with this status. */
  refuseRefreshWith: number | undefined;
  /** How many refresh grants reached the endpoint, answered or refused. */
  refreshRequests: number;
  /** How many requests reached the MCP resource, whatever they were answered. */
  mcpRequests: number;
  /**
   * The grant this endpoint last issued, which is the ONLY one a refresh may
   * present — the way a real server with rotation and reuse-detection behaves,
   * and the reason a rotated token that was not persisted is observable here
   * rather than only in the row.
   */
  expectedRefreshToken: string | undefined;
  /** Whether a refresh response rotates the refresh token (default: it does). */
  rotateRefreshToken: boolean;
  /** `expires_in` a refresh response names; `null` names no lifetime at all. */
  refreshedExpiresIn: number | null;
  /** `scope` a refresh response names; `undefined` names none (RFC 6749 §6). */
  refreshedScope: string | undefined;
  /** `expires_in` the AUTHORIZATION CODE response names. */
  codeExpiresIn: number;
  /**
   * The resource server keeps demanding the bearer it knew BEFORE the refresh:
   * "the authorization server minted a token this resource server will not
   * accept", which is the one case the retry cannot fix.
   */
  resourceStaysOnOldBearer: boolean;
};

let behavior: StubBehavior;

type StubAuthorizationServer = {
  readonly origin: string;
  close(): Promise<void>;
};

function jsonRpcResult(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result: { resultType: 'complete', ...result } };
}

const SEARCH_TOOL = {
  name: 'search_issues',
  description: 'Search issues',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  annotations: { readOnlyHint: true },
};
const FILE_TOOL = {
  name: 'file_issue',
  description: 'File an issue',
  inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
};
const DEFAULT_TOOLS = [SEARCH_TOOL, FILE_TOOL];

async function readBody(stream: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function s256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

/**
 * One loopback server, three roles: the MCP resource, the authorization
 * server, and (at `/token`) the endpoint that decides whether a credential
 * ever exists. Requests reach it through `stubFetch`, which rewrites the two
 * public-looking hostnames onto this socket.
 */
async function startStub(): Promise<StubAuthorizationServer> {
  const server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = new URL(incoming.url ?? '/', 'http://stub');
      const body = await readBody(incoming);

      if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
        sendJson(response, 200, {
          resource: RESOURCE,
          authorization_servers: [ISSUER],
          scopes_supported: ['issues.read'],
        });
        return;
      }

      if (url.pathname === '/.well-known/oauth-authorization-server/tenant') {
        sendJson(response, 200, {
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          registration_endpoint: `${ISSUER}/register`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
        });
        return;
      }

      if (url.pathname === '/tenant/register') {
        behavior.registrations += 1;
        const parsed = JSON.parse(body) as Record<string, unknown>;
        behavior.lastRegistration = parsed;
        // A public client: no secret, and the redirect_uri is echoed — which
        // is what the orchestrator insists on, because a code sent anywhere
        // else never arrives.
        sendJson(response, 201, {
          client_id: `client-${behavior.registrations}`,
          redirect_uris: parsed['redirect_uris'],
          token_endpoint_auth_method: 'none',
        });
        return;
      }

      if (url.pathname === '/tenant/token') {
        const form = new URLSearchParams(body);
        behavior.lastTokenForm = form;

        // ── THE SECOND GRANT (M6-BE-05) ──────────────────────────────────
        // Branching on `grant_type` is what the endpoint really does, and it
        // is also what makes the wire shape falsifiable: a client that sent
        // its `code` or its `code_verifier` on a refresh never reaches the
        // PKCE check below, so only this branch can catch it.
        if (form.get('grant_type') === 'refresh_token') {
          behavior.refreshRequests += 1;

          if (behavior.refuseRefreshWith !== undefined) {
            sendJson(response, behavior.refuseRefreshWith, {
              error: 'invalid_grant',
              error_description: 'the stub refused this refresh',
            });
            return;
          }

          // ROTATION IS ENFORCED, the way a real authorization server that
          // rotates does it: anything but the grant this endpoint last issued
          // is refused, so a rotated refresh token that was not PERSISTED
          // fails the next renewal instead of quietly working forever.
          const presented = form.get('refresh_token');
          if (
            behavior.expectedRefreshToken !== undefined &&
            presented !== behavior.expectedRefreshToken
          ) {
            sendJson(response, 400, {
              error: 'invalid_grant',
              error_description: 'the presented refresh token was superseded',
            });
            return;
          }

          const fresh = `${REFRESHED_ACCESS_TOKEN}_${behavior.refreshRequests}`;
          // The resource server accepts what the authorization server last
          // issued — unless this case is about a minted token it will not take.
          if (!behavior.resourceStaysOnOldBearer) behavior.bearer = fresh;
          const rotated = `${ROTATED_REFRESH_TOKEN}_${behavior.refreshRequests}`;
          if (behavior.rotateRefreshToken) behavior.expectedRefreshToken = rotated;
          sendJson(response, 200, {
            access_token: fresh,
            ...(behavior.rotateRefreshToken ? { refresh_token: rotated } : {}),
            token_type: 'Bearer',
            ...(behavior.refreshedExpiresIn === null
              ? {}
              : { expires_in: behavior.refreshedExpiresIn }),
            ...(behavior.refreshedScope === undefined ? {} : { scope: behavior.refreshedScope }),
          });
          return;
        }

        if (behavior.refuseTokenWith !== undefined) {
          sendJson(response, behavior.refuseTokenWith, {
            error: 'invalid_grant',
            error_description: 'the stub refused this code',
          });
          return;
        }
        const challenge = behavior.pendingChallenge;
        const verifier = form.get('code_verifier') ?? '';
        if (challenge === undefined || s256(verifier) !== challenge) {
          // THE PKCE CHECK. A flow that lost its verifier, or sent a
          // challenge for a different one, fails here — as a 400 the
          // orchestrator reports as `exchange-failed`.
          sendJson(response, 400, {
            error: 'invalid_grant',
            error_description: 'PKCE verification failed',
          });
          return;
        }
        behavior.bearer = ACCESS_TOKEN;
        behavior.expectedRefreshToken = REFRESH_TOKEN;
        sendJson(response, 200, {
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          token_type: 'Bearer',
          expires_in: behavior.codeExpiresIn,
          scope: 'issues.read',
        });
        return;
      }

      if (url.pathname === '/mcp') {
        const authorization = incoming.headers.authorization;
        behavior.sawAuthorization = authorization;
        behavior.mcpRequests += 1;
        if (
          behavior.requireBearer &&
          (behavior.bearer === undefined || authorization !== `Bearer ${behavior.bearer}`)
        ) {
          response.writeHead(401, {
            'content-type': 'application/json',
            'www-authenticate': `Bearer resource_metadata="${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
          });
          response.end(JSON.stringify({ error: 'invalid_token' }));
          return;
        }
        const message = JSON.parse(body) as {
          id?: unknown;
          method: string;
          params?: Record<string, unknown>;
        };
        if (message.id === undefined) {
          // A notification — the MCP client's `notifications/initialized`.
          // The protocol gives it no response, and answering one anyway is
          // what makes a client treat the transport as broken.
          response.writeHead(202);
          response.end();
          return;
        }
        if (behavior.failListing && message.method === 'tools/list') {
          response.writeHead(502);
          response.end('listing is broken');
          return;
        }
        if (message.method === 'server/discover') {
          // The version the client announced is the version this server
          // supports. A stub that answered with a version of its own choosing
          // makes the SDK find no overlap and fall back to the legacy
          // `initialize` handshake — which is a real protocol behaviour, and
          // not the subject of this suite.
          const meta = message.params?.['_meta'];
          const announced =
            meta !== null && typeof meta === 'object'
              ? (meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion']
              : undefined;
          if (typeof announced !== 'string') throw new Error('the client announced no version');
          sendJson(
            response,
            200,
            jsonRpcResult(message.id, {
              supportedVersions: [announced],
              capabilities: { tools: { listChanged: false } },
              _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'stub', version: '1.0.0' } },
            }),
          );
          return;
        }
        if (message.method === 'tools/list') {
          // The 2026 spec requires a cacheable result to say how long it may be cached.
          sendJson(
            response,
            200,
            jsonRpcResult(message.id, { tools: behavior.tools, ttlMs: 0, cacheScope: 'private' }),
          );
          return;
        }
        sendJson(response, 200, {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        });
        return;
      }

      response.writeHead(404);
      response.end('no');
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Both public hostnames the suite uses, rewritten onto the stub. */
const STUB_HOSTS = new Set(['mcp.example.test', 'auth.example.test']);

function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const original = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  if (!STUB_HOSTS.has(original.hostname)) return fetch(input, init);
  return fetch(new URL(`${original.pathname}${original.search}`, stub.origin), init);
}

/** One frame as it arrived, kept with the exact bytes (`text`) it arrived in. */
interface ServerFrameRecord {
  readonly frame: ServerFrame;
  readonly text: string;
}

/**
 * One §4.2 socket, and everything it has been sent.
 *
 * The bytes are kept beside the parsed frame because §7.3 and D-103's "no
 * `botId` on this frame" are claims about what LEFT THE PROCESS: the shared
 * schema strips a key it does not declare, so a test that only inspected the
 * parsed object could not tell an absent field from a stripped one.
 */
interface Window {
  readonly socket: WebSocket;
  readonly frames: ServerFrameRecord[];
  /** Frames this build sent that the §4.2 schema refuses — a client would drop
   * these, so a case that produced one is a failure even if its subject passed. */
  readonly undecodable: string[];
}

/**
 * Open a §4.2 socket as `token`'s principal, and do not return until the
 * gateway has REGISTERED it.
 *
 * The registration is the point: `TurnEventBus` delivers only to the sockets the
 * gateway has taken in, so a frame emitted before the handshake finished would
 * never arrive — and a case that asserted "no `mcp.status` frame" would then
 * pass for the wrong reason. The sync frame below is answered by the gateway's
 * own catch-all handler, which is proof the socket is on the bus's list.
 */
async function openWindow(port: number, token: string): Promise<Window> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  const frames: ServerFrameRecord[] = [];
  const undecodable: string[] = [];
  socket.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) return;
    const text = data.toString();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      undecodable.push(text);
      return;
    }
    const frame = ServerFrameSchema.safeParse(parsed);
    if (frame.success) frames.push({ frame: frame.data, text });
    else undecodable.push(text);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const window: Window = { socket, frames, undecodable };
  await settle(window);
  return window;
}

/**
 * A barrier on one socket.
 *
 * Everything the server emits is written to this socket in order, so a frame
 * the server sent BEFORE this sync frame has already been delivered by the
 * time the `error` answering the sync frame arrives. Without that, "no frame
 * was emitted" is a claim about timing rather than about the code.
 */
async function settle(window: Window): Promise<void> {
  const id = randomUUID();
  window.socket.send(JSON.stringify({ id, type: 'm6.qa.sync', ts: Date.now(), payload: {} }));
  await until(
    () => window.frames.find((entry) => entry.frame.type === 'error' && entry.frame.id === id),
    'the §4.2 socket to answer a sync frame',
  );
  const at = window.frames.findIndex(
    (entry) => entry.frame.type === 'error' && entry.frame.id === id,
  );
  if (at >= 0) window.frames.splice(at, 1);
}

/** Frames of one type, in arrival order. */
function framesOfType(window: Window, type: ServerFrame['type']): ServerFrameRecord[] {
  return window.frames.filter((entry) => entry.frame.type === type);
}

async function until<T>(probe: () => T | undefined, what: string, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M6-BE-03 — connecting an MCP server over OAuth',
  () => {
    let seedCount = 0;

    beforeAll(async () => {
      // The key the credential in this suite is encrypted under. Set here
      // rather than required from the environment so the suite is
      // self-contained — a missing CREDENTIAL_KEY must fail as a REFUSAL the
      // unit suite asserts, not as a confusing 503 in the middle of a flow
      // test (credential-cipher tests do the same for the V1 keyring).
      process.env['CREDENTIAL_KEY'] = '11'.repeat(32);

      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module.js');
      const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      await app.listen(0, '127.0.0.1');
      port = (app.getHttpServer().address() as AddressInfo).port;

      prisma = app.get(PrismaService);
      ACTOR = await signIn(prisma, { label: 'mcp-oauth' });
      FOREIGN = await signIn(prisma, { label: 'mcp-oauth-foreign' });

      stub = await startStub();
      servers = app.get(McpServersService);
      servers.setAddressResolverForTests(() => Promise.resolve(['93.184.216.34']));
      servers.setMcpFetchForTests(stubFetch);
      // Booting AppModule, listening on a loopback port and signing in two
      // users is a host-load cost, not a property of the code under test —
      // close enough to vitest's 10s hook default that a gate running the
      // whole orchestrator suite on a loaded box reports a timeout instead of
      // the flow it was trying to run.
    }, 60_000);

    afterAll(async () => {
      await clearFixtures();
      servers.setMcpFetchForTests(undefined);
      servers.setAddressResolverForTests(undefined);
      await stub.close();
      await app.close();
      await prisma.user.deleteMany({ where: { id: { in: [ACTOR.userId, FOREIGN.userId] } } });
    }, 60_000);

    beforeEach(() => {
      behavior = {
        pendingChallenge: undefined,
        bearer: undefined,
        requireBearer: true,
        sawAuthorization: undefined,
        refuseTokenWith: undefined,
        tools: DEFAULT_TOOLS,
        failListing: false,
        registrations: 0,
        lastTokenForm: undefined,
        lastRegistration: undefined,
        refuseRefreshWith: undefined,
        refreshRequests: 0,
        mcpRequests: 0,
        expectedRefreshToken: undefined,
        rotateRefreshToken: true,
        refreshedExpiresIn: 3600,
        refreshedScope: undefined,
        codeExpiresIn: 3600,
        resourceStaysOnOldBearer: false,
      };
    });

    /** A row that points at the stub's MCP server and asks for OAuth. */
    async function seedOAuthServer(overrides: Record<string, unknown> = {}) {
      seedCount += 1;
      return prisma.mcpServer.create({
        data: {
          userId: ACTOR.userId,
          name: `OAuth Stub ${seedCount}`,
          slug: `oauth-stub-${RUN_ID}-${seedCount}`,
          transport: 'HTTP',
          url: RESOURCE,
          isPrivate: true,
          authType: 'OAUTH2',
          ...overrides,
        },
      });
    }

    async function clearFixtures(): Promise<void> {
      await prisma.mcpServer.deleteMany({
        where: { userId: { in: [ACTOR.userId, FOREIGN.userId] } },
      });
      await prisma.bot.deleteMany({ where: { userId: { in: [ACTOR.userId, FOREIGN.userId] } } });
    }

    async function listServers(actor: SignedInUser = ACTOR): Promise<McpServerSummary[]> {
      const response = await http().get(api('/mcp/servers')).set(actor.headers).expect(200);
      return ListMcpServersResponseSchema.parse(response.body);
    }

    function row(id: string): Promise<McpServerSummary | undefined> {
      return listServers().then((rows) => rows.find((entry) => entry.id === id));
    }

    /** `POST /mcp/servers/:id/connect`, expecting an authorize URL. */
    async function connect(id: string, actor: SignedInUser = ACTOR) {
      const response = await http()
        .post(api(`/mcp/servers/${id}/connect`))
        .set(actor.headers)
        .expect(200);
      const body = response.body as Record<string, unknown>;
      expect(typeof body['authorizeUrl']).toBe('string');
      return new URL(body['authorizeUrl'] as string);
    }

    /** The browser arriving at the redirect with no credential of any kind. */
    function arrive(params: Record<string, string>) {
      const query = new URLSearchParams(params).toString();
      return http().get(api(`/mcp/oauth/callback?${query}`));
    }

    /**
     * The whole trip: connect, hand the challenge to the stub, and come back
     * from the browser with a code. Returns the callback's RESPONSE, so the
     * caller asserts on it — awaiting a supertest chain here would resolve the
     * request before `.expect` could be attached.
     */
    async function completeTrip(id: string, code = `code-${randomUUID()}`) {
      const authorize = await connect(id);
      behavior.pendingChallenge = authorize.searchParams.get('code_challenge') ?? undefined;
      const state = authorize.searchParams.get('state');
      expect(state).toBeTruthy();
      return arrive({ state: state as string, code });
    }

    it('keeps only one active flow after simultaneous Connect requests', async () => {
      const server = await seedOAuthServer();
      const urls = await Promise.all(Array.from({ length: 4 }, () => connect(server.id)));
      const flows = await prisma.mcpOAuthFlow.findMany({ where: { serverId: server.id } });
      expect(flows).toHaveLength(1);
      expect(urls.map((url) => url.searchParams.get('state'))).toContain(flows[0]?.state);
      for (const url of urls) {
        const state = url.searchParams.get('state') as string;
        if (state === flows[0]?.state) continue;
        await arrive({ state, code: 'superseded' }).expect(
          'X-Crewaid-Mcp-Connect',
          'failed:unknown-state',
        );
      }
      expect(behavior.lastTokenForm).toBeUndefined();
    });

    it('refuses a missing encryption key before discovery or consent', async () => {
      const server = await seedOAuthServer();
      const key = process.env['CREDENTIAL_KEY'];
      delete process.env['CREDENTIAL_KEY'];
      try {
        const response = await http()
          .post(api(`/mcp/servers/${server.id}/connect`))
          .set(ACTOR.headers)
          .expect(503);
        expect(response.body.message).toContain('CREDENTIAL_KEY');
        expect(behavior.registrations).toBe(0);
        expect(await prisma.mcpOAuthFlow.count({ where: { serverId: server.id } })).toBe(0);
      } finally {
        process.env['CREDENTIAL_KEY'] = key;
      }
    });

    it('renders a safe failure page when the credential cannot be stored', async () => {
      const server = await seedOAuthServer();
      const authorize = await connect(server.id);
      behavior.pendingChallenge = authorize.searchParams.get('code_challenge') ?? undefined;
      const write = vi
        .spyOn(prisma.mcpCredential, 'upsert')
        .mockRejectedValueOnce(
          new Error(`database write failed with sensitive arguments ${ACCESS_TOKEN}`),
        );
      try {
        const response = await arrive({
          state: authorize.searchParams.get('state') as string,
          code: 'storage-failure',
        }).expect(200);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['x-crewaid-mcp-connect']).toBe('failed:storage-failed');
        expect(response.text).not.toContain(ACCESS_TOKEN);
        expect((await row(server.id))?.lastError).toContain('could not be saved');
        expect(behavior.sawAuthorization).toBeUndefined();
      } finally {
        write.mockRestore();
      }
    });

    it('connects a server end to end: state, PKCE, credential, tools', async () => {
      const server = await seedOAuthServer();

      const authorize = await connect(server.id);

      // The URL Electron would open. Every parameter here is checked by
      // somebody: `resource` and `client_id` by the authorization server,
      // `state` and the challenge by the callback below.
      expect(`${authorize.origin}${authorize.pathname}`).toBe(`${ISSUER}/authorize`);
      expect(authorize.searchParams.get('response_type')).toBe('code');
      expect(authorize.searchParams.get('client_id')).toBe('client-1');
      expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authorize.searchParams.get('scope')).toBe('issues.read');
      expect(authorize.searchParams.get('resource')).toBe(RESOURCE);
      expect(authorize.searchParams.get('redirect_uri')).toBe(
        'http://localhost:3000/api/v1/mcp/oauth/callback',
      );
      expect(behavior.lastRegistration?.['redirect_uris']).toEqual([
        'http://localhost:3000/api/v1/mcp/oauth/callback',
      ]);

      // One flow row, holding the verifier the browser will never see.
      const flow = await prisma.mcpOAuthFlow.findFirstOrThrow({ where: { serverId: server.id } });
      expect(flow.state).toBe(authorize.searchParams.get('state'));
      expect(flow.resource).toBe(RESOURCE);
      expect(flow.tokenEndpoint).toBe(`${ISSUER}/token`);
      expect(flow.expiresAt.getTime()).toBeGreaterThan(Date.now());

      // CONNECTING is derived from that row, not stored on the server.
      expect((await row(server.id))?.status).toBe('CONNECTING');
      const stored = await prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id } });
      expect(stored.status).toBe('DISCONNECTED');

      behavior.pendingChallenge = authorize.searchParams.get('code_challenge') ?? undefined;
      const response = await arrive({
        state: authorize.searchParams.get('state') as string,
        code: 'code-happy-path',
      }).expect(200);

      expect(response.headers['x-crewaid-mcp-connect']).toBe('ok');
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.headers['content-security-policy']).toContain("default-src 'none'");
      expect(response.text).toContain(server.name);
      expect(response.text).toContain('2 tools');

      // The token request was the real one, and the verifier was the one the
      // row held — the stub checked S256 against the challenge itself.
      const form = behavior.lastTokenForm;
      expect(form?.get('grant_type')).toBe('authorization_code');
      expect(form?.get('code')).toBe('code-happy-path');
      expect(form?.get('client_id')).toBe('client-1');
      expect(form?.get('resource')).toBe(RESOURCE);
      expect(form?.get('code_verifier')).toBe(flow.codeVerifier);

      const credential = await prisma.mcpCredential.findUniqueOrThrow({
        where: { serverId: server.id },
      });
      // §7.3, from the other side: what reached the database is ciphertext.
      // Asserted on the COLUMN rather than on the read, because a read that
      // worked would look identical if the write had stored plaintext.
      expect(credential.accessToken.startsWith('g1.')).toBe(true);
      expect(credential.accessToken).not.toContain(ACCESS_TOKEN);
      expect(credential.refreshToken?.startsWith('g1.')).toBe(true);
      expect(credential.refreshToken).not.toContain(REFRESH_TOKEN);
      expect(credential.scopes).toEqual(['issues.read']);

      const decrypted = await readMcpCredential(prisma, {
        userId: ACTOR.userId,
        serverId: server.id,
      });
      expect(decrypted?.accessToken).toBe(ACCESS_TOKEN);
      expect(decrypted?.refreshToken).toBe(REFRESH_TOKEN);
      // …and the same row is invisible to a principal that does not own the
      // server, even holding the correct serverId (M6-BE-04's second fence).
      expect(
        await readMcpCredential(prisma, { userId: FOREIGN.userId, serverId: server.id }),
      ).toBeNull();

      // …and it was USED: the MCP server only answers tools/list to that
      // bearer, so a cached listing is proof the header travelled.
      const connected = await row(server.id);
      expect(connected?.status).toBe('CONNECTED');
      expect(connected?.toolCount).toBe(2);
      expect(connected?.lastError).toBeNull();

      // The state was consumed, not merely marked used.
      expect(await prisma.mcpOAuthFlow.count({ where: { serverId: server.id } })).toBe(0);

      // §7.3: the credential is nowhere in the API's answer.
      const listed = await http().get(api('/mcp/servers')).set(ACTOR.headers).expect(200);
      expect(JSON.stringify(listed.body)).not.toContain(ACCESS_TOKEN);
      expect(JSON.stringify(listed.body)).not.toContain(REFRESH_TOKEN);
    });

    it('refuses a replayed or forged state without touching anything', async () => {
      const server = await seedOAuthServer();
      const authorize = await connect(server.id);
      behavior.pendingChallenge = authorize.searchParams.get('code_challenge') ?? undefined;
      const state = authorize.searchParams.get('state') as string;

      // Every one of these answers 200 with a page: the VERDICT is the header
      // (D-101), because a refusal served as a 4xx or a 5xx is a response a
      // proxy in front of this orchestrator may replace with its own body —
      // and then the person in the browser tab is told nothing.
      await arrive({ state, code: 'code-once' }).expect(200);

      const replay = await arrive({ state, code: 'code-once' }).expect(200);
      expect(replay.headers['x-crewaid-mcp-connect']).toBe('failed:unknown-state');
      expect(replay.text).toContain('no longer valid');

      const forged = await arrive({ state: 'not-a-state-this-build-minted', code: 'x' }).expect(
        200,
      );
      expect(forged.headers['x-crewaid-mcp-connect']).toBe('failed:unknown-state');

      const missing = await http().get(api('/mcp/oauth/callback')).expect(200);
      expect(missing.headers['x-crewaid-mcp-connect']).toBe('failed:invalid-request');

      // The second, forged arrival did not mint a second credential or
      // overwrite the one the first one stored.
      expect(await prisma.mcpCredential.count({ where: { serverId: server.id } })).toBe(1);
    });

    it('refuses a callback from a browser signed in to another account, and redeems nothing', async () => {
      // The link minted by ACTOR's Connect, approved in FOREIGN's browser: the
      // shape of an authorize URL sent to somebody else to click.
      const server = await seedOAuthServer();
      const authorize = await connect(server.id);
      behavior.pendingChallenge = authorize.searchParams.get('code_challenge') ?? undefined;
      const state = authorize.searchParams.get('state') as string;
      const victim = new URLSearchParams({ state, code: 'code-victim' }).toString();
      const refused = await http()
        .get(api(`/mcp/oauth/callback?${victim}`))
        .set(FOREIGN.headers)
        .expect(200);
      expect(refused.headers['x-crewaid-mcp-connect']).toBe('failed:other-account');
      expect(refused.text).toContain('another account');
      expect(await prisma.mcpCredential.count({ where: { serverId: server.id } })).toBe(0);

      // Presence: the owner's own browser finishes the same kind of trip.
      const again = await connect(server.id);
      behavior.pendingChallenge = again.searchParams.get('code_challenge') ?? undefined;
      const own = new URLSearchParams({
        state: again.searchParams.get('state') as string,
        code: 'code-own',
      }).toString();
      const connected = await http()
        .get(api(`/mcp/oauth/callback?${own}`))
        .set(ACTOR.headers)
        .expect(200);
      expect(connected.headers['x-crewaid-mcp-connect']).toBe('ok');
      expect(await prisma.mcpCredential.count({ where: { serverId: server.id } })).toBe(1);
    });

    it('lets a second connect supersede the first', async () => {
      const server = await seedOAuthServer();
      const first = await connect(server.id);
      const second = await connect(server.id);

      expect(second.searchParams.get('state')).not.toBe(first.searchParams.get('state'));
      expect(await prisma.mcpOAuthFlow.count({ where: { serverId: server.id } })).toBe(1);

      behavior.pendingChallenge = second.searchParams.get('code_challenge') ?? undefined;
      const superseded = await arrive({
        state: first.searchParams.get('state') as string,
        code: 'stale',
      }).expect(200);
      expect(superseded.headers['x-crewaid-mcp-connect']).toBe('failed:unknown-state');

      const fresh = await arrive({
        state: second.searchParams.get('state') as string,
        code: 'current',
      }).expect(200);
      expect(fresh.headers['x-crewaid-mcp-connect']).toBe('ok');
    });

    it('refuses an expired flow, and stops calling the row CONNECTING', async () => {
      const server = await seedOAuthServer();
      const authorize = await connect(server.id);
      const state = authorize.searchParams.get('state') as string;

      // Reached by moving the row's clock rather than by waiting ten minutes.
      await prisma.mcpOAuthFlow.update({
        where: { state },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      expect((await row(server.id))?.status).toBe('DISCONNECTED');

      const response = await arrive({ state, code: 'too-late' }).expect(200);
      expect(response.headers['x-crewaid-mcp-connect']).toBe('failed:expired');
      expect(response.text).toContain('expired');
      expect(behavior.lastTokenForm).toBeUndefined();
    });

    it('records a user denial without demoting the server', async () => {
      const server = await seedOAuthServer({ status: 'CONNECTED' });
      const authorize = await connect(server.id);

      const response = await arrive({
        state: authorize.searchParams.get('state') as string,
        error: 'access_denied',
        error_description: 'The user refused the request',
      }).expect(200);

      expect(response.headers['x-crewaid-mcp-connect']).toBe('failed:denied');
      expect(response.text).toContain('access_denied: The user refused the request');
      expect(response.text).toContain('Any previous connection was left unchanged');
      expect(response.text).not.toContain('still disconnected');

      const stored = await prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id } });
      // A failed RE-authorization must not throw away a working credential's
      // status; the reason is recorded and the badge stays where it was.
      expect(stored.status).toBe('CONNECTED');
      expect(stored.lastError).toContain('access_denied');
      expect(await prisma.mcpCredential.count({ where: { serverId: server.id } })).toBe(0);
      expect(await prisma.mcpOAuthFlow.count({ where: { serverId: server.id } })).toBe(0);
    });

    it('bounds a denial even when only the error parameter is supplied', async () => {
      const server = await seedOAuthServer();
      const authorize = await connect(server.id);
      const error = 'x'.repeat(3_000);
      const response = await arrive({
        state: authorize.searchParams.get('state') as string,
        error,
      }).expect(200);
      expect(response.headers['x-crewaid-mcp-connect']).toBe('failed:denied');
      expect(response.text).not.toContain(error);
      expect((await row(server.id))?.lastError?.length).toBeLessThanOrEqual(2_001);
    });

    it('reports a refused exchange and stores nothing', async () => {
      const server = await seedOAuthServer();
      const authorize = await connect(server.id);
      behavior.pendingChallenge = authorize.searchParams.get('code_challenge') ?? undefined;
      behavior.refuseTokenWith = 400;

      const response = await arrive({
        state: authorize.searchParams.get('state') as string,
        code: 'rejected',
      }).expect(200);

      expect(response.headers['x-crewaid-mcp-connect']).toBe('failed:exchange-failed');
      // The provider's own error fields are quoted; its body is not.
      expect(response.text).toContain('invalid_grant: the stub refused this code');
      expect(await prisma.mcpCredential.count({ where: { serverId: server.id } })).toBe(0);
      expect((await row(server.id))?.status).toBe('DISCONNECTED');
    });

    it('keeps the credential when the listing fails, and says which half worked', async () => {
      const server = await seedOAuthServer();
      behavior.failListing = true;

      const response = await completeTrip(server.id);
      // The status is 200 like every other outcome; `failed:tools-failed`
      // below is what says the listing did not complete.
      expect(response.status).toBe(200);

      expect(response.headers['x-crewaid-mcp-connect']).toBe('failed:tools-failed');
      expect(response.text).toContain('credential was stored');

      // Both facts at once: the credential exists, and the server is ERROR
      // because the listing failed — which is what the modal polls.
      expect(await prisma.mcpCredential.count({ where: { serverId: server.id } })).toBe(1);
      const connected = await row(server.id);
      expect(connected?.status).toBe('ERROR');
      expect(connected?.lastError).toBeTruthy();

      // …and a manual refresh, once the server answers again, completes it.
      behavior.failListing = false;
      await http()
        .post(api(`/mcp/servers/${server.id}/refresh-tools`))
        .set(ACTOR.headers)
        .expect(200);
      expect((await row(server.id))?.status).toBe('CONNECTED');
    });

    it('connects a server that needs no credential without a browser trip', async () => {
      const server = await seedOAuthServer({ authType: 'NONE', url: RESOURCE });
      // This stub accepts an unauthenticated caller, which is what a server
      // declaring `authType: NONE` is claiming about itself.
      behavior.requireBearer = false;

      const response = await http()
        .post(api(`/mcp/servers/${server.id}/connect`))
        .set(ACTOR.headers)
        .expect(200);

      expect(response.body).toEqual({ connected: true });
      // A NONE server opens its connection with no header set at all rather
      // than an empty one, so the transport never attaches `authorization`.
      expect(behavior.sawAuthorization).toBeUndefined();
      expect(await prisma.mcpOAuthFlow.count({ where: { serverId: server.id } })).toBe(0);
      expect((await row(server.id))?.toolCount).toBe(2);
    });

    it('refuses a HEADER server with no token stored, and says to add one (D-114)', async () => {
      // HEADER used to be refused outright — there was no route that accepted a
      // token, so the only honest answer was "this cannot be connected". D-114
      // added that route, so the refusal is now about THIS server rather than
      // about the build, and it names the action that fixes it.
      const server = await seedOAuthServer({ authType: 'HEADER' });

      const response = await http()
        .post(api(`/mcp/servers/${server.id}/connect`))
        .set(ACTOR.headers)
        .expect(409);

      expect((response.body as { message: string }).message).toContain('add its token');
      // And no browser trip was opened on the way: a header server has nothing
      // to authorize, so an OAuth flow row here would be one nobody can finish.
      expect(await prisma.mcpOAuthFlow.count({ where: { serverId: server.id } })).toBe(0);
    });

    it('cannot connect somebody else’s server', async () => {
      const server = await seedOAuthServer();

      await http()
        .post(api(`/mcp/servers/${server.id}/connect`))
        .set(FOREIGN.headers)
        .expect(404);

      expect(await prisma.mcpOAuthFlow.count({ where: { serverId: server.id } })).toBe(0);
      // …and the owner's row is untouched by the attempt.
      expect((await row(server.id))?.status).toBe('DISCONNECTED');
    });

    it('serves the callback to a browser with no session at all', async () => {
      // The guard exemption, asserted through the real guard rather than by
      // reading the path comparison: no cookie, no bearer, no principal — and
      // the answer is the flow's, not a 401.
      const response = await http().get(api('/mcp/oauth/callback')).expect(200);
      expect(response.headers['x-crewaid-mcp-connect']).toBe('failed:invalid-request');
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('leaves the credential reachable only through the server row', async () => {
      const server = await seedOAuthServer();
      expect((await completeTrip(server.id)).status).toBe(200);

      // A bot that enables the plugin gets the tools, not the token: the
      // link table is what a turn reads, and M6-BE-06 names the tools from it.
      const bot = await prisma.bot.create({
        data: {
          userId: ACTOR.userId,
          name: `oauth-${RUN_ID}`,
          role: 'test',
          avatarColor: '#8B6F47',
          systemPrompt: 'test',
        },
      });
      await prisma.botMcpServer.create({ data: { botId: bot.id, serverId: server.id } });
      const links = await prisma.botMcpServer.findMany({ where: { botId: bot.id } });
      expect(links).toHaveLength(1);

      // Uninstalling is still the revocation path — the credential goes with
      // the row, and so does the flow table entry if one is in flight.
      const other = await seedOAuthServer();
      await connect(other.id);
      await http()
        .delete(api(`/mcp/servers/${other.id}`))
        .set(ACTOR.headers)
        .expect(204);
      expect(await prisma.mcpOAuthFlow.count({ where: { serverId: other.id } })).toBe(0);
      expect(await prisma.mcpCredential.count({ where: { serverId: server.id } })).toBe(1);
    });

    it('fills the tool cache from the trip, which is what a bot is offered from', async () => {
      const server = await seedOAuthServer();
      behavior.tools = Array.from({ length: 3 }, (unused, index) => ({
        name: `tool_${index}`,
        description: `Tool ${index}`,
        inputSchema: { type: 'object' },
      }));

      expect((await completeTrip(server.id)).status).toBe(200);

      const cached = await prisma.mcpTool.findMany({ where: { serverId: server.id } });
      expect(cached).toHaveLength(3);
    });

    // ── M6-BE-05 — the bearer after the trip ────────────────────────────────

    describe('M6-BE-05 — renewing the bearer, and what a refusal means', () => {
      /** Every socket this nested suite opened, so none outlives its case. */
      const windows: Window[] = [];

      afterEach(() => {
        for (const window of windows) window.socket.close();
        windows.length = 0;
      });

      async function watch(): Promise<Window> {
        const window = await openWindow(port, ACTOR.token);
        windows.push(window);
        return window;
      }

      /** The `mcp.status` frames a window was sent, with the §4.2 parse asserted. */
      function statuses(window: Window): ServerFrameRecord[] {
        expect(window.undecodable).toEqual([]);
        return framesOfType(window, 'mcp.status');
      }

      function refreshToolList(id: string): request.Test {
        return http()
          .post(api(`/mcp/servers/${id}/refresh-tools`))
          .set(ACTOR.headers);
      }

      /**
       * The credential row a completed trip leaves behind, written through the
       * SAME seam the callback writes it with — so the ciphertext, the AAD
       * binding and the metadata are the real ones. Seeded rather than reached
       * by a browser trip because the trip is M6-BE-03's subject and is
       * asserted above; what these cases are about starts with a credential
       * that already exists and a bearer that is about to be spent.
       */
      async function seedCredential(
        serverId: string,
        options: {
          readonly accessToken?: string;
          /** `null` → the authorization server issued no refresh token at all. */
          readonly refreshToken?: string | null;
          /** `null` or absent → the response named no lifetime (the column is NULL). */
          readonly expiresInMs?: number | null;
          /** `null` → a credential from before M6-BE-05, with no coordinates. */
          readonly authMetadata?: {
            readonly tokenEndpoint: string;
            readonly clientId: string;
            readonly resource: string;
          } | null;
          readonly scopes?: readonly string[];
        } = {},
      ): Promise<void> {
        const accessToken = options.accessToken ?? `tok_seeded_${RUN_ID}`;
        const refreshToken =
          options.refreshToken === null ? undefined : (options.refreshToken ?? REFRESH_TOKEN);
        await storeMcpCredential(prisma, {
          userId: ACTOR.userId,
          serverId,
          accessToken,
          refreshToken,
          expiresAt:
            options.expiresInMs === undefined || options.expiresInMs === null
              ? undefined
              : new Date(Date.now() + options.expiresInMs),
          scopes: options.scopes ?? ['issues.read'],
          authMetadata:
            options.authMetadata === null
              ? undefined
              : (options.authMetadata ?? {
                  tokenEndpoint: `${ISSUER}/token`,
                  clientId: SEEDED_CLIENT_ID,
                  resource: RESOURCE,
                }),
        });
        // A credential that EXISTS is one the resource server can be expected
        // to know — the state a real connect leaves — so the stub accepts it
        // from here on. Otherwise every seeded case would start at a 401 and
        // "the renewal was what fixed it" would be unfalsifiable.
        behavior.bearer = accessToken;
        // …and the endpoint remembers the grant it issued, so rotation is
        // enforced from this point exactly as it is after a real trip.
        behavior.expectedRefreshToken = refreshToken;
      }

      it('serializes overlapping refreshes so a rotating grant is spent only once', async () => {
        const server = await seedOAuthServer();
        await seedCredential(server.id, { expiresInMs: 5_000 });
        const window = await watch();

        const responses = await Promise.all(
          Array.from({ length: 4 }, () => refreshToolList(server.id)),
        );

        expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
        expect(behavior.refreshRequests).toBe(1);
        expect((await row(server.id))?.status).toBe('CONNECTED');
        await settle(window);
        expect(statuses(window)).toHaveLength(0);
      });

      it('coordinates rotating grants across separate service instances', async () => {
        const server = await seedOAuthServer();
        await seedCredential(server.id, { expiresInMs: 5_000 });
        const other = new McpServersService(
          prisma,
          app.get(TurnEventBus),
          app.get(ToolRegistry),
          app.get(ComposioService),
        );
        other.setAddressResolverForTests(() => Promise.resolve(['93.184.216.34']));
        let secondGrantStarted = false;
        other.setMcpFetchForTests((input, init) => {
          if (String(init?.body).includes('grant_type=refresh_token')) secondGrantStarted = true;
          return stubFetch(input, init);
        });
        let release!: () => void;
        let started!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const entered = new Promise<void>((resolve) => {
          started = resolve;
        });
        servers.setMcpFetchForTests(async (input, init) => {
          if (String(init?.body).includes('grant_type=refresh_token')) {
            started();
            await held;
          }
          return stubFetch(input, init);
        });
        try {
          const first = servers.refreshTools(ACTOR.userId, server.id);
          await entered;
          const second = other.refreshTools(ACTOR.userId, server.id);
          const results = Promise.all([first, second]);
          // Wait until the other instance is blocked by the row lock, or
          // reaches the token endpoint (which removing the lock permits).
          // This forces overlap without depending on host timing.
          const deadline = Date.now() + 10_000;
          for (;;) {
            const blocked = await prisma.$queryRaw<{ waiting: boolean }[]>`
              SELECT EXISTS (
                SELECT 1 FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'
                  AND query LIKE '%SELECT c."serverId" FROM "McpCredential" c%'
              ) AS waiting
            `;
            if (secondGrantStarted || blocked[0]?.waiting) break;
            if (Date.now() > deadline) throw new Error('The second renewal did not start');
            await sleep(5);
          }
          release();
          expect((await results).map((result) => result.status)).toEqual([
            'CONNECTED',
            'CONNECTED',
          ]);
          expect(behavior.refreshRequests).toBe(1);
        } finally {
          release();
          servers.setMcpFetchForTests(stubFetch);
        }
      });

      it('clears a shared failed refresh so a later attempt can recover', async () => {
        const server = await seedOAuthServer();
        await seedCredential(server.id, { expiresInMs: 5_000 });
        behavior.refuseRefreshWith = 400;
        const window = await watch();

        const responses = await Promise.allSettled([
          servers.refreshTools(ACTOR.userId, server.id),
          servers.refreshTools(ACTOR.userId, server.id),
        ]);
        expect(responses.map((response) => response.status)).toEqual(['rejected', 'rejected']);
        expect(behavior.refreshRequests).toBe(1);
        await settle(window);
        expect(statuses(window)).toHaveLength(1);

        behavior.refuseRefreshWith = undefined;
        await refreshToolList(server.id).expect(200);
        expect(behavior.refreshRequests).toBe(2);
        expect((await row(server.id))?.status).toBe('CONNECTED');
      });

      it('does not share an owner’s in-flight refresh with another principal', async () => {
        const server = await seedOAuthServer();
        await seedCredential(server.id, { expiresInMs: 5_000 });

        await Promise.all([
          expect(servers.refreshTools(ACTOR.userId, server.id)).resolves.toMatchObject({
            status: 'CONNECTED',
          }),
          expect(servers.refreshTools(FOREIGN.userId, server.id)).rejects.toMatchObject({
            status: 404,
          }),
        ]);
        expect(behavior.refreshRequests).toBe(1);
      });

      it('renews a bearer that is already inside the skew, before it dials', async () => {
        const server = await seedOAuthServer();
        await seedCredential(server.id, { accessToken: 'tok_before_renewal', expiresInMs: 5_000 });
        const window = await watch();

        const response = await refreshToolList(server.id).expect(200);
        expect(response.body.toolCount).toBe(2);

        // The wire shape of the second grant: what a refresh must carry, and
        // the three fields that belong to the code exchange and must not.
        const form = behavior.lastTokenForm;
        expect(form?.get('grant_type')).toBe('refresh_token');
        expect(form?.get('refresh_token')).toBe(REFRESH_TOKEN);
        expect(form?.get('client_id')).toBe(SEEDED_CLIENT_ID);
        expect(form?.get('resource')).toBe(RESOURCE);
        expect(form?.get('code')).toBeNull();
        expect(form?.get('code_verifier')).toBeNull();
        expect(form?.get('redirect_uri')).toBeNull();

        // Renewed BEFORE the socket: the resource server saw the minted bearer
        // and never the one with five seconds left on it.
        expect(behavior.mcpRequests).toBeGreaterThan(0);
        expect(behavior.sawAuthorization).toBe(`Bearer ${REFRESHED_ACCESS_TOKEN}_1`);

        // The row moved: new ciphertext, a lifetime that is not the stale one,
        // and the rotated grant.
        const column = await prisma.mcpCredential.findUniqueOrThrow({
          where: { serverId: server.id },
        });
        expect(column.accessToken.startsWith('g1.')).toBe(true);
        expect(column.accessToken).not.toContain('tok_before_renewal');
        expect(column.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
        const credential = await readMcpCredential(prisma, {
          userId: ACTOR.userId,
          serverId: server.id,
        });
        expect(credential?.accessToken).toBe(`${REFRESHED_ACCESS_TOKEN}_1`);
        expect(credential?.refreshToken).toBe(`${ROTATED_REFRESH_TOKEN}_1`);
        // A response that names no `scope` keeps the stored one (RFC 6749 §6).
        expect(credential?.scopes).toEqual(['issues.read']);

        expect((await row(server.id))?.status).toBe('CONNECTED');
        // A renewal that worked is not an event: no status was written, so
        // nothing is announced to the windows that watch them.
        await settle(window);
        expect(statuses(window)).toHaveLength(0);
      });

      it('renews on a 401 from the server, and retries the operation once', async () => {
        const server = await seedOAuthServer();
        await seedCredential(server.id, {
          accessToken: `tok_stale_${RUN_ID}`,
          expiresInMs: 3_600_000,
        });
        // The stored expiry says "an hour left", so nothing is renewed up
        // front. The resource server disagrees — which is the trigger that has
        // to be read off the RESPONSE, because the SDK turns a 401 into an
        // error type that no longer carries the status.
        behavior.bearer = `tok_superseded_${RUN_ID}`;
        behavior.refreshedScope = 'issues.read issues.write';
        const window = await watch();
        const dialsBefore = behavior.mcpRequests;

        const response = await refreshToolList(server.id).expect(200);
        expect(response.body.toolCount).toBe(2);

        // ONE renewal, and the retry carried the new bearer: the rejected
        // connection was abandoned rather than reused, because the client
        // sends the headers it was constructed with.
        expect(behavior.refreshRequests).toBe(1);
        expect(behavior.mcpRequests).toBeGreaterThan(dialsBefore);
        expect(behavior.sawAuthorization).toBe(`Bearer ${REFRESHED_ACCESS_TOKEN}_1`);

        const credential = await readMcpCredential(prisma, {
          userId: ACTOR.userId,
          serverId: server.id,
        });
        expect(credential?.accessToken).toBe(`${REFRESHED_ACCESS_TOKEN}_1`);
        expect(credential?.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
        // A response that DOES name a scope replaces the stored one.
        expect(credential?.scopes).toEqual(['issues.read', 'issues.write']);
        expect((await row(server.id))?.status).toBe('CONNECTED');
        await settle(window);
        expect(statuses(window)).toHaveLength(0);
      });

      it('writes NULL, not the stale instant, when a renewal names no lifetime', async () => {
        const server = await seedOAuthServer();
        await seedCredential(server.id, { expiresInMs: 5_000 });
        behavior.refreshedExpiresIn = null;
        const window = await watch();

        await refreshToolList(server.id).expect(200);
        const stored = await prisma.mcpCredential.findUniqueOrThrow({
          where: { serverId: server.id },
        });
        // "The server did not say" is a fact, and the five-second timestamp it
        // replaced is not a substitute for it.
        expect(stored.expiresAt).toBeNull();

        // …and the NEXT operation neither renews nor needs to: with no expiry
        // there is no skew to be inside. A stale instant written above would
        // have made this a second renewal.
        const asked = behavior.refreshRequests;
        await refreshToolList(server.id).expect(200);
        expect(behavior.refreshRequests).toBe(asked);
        await settle(window);
        expect(statuses(window)).toHaveLength(0);
      });

      it('keeps the stored grant when a renewal does not rotate it, and uses it again', async () => {
        const server = await seedOAuthServer();
        await seedCredential(server.id, { expiresInMs: 5_000 });
        behavior.rotateRefreshToken = false;
        const window = await watch();

        await refreshToolList(server.id).expect(200);
        expect(behavior.lastTokenForm?.get('refresh_token')).toBe(REFRESH_TOKEN);
        // The PLAINTEXT is what an unrotated renewal has to preserve — a
        // re-encrypt under a fresh GCM nonce is expected, so only a read can
        // answer the question and the bytes are deliberately not compared.
        const first = await readMcpCredential(prisma, {
          userId: ACTOR.userId,
          serverId: server.id,
        });
        expect(first?.refreshToken).toBe(REFRESH_TOKEN);

        // …and it is still a USABLE grant. The endpoint accepted it once; a
        // second renewal that presents the same one is what proves no empty
        // value was written over it. The expiry is moved by touching the
        // instant only, so the ciphertext is the one the last write left.
        await prisma.mcpCredential.update({
          where: { serverId: server.id },
          data: { expiresAt: new Date(Date.now() + 5_000) },
        });
        await refreshToolList(server.id).expect(200);
        expect(behavior.refreshRequests).toBe(2);
        expect(behavior.lastTokenForm?.get('refresh_token')).toBe(REFRESH_TOKEN);
        const second = await readMcpCredential(prisma, {
          userId: ACTOR.userId,
          serverId: server.id,
        });
        expect(second?.refreshToken).toBe(REFRESH_TOKEN);
        expect(second?.accessToken).toBe(`${REFRESHED_ACCESS_TOKEN}_2`);
        await settle(window);
        expect(statuses(window)).toHaveLength(0);
      });

      it('turns a refused renewal into NEEDS_REAUTH, one frame, and a 409', async () => {
        const server = await seedOAuthServer();
        await seedCredential(server.id, { expiresInMs: 5_000 });
        behavior.refuseRefreshWith = 400;
        const window = await watch();

        const response = await refreshToolList(server.id).expect(409);
        const message = (response.body as { message: string }).message;

        // §6/M6: the failure surfaces as the one action that fixes it, with
        // the authorization server's own standard error fields quoted.
        expect(message).toContain('needs to be reconnected');
        expect(message).toContain('refused to refresh it');
        expect(message).toContain('invalid_grant: the stub refused this refresh');

        // Durable before emitted: a window that opens later reads the row.
        const stored = await prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id } });
        expect(stored.status).toBe('NEEDS_REAUTH');
        expect(stored.lastError).toBe(message);

        // Nothing was dialled: a bearer that could not be minted is never
        // presented, and "did not answer" would blame the wrong party.
        expect(behavior.mcpRequests).toBe(0);

        await settle(window);
        const frames = statuses(window);
        expect(frames).toHaveLength(1);
        expect(frames[0]?.frame.payload).toEqual({
          serverId: server.id,
          status: 'NEEDS_REAUTH',
          toolCount: 0,
          lastError: message,
        });
        // §7.3 and D-103 are claims about BYTES. The token material is not in
        // the frame, and neither is a bot: this fact is about a server.
        expect(frames[0]?.text).not.toContain(REFRESH_TOKEN);
        expect(frames[0]?.text).not.toContain(`tok_seeded_${RUN_ID}`);
        expect(frames[0]?.text).not.toContain('"botId"');

        // A second operation while the row says NEEDS_REAUTH: refused again,
        // with the same sentence and its own single attempt — and it does not
        // re-announce a transition that has already happened.
        const again = await refreshToolList(server.id).expect(409);
        expect((again.body as { message: string }).message).toBe(message);
        expect(behavior.refreshRequests).toBe(2);
        expect(behavior.mcpRequests).toBe(0);
        await settle(window);
        expect(statuses(window)).toHaveLength(1);
      });

      it('announces nothing when the status could not be written', async () => {
        const server = await seedOAuthServer();
        await seedCredential(server.id, { expiresInMs: 5_000 });
        behavior.refuseRefreshWith = 400;
        const window = await watch();

        // D-103's "written BEFORE it is emitted" is an order, and the socket
        // cannot see one: by the time a frame is readable, both halves have
        // happened. So the write is broken on purpose — a frame emitted first
        // would have arrived anyway, announcing a status the row never took,
        // and no later read could correct it.
        const write = vi
          .spyOn(prisma.mcpServer, 'update')
          .mockRejectedValueOnce(new Error('the row could not be written'));
        try {
          const response = await refreshToolList(server.id);
          expect(response.status).toBeGreaterThanOrEqual(500);
        } finally {
          write.mockRestore();
        }

        await settle(window);
        expect(statuses(window)).toHaveLength(0);
        // …and the row says what actually happened to it, not NEEDS_REAUTH:
        // a status this build could not store is not a verdict it may claim.
        const stored = await prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id } });
        expect(stored.status).toBe('ERROR');
      });

      it('stops after one renewal when the resource server rejects the token just minted', async () => {
        const server = await seedOAuthServer();
        const seeded = `tok_seeded_for_rejection_${RUN_ID}`;
        await seedCredential(server.id, { accessToken: seeded, expiresInMs: 5_000 });
        // The authorization server mints a token; this resource server will
        // not learn it. "Authorized during this operation and still
        // unauthorized" is the board's termination condition, and a second
        // challenge is the infinite re-challenge it exists to avoid.
        behavior.resourceStaysOnOldBearer = true;
        const window = await watch();

        const response = await refreshToolList(server.id).expect(409);
        expect((response.body as { message: string }).message).toContain('was rejected as well');

        expect(behavior.refreshRequests).toBe(1);
        expect(behavior.mcpRequests).toBeGreaterThan(0);
        expect(behavior.sawAuthorization).toBe(`Bearer ${REFRESHED_ACCESS_TOKEN}_1`);
        expect(
          (await prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id } })).status,
        ).toBe('NEEDS_REAUTH');
        await settle(window);
        expect(statuses(window)).toHaveLength(1);
      });

      it('refuses a credential that carries no refresh coordinates, asking nobody', async () => {
        const server = await seedOAuthServer();
        await seedCredential(server.id, { expiresInMs: 5_000, authMetadata: null });
        const window = await watch();

        const response = await refreshToolList(server.id).expect(409);
        const message = (response.body as { message: string }).message;
        expect(message).toContain('no refresh coordinates were recorded');
        expect(message).toContain('needs to be reconnected');

        // Nobody was asked: not the authorization server, not the server.
        expect(behavior.refreshRequests).toBe(0);
        expect(behavior.mcpRequests).toBe(0);
        expect(
          (await prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id } })).status,
        ).toBe('NEEDS_REAUTH');
        await settle(window);
        expect(statuses(window)).toHaveLength(1);
      });

      it('refuses a credential the authorization server gave no refresh token to', async () => {
        const server = await seedOAuthServer();
        await seedCredential(server.id, { expiresInMs: 5_000, refreshToken: null });
        const window = await watch();

        const response = await refreshToolList(server.id).expect(409);
        expect((response.body as { message: string }).message).toContain(
          'issued it no refresh token',
        );
        expect(behavior.refreshRequests).toBe(0);
        expect(behavior.mcpRequests).toBe(0);
        await settle(window);
        expect(statuses(window)).toHaveLength(1);
      });

      it('lets a fresh connect clear NEEDS_REAUTH, and records what the next renewal needs', async () => {
        const server = await seedOAuthServer();
        await seedCredential(server.id, { expiresInMs: 5_000 });
        behavior.refuseRefreshWith = 400;
        const window = await watch();
        await refreshToolList(server.id).expect(409);
        expect((await row(server.id))?.status).toBe('NEEDS_REAUTH');

        // The fix the sentence names, taken: a real browser trip replaces the
        // credential, and the status follows the listing rather than a flag.
        behavior.refuseRefreshWith = undefined;
        expect((await completeTrip(server.id)).status).toBe(200);

        const listed = await row(server.id);
        expect(listed?.status).toBe('CONNECTED');
        expect(listed?.lastError).toBeNull();
        expect(listed?.toolCount).toBe(2);

        // …and the coordinates the NEXT renewal will need came from THIS trip:
        // `client-1` is the id the registration above was handed, and none of
        // the seeded credential survived the replacement.
        const credential = await readMcpCredential(prisma, {
          userId: ACTOR.userId,
          serverId: server.id,
        });
        expect(credential?.accessToken).toBe(ACCESS_TOKEN);
        expect(credential?.refreshToken).toBe(REFRESH_TOKEN);
        expect(credential?.authMetadata).toEqual({
          tokenEndpoint: `${ISSUER}/token`,
          clientId: 'client-1',
          resource: RESOURCE,
        });
        // Recovery is a row fact, not an event: the refusal's frame is the
        // only one this socket got, and M6-FE-02 polls the row for the rest.
        await settle(window);
        expect(statuses(window)).toHaveLength(1);
      });

      it('renews a token that arrives inside the skew, and keeps the rotated grant', async () => {
        const server = await seedOAuthServer();
        // The authorization server issues a five-second token, so the TRIP's
        // own listing is already inside the 60s skew. That first renewal can
        // only happen if the callback stored the coordinates the grant needs
        // (D-103) — a callback that dropped them fails here as a 409.
        behavior.codeExpiresIn = 5;
        expect((await completeTrip(server.id)).status).toBe(200);
        expect(behavior.refreshRequests).toBe(1);

        const afterTrip = await readMcpCredential(prisma, {
          userId: ACTOR.userId,
          serverId: server.id,
        });
        expect(afterTrip?.accessToken).toBe(`${REFRESHED_ACCESS_TOKEN}_1`);
        expect(afterTrip?.refreshToken).toBe(`${ROTATED_REFRESH_TOKEN}_1`);
        expect(afterTrip?.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 3_000_000);

        const window = await watch();
        // An operation with a live token asks nobody.
        const asked = behavior.refreshRequests;
        await refreshToolList(server.id).expect(200);
        expect(behavior.refreshRequests).toBe(asked);
        expect(behavior.sawAuthorization).toBe(`Bearer ${REFRESHED_ACCESS_TOKEN}_1`);

        // Now spend it, by moving the instant only — the ciphertext is left
        // exactly as the last write left it. The endpoint refuses any grant
        // but the one it last issued, so this renewal is the proof that the
        // ROTATED grant is what the row holds: a row still carrying the
        // superseded one is refused as a 409 here.
        await prisma.mcpCredential.update({
          where: { serverId: server.id },
          data: { expiresAt: new Date(Date.now() + 5_000) },
        });
        behavior.lastTokenForm = undefined;
        await refreshToolList(server.id).expect(200);
        expect(behavior.lastTokenForm?.get('refresh_token')).toBe(`${ROTATED_REFRESH_TOKEN}_1`);
        expect(behavior.lastTokenForm?.get('client_id')).toBe('client-1');

        const listed = await row(server.id);
        expect(listed?.status).toBe('CONNECTED');
        expect(listed?.toolCount).toBe(2);
        await settle(window);
        expect(statuses(window)).toHaveLength(0);
      });
    });
  },
);
