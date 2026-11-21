import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tool } from '../src/agent/tool-contract.js';
import {
  MockLanguageModelV4,
  scriptModel,
  simulateReadableStream,
} from './model-resolution-fake.js';
import type { ScriptPart as LanguageModelV4StreamPart } from './model-resolution-fake.js';
import { z } from 'zod';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BotWithSandboxSchema, type ApprovalMode } from '@crewaid/shared';

import { TanStackTurns } from '../src/agent/tanstack-turns.js';
import {
  CONTAINED_BUILTIN,
  OBSERVING_BUILTIN,
  SENSITIVE_BUILTIN,
  ToolRegistry,
  type ToolBehavior,
} from '../src/agent/tool-registry.js';
import { BotsService } from '../src/bots/bots.service.js';
import { MessagesService } from '../src/messages/messages.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import { FakeProvider } from './sandbox-fakes.js';

/**
 * D-144 — a bot's approval mode decides a real turn.
 *
 * The matcher is unit-tested beside its rules; this proves the turn reads the
 * mode off the bot and hands it to the policy, which is the one place the
 * wiring could be quietly wrong. Each case runs one scripted turn that calls
 * a single probe, and asks one question: did the turn stop for approval?
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };

/** Which probe the next turn calls. The model reads it when a stream starts. */
let nextProbe = 'probe_act';

function callsTheProbe(): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'calls-the-probe',
    doStream: async () => {
      call += 1;
      const chunks: LanguageModelV4StreamPart[] =
        call === 1
          ? [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: `call-${randomUUID()}`,
                toolName: nextProbe,
                input: '{}',
              },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: 'Done.' },
              { type: 'text-end', id: 't' },
              { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
            ];
      return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }) };
    },
  });
}

let app: INestApplication;
let bots: BotsService;
let messages: MessagesService;
let prisma: PrismaService;
let turns: TanStackTurns;
let USER: SignedInUser;
const ran: string[] = [];

async function until<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe.skipIf(!DATABASE_URL)('D-144 — the approval mode decides a real turn', () => {
  beforeAll(async () => {
    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('../src/app.module.js');
    const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SANDBOX_PROVIDER)
      .useValue(new FakeProvider())
      .compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new CrewaidWsAdapter(app));
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    await app.init();
    scriptModel(app, () => callsTheProbe());
    bots = app.get(BotsService);
    messages = app.get(MessagesService);
    prisma = app.get(PrismaService);
    turns = app.get(TanStackTurns);
    USER = await signIn(prisma, { label: 'd144-approval-mode' });

    const probe = (name: string, behavior: ToolBehavior) => ({
      name,
      behavior,
      build: () =>
        tool({
          description: name,
          inputSchema: z.object({}),
          execute: () => {
            ran.push(name);
            return Promise.resolve('ok');
          },
        }),
    });
    const registry = app.get(ToolRegistry);
    registry.register(probe('probe_act', CONTAINED_BUILTIN) as never);
    registry.register(probe('probe_risky', SENSITIVE_BUILTIN) as never);
    registry.register(probe('probe_look', OBSERVING_BUILTIN) as never);
  }, 60_000);

  afterAll(async () => {
    if (prisma !== undefined) await signOutAndDelete(prisma, USER.userId);
    await app?.close();
  });

  /** One turn calling `toolName`, for a bot in `mode`: did it stop to ask? */
  async function asks(mode: ApprovalMode, toolName: string): Promise<boolean> {
    const bot = await bots.create(USER.userId, {
      name: `d144-${randomUUID().slice(0, 8)}`,
      role: 'R',
      avatarColor: '#123456',
      systemPrompt: 'x',
      autoReviewRules: [],
      approvalMode: mode,
    });
    nextProbe = toolName;
    const before = ran.length;
    const trigger = await messages.createUserMessage(USER.userId, bot.id, { content: 'go' });
    // A run that stops to ask parks: its row reads `interrupted` and the
    // question is a pending RunInterrupt. One that does not finishes.
    await turns.startStored(USER.userId, bot.id, {
      id: trigger.id,
      content: trigger.content,
      chainId: trigger.chainId,
      hopCount: 0,
    });
    const outcome = await until(async () => {
      const row = await prisma.agentTurn.findFirst({
        where: { botId: bot.id },
        select: { status: true, interrupts: { select: { payload: true, status: true } } },
      });
      if (row === null || row.status === 'running') return undefined;
      return row.status === 'interrupted' ? row : ('ran' as const);
    }, `a ${mode} turn calling ${toolName} to ask or finish`);
    if (outcome !== 'ran') {
      const pending = outcome.interrupts.filter((interrupt) => interrupt.status === 'pending');
      expect(pending).toHaveLength(1);
      expect(JSON.stringify(pending[0]?.payload)).toContain(toolName);
      expect(ran.length).toBe(before);
      return true;
    }
    expect(ran.slice(before)).toEqual([toolName]);
    return false;
  }

  it('Approve for me runs what stays inside and asks about what is sensitive', async () => {
    expect(await asks('AUTO', 'probe_act')).toBe(false);
    expect(await asks('AUTO', 'probe_risky')).toBe(true);
  });

  it('Ask for approval asks before an act, and not before a look', async () => {
    expect(await asks('ASK', 'probe_act')).toBe(true);
    expect(await asks('ASK', 'probe_look')).toBe(false);
  });

  it('Full access asks about nothing, the sensitive tool included', async () => {
    expect(await asks('FULL', 'probe_risky')).toBe(false);
  });

  it('is set and read through PATCH and GET /bots, and a new bot starts on Approve for me', async () => {
    const bot = await bots.create(USER.userId, {
      name: `d144-http-${randomUUID().slice(0, 6)}`,
      role: 'R',
      avatarColor: '#123456',
      systemPrompt: 'x',
    });
    expect(bot.approvalMode).toBe('AUTO');
    await request(app.getHttpServer())
      .patch(`/api/v1/bots/${bot.id}`)
      .set(USER.headers)
      .send({ approvalMode: 'FULL' })
      .expect(200);
    const list = await request(app.getHttpServer())
      .get('/api/v1/bots')
      .set(USER.headers)
      .expect(200);
    const row = BotWithSandboxSchema.array()
      .parse(list.body)
      .find((candidate) => candidate.id === bot.id);
    expect(row?.approvalMode).toBe('FULL');
    await request(app.getHttpServer())
      .patch(`/api/v1/bots/${bot.id}`)
      .set(USER.headers)
      .send({ approvalMode: 'SOMETIMES' })
      .expect(400);
  });
});
