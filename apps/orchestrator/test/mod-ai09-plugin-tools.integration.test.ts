import { ComposioService } from '../src/integrations/composio/composio.service.js';
import { FakeComposio } from './composio-fixture.js';
/**
 * D-194: plugin tools on a TanStack run — loaded, called directly, approved on
 * a resume, refused when not loaded or revoked, and bounded by D-113's budget.
 *
 * The real application and the real send route (`POST /bots/:id/chat`), a real
 * MCP server on loopback, and a model that follows a script and records the
 * tools each call was sent.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { EventType, type StreamChunk, type TextOptions, type Tool } from '@tanstack/ai';
import { BaseTextAdapter } from '@tanstack/ai/adapters';
import { FIND_PLUGIN_TOOLS, PLUGIN_LISTING_TOKEN_BUDGET } from '@crewaid/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ModelResolutionService } from '../src/models/model-resolution.service.js';
import { McpServersService } from '../src/mcp/mcp-servers.service.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import { startStubMcpServer, stubFetchTo, type StubMcpServer } from './mcp-stub.js';
import { FakeProvider } from './sandbox-fakes.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const STUB_HOST = 'plugins.mod-ai09.test';

type Step =
  { readonly call: string; readonly args: Record<string, unknown> } | { readonly text: string };
type Sent = {
  readonly tools: readonly string[];
  readonly descriptions: ReadonlyMap<string, string>;
};

/** A model that follows a script, one step per call, and records what it was sent. */
class PlanAdapter extends BaseTextAdapter<'plan', Record<string, never>, readonly ['text'], never> {
  readonly name = 'plan';
  readonly sent: Sent[] = [];
  plan: Step[] = [];

  constructor() {
    super({}, 'plan');
  }

  async *chatStream(options: TextOptions<Record<string, never>>): AsyncIterable<StreamChunk> {
    const tools: readonly Tool[] = options.tools ?? [];
    this.sent.push({
      tools: tools.map((tool) => tool.name),
      descriptions: new Map(tools.map((tool) => [tool.name, tool.description])),
    });
    const runId = options.runId ?? randomUUID();
    const threadId = options.threadId ?? randomUUID();
    const messageId = `asst-${randomUUID()}`;
    const now = Date.now();
    const step = this.plan.shift() ?? { text: 'done' };
    yield { type: EventType.RUN_STARTED, runId, threadId, timestamp: now } as StreamChunk;
    if ('text' in step) {
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: 'assistant',
        timestamp: now,
      } as StreamChunk;
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: step.text,
        timestamp: now,
      } as StreamChunk;
      yield { type: EventType.TEXT_MESSAGE_END, messageId, timestamp: now } as StreamChunk;
      yield {
        type: EventType.RUN_FINISHED,
        runId,
        threadId,
        finishReason: 'stop',
        usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 },
        timestamp: now,
      } as StreamChunk;
      return;
    }
    const toolCallId = `call-${randomUUID()}`;
    yield {
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: step.call,
      parentMessageId: messageId,
      index: 0,
      timestamp: now,
    } as StreamChunk;
    yield {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta: JSON.stringify(step.args),
      timestamp: now,
    } as StreamChunk;
    yield { type: EventType.TOOL_CALL_END, toolCallId, timestamp: now } as StreamChunk;
    yield {
      type: EventType.RUN_FINISHED,
      runId,
      threadId,
      finishReason: 'tool_calls',
      usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 },
      timestamp: now,
    } as StreamChunk;
  }

  structuredOutput(): Promise<never> {
    return Promise.reject(new Error('the plan adapter has no structured output'));
  }
}

const READ_TOOL = {
  name: 'list_invoices',
  description: 'List the invoices',
  inputSchema: { type: 'object', properties: { since: { type: 'string' } } },
  annotations: { readOnlyHint: true },
};
const WRITE_TOOL = {
  name: 'send_invoice',
  description: 'Send one invoice to a customer',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  annotations: { readOnlyHint: false },
};

const estimate = (text: string) => Math.ceil(text.length / 4);

describe.skipIf(!DATABASE_URL)(
  'MOD-AI-09 plugin tools on a TanStack run (real app, real db)',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let base = '';
    let owner: SignedInUser;
    let stub: StubMcpServer;
    const adapter = new PlanAdapter();
    let seed = 0;
    const composio = new FakeComposio();

    beforeAll(async () => {
      vi.stubEnv('COMPOSIO_API_KEY', 'test-key');
      vi.stubEnv('COMPOSIO_AUTH_CONFIG_GMAIL', 'ac-gmail');
      process.env['CREDENTIAL_KEY'] = '44'.repeat(32);
      stub = await startStubMcpServer();
      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module.js');
      const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(new FakeProvider())
        .overrideProvider(ModelResolutionService)
        .useValue({
          resolveText: () =>
            Promise.resolve({
              adapter,
              kind: 'custom',
              modelId: 'plan:test',
              connectionId: 'fixture',
              connectionName: 'Fixture',
              upstreamModelId: 'plan',
              label: 'Plan',
              contextWindow: 100000,
              capabilities: { tools: true, vision: false, reasoning: false },
            }),
        })
        .compile();
      app = moduleRef.createNestApplication();
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      await app.listen(0, '127.0.0.1');
      base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1`;
      prisma = app.get(PrismaService);
      app.get(ComposioService).setPortForTests(composio);
      const servers = app.get(McpServersService);
      servers.setAddressResolverForTests(() => Promise.resolve(['93.184.216.34']));
      servers.setMcpFetchForTests(stubFetchTo(stub, new Set([STUB_HOST])));
      owner = await signIn(prisma, { label: 'modai09' });
    }, 60_000);
    afterAll(async () => {
      await signOutAndDelete(prisma, owner.userId);
      await app.close();
      await stub.close();
      vi.unstubAllEnvs();
    });

    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${base}${path}`, {
        method,
        headers: { ...owner.headers, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    /** A connected plugin on a fresh TanStack bot, with writes asked about. */
    async function botWithPlugin(tools: Record<string, unknown>[] = [READ_TOOL, WRITE_TOOL]) {
      seed += 1;
      stub.tools = tools;
      const installed = (await (
        await call('POST', '/mcp/servers', {
          name: `Invoices ${String(seed)} ${randomUUID().slice(0, 6)}`,
          url: `https://${STUB_HOST}/mcp/${String(seed)}`,
          transport: 'HTTP',
        })
      ).json()) as { id: string; slug: string };
      expect((await call('POST', `/mcp/servers/${installed.id}/connect`)).status).toBe(200);
      const bot = await prisma.bot.create({
        data: {
          userId: owner.userId,
          name: `plugins-${randomUUID()}`,
          role: 'fixture',
          avatarColor: '#8B6F47',
          systemPrompt: '',
          approvalMode: 'ASK',
        },
      });
      const thread = await prisma.conversation.create({
        data: { botId: bot.id },
      });
      expect(
        (await call('PUT', `/bots/${bot.id}/plugins`, { serverIds: [installed.id] })).status,
      ).toBe(200);
      stub.clear();
      return { botId: bot.id, threadId: thread.id, serverId: installed.id, slug: installed.slug };
    }

    async function say(botId: string, threadId: string, content: string) {
      const runId = `run-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const response = await call('POST', `/bots/${botId}/chat`, {
        threadId,
        runId,
        messages: [{ id: `u-${randomUUID()}`, role: 'user', content }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      });
      expect(response.status).toBe(200);
      await response.text();
      return runId;
    }

    async function botWithComposio(mode: 'ASK' | 'AUTO' | 'FULL' = 'ASK', rules: unknown = []) {
      const existing = await prisma.mcpServer.findFirst({
        where: { userId: owner.userId, slug: 'gmail' },
      });
      if (existing) await app.get(McpServersService).remove(owner.userId, existing.id);
      const response = await call('POST', '/mcp/servers', { slug: 'gmail' });
      expect(response.status).toBe(201);
      const installed = (await response.json()) as { id: string };
      const connect = await call('POST', `/mcp/servers/${installed.id}/connect`);
      expect(connect.status).toBe(200);
      const pending = await prisma.composioConnection.findUniqueOrThrow({
        where: { serverId: installed.id },
      });
      composio.activate(pending.pendingAccountId!);
      const summaries = await call('GET', '/mcp/servers');
      expect(summaries.status).toBe(200);
      expect(await summaries.json()).toContainEqual(
        expect.objectContaining({
          id: installed.id,
          backend: 'COMPOSIO',
          status: 'CONNECTED',
          url: null,
          transport: null,
        }),
      );
      const bot = await prisma.bot.create({
        data: {
          userId: owner.userId,
          name: `composio-${randomUUID()}`,
          role: 'test',
          avatarColor: '#123456',
          systemPrompt: '',
          approvalMode: mode,
          autoReviewRules: rules as never,
        },
      });
      const thread = await prisma.conversation.create({ data: { botId: bot.id } });
      expect(
        (await call('PUT', `/bots/${bot.id}/plugins`, { serverIds: [installed.id] })).status,
      ).toBe(200);
      composio.execute.mockClear();
      adapter.sent.length = 0;
      return { botId: bot.id, threadId: thread.id, serverId: installed.id };
    }

    async function approveComposio(f: { botId: string; threadId: string }, parentRunId: string) {
      const proposal = await prisma.runInterrupt.findFirstOrThrow({
        where: { runId: parentRunId },
      });
      adapter.plan = [{ text: 'finished' }];
      const runId = `run-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const response = await call('POST', `/bots/${f.botId}/chat`, {
        threadId: f.threadId,
        runId,
        messages: [],
        tools: [],
        context: [],
        forwardedProps: {},
        parentRunId,
        resume: [
          {
            interruptId: proposal.nativeInterruptId,
            status: 'resolved',
            payload: { approved: true },
          },
        ],
      });
      await response.text();
      return { response, runId };
    }

    it('loads a Composio read through search and executes only the selected account', async () => {
      const f = await botWithComposio();
      const read = 'gmail__GMAIL_GET_PROFILE';
      adapter.plan = [
        { call: FIND_PLUGIN_TOOLS, args: { names: [read] } },
        { call: read, args: { id: 'me' } },
        { text: 'read' },
      ];
      const runId = await say(f.botId, f.threadId, 'read my profile');
      expect(adapter.sent[0]?.tools).not.toContain(read);
      expect(adapter.sent[1]?.tools).toContain(read);
      expect(await prisma.runInterrupt.count({ where: { runId } })).toBe(0);
      const connection = await prisma.composioConnection.findUniqueOrThrow({
        where: { serverId: f.serverId },
      });
      expect(composio.execute).toHaveBeenCalledWith(
        connection.sessionId,
        connection.accountId,
        'GMAIL_GET_PROFILE',
        { id: 'me' },
        expect.any(AbortSignal),
      );
    });

    it('routes a Composio write through ASK approval before SDK dispatch', async () => {
      const f = await botWithComposio();
      const write = 'gmail__GMAIL_SEND_EMAIL';
      adapter.plan = [
        { call: FIND_PLUGIN_TOOLS, args: { names: [write] } },
        { call: write, args: { id: 'draft-1' } },
      ];
      const parent = await say(f.botId, f.threadId, 'send this message');
      expect(composio.execute).not.toHaveBeenCalled();
      expect((await prisma.agentTurn.findUniqueOrThrow({ where: { id: parent } })).status).toBe(
        'interrupted',
      );
      const { response } = await approveComposio(f, parent);
      expect(response.status).toBe(200);
      expect(composio.execute).toHaveBeenCalledTimes(1);
      expect(composio.execute.mock.calls[0]?.[3]).toEqual({ id: 'draft-1' });
    });

    it('invalidates a pending approval after an ALL-mode exclusion is added', async () => {
      const f = await botWithComposio();
      const all = await call('PUT', `/mcp/servers/${f.serverId}/access`, {
        mode: 'ALL',
        excludedBotIds: [],
      });
      expect(all.status).toBe(200);
      adapter.plan = [
        { call: FIND_PLUGIN_TOOLS, args: { names: ['gmail__GMAIL_SEND_EMAIL'] } },
        { call: 'gmail__GMAIL_SEND_EMAIL', args: { id: 'write' } },
      ];
      const parent = await say(f.botId, f.threadId, 'send this message');
      expect(composio.execute).not.toHaveBeenCalled();
      const excluded = await call('PUT', `/mcp/servers/${f.serverId}/access`, {
        mode: 'ALL',
        excludedBotIds: [f.botId],
      });
      expect(excluded.status).toBe(200);
      await approveComposio(f, parent);
      expect(composio.execute).not.toHaveBeenCalled();
    });

    it('invalidates a pending Composio approval after reconnecting the account', async () => {
      const f = await botWithComposio();
      const write = 'gmail__GMAIL_SEND_EMAIL';
      adapter.plan = [
        { call: FIND_PLUGIN_TOOLS, args: { names: [write] } },
        { call: write, args: { id: 'draft-2' } },
      ];
      const parent = await say(f.botId, f.threadId, 'send this message');
      expect(composio.execute).not.toHaveBeenCalled();
      expect((await call('POST', `/mcp/servers/${f.serverId}/connect`)).status).toBe(200);
      const pending = await prisma.composioConnection.findUniqueOrThrow({
        where: { serverId: f.serverId },
      });
      composio.activate(pending.pendingAccountId!);
      await call('GET', '/mcp/servers');
      await approveComposio(f, parent);
      expect(composio.execute).not.toHaveBeenCalled();
    });

    it.each([
      { mode: 'AUTO' as const, decision: 'deny' },
      { mode: 'AUTO' as const, decision: 'allow' },
      { mode: 'FULL' as const, decision: 'allow' },
    ])(
      'uses $mode rules with decision $decision for Composio writes',
      async ({ mode, decision }) => {
        const f = await botWithComposio(mode, [{ toolPattern: 'gmail__*', decision }]);
        const write = 'gmail__GMAIL_SEND_EMAIL';
        adapter.plan = [
          { call: FIND_PLUGIN_TOOLS, args: { names: [write] } },
          { call: write, args: { id: '1' } },
          { text: 'done' },
        ];
        const run = await say(f.botId, f.threadId, 'send');
        expect(composio.execute).toHaveBeenCalledTimes(decision === 'allow' ? 1 : 0);
        expect(await prisma.runInterrupt.count({ where: { runId: run } })).toBe(0);
      },
    );

    it('rejects an unauthenticated connection poll', async () => {
      const response = await fetch(`${base}/mcp/servers`);
      expect(response.status).toBe(401);
    });

    it('loads a plugin tool, then calls it as itself; a read runs without asking', async () => {
      const f = await botWithPlugin();
      const read = `${f.slug}__list_invoices`;
      adapter.sent.length = 0;
      adapter.plan = [
        { call: FIND_PLUGIN_TOOLS, args: { names: [read] } },
        { call: read, args: { since: '2026-01-01' } },
        { text: 'listed' },
      ];
      const runId = await say(f.botId, f.threadId, 'list my invoices');

      const [first, second] = adapter.sent;
      expect(first?.tools).toContain(FIND_PLUGIN_TOOLS);
      expect(first?.tools.filter((name) => name.startsWith(`${f.slug}__`))).toEqual([]);
      // The listing names it, so the model knows what to load.
      expect(first?.descriptions.get(FIND_PLUGIN_TOOLS)).toContain(read);
      expect(second?.tools).toContain(read);
      expect(second?.tools).not.toContain(`${f.slug}__send_invoice`);
      expect(stub.calls).toEqual([{ name: 'list_invoices', args: { since: '2026-01-01' } }]);
      // D-197: a read reserves nothing in the dispatch ledger.
      expect(await prisma.toolDispatch.count({ where: { conversationId: f.threadId } })).toBe(0);
      const run = await prisma.agentTurn.findUniqueOrThrow({ where: { id: runId } });
      expect(run.status).toBe('completed');
      expect(await prisma.runInterrupt.count({ where: { runId } })).toBe(0);
    });

    it('asks before a write, and the approved call runs on the resume with its final arguments', async () => {
      const f = await botWithPlugin();
      const write = `${f.slug}__send_invoice`;
      adapter.plan = [
        { call: FIND_PLUGIN_TOOLS, args: { query: 'send invoice' } },
        { call: write, args: { id: 'inv-1' } },
      ];
      const parkedRunId = await say(f.botId, f.threadId, 'send invoice 1');
      expect(
        (await prisma.agentTurn.findUniqueOrThrow({ where: { id: parkedRunId } })).status,
      ).toBe('interrupted');
      expect(stub.calls).toEqual([]);
      const proposal = await prisma.runInterrupt.findFirstOrThrow({
        where: { runId: parkedRunId },
        select: { nativeInterruptId: true },
      });

      adapter.sent.length = 0;
      adapter.plan = [{ text: 'sent' }];
      const continuation = `run-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const response = await call('POST', `/bots/${f.botId}/chat`, {
        threadId: f.threadId,
        runId: continuation,
        messages: [],
        tools: [],
        context: [],
        forwardedProps: {},
        parentRunId: parkedRunId,
        resume: [
          {
            interruptId: proposal.nativeInterruptId,
            status: 'resolved',
            payload: { approved: true, editedArgs: { id: 'inv-1-edited' } },
          },
        ],
      });
      expect(response.status).toBe(200);
      await response.text();

      // A new engine with nothing remembered: the pending call is in the list
      // because the history says it is waiting, and it ran with the edit.
      expect(stub.calls).toEqual([{ name: 'send_invoice', args: { id: 'inv-1-edited' } }]);
      // D-197: the write was reserved before it ran and settled after.
      expect(await prisma.toolDispatch.findMany({ where: { conversationId: f.threadId } })).toEqual(
        [expect.objectContaining({ toolName: write, status: 'COMMITTED', runId: continuation })],
      );
      expect(adapter.sent[0]?.tools).toContain(write);
      expect(
        (await prisma.agentTurn.findUniqueOrThrow({ where: { id: continuation } })).status,
      ).toBe('completed');
    });

    it('never asks about a call to a tool it was not sent', async () => {
      const f = await botWithPlugin();
      adapter.plan = [{ call: `${f.slug}__send_invoice`, args: { id: 'inv-2' } }, { text: 'oh' }];
      const runId = await say(f.botId, f.threadId, 'send invoice 2 without looking');
      expect(stub.calls).toEqual([]);
      expect(await prisma.runInterrupt.count({ where: { runId } })).toBe(0);
      expect((await prisma.agentTurn.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
        'completed',
      );
    });

    it('a history that loaded a tool grants nothing once the plugin is taken away', async () => {
      const f = await botWithPlugin();
      const read = `${f.slug}__list_invoices`;
      adapter.plan = [
        { call: FIND_PLUGIN_TOOLS, args: { names: [read] } },
        { call: read, args: {} },
        { text: 'listed' },
      ];
      await say(f.botId, f.threadId, 'list');
      expect(stub.calls).toHaveLength(1);

      // A later turn on the same thread still loads it from history…
      adapter.sent.length = 0;
      adapter.plan = [{ text: 'still here' }];
      await say(f.botId, f.threadId, 'again');
      expect(adapter.sent[0]?.tools).toContain(read);

      // …until the plugin is disabled for the bot.
      expect((await call('PUT', `/bots/${f.botId}/plugins`, { serverIds: [] })).status).toBe(200);
      stub.clear();
      adapter.sent.length = 0;
      adapter.plan = [{ call: read, args: {} }, { text: 'gone' }];
      const runId = await say(f.botId, f.threadId, 'list once more');
      expect(adapter.sent[0]?.tools).not.toContain(read);
      expect(adapter.sent[0]?.tools).not.toContain(FIND_PLUGIN_TOOLS);
      expect(stub.calls).toEqual([]);
      expect(await prisma.runInterrupt.count({ where: { runId } })).toBe(0);
    });

    it('keeps a large catalogue to the listing budget and loads only what was asked for', async () => {
      const catalogue = Array.from({ length: 300 }, (_, index) => ({
        name: `action_${String(index).padStart(3, '0')}`,
        description: `Perform administrative action number ${String(index)} on the workspace, with care.`,
        inputSchema: {
          type: 'object',
          properties: { target: { type: 'string', description: 'What to act on' } },
        },
        annotations: { readOnlyHint: true },
      }));
      const f = await botWithPlugin(catalogue);
      const wanted = `${f.slug}__action_042`;
      adapter.sent.length = 0;
      adapter.plan = [
        { call: FIND_PLUGIN_TOOLS, args: { names: [wanted] } },
        { call: wanted, args: { target: 'x' } },
        { text: 'acted' },
      ];
      await say(f.botId, f.threadId, 'do action 42');

      const [first, second] = adapter.sent;
      const listing = first?.descriptions.get(FIND_PLUGIN_TOOLS) ?? '';
      // The header sentence plus the D-113 listing, which never exceeds the budget.
      expect(estimate(listing)).toBeLessThanOrEqual(PLUGIN_LISTING_TOKEN_BUDGET + 100);
      const direct = catalogue.reduce(
        (sum, tool) =>
          sum +
          estimate(`${f.slug}__${tool.name}${tool.description}${JSON.stringify(tool.inputSchema)}`),
        0,
      );
      expect(direct).toBeGreaterThan(3 * PLUGIN_LISTING_TOKEN_BUDGET);
      expect(first?.tools.filter((name) => name.startsWith(`${f.slug}__`))).toEqual([]);
      expect(second?.tools.filter((name) => name.startsWith(`${f.slug}__`))).toEqual([wanted]);
      expect(stub.calls).toEqual([{ name: 'action_042', args: { target: 'x' } }]);
    });
  },
);
