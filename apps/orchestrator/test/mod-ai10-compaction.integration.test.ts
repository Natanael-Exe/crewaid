/**
 * D-195: a thread longer than the history budget, through the real send route.
 * The model is sent a compacted copy under the budget; the thread keeps every
 * message it ever had.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ModelResolutionService } from '../src/models/model-resolution.service.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { AI_TELEMETRY, type AiTelemetryEvent } from '../src/telemetry/ai-telemetry.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import { ScriptedAdapter } from './mod-02-tanstack-harness.js';
import { estimateTokens } from '../src/agent/execution/context-compaction.js';
import { FakeProvider } from './sandbox-fakes.js';

const DATABASE_URL = process.env['DATABASE_URL'];

describe.skipIf(!DATABASE_URL)('MOD-AI-10 compaction on a real thread (real app, real db)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base = '';
  let owner: SignedInUser;
  let stranger: SignedInUser;
  const adapter = new ScriptedAdapter();
  const recorded: AiTelemetryEvent[] = [];

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
    owner = await signIn(prisma, { label: 'compaction' });
    stranger = await signIn(prisma, { label: 'compactionx' });
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

  it('sends a long thread compacted under the budget and keeps every message', async () => {
    const previous = process.env['AGENT_CONTEXT_TRIM_TOKENS'];
    process.env['AGENT_CONTEXT_TRIM_TOKENS'] = '1500';
    try {
      const f = await thread();
      const filler = Array.from({ length: 120 }, (_, i) => `word${String(i)}`).join(' ');
      const sends = 20;
      for (let i = 0; i < sends; i += 1) {
        const payload = body(f.threadId, {
          id: `u-${randomUUID()}`,
          content: `note ${String(i)} ${filler}`,
        });
        const response = await send(f.bot.id, payload);
        expect(response.status).toBe(200);
        await response.text();
      }
      const last = adapter.calls.at(-1)?.messages ?? [];
      const estimate = last.reduce((sum, message) => sum + estimateTokens(message), 0);
      expect(estimate).toBeLessThanOrEqual(1500);
      expect(JSON.stringify(last[0]?.content)).toContain('earlier message(s) omitted');
      // The newest question is what the model answers.
      expect(JSON.stringify(last.at(-1)?.content)).toContain(`note ${String(sends - 1)}`);
      // Nothing was removed from the thread itself.
      const stored = await prisma.message.count({ where: { conversationId: f.threadId } });
      expect(stored).toBe(sends * 2);
    } finally {
      if (previous === undefined) delete process.env['AGENT_CONTEXT_TRIM_TOKENS'];
      else process.env['AGENT_CONTEXT_TRIM_TOKENS'] = previous;
    }
  }, 120_000);
});
