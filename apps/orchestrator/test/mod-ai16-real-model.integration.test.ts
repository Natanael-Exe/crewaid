/**
 * @skip-reason: on-demand real-token acceptance; requires
 * MODAI16_REAL_MODEL, EVAL_API_KEY_<KIND> and DATABASE_URL. The route, the
 * assembly, the lease, the durable log and the transcript are all production;
 * the model is a real one, reached with a real key.
 *
 * D-190's last acceptance line: a user turn admitted through
 * `POST /bots/:id/chat` streams a real model's answer, and the rows the run
 * wrote agree with the events it delivered.
 */
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { EventType } from '@tanstack/ai';
import { ProviderKindSchema } from '@crewaid/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { CredentialService } from '../src/credentials/credential.service.js';
import { toDbKind } from '../src/providers/provider-connections.service.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import { FakeProvider } from './sandbox-fakes.js';

const MODEL = process.env['MODAI16_REAL_MODEL'] ?? '';
const DATABASE_URL = process.env['DATABASE_URL'];

describe.skipIf(!MODEL || !DATABASE_URL)('MOD-AI-16 real model through the send route', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: SignedInUser;
  let base = '';
  let modelId = '';

  beforeAll(async () => {
    vi.stubEnv('CREWAID_CREDENTIAL_KEYRING', JSON.stringify({ 1: '8'.repeat(64) }));
    vi.stubEnv('CREWAID_CREDENTIAL_KEY_ACTIVE', '1');
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
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1`;
    prisma = app.get(PrismaService);
    owner = await signIn(prisma, { label: 'modai16real' });

    const separator = MODEL.indexOf(':');
    const kind = ProviderKindSchema.parse(MODEL.slice(0, separator));
    const apiKey = process.env[`EVAL_API_KEY_${kind.toUpperCase()}`];
    if (!apiKey) throw new Error(`EVAL_API_KEY_${kind.toUpperCase()} is required`);
    const connection = await prisma.providerConnection.create({
      data: { userId: owner.userId, kind: toDbKind(kind), name: 'MOD-AI-16 acceptance BYOK' },
    });
    await new CredentialService(prisma).setCredential(owner.userId, connection.id, apiKey);
    const model = await prisma.providerModel.create({
      data: {
        connectionId: connection.id,
        upstreamModelId: MODEL.slice(separator + 1),
        label: 'Acceptance real model',
        contextWindow: 128000,
        supportsTools: true,
      },
      select: { id: true },
    });
    modelId = model.id;
  });
  afterAll(async () => {
    if (owner) await signOutAndDelete(prisma, owner.userId);
    await app.close();
    vi.unstubAllEnvs();
  });

  it('streams a real answer and leaves a transcript that matches the log', async () => {
    const bot = await prisma.bot.create({
      data: {
        userId: owner.userId,
        name: `real-${randomUUID().slice(0, 8)}`,
        role: 'assistant',
        avatarColor: '#8B6F47',
        systemPrompt: '',
        modelId,
      },
      select: { id: true },
    });
    const conversation = await prisma.conversation.create({
      data: { botId: bot.id },
      select: { id: true },
    });
    const messageId = `u-${randomUUID()}`;
    const runId = `run-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const response = await fetch(`${base}/bots/${bot.id}/chat`, {
      method: 'POST',
      headers: { ...owner.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadId: conversation.id,
        runId,
        messages: [
          {
            id: messageId,
            role: 'user',
            content: 'Reply with exactly the word ACCEPTED and nothing else.',
          },
        ],
        tools: [],
        context: [],
        forwardedProps: {},
      }),
    });
    expect(response.status).toBe(200);
    const events = (await response.text())
      .split('\n\n')
      .filter((frame) => frame.includes('data: '))
      .map(
        (frame) => JSON.parse(/^data: (.+)$/m.exec(frame)?.[1] ?? '{}') as Record<string, unknown>,
      );
    const streamed = events
      .filter((event) => event['type'] === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => String(event['delta'] ?? ''))
      .join('');
    expect(streamed.toUpperCase()).toContain('ACCEPTED');
    expect(events.at(-1)?.['type']).toBe(EventType.RUN_FINISHED);

    const run = await prisma.agentTurn.findUniqueOrThrow({
      where: { id: runId },
      select: { status: true, inputTokens: true, outputTokens: true, modelId: true },
    });
    expect(run.status).toBe('completed');
    // A real provider reports usage, and the run persisted what it reported.
    expect(run.inputTokens + run.outputTokens).toBeGreaterThan(0);
    const rows = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { sequence: 'asc' },
      select: { author: true, content: true, runId: true },
    });
    expect(rows[0]?.author).toBe('USER');
    const reply = rows.find((row) => row.author === 'BOT');
    // What the client was streamed is what the transcript kept.
    expect(reply?.content.toUpperCase()).toContain('ACCEPTED');
    expect(reply?.runId).toBe(runId);
    const delivered = await prisma.runEvent.count({ where: { runId } });
    expect(delivered).toBe(events.length);
  });
});
