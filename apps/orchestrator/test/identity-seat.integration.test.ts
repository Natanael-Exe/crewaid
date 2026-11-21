import { PLAYWRIGHT_CONNECT, type PlaywrightConnect } from '../src/agent/agent-browser.service.js';
import { fakePlaywrightBrowser } from './playwright-fakes.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { FakeProvider } from './sandbox-fakes.js';
import 'reflect-metadata';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  MockLanguageModelV4,
  scriptModel,
  simulateReadableStream,
} from './model-resolution-fake.js';
import type { ScriptPart as LanguageModelV4StreamPart } from './model-resolution-fake.js';
import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { BotsService } from '../src/bots/bots.service.js';
import { SeatService } from '../src/sandbox/seat.service.js';
import { IdentityService } from '../src/sandbox/identity.service.js';
import { StructuredLogger } from '../src/logging/structured-logger.js';
import { SeatControlService } from '../src/screen/seat-control.service.js';
import { answerChat, pendingApproval, sendChat } from './chat-fixture.js';
import { signIn } from './auth-fixture.js';

/**
 * M5-BE-27 — a bot moves onto a shared browser identity, once someone says so.
 *
 * ── WHY THIS RUNS THE REAL SEAT SERVICE ─────────────────────────────────────
 *
 * Every other full-application suite stubs `SeatService`, and they are right
 * to: their subject is upstream of it. Here the seat IS the subject. The whole
 * feature is one field on one request into the machine — `profile` — and the
 * two ways it can be wrong are both invisible from above:
 *
 *   - sent when it should not be, which silently moves a bot with no grant
 *     onto a shared cookie jar and still produces a working seat;
 *   - not sent when it should be, which looks exactly like a grant that
 *     worked until someone notices the bot is signed out.
 *
 * So the machine here is a real HTTP server speaking the bridge's seat routes,
 * and `SeatService` and `IdentityService` are the real ones against a real
 * PostgreSQL. What is faked is the container: a bridge that records requests,
 * and a Chrome that answers enough CDP for `browser_navigate` to land.
 *
 * ── THE ORDER IS THE CLAIM ──────────────────────────────────────────────────
 *
 * A seat's profile is fixed when the window opens, so "switch identity" is
 * necessarily three things in one order: write the grant, close the window the
 * bot is holding, forget the page this turn had open on it. The turn below
 * navigates BEFORE it switches, precisely so there is a window to close and a
 * page to forget — a test that switched first would pass with the release and
 * the reset both deleted.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
/** Whoever this suite signs in as — its rows are owned by that user. */
let USER_ID: string;
let TOKEN: string;

const IDENTITY = 'company-google';
const FIRST_URL = 'https://example.com/before';
const SECOND_URL = 'https://example.com/after';
const CDP_SESSION = 'cdp-session-under-test';
const PAGE_TARGET = 'page-target-under-test';

/** One request the machine received, reduced to what a claim here is about. */
interface BridgeCall {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | undefined;
}

interface FakeBridge {
  readonly port: number;
  readonly calls: BridgeCall[];
  /** Every `POST /seats`, in order, as the orchestrator sent it. */
  creates(): Array<Record<string, unknown>>;
  /** Seat ids the orchestrator asked the machine to close, in order. */
  closed(): string[];
  /** Forget every seat and every request, so a case reads only its own run. */
  clear(): void;
  failClose(value: boolean): void;
  close(): Promise<void>;
}

/**
 * The agent-bridge's seat routes, with the machine's own bookkeeping.
 *
 * It keeps seats the way the real registry does — one per bot, idempotent on
 * the label, and the profile fixed at creation — because the orchestrator's
 * behaviour depends on those answers: a bridge that handed back a seat after
 * a close would hide a missing release, and one that forgot the profile would
 * make the second create indistinguishable from the first.
 */
async function fakeBridge(): Promise<FakeBridge> {
  const calls: BridgeCall[] = [];
  const seats = new Map<
    string,
    {
      seatId: string;
      botId: string;
      profile: string;
      identityRevision: number;
      browserReady: boolean;
    }
  >();
  let next = 1;
  let failClose = false;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const body = raw === '' ? undefined : (JSON.parse(raw) as Record<string, unknown>);
      const url = new URL(req.url ?? '/', 'http://machine');
      calls.push({ method: req.method ?? 'GET', path: url.pathname + url.search, body });
      const answer = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      // D-060: a seat is a display with its own browser, so what the machine
      // reports is the display and the two ports that reach it.
      const describe = (seat: {
        seatId: string;
        botId: string;
        profile: string;
        identityRevision: number;
        browserReady: boolean;
      }) => ({
        ...seat,
        browserGeneration: next,
        display: ':10',
        rfbPort: 5901,
        cdpPort: 9301,
        width: 1280,
        height: 800,
      });

      if (req.method === 'GET' && url.pathname === '/seats') {
        const botId = url.searchParams.get('botId') ?? '';
        const seat = seats.get(botId);
        if (seat === undefined) {
          answer(404, { ok: false, code: 'NO_SUCH_SEAT' });
          return;
        }
        answer(200, { ok: true, seat: describe(seat) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/seats/browser') {
        const seat = seats.get(String(body?.['botId'] ?? ''));
        if (seat !== undefined) seat.browserReady = true;
        answer(
          seat ? 200 : 503,
          seat
            ? { ok: true, seat: { ...describe(seat), browserReady: true } }
            : { ok: false, code: 'SEAT_UNAVAILABLE' },
        );
        return;
      }
      if (req.method === 'POST' && url.pathname === '/seats') {
        const botId = String(body?.['botId'] ?? '');
        // The machine's own default (D-056): no profile named means the bot's
        // own. Modelled rather than asserted away, so a request that stops
        // sending the field produces a seat on the WRONG profile here too.
        const profile = typeof body?.['profile'] === 'string' ? body['profile'] : botId;
        const existing = seats.get(botId);
        if (existing !== undefined) {
          if (existing.profile !== profile) {
            answer(503, { ok: false, code: 'SEAT_UNAVAILABLE', detail: 'wrong profile' });
            return;
          }
          answer(200, { ok: true, seat: describe(existing) });
          return;
        }
        const holder = [...seats.values()].find((seat) => seat.profile === profile);
        if (holder !== undefined) {
          answer(503, {
            ok: false,
            code: 'SEAT_UNAVAILABLE',
            holderBotId: holder.botId,
            detail: 'IDENTITY_IN_USE',
          });
          return;
        }
        const seat = {
          seatId: `seat-${next++}`,
          botId,
          profile,
          identityRevision: Number(body?.['identityRevision'] ?? 0),
          browserReady: false,
        };
        seats.set(botId, seat);
        answer(200, { ok: true, seat: describe(seat) });
        return;
      }
      if (req.method === 'POST' && url.pathname.endsWith('/close')) {
        if (failClose) {
          answer(503, { ok: false, code: 'SEAT_CLOSE_FAILED' });
          return;
        }
        const seatId = url.pathname.split('/')[2] ?? '';
        for (const [botId, seat] of seats) {
          if (seat.seatId === seatId) seats.delete(botId);
        }
        answer(200, { ok: true });
        return;
      }
      answer(404, { ok: false });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: (server.address() as AddressInfo).port,
    calls,
    creates: () =>
      calls
        .filter((call) => call.method === 'POST' && call.path === '/seats')
        .map((call) => call.body ?? {}),
    closed: () =>
      calls
        .filter((call) => call.method === 'POST' && call.path.endsWith('/close'))
        .map((call) => call.path.split('/')[2] ?? ''),
    failClose: (value) => {
      failClose = value;
    },
    clear: () => {
      failClose = false;
      calls.length = 0;
      // The seats and the counter go with the log. A case asserts on the
      // machine's answers as well as its requests, and a leftover seat from
      // the previous case is a bot that already has a window it never opened.
      seats.clear();
      next = 1;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface FakeChrome {
  readonly connect: PlaywrightConnect;
  readonly url: string;
  /** How many times a client attached to a target — one per CDP connection. */
  attaches(): number;
  navigations(): string[];
  clear(): void;
  close(): Promise<void>;
}

/** Discovery stays real HTTP; the native driver port records policy-authorized navigation. */
async function fakeChrome(): Promise<FakeChrome> {
  const navigations: string[] = [];
  let connections = 0;
  const server = createServer((req, res) => {
    if (req.url !== '/json/version') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/devtools/browser/fixture`,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    connect: async () => {
      connections += 1;
      return fakePlaywrightBrowser((url) => navigations.push(url));
    },
    attaches: () => connections,
    navigations: () => [...navigations],
    clear: () => {
      navigations.length = 0;
      connections = 0;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Every step the model takes, in order, once per `stream()` call. */
type Script = Array<
  { kind: 'tool'; id: string; name: string; input: unknown } | { kind: 'text'; text: string }
>;

/** What the model was handed back, so a tool's own words can be asserted on. */
type ModelCalls = Array<{ prompt: unknown }>;

function scriptedModel(script: Script, calls: ModelCalls): MockLanguageModelV4 {
  const usage = { inputTokens: { total: 3 }, outputTokens: { total: 2 } };
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'mock-identity-model',
    doStream: async (options: { prompt?: unknown }) => {
      const step = script[calls.length];
      calls.push({ prompt: options.prompt });
      if (step === undefined) throw new Error(`the model was called ${calls.length} times`);
      const chunks: LanguageModelV4StreamPart[] =
        step.kind === 'tool'
          ? [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: step.id,
                toolName: step.name,
                input: JSON.stringify(step.input),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage,
              },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: step.text },
              { type: 'text-end', id: 't' },
              { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
            ];
      return {
        stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }),
      };
    },
  });
}

/** Every tool result the model has been handed, flattened. */
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

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M5-BE-27 a granted identity moves the bot to a shared profile',
  () => {
    let app: INestApplication;
    let port: number;
    let prisma: PrismaService;
    let bots: BotsService;
    let provider: FakeProvider;
    let bridge: FakeBridge;
    let chrome: FakeChrome;
    let calls: ModelCalls;
    let model: MockLanguageModelV4;
    const createdBotIds: string[] = [];
    const privateComputerIds: string[] = [];

    beforeAll(async () => {
      bridge = await fakeBridge();
      chrome = await fakeChrome();
      provider = new FakeProvider();
      provider.cdpUrl = chrome.url;
      provider.bridgePort = bridge.port;
      calls = [];
      model = scriptedModel([{ kind: 'text', text: 'unused' }], calls);
      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module.js');
      const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PLAYWRIGHT_CONNECT)
        .useValue(chrome.connect)
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(provider)
        .compile();

      app = moduleRef.createNestApplication();
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      await app.listen(0);
      port = (app.getHttpServer().address() as { port: number }).port;
      scriptModel(app, () => model);

      prisma = app.get(PrismaService);
      // V1-08: a real session for a real user, in place of the static
      // ORCH_API_TOKEN every request used to carry.
      // V1-09: the socket resolves this connection's own session, so the
      // suite no longer has to borrow the singleton to be approved.
      ({ token: TOKEN, userId: USER_ID } = await signIn(prisma));
      bots = app.get(BotsService);
      await prisma.user.upsert({
        where: { id: USER_ID },
        create: { id: USER_ID, name: 'Test User', email: `${USER_ID}@test.invalid` },
        update: {},
      });
    });

    afterAll(async () => {
      for (const id of createdBotIds) {
        await prisma?.bot.delete({ where: { id } }).catch(() => null);
      }
      for (const id of privateComputerIds) {
        await prisma?.sandbox.delete({ where: { id } }).catch(() => null);
      }
      await app?.close();
      await bridge?.close();
      await chrome?.close();
    });

    beforeEach(() => {
      bridge.clear();
      chrome.clear();
      provider.reset();
      provider.cdpUrl = chrome.url;
      provider.bridgePort = bridge.port;
    });

    /**
     * A machine this suite owns, for the reason M5-QA-05 documents at length:
     * `attachToComputer` hands a bot the OLDEST `Sandbox` row for the user, and
     * on a shared test database that row belongs to whichever suite created the
     * first one — a container this process's provider has never heard of. Here
     * it would produce a bridge call to a port nothing is listening on, which
     * reads as a broken identity switch rather than as borrowed leftovers.
     */
    async function privateComputer(botId: string): Promise<void> {
      const computer = await prisma.sandbox.create({
        data: { userId: USER_ID },
        select: { id: true },
      });
      privateComputerIds.push(computer.id);
      await prisma.bot.update({ where: { id: botId }, data: { sandboxId: computer.id } });
      await provider.provisionWorkspace({ botId: computer.id });
      return;
    }

    /**
     * A bot that may browse freely and must ask before it shares a login.
     *
     * The two rules are the point of the fixture: with `browser_navigate` on
     * `allow`, the only approval this turn raises is the identity one, so the
     * frame asserted below cannot be some other tool's.
     */
    async function freshBot(label: string, sandboxId?: string): Promise<string> {
      const bot = await bots.create(USER_ID, {
        name: `m5be27-${label}-${randomUUID().slice(0, 8)}`,
        role: 'Identity Subject',
        avatarColor: '#A855F7',
        systemPrompt: 'share a login when asked',
        autoReviewRules: [
          { toolPattern: 'browser_navigate', decision: 'allow' },
          { toolPattern: 'use_identity', decision: 'ask' },
        ],
      });
      createdBotIds.push(bot.id);
      // Identity policy is the subject; start with an observed private seat.
      app.get(SeatControlService).seats.observed(bot.id);
      if (sandboxId === undefined) await privateComputer(bot.id);
      else await prisma.bot.update({ where: { id: bot.id }, data: { sandboxId } });
      return bot.id;
    }

    /** A person's message; resolves once the run has parked or finished. */
    async function send(botId: string, content: string): Promise<void> {
      const { response } = await sendChat(app.getHttpServer(), {
        prisma,
        headers: { Authorization: `Bearer ${TOKEN}` },
        botId,
        content,
      });
      expect(response.status).toBe(200);
    }

    /** The question the parked run is waiting on. */
    async function asked(botId: string) {
      const pending = await pendingApproval(prisma, botId);
      if (pending === null) throw new Error('the run is not waiting on an approval');
      return pending.request;
    }

    /** The operator's answer; resolves once the continuation has run. */
    async function answer(
      botId: string,
      reply: { readonly approved: boolean; readonly reason?: string },
    ): Promise<void> {
      const { response } = await answerChat(app.getHttpServer(), {
        prisma,
        headers: { Authorization: `Bearer ${TOKEN}` },
        botId,
        answer: reply,
      });
      expect(response.status).toBe(200);
    }

    /** The turn that browses, switches identity, then browses again. */
    function switchingScript(): Script {
      return [
        { kind: 'tool', id: 'nav-before', name: 'browser_navigate', input: { url: FIRST_URL } },
        { kind: 'tool', id: 'switch', name: 'use_identity', input: { identity: IDENTITY } },
        { kind: 'tool', id: 'observe-after', name: 'browser_read', input: {} },
        { kind: 'tool', id: 'nav-after', name: 'browser_navigate', input: { url: SECOND_URL } },
        { kind: 'text', text: 'done.' },
      ];
    }

    it('reselects an older grant independently of grant timestamps', async () => {
      const botId = await freshBot('reselect');
      const identities = app.get(IdentityService);
      await identities.grant(USER_ID, botId, 'login-a');
      await identities.grant(USER_ID, botId, 'login-b');
      await prisma.botIdentity.updateMany({ where: { botId }, data: { grantedAt: new Date(0) } });
      expect((await identities.grant(USER_ID, botId, 'login-a')).alreadyGranted).toBe(true);
      expect(await identities.selectionFor(botId)).toEqual({ profile: 'login-a', revision: 3 });
      expect(await prisma.botIdentity.count({ where: { botId } })).toBe(2);
    });

    it('serializes simultaneous grants to one named identity on one owned computer', async () => {
      const first = await freshBot('concurrent-first');
      const bot = await prisma.bot.findUniqueOrThrow({ where: { id: first } });
      const second = await freshBot('concurrent-second', bot.sandboxId!);
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          app.get(IdentityService).grant(USER_ID, index % 2 ? first : second, 'one-login'),
        ),
      );
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(
        await prisma.identity.count({ where: { sandboxId: bot.sandboxId!, name: 'one-login' } }),
      ).toBe(1);
      expect((await app.get(IdentityService).selectionFor(first)).revision).toBe(4);
      expect((await app.get(IdentityService).selectionFor(second)).revision).toBe(4);
    });

    it('names only an owned computer peer when the bridge reports login contention', async () => {
      const first = await freshBot('named-holder');
      const bot = await prisma.bot.findUniqueOrThrow({ where: { id: first } });
      const second = await freshBot('named-waiter', bot.sandboxId!);
      const otherComputer = await freshBot('different-computer');
      const identities = app.get(IdentityService);
      await identities.grant(USER_ID, first, 'shared-company');
      await identities.grant(USER_ID, second, 'shared-company');
      await provider.createSession({ sessionId: bot.sandboxId! });
      const seats = app.get(SeatService);
      const geometry = { widthPx: 1280, heightPx: 800 };
      await seats.ensureSeat(bot.sandboxId!, first, geometry);
      await expect(seats.ensureSeat(bot.sandboxId!, second, geometry)).rejects.toThrow(bot.name);
      await expect(seats.ensureSeat(bot.sandboxId!, second, geometry)).rejects.toThrow(
        'Release shared login',
      );
      expect(await identities.holderNameFor(second, otherComputer)).toBeNull();
      const foreign = await signIn(prisma);
      const foreignBot = await bots.create(foreign.userId, {
        name: 'foreign holder',
        role: 'Fixture',
        avatarColor: '#A855F7',
        systemPrompt: '',
      });
      createdBotIds.push(foreignBot.id);
      // Even a poisoned attachment cannot turn the hint into an ownership oracle.
      await prisma.bot.update({
        where: { id: foreignBot.id },
        data: { sandboxId: bot.sandboxId! },
      });
      expect(await identities.holderNameFor(second, foreignBot.id)).toBeNull();
    });

    it('reconciles a grant committed before a crashed closer, and then a revoked grant', async () => {
      const botId = await freshBot('interrupted');
      const bot = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
      await provider.createSession({ sessionId: bot.sandboxId! });
      const geometry = { widthPx: 1280, heightPx: 800 };
      await app.get(SeatService).ensureSeat(bot.sandboxId!, botId, geometry);
      await app.get(IdentityService).grant(USER_ID, botId, 'recover-login');
      // A fresh service has no promise/cache from the process that selected the login.
      const restarted = new SeatService(
        provider,
        app.get(StructuredLogger),
        app.get(IdentityService),
        prisma,
        app.get(SeatControlService),
      );
      expect(await restarted.ensureSeat(bot.sandboxId!, botId, geometry)).toMatchObject({
        profile: 'recover-login',
        identityRevision: 1,
      });
      expect(bridge.closed()).toEqual(['seat-1']);
      await app.get(IdentityService).release(USER_ID, botId);
      expect(await restarted.ensureSeat(bot.sandboxId!, botId, geometry)).toMatchObject({
        profile: botId,
        identityRevision: 2,
        browserReady: false,
      });
      expect(await prisma.botIdentity.count({ where: { botId } })).toBe(0);
      expect(bridge.closed()).toEqual(['seat-1', 'seat-2']);
    });

    it('an operator release is owned, durable on close failure and safely retryable', async () => {
      const botId = await freshBot('release');
      const bot = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
      await provider.createSession({ sessionId: bot.sandboxId! });
      await prisma.sandbox.update({ where: { id: bot.sandboxId! }, data: { state: 'RUNNING' } });
      await app.get(IdentityService).grant(USER_ID, botId, 'release-login');
      await app
        .get(SeatService)
        .ensureSeat(bot.sandboxId!, botId, { widthPx: 1280, heightPx: 800 });
      const foreign = await signIn(prisma);
      await request(app.getHttpServer())
        .delete(`/api/v1/bots/${botId}/identity`)
        .set('Authorization', `Bearer ${foreign.token}`)
        .expect(404);
      expect(await app.get(IdentityService).profileFor(botId)).toBe('release-login');
      bridge.failClose(true);
      await request(app.getHttpServer())
        .delete(`/api/v1/bots/${botId}/identity`)
        .set('Authorization', `Bearer ${TOKEN}`)
        .expect(409);
      expect(await app.get(IdentityService).selectionFor(botId)).toEqual({
        profile: null,
        revision: 2,
      });
      expect(await app.get(SeatService).seatFor(bot.sandboxId!, botId)).toMatchObject({
        profile: 'release-login',
      });
      bridge.failClose(false);
      await request(app.getHttpServer())
        .delete(`/api/v1/bots/${botId}/identity`)
        .set('Authorization', `Bearer ${TOKEN}`)
        .expect(204);
      expect(await app.get(SeatService).seatFor(bot.sandboxId!, botId)).toBeNull();
      expect((await app.get(IdentityService).selectionFor(botId)).revision).toBe(2);
    });

    it('refuses profile changes while teaching and never wakes a stopped computer to release', async () => {
      const botId = await freshBot('teaching-release');
      await app.get(IdentityService).grant(USER_ID, botId, 'teaching-login');
      const recording = await prisma.recording.create({ data: { botId } });
      await expect(
        app.get(IdentityService).grant(USER_ID, botId, 'different-login'),
      ).rejects.toThrow('Stop teaching');
      await request(app.getHttpServer())
        .delete(`/api/v1/bots/${botId}/identity`)
        .set('Authorization', `Bearer ${TOKEN}`)
        .expect(409);
      expect(await app.get(IdentityService).profileFor(botId)).toBe('teaching-login');
      await prisma.recording.delete({ where: { id: recording.id } });
      await request(app.getHttpServer())
        .delete(`/api/v1/bots/${botId}/identity`)
        .set('Authorization', `Bearer ${TOKEN}`)
        .expect(204);
      expect(bridge.calls).toEqual([]);
    });

    it('asks first, and the prompt names the identity rather than just the tool', async () => {
      calls = [];
      model = scriptedModel(switchingScript(), calls);
      const botId = await freshBot('asks');
      await send(botId, 'use the company login');

      // An operator answering this sees the tool AND the identity: "use an
      // identity" with the name hidden is not a question anyone can judge.
      expect(await asked(botId)).toMatchObject({
        toolCallId: expect.any(String),
        binding: expect.objectContaining({ toolName: 'use_identity', scope: 'call' }),
        toolName: 'use_identity',
        args: { identity: IDENTITY },
      });

      // Nothing is granted by asking. The rows are the durable half of this
      // feature, so a prompt that had already written them would mean the
      // operator's answer changed nothing.
      const granted = await prisma.botIdentity.findMany({ where: { botId } });
      expect(granted).toEqual([]);
      const identity = await prisma.identity.findFirst({ where: { name: IDENTITY } });
      expect(identity).toBeNull();

      // The first navigate already happened, so the bot HAS a seat — and it is
      // on its own profile, because nothing has been granted.
      expect(bridge.creates()).toHaveLength(1);
      expect(bridge.creates()[0]).not.toHaveProperty('profile');
      expect(bridge.closed()).toEqual([]);
    }, 25_000);

    it('on approve: the seat is reopened on the identity, and the grant outlives the turn', async () => {
      calls = [];
      model = scriptedModel(switchingScript(), calls);
      const botId = await freshBot('approve');
      await send(botId, 'use the company login');
      await answer(botId, { approved: true });

      // Two windows, in this order: the bot's own, then the identity's. The
      // close between them is what makes the second one possible at all — a
      // seat's profile is fixed at creation, so without the release the
      // machine hands back the seat the bot already has.
      const creates = bridge.creates();
      expect(creates).toHaveLength(2);
      expect(creates[0]).not.toHaveProperty('profile');
      expect(creates[1]).toMatchObject({ botId, profile: IDENTITY });
      expect(bridge.closed()).toEqual(['seat-1']);

      // And the turn's own page followed it. Without the reset the memoized
      // page stays attached to the target the machine just closed, and the
      // second navigate would go to the window that is gone.
      expect(chrome.navigations()).toEqual([FIRST_URL, SECOND_URL]);
      expect(chrome.attaches()).toBe(2);

      // The durable half: one identity on this bot's machine, one grant.
      const computer = await prisma.sandbox.findFirstOrThrow({
        where: { bots: { some: { id: botId } } },
        select: { id: true },
      });
      const identity = await prisma.identity.findUniqueOrThrow({
        where: { sandboxId_name: { sandboxId: computer.id, name: IDENTITY } },
      });
      const grants = await prisma.botIdentity.findMany({ where: { botId } });
      expect(grants.map((grant) => grant.identityId)).toEqual([identity.id]);

      // The model was told what happened in terms it can act on — that the
      // profile is new and therefore signed out, which is the one thing it
      // would otherwise discover as an unexplained logged-out page.
      const told = JSON.stringify(toolResults(calls[2]?.prompt));
      expect(told).toContain(IDENTITY);
      expect(told).toContain('starts signed out');
    }, 25_000);

    it('on deny: no grant, no close, and the bot keeps the window it had', async () => {
      calls = [];
      model = scriptedModel(switchingScript(), calls);
      const botId = await freshBot('deny');
      await send(botId, 'use the company login');
      await answer(botId, { approved: false, reason: 'not that account' });

      expect(await prisma.botIdentity.findMany({ where: { botId } })).toEqual([]);
      expect(bridge.closed()).toEqual([]);
      // One seat, on the bot's own profile, still serving the second navigate:
      // a refused switch must not cost the bot the window it was using.
      expect(bridge.creates()).toHaveLength(1);
      expect(chrome.navigations()).toEqual([FIRST_URL, SECOND_URL]);
    }, 25_000);

    it('a second bot on the same machine joins the identity rather than making another', async () => {
      // The entire point of a shared identity: the second bot arrives at a
      // profile someone has already signed into. Two identities with one name
      // would be two empty cookie jars and a feature that does nothing.
      calls = [];
      model = scriptedModel(switchingScript(), calls);
      const first = await freshBot('join-first');
      const computer = await prisma.sandbox.findFirstOrThrow({
        where: { bots: { some: { id: first } } },
        select: { id: true },
      });
      await send(first, 'use the company login');
      await answer(first, { approved: true });

      calls = [];
      model = scriptedModel(switchingScript(), calls);
      await app
        .get((await import('../src/sandbox/seat.service.js')).SeatService)
        .releaseSeatForBot(first);
      const second = await freshBot('join-second', computer.id);
      await send(second, 'use the company login');
      await answer(second, { approved: true });

      const identities = await prisma.identity.findMany({
        where: { sandboxId: computer.id, name: IDENTITY },
      });
      expect(identities).toHaveLength(1);
      const grants = await prisma.botIdentity.findMany({
        where: { identityId: identities[0]?.id },
        select: { botId: true },
      });
      expect(grants.map((grant) => grant.botId).sort()).toEqual([first, second].sort());

      // Sequential holders reuse one directory. Permissions may coexist; Chrome holders cannot.
      const onIdentity = bridge.creates().filter((body) => body['profile'] === IDENTITY);
      expect(onIdentity.map((body) => body['botId']).sort()).toEqual([first, second].sort());

      // The second bot is told it joined rather than created, because "this is
      // new and signed out" and "this may already be signed in" lead it to
      // different next steps.
      const told = JSON.stringify(toolResults(calls[2]?.prompt));
      expect(told).toContain('already exists on this computer');
      expect(told).not.toContain('starts signed out');
    }, 40_000);

    it('refuses a name that is a bot’s own profile, as a result the model can act on', async () => {
      // D-056 makes every bot id a profile directory. Granting one as an
      // identity would turn that bot's private browser state into shared
      // state, silently and permanently — the one thing this feature must
      // never be able to express.
      const victim = await freshBot('victim');
      calls = [];
      model = scriptedModel(
        [
          { kind: 'tool', id: 'switch', name: 'use_identity', input: { identity: victim } },
          { kind: 'text', text: 'understood.' },
        ],
        calls,
      );
      const botId = await freshBot('thief');
      await send(botId, 'use that other bot’s login');
      await answer(botId, { approved: true });

      // Approved by the operator and still refused: an operator answering a
      // prompt is agreeing to share a login, not auditing whether the name
      // happens to be another bot's directory.
      expect(await prisma.botIdentity.findMany({ where: { botId } })).toEqual([]);
      expect(await prisma.identity.findFirst({ where: { name: victim } })).toBeNull();

      // A sentence, not an exception: the turn settles and the model is told
      // why, so its next step is a different name rather than a failed turn.
      // The run that asked parked; the one that carried the answer finished.
      const last = await prisma.agentTurn.findFirstOrThrow({
        where: { botId },
        orderBy: { startedAt: 'desc' },
        select: { status: true },
      });
      expect(last.status).toBe('completed');
      const told = JSON.stringify(toolResults(calls[1]?.prompt));
      expect(told).toContain('not a shared identity');
    }, 25_000);
  },
);
