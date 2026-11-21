/**
 * D-191: every turn on a TanStack thread, through the real application.
 *
 * `TanStackTurns.startStored` is the one entry point a routine, a teammate's
 * delivery and a Work Start all use (D-199), so these tests drive it the way
 * those callers do — write the trigger with the writer that caller uses, then
 * start the run — and assert what the thread ends up holding, which run
 * answered it, and what the model was given.
 *
 * The model is scripted; everything under it is the production path.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { ListBotsResponseSchema } from '@crewaid/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ModelResolutionService } from '../src/models/model-resolution.service.js';
import { MessagesService } from '../src/messages/messages.service.js';
import { TanStackTurns } from '../src/agent/tanstack-turns.js';
import { TurnControlService } from '../src/agent/turn-control.service.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import { ScriptedAdapter } from './mod-02-tanstack-harness.js';
import { FakeProvider } from './sandbox-fakes.js';

const DATABASE_URL = process.env['DATABASE_URL'];

/** Until the predicate holds, or the step budget runs out. */
async function until(predicate: () => Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) =>
      typeof part === 'object' && part !== null && 'content' in part
        ? String((part as { content: unknown }).content)
        : '',
    )
    .join('');
}

describe.skipIf(!DATABASE_URL)('MOD-AI-17 serving every turn on a TanStack thread', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let messages: MessagesService;
  let turns: TanStackTurns;
  let control: TurnControlService;
  let base = '';
  let owner: SignedInUser;
  const adapter = new ScriptedAdapter();

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
      .compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new CrewaidWsAdapter(app));
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}/api/v1`;
    prisma = app.get(PrismaService);
    messages = app.get(MessagesService);
    turns = app.get(TanStackTurns);
    control = app.get(TurnControlService);
    owner = await signIn(prisma, { label: 'cutover' });
  });
  afterAll(async () => {
    await signOutAndDelete(prisma, owner.userId);
    await app.close();
  });

  async function bot(label = 'cut') {
    const row = await prisma.bot.create({
      data: {
        userId: owner.userId,
        name: `${label}-${randomUUID()}`,
        role: 'fixture',
        avatarColor: '#8B6F47',
        systemPrompt: '',
      },
    });
    const conversation = await prisma.conversation.create({
      data: { botId: row.id },
    });
    return { bot: row, threadId: conversation.id };
  }

  const runsOf = (threadId: string) =>
    prisma.agentTurn.findMany({
      where: { conversationId: threadId },
      orderBy: { sequence: 'asc' },
      select: { id: true, status: true, triggerMessageId: true, cancelRequested: true },
    });

  it('names each bot thread on the wire', async () => {
    const tanstack = await bot('wire');
    const response = await fetch(`${base}/bots`, { headers: owner.headers });
    expect(response.status).toBe(200);
    const rows = ListBotsResponseSchema.parse(await response.json());
    expect(rows.find((row) => row.id === tanstack.bot.id)?.thread).toEqual({
      id: tanstack.threadId,
      // Nothing said on either yet; D-192's preview is covered by its own suite.
      preview: null,
    });
  });

  it("runs a routine's prompt as one canonical row and one run", async () => {
    const f = await bot('routine');
    const routine = await prisma.routine.create({
      data: {
        botId: f.bot.id,
        name: 'Morning hello',
        prompt: 'say hello',
        cron: '0 9 * * *',
        timezone: 'UTC',
      },
      select: { id: true },
    });
    const trigger = await messages.createUserMessage(
      owner.userId,
      f.bot.id,
      { content: 'good morning' },
      { routineId: routine.id },
    );
    await turns.startStored(owner.userId, f.bot.id, {
      id: trigger.id,
      content: trigger.content,
      chainId: null,
      hopCount: 0,
    });
    await until(
      async () => (await runsOf(f.threadId)).some((run) => run.status === 'completed'),
      'the routine run to settle',
    );

    const stored = await prisma.message.findMany({
      where: { conversationId: f.threadId },
      orderBy: { sequence: 'asc' },
      select: { id: true, author: true, parts: true, routineId: true, runId: true },
    });
    // The product fact stays in its column, and the row is a model message.
    expect(stored[0]).toMatchObject({ id: trigger.id, author: 'USER', routineId: routine.id });
    expect(stored[0]?.parts).toMatchObject({ role: 'user', content: 'good morning' });
    expect(stored.some((row) => row.author === 'BOT' && row.runId !== null)).toBe(true);
    const runs = await runsOf(f.threadId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.triggerMessageId).toBe(trigger.id);
  });

  it("reads a teammate's message as the teammate's, and stores it verbatim", async () => {
    const receiver = await bot('inbox');
    const sender = await bot('sender');
    const chainId = randomUUID();
    const delivered = await messages.createInboundBotMessage({
      toBotId: receiver.bot.id,
      fromBotId: sender.bot.id,
      content: 'can you take the deploy note?',
      chainId,
      hopCount: 1,
    });
    const before = adapter.calls.length;
    await turns.startStored(owner.userId, receiver.bot.id, {
      id: delivered.id,
      content: delivered.content,
      chainId,
      hopCount: 1,
    });
    await until(
      async () => (await runsOf(receiver.threadId)).some((run) => run.status === 'completed'),
      'the delivered run to settle',
    );

    const row = await prisma.message.findUniqueOrThrow({
      where: { id: delivered.id },
      select: { author: true, fromBotId: true, content: true, chainId: true, hopCount: true },
    });
    // BOT-authored with the SENDER's id, and the sender's words untouched.
    expect(row).toMatchObject({
      author: 'BOT',
      fromBotId: sender.bot.id,
      content: 'can you take the deploy note?',
      chainId,
      hopCount: 1,
    });
    const call = adapter.calls[before];
    const attributed = (call?.messages ?? []).filter((message) => message.role === 'user');
    expect(attributed.map((message) => textOf(message.content)).join('\n')).toContain(
      `[Message from ${sender.bot.name}, another bot on this team]`,
    );
  });

  it('answers a trigger that arrived mid-run, exactly once, with the newest of them', async () => {
    const f = await bot('queue');
    adapter.wordDelayMs = 30;
    const first = await messages.createUserMessage(owner.userId, f.bot.id, {
      content: 'slow please',
    });
    // D-191 §3: `startStored` resolves once the run it started has settled, so
    // awaiting it would end the run before this test could send anything
    // mid-run. The start is detached — the way the send route and every
    // background caller run it — and the lease below is what proves the run is
    // live; the handle is awaited at the end so a failed start still fails the
    // test instead of its timeout.
    const started = turns.startStored(owner.userId, f.bot.id, {
      id: first.id,
      content: first.content,
      chainId: null,
      hopCount: 0,
    });
    await until(
      async () => (await runsOf(f.threadId)).some((run) => run.status === 'running'),
      'the first run to claim its lease',
    );

    // Two more arrive while it works. Both are stored; one run answers them.
    const second = await messages.createUserMessage(owner.userId, f.bot.id, { content: 'and one' });
    await turns.startStored(owner.userId, f.bot.id, {
      id: second.id,
      content: second.content,
      chainId: null,
      hopCount: 0,
    });
    const third = await messages.createUserMessage(owner.userId, f.bot.id, { content: 'and two' });
    await turns.startStored(owner.userId, f.bot.id, {
      id: third.id,
      content: third.content,
      chainId: null,
      hopCount: 0,
    });
    adapter.wordDelayMs = 2;

    await until(async () => {
      const runs = await runsOf(f.threadId);
      return runs.length === 2 && runs.every((run) => run.status === 'completed');
    }, 'the handoff run to settle');
    await started;
    const runs = await runsOf(f.threadId);
    // Fold, not drain: the newest unanswered trigger, and nothing for the one
    // it overtook — M5-BE-02 puts that in the history the second run reads.
    expect(runs.map((run) => run.triggerMessageId)).toEqual([first.id, third.id]);
  });

  it('stops a running run, and ends an interrupted one with its interrupts cancelled', async () => {
    const f = await bot('stop');
    adapter.wordDelayMs = 40;
    const trigger = await messages.createUserMessage(owner.userId, f.bot.id, {
      content: 'slow please',
    });
    // Detached for the same D-191 §3 reason the mid-run case above gives: the
    // run has to be live when Stop arrives, and an awaited `startStored` would
    // not return until it had already ended.
    const started = turns.startStored(owner.userId, f.bot.id, {
      id: trigger.id,
      content: trigger.content,
      chainId: null,
      hopCount: 0,
    });
    await until(
      async () => (await runsOf(f.threadId)).some((run) => run.status === 'running'),
      'the run to claim its lease',
    );
    expect(control.cancelTurn(owner.userId, f.bot.id)).toBe(true);
    adapter.wordDelayMs = 2;
    await until(async () => {
      const runs = await runsOf(f.threadId);
      return runs.length === 1 && runs[0]?.status !== 'running';
    }, 'the cancelled run to end');
    await started;
    const [stopped] = await runsOf(f.threadId);
    expect(stopped?.status).toBe('aborted');
    expect(stopped?.cancelRequested).toBe(true);

    // A parked run is the operator declining to answer: nothing is producing
    // it, so Stop has to end it and cancel what it asked.
    const parkedTrigger = await messages.createUserMessage(owner.userId, f.bot.id, {
      content: 'needs approval',
    });
    const parked = await prisma.agentTurn.create({
      data: {
        botId: f.bot.id,
        conversationId: f.threadId,
        triggerMessageId: parkedTrigger.id,
        status: 'interrupted',
        activeKey: null,
      },
      select: { id: true },
    });
    const interrupt = await prisma.runInterrupt.create({
      data: {
        runId: parked.id,
        conversationId: f.threadId,
        userId: owner.userId,
        payload: { toolName: 'send_email', args: {}, binding: {} },
      },
      select: { id: true },
    });
    control.cancelTurn(owner.userId, f.bot.id);
    await until(async () => {
      const row = await prisma.agentTurn.findUniqueOrThrow({
        where: { id: parked.id },
        select: { status: true },
      });
      return row.status === 'aborted';
    }, 'the parked run to be aborted');
    const answered = await prisma.runInterrupt.findUniqueOrThrow({
      where: { id: interrupt.id },
      select: { status: true, resolvedAt: true },
    });
    expect(answered.status).toBe('cancelled');
    expect(answered.resolvedAt).not.toBeNull();
    // And nothing was started for the trigger it was parked on.
    expect((await runsOf(f.threadId)).filter((run) => run.status === 'running')).toHaveLength(0);
  }, 20000);

  it('serves no AI SDK message route any more, and still answers approvals', async () => {
    const f = await bot('engine');
    const list = await fetch(`${base}/bots/${f.bot.id}/messages`, { headers: owner.headers });
    const send = await fetch(`${base}/bots/${f.bot.id}/messages`, {
      method: 'POST',
      headers: { ...owner.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });
    expect([list.status, send.status]).toEqual([404, 404]);
    // Nothing was written by the refused POST.
    expect(await prisma.message.count({ where: { conversationId: f.threadId } })).toBe(0);
    const approvals = await fetch(`${base}/bots/${f.bot.id}/approvals`, { headers: owner.headers });
    expect(approvals.status).toBe(200);
  });
});
