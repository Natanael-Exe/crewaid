import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  MockLanguageModelV4,
  scriptModel,
  simulateReadableStream,
} from './model-resolution-fake.js';
import type { ScriptPart as LanguageModelV4StreamPart } from './model-resolution-fake.js';
import type { INestApplication } from '@nestjs/common';
import {
  DEFAULT_AUTO_REVIEW_RULES,
  FIND_PLUGIN_TOOLS,
  McpServerSummarySchema,
} from '@crewaid/shared';

import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { BotsService } from '../src/bots/bots.service.js';
import { McpServersService } from '../src/mcp/mcp-servers.service.js';
import { TurnControlService } from '../src/agent/turn-control.service.js';
import { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { chatBody, threadOf } from './chat-fixture.js';
import { FakeProvider } from './sandbox-fakes.js';
import { signIn, type SignedInUser } from './auth-fixture.js';
import { startStubMcpServer, stubFetchTo, type StubMcpServer } from './mcp-stub.js';

/**
 * M6-QA-05 and M6-QA-10 — a plugin tool, all the way to the model and back.
 *
 *   QA-05  install → connect → list → enable for a bot → call a tool →
 *          assert the result reaches the model.
 *   QA-10  under DEFAULT rules, a write-classified tool blocks for approval
 *          and a read-only one does not.
 *
 * ── WHAT IS REAL HERE ───────────────────────────────────────────────────────
 *
 * Everything except the model and the server's network address. The MCP server
 * speaks the real protocol over loopback (`mcp-stub.ts`); the install, the
 * connect, the tool cache, the namespacing, the read-only ladder, the per-bot
 * budget, the approval matcher and the AI SDK's tool loop are all the
 * production code. The model is `MockLanguageModelV4`, which is what makes
 * "the result reached the model" something a test can read rather than infer:
 * the SDK hands the next step's messages to the model, and the mock records
 * them.
 *
 * ⚠️ NO SANDBOX, NO CHROME, AND THAT IS AN ASSERTION RATHER THAN A SHORTCUT.
 * An MCP tool runs in the orchestrator (R10) — it needs no desktop — so a turn
 * that only calls plugin tools must start nothing. M5-BE-14 made every tool
 * context accessor a thunk for exactly this, and a suite that had to stand up
 * a fake Chrome to exercise a Gmail call would be evidence that the rule had
 * quietly stopped holding.
 *
 * Needs DATABASE_URL. Without it every case skips and the run still reports
 * green (CLAUDE.md: a silently skipped test is a dormant guard).
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);

/** The host every server in this suite is installed under. */
const STUB_HOST = 'plugin.example.test';
const STUB_HOSTS = new Set([STUB_HOST]);

/**
 * M6-QA-09's failing server: one plugin whose every request answers 500.
 *
 * It is a SEPARATE listener rather than a flag on the stub because the
 * acceptance criterion is about one server being down while two others are
 * not, in the same turn — a flag would take all three down together and the
 * case would pass without proving isolation of anything.
 */
let broken: Server;
let brokenOrigin: string;
/**
 * Which installed server ids are currently routed to the 500 listener.
 *
 * A server that 500s can never be connected, and §6/M6's case is a server that
 * WAS working: "With one plugin's server returning 500 for every request, a
 * turn using two other plugins still completes" describes a plugin that
 * connected and then went down. So the routing is per-server and flipped after
 * the install, which is the sequence that actually happens.
 */
const downedPaths = new Set<string>();

/**
 * Paths routed to a socket that accepts a request and never answers.
 *
 * A 500 and a hang are different failures and only one of them is a timeout:
 * a server that refuses loudly fails fast on its own, and the deadline is
 * there for the one that does not fail at all.
 */
const hangingPaths = new Set<string>();
const hangingCallPaths = new Set<string>();
let nextHangingCall: (() => void) | undefined;
let cancelledRemoteCalls = 0;
/** The chat streams a case started and did not wait for. */
const inflight: Promise<void>[] = [];

const READ_TOOL = {
  name: 'list_invoices',
  description: 'List the invoices',
  inputSchema: { type: 'object', properties: { since: { type: 'string' } } },
};

const WRITE_TOOL = {
  name: 'send_invoice',
  description: 'Send one invoice to a customer',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
};

let app: INestApplication;
let prisma: PrismaService;
let bots: BotsService;
let servers: McpServersService;
let turns: TurnControlService;
let stub: StubMcpServer;
let ACTOR: SignedInUser;
let model: MockLanguageModelV4;

type TurnRow = { readonly id: string; readonly status: string };

const api = (path: string): string => `/api/v1${path}`;
const http = (): request.Test => request(app.getHttpServer()) as unknown as request.Test;

const usage = { inputTokens: { total: 3 }, outputTokens: { total: 2 } };

/**
 * Calls one tool, then answers.
 *
 * The second call is what carries the tool RESULT: the SDK appends it to the
 * next step's messages, so a model that answered on the first call would leave
 * "did the result reach the model" unanswerable.
 */
/**
 * A model that reaches a plugin tool the way D-194 says it must on a run:
 * `find_plugin_tools` loads it by the name the listing gave, and the next
 * call is the tool itself. Then it answers.
 */
function callingPluginTool(toolName: string, input: Record<string, unknown>): MockLanguageModelV4 {
  let calls = 0;
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'mock-mcp-model',
    doStream: async () => {
      calls += 1;
      const call = (name: string, args: Record<string, unknown>): LanguageModelV4StreamPart[] => [
        { type: 'stream-start', warnings: [] },
        {
          type: 'tool-call',
          // Unique per call, as a provider's are: a thread's runs share one history.
          toolCallId: `call-${randomUUID()}`,
          toolName: name,
          input: JSON.stringify(args),
        },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
      ];
      const chunks: LanguageModelV4StreamPart[] =
        calls === 1
          ? call(FIND_PLUGIN_TOOLS, { names: [toolName] })
          : calls === 2
            ? call(toolName, input)
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 't' },
                { type: 'text-delta', id: 't', delta: 'done.' },
                { type: 'text-end', id: 't' },
                { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
              ];
      return {
        stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }),
      };
    },
  });
}

/** The call that carries the plugin tool's RESULT: after the load and the call. */
const AFTER_THE_CALL = 2;

/** Every tool-result output the model was handed, across every message. */
function toolResults(prompt: unknown): unknown[] {
  const found: unknown[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    if (record['type'] === 'tool-result') found.push(record['output']);
    for (const item of Object.values(record)) walk(item);
  };
  walk(prompt);
  return found;
}

/** The names the provider was offered on the first call. */
function offeredTools(): string[] {
  return (model.doStreamCalls[0]?.tools ?? []).map((entry) => entry.name);
}

/** What the provider was told about one offered tool. */
function offeredTool(name: string): { description?: string } | undefined {
  return (model.doStreamCalls[0]?.tools ?? []).find((entry) => entry.name === name);
}

/**
 * The plugin tools the bridge advertised on the first call.
 *
 * D-113 moved every plugin tool behind the door, so "was it offered" is now a
 * question about the LISTING the search definition carries — and it is still
 * the question §6/M6's failure isolation asks, because a tool missing from the
 * listing is a tool the model has to guess its way to.
 */
function offeredListing(): string {
  return String(offeredTool('find_plugin_tools')?.description ?? '');
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M6-QA-05 / M6-QA-10 — a plugin tool reaches the model, and asks first when it writes',
  () => {
    let seed = 0;

    beforeAll(async () => {
      process.env['CREDENTIAL_KEY'] = '44'.repeat(32);
      stub = await startStubMcpServer();
      broken = createServer((_request, response) => {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end('the plugin is having a bad afternoon');
      });
      await new Promise<void>((resolve) => broken.listen(0, '127.0.0.1', resolve));
      brokenOrigin = `http://127.0.0.1:${String((broken.address() as AddressInfo).port)}`;

      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module.js');
      const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        // Creating a bot provisions its computer's workspace. A plugin tool
        // never needs that machine (R10), so a real daemon and image would
        // only make this suite depend on what the host happens to have built.
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(new FakeProvider())
        .compile();

      app = moduleRef.createNestApplication();
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      // The app declares a §4.2 gateway, and Nest calls `process.exit` looking
      // for a socket.io driver when none is set — even on a suite that opens
      // no socket.
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      // Listening once, rather than letting supertest listen and close per
      // request: `runTurn` starts the next chat while the last one's stream is
      // still finishing, and that request's close tears down the keep-alive
      // socket the new one was just handed — an ECONNRESET before the server
      // ever sees it.
      await app.listen(0, '127.0.0.1');
      // A thunk, because each case installs its own model before starting a
      // turn: the run resolves it at call time, not at wiring time.
      scriptModel(app, () => model);

      prisma = app.get(PrismaService);
      ACTOR = await signIn(prisma, { label: 'mcp-turn' });
      bots = app.get(BotsService);
      turns = app.get(TurnControlService);
      servers = app.get(McpServersService);
      // D-085 refuses a private address twice — at install, and again at
      // request time. Both seams are named for what they stand in for.
      servers.setAddressResolverForTests(() => Promise.resolve(['93.184.216.34']));
      servers.setMcpFetchForTests(routedFetch());
    }, 60_000);

    /**
     * The stub for everything, except the paths this case has taken down.
     *
     * `stubFetchTo`'s host rule is not enough here: all three servers share a
     * host, and what distinguishes them is the path their install recorded.
     */
    function routedFetch(): typeof fetch {
      const toStub = stubFetchTo(stub, STUB_HOSTS);
      return async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        if (url.hostname === STUB_HOST && hangingCallPaths.has(url.pathname)) {
          const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
          if (
            body !== null &&
            typeof body === 'object' &&
            'method' in body &&
            body.method === 'tools/call'
          ) {
            nextHangingCall?.();
            const signal = init?.signal;
            if (!signal) throw new Error('tools/call has no cancellation signal');
            return await new Promise<Response>((_resolve, reject) => {
              const cancelled = () => {
                cancelledRemoteCalls += 1;
                reject(signal.reason);
              };
              signal.addEventListener('abort', cancelled, { once: true });
              if (signal.aborted) cancelled();
            });
          }
        }
        if (url.hostname === STUB_HOST && hangingPaths.has(url.pathname)) {
          // Never settles, and never rejects either: that is the shape a
          // deadline exists for.
          return new Promise<Response>(() => undefined);
        }
        if (url.hostname === STUB_HOST && downedPaths.has(url.pathname)) {
          return fetch(new URL(url.pathname, brokenOrigin), init);
        }
        return toStub(input, init);
      };
    }

    beforeEach(async () => {
      stub.clear();
      stub.tools = [READ_TOOL, WRITE_TOOL];
      downedPaths.clear();
      hangingPaths.clear();
      hangingCallPaths.clear();
      nextHangingCall = undefined;
      cancelledRemoteCalls = 0;
      // A case returns once its run's row has settled, while the run's stream
      // may still be writing its tail. Deleting the bots under it is a write
      // conflict, so the next case waits for those streams first — bounded,
      // because a case about a hanging server leaves one open on purpose.
      await Promise.race([
        Promise.allSettled(inflight.splice(0)),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
      await clearFixtures();
    });

    afterAll(async () => {
      await Promise.race([
        Promise.allSettled(inflight.splice(0)),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
      await clearFixtures();
      servers.setMcpFetchForTests(undefined);
      servers.setAddressResolverForTests(undefined);
      await stub.close();
      broken.closeAllConnections();
      await new Promise<void>((resolve) => broken.close(() => resolve()));
      await app.close();
      await prisma.user.deleteMany({ where: { id: ACTOR.userId } });
    });

    async function clearFixtures(): Promise<void> {
      await prisma.mcpServer.deleteMany({ where: { userId: ACTOR.userId } });
      await prisma.bot.deleteMany({ where: { userId: ACTOR.userId } });
    }

    /**
     * §4.1's own route sequence: install a private server, connect it, and
     * let the connect list its tools.
     *
     * Driven over HTTP rather than through the service, because "install →
     * connect → list" is the operator's path and the routes are where the
     * ownership fence and the admission checks live.
     */
    async function installAndConnect(): Promise<{
      id: string;
      slug: string;
      name: string;
      path: string;
    }> {
      seed += 1;
      const name = `Plugin ${RUN_ID} ${seed}`;
      // A path per server, so a case can take exactly one of them down while
      // the others keep answering.
      const path = `/mcp/${String(seed)}`;
      const installed = McpServerSummarySchema.parse(
        (
          await http()
            .post(api('/mcp/servers'))
            .set(ACTOR.headers)
            .send({ name, url: `https://${STUB_HOST}${path}`, transport: 'HTTP' })
            .expect(201)
        ).body,
      );
      expect(installed.status).toBe('DISCONNECTED');
      expect(installed.toolCount).toBe(0);

      // `authType: NONE` for a private install, so connect lists on the spot.
      await http()
        .post(api(`/mcp/servers/${installed.id}/connect`))
        .set(ACTOR.headers)
        .expect(200)
        .expect({ connected: true });

      const connected = McpServerSummarySchema.parse(
        (await http().get(api('/mcp/servers')).set(ACTOR.headers).expect(200)).body.find(
          (row: { id: string }) => row.id === installed.id,
        ),
      );
      expect(connected.status).toBe('CONNECTED');
      expect(connected.toolCount).toBe(2);
      return { id: installed.id, slug: installed.slug, name, path };
    }

    /** A bot carrying §6/M5's shipped default rules and nothing bespoke. */
    async function botWithDefaultRules(): Promise<string> {
      seed += 1;
      const bot = await bots.create(ACTOR.userId, {
        name: `mcp-turn-${RUN_ID}-${seed}`,
        role: 'Plugin Subject',
        avatarColor: '#22C55E',
        systemPrompt: 'use the plugin',
        // Written out rather than left to the create default, so the case
        // states which policy it is asserting under. D-064's list has no
        // catch-all, which is what lets the tool's own reach decide.
        autoReviewRules: [...DEFAULT_AUTO_REVIEW_RULES],
      });
      return bot.id;
    }

    async function enable(botId: string, ...serverIds: string[]): Promise<void> {
      await http()
        .put(api(`/bots/${botId}/plugins`))
        .set(ACTOR.headers)
        .send({ serverIds })
        .expect(200);
    }

    /**
     * Send a USER message the way the desktop does, and wait for the turn to
     * stop moving.
     *
     * The send is not awaited — its response streams for as long as the run
     * works — so every assertion below would otherwise race the work it is
     * about. What is waited on is the TURN ROW rather than a
     * `message.completed` frame: a completed reply is not a settled turn, and
     * an approval suspends without settling at all, which is why the probe
     * takes what it is waiting FOR rather than assuming SUCCEEDED.
     */
    async function runTurn(
      botId: string,
      settled: (turn: TurnRow) => boolean | Promise<boolean>,
    ): Promise<TurnRow> {
      // ⚠️ THE PREVIOUS TURN'S ROW IS THE TRAP. `orderBy: startedAt desc` finds
      // it the instant this posts, and it is already SUCCEEDED — so a second
      // call would return before the second turn had started, and a case that
      // runs three turns would measure one. The ids are counted first, and the
      // wait is for a turn that is not one of them.
      const before = new Set(
        (await prisma.agentTurn.findMany({ where: { botId }, select: { id: true } })).map(
          (turn) => turn.id,
        ),
      );
      // Not awaited: the response streams for as long as the run works, and
      // a run that parks or hangs is what some cases are about. A request that
      // fails never started a turn, so its error is what a timeout reports.
      const threadId = await threadOf(prisma, botId);
      let requestError: unknown;
      inflight.push(
        http()
          .post(api(`/bots/${botId}/chat`))
          .set(ACTOR.headers)
          .send(chatBody(threadId, 'go'))
          .then(
            () => undefined,
            (error: unknown) => {
              requestError = error;
            },
          ),
      );

      const deadline = Date.now() + 20_000;
      for (;;) {
        const turn = await prisma.agentTurn.findFirst({
          where: { botId, id: { notIn: [...before] } },
          orderBy: { startedAt: 'desc' },
          select: { id: true, status: true },
        });
        if (turn !== null && (await settled(turn))) return turn;
        if (Date.now() > deadline) {
          const cause =
            requestError === undefined ? '' : `; the chat request failed: ${String(requestError)}`;
          throw new Error(`turn never settled; last status ${String(turn?.status)}${cause}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    const finished = (turn: TurnRow): boolean =>
      turn.status !== 'running' && turn.status !== 'interrupted';

    /** Every SYSTEM message in this bot's conversation, oldest first. */
    async function systemNotes(botId: string): Promise<string[]> {
      const rows = await prisma.message.findMany({
        where: { conversation: { botId }, author: 'SYSTEM' },
        orderBy: { createdAt: 'asc' },
        select: { content: true },
      });
      return rows.map((row) => row.content);
    }

    it('M6-QA-05 — install, connect, list, enable, call, and the result reaches the model', async () => {
      const server = await installAndConnect();
      const botId = await botWithDefaultRules();
      await enable(botId, server.id);

      model = callingPluginTool(`${server.slug}__list_invoices`, { since: '2026-01-01' });
      await runTurn(botId, finished);

      // 1. The tool was OFFERED — as part of the listing the bridge carries
      //    (D-113), under §6/M6's namespaced name.
      expect(offeredTools()).toContain(FIND_PLUGIN_TOOLS);
      expect(offeredTool('find_plugin_tools')?.description).toContain(
        `${server.slug}__list_invoices`,
      );

      // 2. The call reached the server under the server's OWN name — the round
      //    trip D-104 makes a closure rather than a parse — with the model's
      //    arguments intact.
      expect(stub.calls).toEqual([{ name: 'list_invoices', args: { since: '2026-01-01' } }]);

      // 3. The server's answer reached the MODEL, which is the half a stub
      //    that only counted calls could not state.
      expect(toolResults(model.doStreamCalls[AFTER_THE_CALL]?.prompt)).toContainEqual({
        type: 'text',
        value: 'called list_invoices',
      });
    }, 30_000);

    it('M6-QA-10 — a read-only tool runs without asking, under the default rules', async () => {
      const server = await installAndConnect();
      const botId = await botWithDefaultRules();
      await enable(botId, server.id);

      model = callingPluginTool(`${server.slug}__list_invoices`, {});
      const turn = await runTurn(botId, finished);

      // It ran: the server saw the call, and the turn went on to answer
      // rather than suspending on a question nobody answered.
      expect(stub.calls.map((call) => call.name)).toEqual(['list_invoices']);
      expect(model.doStreamCalls).toHaveLength(3);
      expect(turn.status).toBe('completed');
    }, 30_000);

    it('M6-QA-10 — a write-classified tool blocks for approval instead', async () => {
      const server = await installAndConnect();
      const botId = await botWithDefaultRules();
      await enable(botId, server.id);

      model = callingPluginTool(`${server.slug}__send_invoice`, { id: 'inv-1' });
      // Waiting for the APPROVAL rather than for the turn to finish: a
      // suspended turn never finishes, so `finished` would time out here and
      // report a hang where the product did exactly the right thing. Both
      // halves of it, because they are written separately: the pending entry
      // is registered in memory a moment before the row reaches
      // AWAITING_APPROVAL, and a read in that gap saw RUNNING (CI, #363).
      const turn = await runTurn(
        botId,
        async (row) =>
          row.status === 'interrupted' &&
          (await turns.listPendingApprovals(ACTOR.userId, botId)).length > 0,
      );

      // The server never saw it. That is what "blocks" means here, and it is
      // asserted against the presence in the case above: the same server, the
      // same bot, the same rules — one tool ran, and this one did not.
      expect(stub.calls).toEqual([]);
      // Suspended rather than settled: the turn is parked on a person.
      expect(turn.status).toBe('interrupted');
      // And the prompt names the PLUGIN TOOL, not the door it came through.
      // The model called `use_plugin_tool`; the operator is asked about
      // `...__send_invoice`, because that is what will run on their account if
      // they say yes (D-113). The classification that got it here is the same
      // unwrap — `readOnly: false` → `sensitive` → ask — so this assertion is
      // the other half of the read-only case above.
      expect(
        (await turns.listPendingApprovals(ACTOR.userId, botId)).map((entry) => entry.toolName),
      ).toEqual([`${server.slug}__send_invoice`]);
    }, 30_000);

    describe('M6-BE-10 — one broken plugin never fails a turn', () => {
      it('M6-QA-09 — three servers, one 500s, and the turn still completes', async () => {
        // §6/M6's acceptance line: "With one plugin's server returning 500 for
        // every request, a turn using two other plugins still completes."
        const first = await installAndConnect();
        const down = await installAndConnect();
        const third = await installAndConnect();
        const botId = await botWithDefaultRules();
        await enable(botId, first.id, down.id, third.id);
        // It connected, and THEN it went down. A server that 500s from the
        // start could never have been connected, so that ordering is the only
        // one the criterion can be describing.
        downedPaths.add(down.path);

        model = callingPluginTool(`${down.slug}__list_invoices`, {});
        const turn = await runTurn(botId, finished);

        // The turn answered. That is the whole claim.
        expect(turn.status).toBe('completed');
        // All three servers' tools were advertised — the failure is at call
        // time, not at resolution time, so nothing was withheld.
        const offered = offeredListing();
        for (const server of [first, down, third]) {
          expect(offered).toContain(`${server.slug}__list_invoices`);
        }
        // The model was handed the failure as a RESULT it can act on, not an
        // exception that ended the turn.
        const results = toolResults(model.doStreamCalls[AFTER_THE_CALL]?.prompt);
        expect(JSON.stringify(results)).toContain('could not be called');
        // Nothing was said in the transcript yet: the server is still
        // CONNECTED, so it was not dropped from anything.
        expect(await systemNotes(botId)).toEqual([]);
      }, 40_000);

      it('moves a server to ERROR after three consecutive failures, and says so once', async () => {
        const healthy = await installAndConnect();
        const down = await installAndConnect();
        const botId = await botWithDefaultRules();
        await enable(botId, healthy.id, down.id);
        downedPaths.add(down.path);

        const events = app.get(TurnEventBus);
        const statuses = vi.spyOn(events, 'emitMcpStatus');

        // Two failures are weather; the server is still offered.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          model = callingPluginTool(`${down.slug}__list_invoices`, {});
          await runTurn(botId, finished);
        }
        expect((await prisma.mcpServer.findUniqueOrThrow({ where: { id: down.id } })).status).toBe(
          'CONNECTED',
        );
        expect(statuses).not.toHaveBeenCalled();

        // The third is the one §6/M6 names.
        model = callingPluginTool(`${down.slug}__list_invoices`, {});
        await runTurn(botId, finished);

        const row = await prisma.mcpServer.findUniqueOrThrow({ where: { id: down.id } });
        expect(row.status).toBe('ERROR');
        expect(statuses).toHaveBeenCalledTimes(1);
        expect(statuses.mock.calls[0]?.[2]).toBe('ERROR');
        statuses.mockRestore();
      }, 60_000);

      it('drops the ERROR server from the next turn, with exactly one system note', async () => {
        const healthy = await installAndConnect();
        const down = await installAndConnect();
        const alsoDown = await installAndConnect();
        const botId = await botWithDefaultRules();
        await enable(botId, healthy.id, down.id, alsoDown.id);
        // Written directly rather than earned through three failures: what
        // this case is about is what a turn does with an ERROR server, and
        // the transition itself is the case above.
        await prisma.mcpServer.updateMany({
          where: { id: { in: [down.id, alsoDown.id] } },
          data: { status: 'ERROR', lastError: 'stopped answering' },
        });

        model = callingPluginTool(`${healthy.slug}__list_invoices`, {});
        const turn = await runTurn(botId, finished);

        expect(turn.status).toBe('completed');
        // The healthy one is still there — the presence this refusal is
        // asserted against, so "nothing was advertised" cannot pass for
        // "the broken ones were dropped".
        const offered = offeredListing();
        expect(offered).toContain(`${healthy.slug}__list_invoices`);
        expect(offered).not.toContain(`${down.slug}__list_invoices`);
        expect(offered).not.toContain(`${alsoDown.slug}__list_invoices`);

        // EXACTLY one note, for two dropped servers, naming both.
        const notes = await systemNotes(botId);
        expect(notes).toHaveLength(1);
        expect(notes[0]).toContain(down.name);
        expect(notes[0]).toContain(alsoDown.name);
        expect(notes[0]).toContain('stopped responding');
      }, 40_000);

      it('bounds a call that never answers, rather than holding the turn open', async () => {
        // §7.4's 30 s. Exercised at 150 ms so the suite does not spend half a
        // minute proving a number — the DEADLINE is what is under test, not
        // its value, and the value is pinned where it is published
        // (`mcp-namespace.test.ts` asserts the descriptor carries 30 s).
        const server = await installAndConnect();
        hangingPaths.add(server.path);

        await expect(
          servers.callTool(ACTOR.userId, server.id, 'list_invoices', {}, 150),
        ).rejects.toThrow(/did not answer within/);
      }, 30_000);

      it('cancels in-flight requests without counting operator cancellation as a server failure', async () => {
        const server = await installAndConnect();
        hangingCallPaths.add(server.path);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const controller = new AbortController();
          const arrived = new Promise<void>((resolve) => {
            nextHangingCall = resolve;
          });
          const request = servers.callTool(
            ACTOR.userId,
            server.id,
            'list_invoices',
            {},
            5000,
            controller.signal,
          );
          await arrived; // The initialized client has dispatched tools/call.
          const rejected = expect(request).rejects.toThrow('operator cancelled');
          controller.abort(new Error('operator cancelled'));
          await rejected;
        }
        expect(
          (await prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id } })).status,
        ).toBe('CONNECTED');
        expect(cancelledRemoteCalls).toBe(3);
        hangingCallPaths.delete(server.path);
        await expect(
          servers.callTool(ACTOR.userId, server.id, 'list_invoices', {}, 5000),
        ).resolves.toBeDefined();
      }, 30000);

      it('refuses a server that asks for input mid-call, without a strike (D-194)', async () => {
        const server = await installAndConnect();
        stub.results.set('list_invoices', {
          resultType: 'input_required',
          inputRequests: {
            approve: {
              method: 'elicitation/create',
              params: { mode: 'form', message: 'Confirm?', requestedSchema: { type: 'object' } },
            },
          },
        });
        try {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const result = await servers.callTool(
              ACTOR.userId,
              server.id,
              'list_invoices',
              {},
              5_000,
            );
            expect(result.isError).toBe(true);
            expect(JSON.stringify(result.content)).toContain('PLUGIN_INPUT_UNSUPPORTED');
          }
        } finally {
          stub.results.delete('list_invoices');
        }
        expect(
          (await prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id } })).status,
        ).toBe('CONNECTED');
      }, 30_000);

      it('a timed-out call is a strike, and a working one forgives the earlier ones', async () => {
        // "Three CONSECUTIVE failures" — the word is load-bearing, and the
        // counter is the only place it can be wrong. Two failures, one
        // success, two more failures must not add up to ERROR.
        const server = await installAndConnect();
        hangingPaths.add(server.path);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await expect(
            servers.callTool(ACTOR.userId, server.id, 'list_invoices', {}, 150),
          ).rejects.toThrow();
        }

        hangingPaths.delete(server.path);
        await expect(
          servers.callTool(ACTOR.userId, server.id, 'list_invoices', {}, 5_000),
        ).resolves.toBeDefined();

        hangingPaths.add(server.path);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await expect(
            servers.callTool(ACTOR.userId, server.id, 'list_invoices', {}, 150),
          ).rejects.toThrow();
        }

        expect(
          (await prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id } })).status,
        ).toBe('CONNECTED');
      }, 30_000);
    });

    it('starts no computer to run a plugin tool (R10)', async () => {
      // An MCP tool lives in the orchestrator, so a turn that only calls one
      // must wake nothing. The row is the evidence: this bot has no machine
      // before the turn and must have none after it.
      const server = await installAndConnect();
      const botId = await botWithDefaultRules();
      await enable(botId, server.id);
      await prisma.bot.update({ where: { id: botId }, data: { sandboxId: null } });

      model = callingPluginTool(`${server.slug}__list_invoices`, {});
      await runTurn(botId, finished);

      const bot = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
      expect(bot.sandboxId).toBeNull();
      expect(stub.calls.map((call) => call.name)).toEqual(['list_invoices']);
    }, 30_000);
  },
);
