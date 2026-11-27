/**
 * D-190: `POST /bots/:id/chat` through the real application — AuthGuard, the
 * ownership marker, admission, a real lease and producer, and the durable
 * stream the response is a reader of.
 *
 * The model is scripted; everything under it is the production path.
 */
import {
  crewaidChat,
  createRunAnnouncements,
} from '../../desktop/src/renderer/chat/crewaidChat.js';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { EventType } from '@tanstack/ai';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ModelResolutionService } from '../src/models/model-resolution.service.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { AI_TELEMETRY, type AiTelemetryEvent } from '../src/telemetry/ai-telemetry.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import { ScriptedAdapter } from './mod-02-tanstack-harness.js';
import { MessagesService } from '../src/messages/messages.service.js';
import { ChatSendService } from '../src/chat/chat-send.service.js';
import { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { RunLeaseService, RUN_HEARTBEAT_MS } from '../src/agent/persistence/run-lease.js';
import { admitOwnedToolResumeBatch } from '../src/agent/persistence/owned-resume-admission.js';
import { ToolRegistry, SENSITIVE_BUILTIN } from '../src/agent/tool-registry.js';
import { tool } from '../src/agent/tool-contract.js';
import { z } from 'zod';
import { createDispatchLedger } from '../src/agent/policy/dispatch-ledger.js';
import { readMaxSteps } from '../src/agent/agent-loop.config.js';
import { PolicyProposalSchema } from '../src/agent/policy/proposal-store.js';
import { ownedThread, produceOwned } from './mod-ai06-owned-harness.js';
import { FakeProvider } from './sandbox-fakes.js';

const DATABASE_URL = process.env['DATABASE_URL'];

type Frame = { readonly id: string | undefined; readonly event: Record<string, unknown> };

/** SSE frames as the stock client parses them. */
function frames(body: string): Frame[] {
  return body
    .split('\n\n')
    .filter((frame) => frame.includes('data: '))
    .map((frame) => ({
      id: /^id: (.+)$/m.exec(frame)?.[1],
      event: JSON.parse(/^data: (.+)$/m.exec(frame)?.[1] ?? '{}') as Record<string, unknown>,
    }));
}

function textOf(received: Frame[]): string {
  return received
    .filter((frame) => frame.event['type'] === EventType.TEXT_MESSAGE_CONTENT)
    .map((frame) => String(frame.event['delta'] ?? ''))
    .join('');
}

describe.skipIf(!DATABASE_URL)('MOD-AI-16 chat send route (real app, real db)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const recoveredEffect = vi.fn(async () => 'sent');
  let base = '';
  let owner: SignedInUser;
  let stranger: SignedInUser;
  const adapter = new ScriptedAdapter();
  const recorded: AiTelemetryEvent[] = [];
  let settledFor: (threadId: string) => unknown[] = () => [];

  beforeAll(async () => {
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
            modelId: 'scripted:test',
            connectionId: 'fixture',
            connectionName: 'Fixture',
            upstreamModelId: 'scripted',
            label: 'Scripted',
            contextWindow: 100000,
            capabilities: { tools: true, vision: false, reasoning: false },
          }),
      })
      .overrideProvider(AI_TELEMETRY)
      .useValue({ record: (event: AiTelemetryEvent) => void recorded.push(event) })
      .compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new CrewaidWsAdapter(app));
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}/api/v1`;
    prisma = app.get(PrismaService);
    app.get(ToolRegistry).register({
      name: 'send_email',
      behavior: SENSITIVE_BUILTIN,
      build: () => tool({ inputSchema: z.object({ to: z.string() }), execute: recoveredEffect }),
    });
    // Observed, not replaced: the frame still goes out as it would.
    const settled = vi.spyOn(app.get(TurnEventBus), 'emitRunSettled');
    settledFor = (threadId) =>
      settled.mock.calls.map(([payload]) => payload).filter((p) => p.threadId === threadId);
    owner = await signIn(prisma, { label: 'chatsend' });
    stranger = await signIn(prisma, { label: 'chatsendx' });
  });
  afterAll(async () => {
    await signOutAndDelete(prisma, owner.userId);
    await signOutAndDelete(prisma, stranger.userId);
    await app.close();
  });

  async function thread(user = owner) {
    const bot = await prisma.bot.create({
      data: {
        userId: user.userId,
        name: `send-${randomUUID()}`,
        role: 'fixture',
        avatarColor: '#8B6F47',
        systemPrompt: '',
      },
    });
    const conversation = await prisma.conversation.create({
      data: { botId: bot.id },
    });
    return { bot, threadId: conversation.id };
  }

  function body(
    threadId: string,
    message: { id: string; content: string },
    extra: Record<string, unknown> = {},
  ) {
    return {
      threadId,
      runId: `run-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      messages: [{ id: message.id, role: 'user', content: message.content }],
      tools: [],
      context: [],
      // What `@tanstack/ai-client` puts in every body, so every case here is
      // the request the renderer actually makes.
      state: {},
      forwardedProps: {},
      ...extra,
    };
  }

  const send = (botId: string, payload: unknown, user = owner) =>
    fetch(`${base}/bots/${botId}/chat`, {
      method: 'POST',
      headers: { ...user.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  it('admits a user turn, stores it once, and streams the run that answers it', async () => {
    const f = await thread();
    const payload = body(f.threadId, { id: `u-${randomUUID()}`, content: 'hello there' });
    const response = await send(f.bot.id, payload);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const received = frames(await response.text());
    expect(textOf(received)).toBe('hello from the script');
    // Every frame carries its offset, so the stock client can resume.
    expect(received.every((frame) => frame.id !== undefined)).toBe(true);
    expect(received.at(-1)?.event['type']).toBe(EventType.RUN_FINISHED);

    const stored = await prisma.message.findMany({
      where: { conversationId: f.threadId },
      orderBy: { sequence: 'asc' },
      select: { id: true, author: true, content: true },
    });
    // The trigger keeps the id the client proposed, and the reply is the
    // engine's own row — not a draft this route created.
    expect(stored[0]).toMatchObject({ id: payload.messages[0]!.id, author: 'USER' });
    expect(stored.filter((row) => row.author === 'BOT')).toHaveLength(1);
    const run = await prisma.agentTurn.findFirstOrThrow({
      where: { conversationId: f.threadId },
      select: { id: true, status: true, triggerMessageId: true },
    });
    expect(run).toMatchObject({ id: payload.runId, status: 'completed' });
    // D-189: the production producer records its model call, scoped to this run.
    expect(recorded.filter((event) => event.runId === payload.runId)).toEqual([
      expect.objectContaining({ event: 'ai.model-call', botId: f.bot.id, outcome: 'success' }),
    ]);
  });

  it('replays the same run to a reader that joins after it finished', async () => {
    const f = await thread();
    const payload = body(f.threadId, { id: `u-${randomUUID()}`, content: 'hello again' });
    await send(f.bot.id, payload).then((response) => response.text());
    const rejoined = await fetch(`${base}/bots/${f.bot.id}/chat?runId=${payload.runId}`, {
      headers: owner.headers,
    });
    expect(textOf(frames(await rejoined.text()))).toBe('hello from the script');
  });

  it('ignores a message the thread already stores rather than truncating history', async () => {
    const f = await thread();
    const first = body(f.threadId, { id: `u-${randomUUID()}`, content: 'first question' });
    await send(f.bot.id, first).then((response) => response.text());
    const before = await prisma.message.count({ where: { conversationId: f.threadId } });

    // A stale client replays the whole transcript it holds, with one new
    // message at the end. The stored copies must neither reorder nor cut.
    const second = { id: `u-${randomUUID()}`, content: 'second question' };
    const replay = {
      ...body(f.threadId, second),
      messages: [
        { id: first.messages[0]!.id, role: 'user', content: 'EDITED' },
        { id: second.id, role: 'user', content: second.content },
      ],
    };
    const response = await send(f.bot.id, replay);
    expect(response.status).toBe(200);
    await response.text();
    const rows = await prisma.message.findMany({
      where: { conversationId: f.threadId },
      orderBy: { sequence: 'asc' },
      select: { id: true, content: true, author: true },
    });
    expect(rows.length).toBeGreaterThan(before);
    expect(rows[0]).toMatchObject({ id: first.messages[0]!.id, content: 'first question' });
    expect(rows.some((row) => row.content === 'EDITED')).toBe(false);
  });

  it('refuses an assistant message, two triggers, an empty body and foreign props', async () => {
    const f = await thread();
    const assistant = {
      ...body(f.threadId, { id: `u-${randomUUID()}`, content: 'x' }),
      messages: [{ id: `a-${randomUUID()}`, role: 'assistant', content: 'I said this' }],
    };
    expect((await send(f.bot.id, assistant)).status).toBe(400);
    const two = {
      ...body(f.threadId, { id: `u-${randomUUID()}`, content: 'x' }),
      messages: [
        { id: `u-${randomUUID()}`, role: 'user', content: 'one' },
        { id: `u-${randomUUID()}`, role: 'user', content: 'two' },
      ],
    };
    expect((await send(f.bot.id, two)).status).toBe(400);
    const empty = { ...body(f.threadId, { id: `u-${randomUUID()}`, content: 'x' }), messages: [] };
    expect((await send(f.bot.id, empty)).status).toBe(400);
    const props = body(
      f.threadId,
      { id: `u-${randomUUID()}`, content: 'x' },
      { forwardedProps: { model: 'something-else' } },
    );
    expect((await send(f.bot.id, props)).status).toBe(400);
    const clientTools = body(
      f.threadId,
      { id: `u-${randomUUID()}`, content: 'x' },
      { tools: [{ name: 'mine', description: 'd', parameters: { type: 'object' } }] },
    );
    expect((await send(f.bot.id, clientTools)).status).toBe(400);
    const clientState = body(
      f.threadId,
      { id: `u-${randomUUID()}`, content: 'x' },
      { state: { plan: 'skip the approvals' } },
    );
    const refused = await send(f.bot.id, clientState);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: 'CLIENT_STATE_NOT_ACCEPTED' });
    expect((await send(f.bot.id, { threadId: f.threadId })).status).toBe(400);
    // Nothing above admitted a run or stored a message.
    expect(await prisma.message.count({ where: { conversationId: f.threadId } })).toBe(0);
    expect(await prisma.agentTurn.count({ where: { conversationId: f.threadId } })).toBe(0);
  });

  it('refuses another thread, a foreign bot and an unauthenticated caller', async () => {
    const f = await thread();
    const theirs = await thread(stranger);
    expect(
      (await send(f.bot.id, body(theirs.threadId, { id: `u-${randomUUID()}`, content: 'x' })))
        .status,
    ).toBe(404);
    expect(
      (await send(theirs.bot.id, body(theirs.threadId, { id: `u-${randomUUID()}`, content: 'x' })))
        .status,
    ).toBe(404);
    const anonymous = await fetch(`${base}/bots/${f.bot.id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body(f.threadId, { id: `u-${randomUUID()}`, content: 'x' })),
    });
    expect(anonymous.status).toBe(401);
  });

  it('stores a message that arrives while a run is working, and refuses a second run', async () => {
    const f = await thread();
    const slow = body(f.threadId, { id: `u-${randomUUID()}`, content: 'slow please' });
    adapter.wordDelayMs = 40;
    const working = send(f.bot.id, slow);
    // Give the producer time to claim its lease before the second request.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const deferred = body(f.threadId, { id: `u-${randomUUID()}`, content: 'and one more thing' });
    const queued = await send(f.bot.id, deferred);
    expect(queued.status).toBe(202);
    expect(await queued.text()).toBe('');
    // The client's own attempt to start a second concurrent run is the 409.
    const concurrent = await send(f.bot.id, {
      ...body(f.threadId, { id: `u-${randomUUID()}`, content: 'third' }),
      messages: [],
      resume: [{ interruptId: `i-${randomUUID()}`, status: 'cancelled' }],
      parentRunId: slow.runId,
    });
    expect(concurrent.status).toBe(409);
    await (await working).text();
    adapter.wordDelayMs = 2;
    const stored = await prisma.message.findMany({
      where: { conversationId: f.threadId, author: 'USER' },
      select: { id: true },
    });
    // Stored exactly once, and still unanswered: the run that answers it is
    // the next one, announced by `run.started`.
    expect(stored.map((row) => row.id).sort()).toEqual(
      [slow.messages[0]!.id, deferred.messages[0]!.id].sort(),
    );
  });

  it('says which messages a run answered once nothing more will happen for them', async () => {
    const f = await thread();
    const first = body(f.threadId, { id: `u-${randomUUID()}`, content: 'slow please' });
    adapter.wordDelayMs = 40;
    const working = send(f.bot.id, first);
    await new Promise((resolve) => setTimeout(resolve, 250));
    // Two messages queue behind the first run; the next run answers both.
    const second = body(f.threadId, { id: `u-${randomUUID()}`, content: 'and this' });
    expect((await send(f.bot.id, second)).status).toBe(202);
    const third = body(f.threadId, { id: `u-${randomUUID()}`, content: 'and that' });
    expect((await send(f.bot.id, third)).status).toBe(202);
    await (await working).text();
    adapter.wordDelayMs = 2;
    await vi.waitFor(() => expect(settledFor(f.threadId)).toHaveLength(2), { timeout: 10_000 });
    expect(settledFor(f.threadId)).toEqual([
      expect.objectContaining({
        botId: f.bot.id,
        runId: first.runId,
        messageIds: [first.messages[0]!.id],
        outcome: 'completed',
        reply: expect.stringMatching(/^w0 w1/),
      }),
      expect.objectContaining({
        // The newest message triggers the run; the older one is folded in.
        messageIds: [third.messages[0]!.id, second.messages[0]!.id],
        outcome: 'completed',
      }),
    ]);
  });

  it('refuses a wire version it does not speak', async () => {
    const f = await thread();
    const response = await fetch(`${base}/bots/${f.bot.id}/chat`, {
      method: 'POST',
      headers: {
        ...owner.headers,
        'Content-Type': 'application/json',
        'X-Crewaid-Wire-Version': '999',
      },
      body: JSON.stringify(body(f.threadId, { id: `u-${randomUUID()}`, content: 'x' })),
    });
    expect(response.status).toBe(426);
  });

  it('claims the uploads a turn names, and refuses one it does not own', async () => {
    const f = await thread();
    const upload = await prisma.attachment.create({
      data: {
        ownerId: owner.userId,
        filename: 'notes.txt',
        mimeType: 'text/plain',
        sizeBytes: 4,
        storageKey: `k-${randomUUID()}`,
      },
      select: { id: true },
    });
    const theirs = await prisma.attachment.create({
      data: {
        ownerId: stranger.userId,
        filename: 'theirs.txt',
        mimeType: 'text/plain',
        sizeBytes: 4,
        storageKey: `k-${randomUUID()}`,
      },
      select: { id: true },
    });
    const foreign = body(
      f.threadId,
      { id: `u-${randomUUID()}`, content: 'read this' },
      { forwardedProps: { attachmentIds: [theirs.id] } },
    );
    expect((await send(f.bot.id, foreign)).status).toBe(404);
    expect(await prisma.message.count({ where: { conversationId: f.threadId } })).toBe(0);

    const mine = body(
      f.threadId,
      { id: `u-${randomUUID()}`, content: 'read this' },
      { forwardedProps: { attachmentIds: [upload.id] } },
    );
    await send(f.bot.id, mine).then((response) => response.text());
    const claimed = await prisma.attachment.findUniqueOrThrow({
      where: { id: upload.id },
      select: { messageId: true },
    });
    expect(claimed.messageId).toBe(mine.messages[0]!.id);
  });

  it('refuses a resume with no parked run named, and one naming a run that is not there', async () => {
    const f = await thread();
    const orphan = {
      ...body(f.threadId, { id: `u-${randomUUID()}`, content: 'x' }),
      messages: [],
      resume: [
        { interruptId: `i-${randomUUID()}`, status: 'resolved', payload: { approved: true } },
      ],
    };
    expect((await send(f.bot.id, orphan)).status).toBe(400);
    // An unknown run is a 404, exactly as the join route answers one: the
    // refusal says nothing about whose run that id might be.
    expect((await send(f.bot.id, { ...orphan, parentRunId: `run-${randomUUID()}` })).status).toBe(
      404,
    );
  });

  it('hydrates and resumes a parked approval using the actual standalone renderer client', async () => {
    const f = await thread();
    const payload = body(f.threadId, { id: `u-${randomUUID()}`, content: 'gated please' });
    await (await send(f.bot.id, payload)).text();
    const before = recoveredEffect.mock.calls.length;
    const chat = crewaidChat({
      threadId: f.threadId,
      endpoint: { url: `${base}/bots/${f.bot.id}/chat`, headers: owner.headers },
      runs: createRunAnnouncements(),
    });
    try {
      chat.start();
      await vi.waitFor(() => expect(chat.getSnapshot().interrupts).toHaveLength(1));
      chat.getSnapshot().interrupts[0]!.resolveInterrupt({
        approved: true,
        editedArgs: { to: 'reviewed@example.test' },
      });
      await vi.waitFor(
        () => {
          expect(chat.getSnapshot().interrupts).toHaveLength(0);
          expect(chat.getSnapshot().sessionGenerating).toBe(false);
          expect(chat.getSnapshot().error).toBeUndefined();
        },
        { timeout: 10000 },
      );
      expect(recoveredEffect.mock.calls.length).toBe(before + 1);
      expect(recoveredEffect.mock.calls.at(-1)?.[0]).toEqual({ to: 'reviewed@example.test' });
      expect(chat.agent.messages.some((message) => message.role === 'tool')).toBe(true);
    } finally {
      chat.dispose();
    }
  });

  it('answers a parked approval through the route, once, and streams its continuation', async () => {
    // A real producer parks on a policy prompt first: the interrupt the route
    // answers has to be one the engine actually wrote.
    const parked = await ownedThread(prisma, owner.userId);
    const outcome = await produceOwned(prisma, parked, parked.first, () =>
      Promise.resolve('must not run'),
    );
    expect(outcome.status).toBe('interrupted');
    const proposal = await prisma.runInterrupt.findFirstOrThrow({
      where: { runId: parked.first.runId },
      select: { id: true, nativeInterruptId: true },
    });

    const answer = {
      threadId: parked.threadId,
      runId: `run-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {},
      parentRunId: parked.first.runId,
      resume: [
        {
          interruptId: proposal.nativeInterruptId,
          status: 'resolved',
          payload: { approved: false, reason: 'not this time' },
        },
      ],
    };
    const response = await send(parked.botId, answer);
    expect(response.status).toBe(200);
    const received = frames(await response.text());
    expect(received.at(-1)?.event['type']).toBeDefined();

    // The decision was consumed, and the continuation is a run of its own,
    // recorded against the run it answered.
    const row = await prisma.runInterrupt.findUniqueOrThrow({
      where: { id: proposal.id },
      select: { status: true },
    });
    expect(row.status).toBe('resolved');
    const continuation = await prisma.agentTurn.findFirstOrThrow({
      where: { resumesRunId: parked.first.runId },
      select: { id: true, status: true },
    });
    expect(['completed', 'failed', 'aborted']).toContain(continuation.status);
    // The client's run id is the run id (D-160 §3.1). A continuation under an
    // id of the server's choosing reads, to the client that asked for it, as
    // a run some other window started — and it renders the reply twice.
    expect(continuation.id).toBe(answer.runId);
    // The continuation answers the message the parked run was started for.
    const parkedRun = await prisma.agentTurn.findUniqueOrThrow({
      where: { id: parked.first.runId },
      select: { triggerMessageId: true },
    });
    await vi.waitFor(() =>
      expect(settledFor(parked.threadId)).toEqual([
        expect.objectContaining({ runId: answer.runId, messageIds: [parkedRun.triggerMessageId] }),
      ]),
    );
    // A second answer finds nothing pending and consumes nothing.
    expect(
      (await send(parked.botId, { ...answer, runId: `run-${randomUUID().slice(0, 12)}` })).status,
    ).toBe(409);
  });
  it('continues after a provider timeout without repeating completed tool work', async () => {
    const f = await thread();
    const payload = body(f.threadId, { id: `u-${randomUUID()}`, content: 'tool please' });
    const natural = adapter.chatStream.bind(adapter);
    let failed = false;
    const spy = vi.spyOn(adapter, 'chatStream').mockImplementation((options) => {
      if (!failed && options.messages.at(-1)?.role === 'tool') {
        failed = true;
        return (async function* () {
          throw new Error('provider timeout');
        })();
      }
      return natural(options);
    });
    try {
      await (await send(f.bot.id, payload)).text();
      await vi.waitFor(async () => {
        const runs = await prisma.agentTurn.findMany({
          where: { conversationId: f.threadId },
          orderBy: { sequence: 'asc' },
        });
        expect(runs.map((run) => run.status)).toEqual(['failed', 'completed']);
        expect(runs.every((run) => run.triggerMessageId === payload.messages[0]!.id)).toBe(true);
      });
      const toolRows = await prisma.message.findMany({
        where: { conversationId: f.threadId, author: 'TOOL' },
      });
      expect(toolRows).toHaveLength(1);
      // The retry is the answer: the attempt that failed says nothing.
      await vi.waitFor(() =>
        expect(settledFor(f.threadId)).toEqual([
          expect.objectContaining({ messageIds: [payload.messages[0]!.id], outcome: 'completed' }),
        ]),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('bounds repeated transient failures and leaves permanent failures alone', async () => {
    const natural = adapter.chatStream.bind(adapter);
    const spy = vi.spyOn(adapter, 'chatStream');
    try {
      for (const [detail, attempts] of [
        ['provider timeout', 4],
        ['invalid api key', 1],
      ] as const) {
        spy.mockImplementation(() =>
          (async function* () {
            throw new Error(detail);
          })(),
        );
        const f = await thread();
        await (
          await send(f.bot.id, body(f.threadId, { id: `u-${randomUUID()}`, content: 'hello' }))
        ).text();
        await vi.waitFor(async () => {
          const runs = await prisma.agentTurn.findMany({ where: { conversationId: f.threadId } });
          expect(runs).toHaveLength(attempts);
          expect(runs.every((run) => run.status === 'failed' && run.activeKey === null)).toBe(true);
          // Only the attempt nothing follows is the last word.
          expect(settledFor(f.threadId)).toEqual([expect.objectContaining({ outcome: 'failed' })]);
        });
      }
    } finally {
      spy.mockImplementation(natural);
      spy.mockRestore();
    }
  });

  it('recovers an expired producer while preserving a healthy owner', async () => {
    const abandoned = await ownedThread(prisma, owner.userId);
    const healthy = await ownedThread(prisma, stranger.userId);
    const leases = new RunLeaseService(prisma);
    await leases.release(abandoned.first);
    await app.get(ChatSendService).recoverAbandonedRuns();
    await vi.waitFor(async () => {
      const run = await prisma.agentTurn.findUniqueOrThrow({
        where: { id: abandoned.first.runId },
      });
      expect(run.status).toBe('interrupted');
      expect(run.driverEpoch).toBe(abandoned.first.epoch + 1);
    });
    const untouched = await prisma.agentTurn.findUniqueOrThrow({
      where: { id: healthy.first.runId },
    });
    expect(untouched).toMatchObject({
      status: 'running',
      workerId: healthy.first.workerId,
      driverEpoch: healthy.first.epoch,
    });
    await leases.finish(healthy.first, 'aborted');
    await app.get(ChatSendService).cancel(owner.userId, abandoned.botId);
  });

  it('recovers an admitted approval from durable rows and consumes it once', async () => {
    const f = await thread();
    const payload = body(f.threadId, { id: `u-${randomUUID()}`, content: 'gated please' });
    await (await send(f.bot.id, payload)).text();
    const proposal = await prisma.runInterrupt.findFirstOrThrow({
      where: { runId: payload.runId },
    });
    const admitted = await admitOwnedToolResumeBatch(
      prisma,
      {
        userId: owner.userId,
        botId: f.bot.id,
        threadId: f.threadId,
        parentRunId: payload.runId,
      },
      [
        {
          interruptId: proposal.nativeInterruptId!,
          status: 'resolved',
          payload: { approved: true },
        },
      ],
    );
    const before = recoveredEffect.mock.calls.length;
    await new RunLeaseService(prisma).release(admitted.lease);
    await app.get(ChatSendService).recoverAbandonedRuns();
    await vi.waitFor(async () => {
      const run = await prisma.agentTurn.findUniqueOrThrow({ where: { id: admitted.lease.runId } });
      expect(run.status).toBe('completed');
    });
    expect(recoveredEffect.mock.calls.length).toBe(before + 1);
    expect(
      (await prisma.agentTurn.findUniqueOrThrow({ where: { id: payload.runId } })).status,
    ).toBe('completed');
    const consumed = await prisma.runInterrupt.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(consumed).toMatchObject({ status: 'resolved', nativeStatus: 'resolved' });
    await app.get(ChatSendService).recoverAbandonedRuns();
    expect(recoveredEffect.mock.calls.length).toBe(before + 1);
  });
  it('settles a closed running log once without replaying tools or calling the model', async () => {
    const f = await ownedThread(prisma, owner.userId);
    await prisma.agentTurn.updateMany({
      where: { id: f.first.runId, bot: { userId: owner.userId } },
      data: { eventsClosedAt: new Date() },
    });
    const calls = adapter.calls.length;
    await new RunLeaseService(prisma).release(f.first);
    const service = app.get(ChatSendService);
    await service.recoverAbandonedRuns();
    await vi.waitFor(async () => {
      const run = await prisma.agentTurn.findFirstOrThrow({
        where: { id: f.first.runId, bot: { userId: owner.userId } },
      });
      expect(run).toMatchObject({ status: 'failed', activeKey: null, workerId: null });
      expect(run.endedAt).not.toBeNull();
    });
    await service.recoverAbandonedRuns();
    expect(adapter.calls).toHaveLength(calls);
    const run = await prisma.agentTurn.findFirstOrThrow({
      where: { id: f.first.runId, bot: { userId: owner.userId } },
    });
    expect(run.driverEpoch).toBe(f.first.epoch + 1);
  });
  it('keeps sweeping after a boot pass before the abandoned lease expires', async () => {
    const abandoned = await ownedThread(prisma, owner.userId);
    const service = app.get(ChatSendService);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await service.startRecovery();
      const before = await prisma.agentTurn.findUniqueOrThrow({
        where: { id: abandoned.first.runId },
      });
      expect(before).toMatchObject({ status: 'running', driverEpoch: abandoned.first.epoch });
      await new RunLeaseService(prisma).release(abandoned.first);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_MS);
      await vi.waitFor(async () => {
        const after = await prisma.agentTurn.findUniqueOrThrow({
          where: { id: abandoned.first.runId },
        });
        expect(after.status).toBe('interrupted');
        expect(after.driverEpoch).toBe(abandoned.first.epoch + 1);
      });
    } finally {
      await service.onModuleDestroy();
      vi.useRealTimers();
    }
  });
  it('does not repeat an approved action whose dispatch outcome was lost', async () => {
    const f = await thread();
    const payload = body(f.threadId, { id: `u-${randomUUID()}`, content: 'gated please' });
    await (await send(f.bot.id, payload)).text();
    const proposal = await prisma.runInterrupt.findFirstOrThrow({
      where: { runId: payload.runId },
    });
    const admitted = await admitOwnedToolResumeBatch(
      prisma,
      {
        userId: owner.userId,
        botId: f.bot.id,
        threadId: f.threadId,
        parentRunId: payload.runId,
      },
      [
        {
          interruptId: proposal.nativeInterruptId!,
          status: 'resolved',
          payload: { approved: true },
        },
      ],
    );
    const call = PolicyProposalSchema.parse(proposal.payload);
    await createDispatchLedger(
      prisma,
      {
        userId: owner.userId,
        conversationId: f.threadId,
        runId: admitted.lease.runId,
      },
      admitted.lease,
    ).reserve({
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      args: call.args,
      effect: 'unknown',
    });
    const before = recoveredEffect.mock.calls.length;
    await new RunLeaseService(prisma).release(admitted.lease);
    await app.get(ChatSendService).recoverAbandonedRuns();
    await vi.waitFor(async () => {
      const run = await prisma.agentTurn.findUniqueOrThrow({ where: { id: admitted.lease.runId } });
      expect(run.status).toBe('completed');
    });
    expect(recoveredEffect.mock.calls.length).toBe(before);
    const dispatch = await prisma.toolDispatch.findFirstOrThrow({
      where: { runId: admitted.lease.runId },
    });
    expect(dispatch.status).toBe('UNCERTAIN');
    const results = await prisma.message.findMany({
      where: { conversationId: f.threadId, author: 'TOOL' },
    });
    expect(JSON.stringify(results)).toContain('OUTCOME_UNKNOWN');
  });

  it('settles an expired canceled continuation without dispatching its approved action', async () => {
    const f = await thread();
    const payload = body(f.threadId, { id: `u-${randomUUID()}`, content: 'gated please' });
    await (await send(f.bot.id, payload)).text();
    const proposal = await prisma.runInterrupt.findFirstOrThrow({
      where: { runId: payload.runId },
    });
    const admitted = await admitOwnedToolResumeBatch(
      prisma,
      {
        userId: owner.userId,
        botId: f.bot.id,
        threadId: f.threadId,
        parentRunId: payload.runId,
      },
      [
        {
          interruptId: proposal.nativeInterruptId!,
          status: 'resolved',
          payload: { approved: true },
        },
      ],
    );
    await prisma.agentTurn.update({
      where: { id: admitted.lease.runId },
      data: { cancelRequested: true },
    });
    await new RunLeaseService(prisma).release(admitted.lease);
    const before = recoveredEffect.mock.calls.length;
    await app.get(ChatSendService).recoverAbandonedRuns();
    const run = await prisma.agentTurn.findUniqueOrThrow({ where: { id: admitted.lease.runId } });
    expect(run).toMatchObject({ status: 'aborted', activeKey: null, workerId: null });
    expect(recoveredEffect.mock.calls.length).toBe(before);
    const cancelled = await prisma.runInterrupt.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(cancelled).toMatchObject({ status: 'cancelled', nativeStatus: 'cancelled' });
    const rejoined = await fetch(`${base}/bots/${f.bot.id}/chat?runId=${admitted.lease.runId}`, {
      headers: owner.headers,
    });
    const events = frames(await rejoined.text());
    expect(events.at(-1)?.event).toMatchObject({
      type: EventType.RUN_ERROR,
      code: 'RUN_CANCELLED',
    });
    const next = body(f.threadId, { id: `u-${randomUUID()}`, content: 'hello again' });
    expect((await send(f.bot.id, next)).status).toBe(200);
    await vi.waitFor(async () => {
      expect((await prisma.agentTurn.findUniqueOrThrow({ where: { id: next.runId } })).status).toBe(
        'completed',
      );
    });
  });
  it("preserves the abandoned run's spending and refuses work beyond its step ceiling", async () => {
    const abandoned = await ownedThread(prisma, owner.userId);
    const stepIndex = readMaxSteps(process.env['AGENT_MAX_STEPS']);
    await prisma.agentTurn.update({
      where: { id: abandoned.first.runId },
      data: { stepIndex, inputTokens: 120, workingMs: 500 },
    });
    await new RunLeaseService(prisma).release(abandoned.first);
    await app.get(ChatSendService).recoverAbandonedRuns();
    await vi.waitFor(async () => {
      const run = await prisma.agentTurn.findUniqueOrThrow({
        where: { id: abandoned.first.runId },
      });
      expect(run).toMatchObject({
        status: 'completed',
        stepIndex,
        inputTokens: 120,
        workingMs: 500,
        workerId: null,
      });
    });
    expect(recorded.some((event) => event.runId === abandoned.first.runId)).toBe(false);
    // The ordinary bounded handoff may start a new run after the recovered
    // one closes. Let that run park before deleting this fixture's owner.
    await vi.waitFor(async () => {
      const runs = await prisma.agentTurn.findMany({ where: { botId: abandoned.botId } });
      expect(
        runs.some(
          (run) =>
            run.id !== abandoned.first.runId &&
            run.status === 'interrupted' &&
            run.eventsClosedAt !== null,
        ),
      ).toBe(true);
    });
    const notices = await prisma.message.findMany({
      where: {
        conversationId: abandoned.threadId,
        author: 'SYSTEM',
        conversation: { bot: { userId: owner.userId } },
      },
      select: { content: true },
    });
    expect(notices.some(({ content }) => content.includes('carrying on for'))).toBe(false);
  });

  it('cancelling a parked approval clears both private and native interrupt facets', async () => {
    const f = await thread();
    const payload = body(f.threadId, { id: `u-${randomUUID()}`, content: 'gated please' });
    await (await send(f.bot.id, payload)).text();
    const proposal = await prisma.runInterrupt.findFirstOrThrow({
      where: { runId: payload.runId },
    });
    expect(proposal).toMatchObject({ status: 'pending', nativeStatus: 'pending' });

    app.get(ChatSendService).cancel(owner.userId, f.bot.id);
    await vi.waitFor(async () => {
      const updated = await prisma.runInterrupt.findUniqueOrThrow({ where: { id: proposal.id } });
      expect(updated).toMatchObject({ status: 'cancelled', nativeStatus: 'cancelled' });
      expect(updated.nativeResolvedAt).not.toBeNull();
    });

    const next = body(f.threadId, { id: `u-${randomUUID()}`, content: 'hello after cancel' });
    expect((await send(f.bot.id, next)).status).toBe(200);
    await vi.waitFor(async () => {
      expect((await prisma.agentTurn.findUniqueOrThrow({ where: { id: next.runId } })).status).toBe(
        'completed',
      );
    });
  });

  it('recoverAbandonedRuns reconciles orphaned split-brain native interrupts', async () => {
    const f = await thread();
    const payload = body(f.threadId, { id: `u-${randomUUID()}`, content: 'gated please' });
    await (await send(f.bot.id, payload)).text();
    const proposal = await prisma.runInterrupt.findFirstOrThrow({
      where: { runId: payload.runId },
    });
    const admitted = await admitOwnedToolResumeBatch(
      prisma,
      {
        userId: owner.userId,
        botId: f.bot.id,
        threadId: f.threadId,
        parentRunId: payload.runId,
      },
      [
        {
          interruptId: proposal.nativeInterruptId!,
          status: 'resolved',
          payload: { approved: true },
        },
      ],
    );
    // Simulate a legacy continuation that failed without committing nativeStatus.
    await prisma.agentTurn.update({
      where: { id: admitted.lease.runId },
      data: {
        status: 'failed',
        endedAt: new Date(),
        activeKey: null,
        workerId: null,
        leaseExpiresAt: null,
      },
    });
    expect(
      await prisma.runInterrupt.findUniqueOrThrow({ where: { id: proposal.id } }),
    ).toMatchObject({ status: 'resolved', nativeStatus: 'pending' });

    await app.get(ChatSendService).recoverAbandonedRuns();
    const repaired = await prisma.runInterrupt.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(repaired).toMatchObject({ status: 'resolved', nativeStatus: 'resolved' });
    expect(repaired.nativeResolvedAt).not.toBeNull();
    // The parent stranded this way closes too, so the bot is no longer
    // "working".
    expect(
      await prisma.agentTurn.findUniqueOrThrow({ where: { id: payload.runId } }),
    ).toMatchObject({ status: 'failed', endedAt: expect.any(Date) });

    const next = body(f.threadId, { id: `u-${randomUUID()}`, content: 'hello after repair' });
    expect((await send(f.bot.id, next)).status).toBe(200);
    await vi.waitFor(async () => {
      expect((await prisma.agentTurn.findUniqueOrThrow({ where: { id: next.runId } })).status).toBe(
        'completed',
      );
    });
    // Deleting a message was refused while the parent stayed `interrupted`.
    const leftover = await prisma.message.findFirstOrThrow({
      where: { conversationId: f.threadId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    await expect(
      app
        .get(MessagesService)
        .deleteMessages(owner.userId, f.bot.id, { messageId: leftover.id, forget: false }),
    ).resolves.toBeDefined();
  });
});
