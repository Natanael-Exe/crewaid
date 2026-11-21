/**
 * D-159 §3.2 / D-187: `GET /bots/:id/chat?runId=&offset=` through the real
 * application — AuthGuard, the ownership marker, the SSE encoding and a live
 * tail over a loopback socket, read the way the stock client reads it.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { EventType, type StreamChunk } from '@tanstack/ai';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import { RunLeaseService } from '../src/agent/persistence/run-lease.js';
import {
  createRunEventLog,
  RUN_EVENT_RETENTION_MS,
} from '../src/agent/persistence/run-event-log.js';
import { RunEventWakeupsService } from '../src/chat/run-event-wakeups.service.js';
import { ownedThread, produceOwned, userMessage } from './mod-ai06-owned-harness.js';

const DATABASE_URL = process.env['DATABASE_URL'];

function text(delta: string): StreamChunk {
  return { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta, timestamp: Date.now() };
}

/** SSE frames as the stock client parses them: `id:` and `data:` lines. */
function frames(body: string): Array<{ id: string | undefined; delta: string }> {
  return body
    .split('\n\n')
    .filter((frame) => frame.includes('data: '))
    .map((frame) => {
      const id = /^id: (.+)$/m.exec(frame)?.[1];
      const data = JSON.parse(/^data: (.+)$/m.exec(frame)?.[1] ?? '{}') as { delta?: string };
      return { id, delta: data.delta ?? '?' };
    });
}

describe.skipIf(!DATABASE_URL)('MOD-AI-07 chat join route (real app, real db)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let wakeups: RunEventWakeupsService;
  let base = '';
  let owner: SignedInUser;
  let stranger: SignedInUser;

  beforeAll(async () => {
    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('../src/app.module.js');
    const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new CrewaidWsAdapter(app));
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}/api/v1`;
    prisma = app.get(PrismaService);
    wakeups = app.get(RunEventWakeupsService);
    owner = await signIn(prisma, { label: 'chatjoin' });
    stranger = await signIn(prisma, { label: 'chatjoinx' });
    // The whole app, cold: as the first suite of a full run, while turbo tests
    // the other packages beside it, this boot alone outlasts the 10 s default.
  }, 60_000);
  afterAll(async () => {
    await signOutAndDelete(prisma, owner.userId);
    await signOutAndDelete(prisma, stranger.userId);
    await app.close();
  });

  async function run(user = owner) {
    const bot = await prisma.bot.create({
      data: {
        userId: user.userId,
        name: `join-${randomUUID()}`,
        role: 'fixture',
        avatarColor: '#8B6F47',
        systemPrompt: '',
      },
    });
    const thread = await prisma.conversation.create({
      data: { botId: bot.id },
    });
    const triggerMessageId = await userMessage(prisma, bot.id, thread.id, 'hello');
    const claim = await new RunLeaseService(prisma).claim({
      userId: user.userId,
      botId: bot.id,
      threadId: thread.id,
      runId: randomUUID(),
      triggerMessageId,
    });
    if (claim.kind !== 'claimed') throw new Error('fixture');
    const scope = {
      userId: user.userId,
      botId: bot.id,
      threadId: thread.id,
      runId: claim.lease.runId,
    };
    return {
      bot,
      scope,
      lease: claim.lease,
      log: createRunEventLog(prisma, scope, { wakeups, writer: claim.lease }),
    };
  }
  const url = (botId: string, query: string) => `${base}/bots/${botId}/chat?${query}`;

  it('replays a closed log as SSE frames tagged with offsets, and resumes after one', async () => {
    const f = await run();
    const offsets = await f.log.append([text('a'), text('b'), text('c')]);
    await f.log.close();
    const response = await fetch(url(f.bot.id, `runId=${f.scope.runId}`), {
      headers: owner.headers,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(frames(await response.text())).toEqual([
      { id: offsets[0], delta: 'a' },
      { id: offsets[1], delta: 'b' },
      { id: offsets[2], delta: 'c' },
    ]);
    // The stock client reconnects with Last-Event-ID; nothing is delivered twice.
    const resumed = await fetch(url(f.bot.id, `runId=${f.scope.runId}`), {
      headers: { ...owner.headers, 'Last-Event-ID': offsets[0]! },
    });
    expect(frames(await resumed.text()).map((frame) => frame.delta)).toEqual(['b', 'c']);
    const byQuery = await fetch(url(f.bot.id, `runId=${f.scope.runId}&offset=${offsets[1]}`), {
      headers: owner.headers,
    });
    expect(frames(await byQuery.text()).map((frame) => frame.delta)).toEqual(['c']);
  });

  it('tails a live producer and ends when its log closes', async () => {
    const f = await run();
    await f.log.append([text('early')]);
    const response = await fetch(url(f.bot.id, `runId=${f.scope.runId}`), {
      headers: owner.headers,
    });
    const body = response.text();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await f.log.append([text('late')]);
    await f.log.close();
    expect(frames(await body).map((frame) => frame.delta)).toEqual(['early', 'late']);
  });

  it('refuses without auth, for a foreign bot, a run on another thread, and bad offsets', async () => {
    const f = await run();
    const [offset] = await f.log.append([text('x')]);
    await f.log.close();
    const other = await run();
    const theirs = await run(stranger);
    expect((await fetch(url(f.bot.id, `runId=${f.scope.runId}`))).status).toBe(401);
    // The marker answers a foreign bot before the handler runs.
    expect(
      (await fetch(url(theirs.bot.id, `runId=${theirs.scope.runId}`), { headers: owner.headers }))
        .status,
    ).toBe(404);
    expect(
      (await fetch(url(f.bot.id, `runId=${other.scope.runId}`), { headers: owner.headers })).status,
    ).toBe(404);
    expect(
      (await fetch(url(f.bot.id, `runId=${randomUUID()}`), { headers: owner.headers })).status,
    ).toBe(404);
    const [foreignOffset] = await other.log.append([text('y')]);
    expect(
      (
        await fetch(url(f.bot.id, `runId=${f.scope.runId}&offset=${foreignOffset}`), {
          headers: owner.headers,
        })
      ).status,
    ).toBe(400);
    expect(
      (await fetch(url(f.bot.id, `runId=${f.scope.runId}&offset=nope`), { headers: owner.headers }))
        .status,
    ).toBe(400);
    await prisma.agentTurn.update({
      where: { id: f.scope.runId },
      data: { eventsClosedAt: new Date(Date.now() - RUN_EVENT_RETENTION_MS - 60_000) },
    });
    await prisma.runEvent.deleteMany({ where: { runId: f.scope.runId } });
    expect(
      (
        await fetch(url(f.bot.id, `runId=${f.scope.runId}&offset=${offset}`), {
          headers: owner.headers,
        })
      ).status,
    ).toBe(410);
  });

  it('a disconnect ends only the join; the producer keeps writing', async () => {
    const f = await run();
    const controller = new AbortController();
    const response = await fetch(url(f.bot.id, `runId=${f.scope.runId}`), {
      headers: owner.headers,
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    controller.abort();
    await f.log.append([text('after-disconnect')]);
    await f.log.close();
    const replay = await fetch(url(f.bot.id, `runId=${f.scope.runId}`), { headers: owner.headers });
    expect(frames(await replay.text()).map((frame) => frame.delta)).toEqual(['after-disconnect']);
  });

  it('a revoked session stops receiving within one keep-alive interval', async () => {
    const reader = await signIn(prisma, { label: 'chatjoinrevoke' });
    try {
      const f = await run(reader);
      await f.log.append([text('before')]);
      const response = await fetch(url(f.bot.id, `runId=${f.scope.runId}`), {
        headers: reader.headers,
      });
      const body = response.text();
      await prisma.session.deleteMany({ where: { token: reader.token } });
      // The log never closes: only the revocation can end this stream.
      expect(frames(await body).map((frame) => frame.delta)).toEqual(['before']);
    } finally {
      await signOutAndDelete(prisma, reader.userId);
    }
  }, 30_000);

  it('hydrates the owned thread: transcript, no active run, and the pending approval', async () => {
    const t = await ownedThread(prisma, owner.userId);
    expect((await produceOwned(prisma, t, t.first, async () => 'never')).status).toBe(
      'interrupted',
    );
    const response = await fetch(url(t.botId, `threadId=${t.threadId}`), {
      headers: owner.headers,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      messages: Array<{ role: string }>;
      activeRun: unknown;
      interrupts: { runId: string; pending: unknown[] } | null;
    };
    expect(body.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(body.activeRun).toBeNull();
    expect(body.interrupts?.runId).toBe(t.first.runId);
    expect(body.interrupts?.pending).toHaveLength(1);
    expect(
      (await fetch(url(t.botId, `threadId=${randomUUID()}`), { headers: owner.headers })).status,
    ).toBe(404);
    expect(
      (await fetch(url(t.botId, `threadId=${t.threadId}`), { headers: stranger.headers })).status,
    ).toBe(404);
    expect(
      (
        await fetch(url(t.botId, `threadId=${t.threadId}&runId=${t.first.runId}`), {
          headers: owner.headers,
        })
      ).status,
    ).toBe(400);
  });
  it('hydrates the original admitted clock for an active run', async () => {
    const f = await run();
    const startedAt = new Date(Date.now() - 600_000);
    await prisma.agentTurn.updateMany({
      where: { id: f.lease.runId, bot: { userId: owner.userId } },
      data: { startedAt },
    });
    const response = await fetch(url(f.scope.botId, `threadId=${f.scope.threadId}`), {
      headers: owner.headers,
    });
    expect(response.status).toBe(200);
    expect((await response.json()).activeRun).toEqual({
      runId: f.lease.runId,
      startedAt: startedAt.getTime(),
    });
    await new RunLeaseService(prisma).finish(f.lease, 'aborted');
    await f.log.close();
  });

  it('a client built for another wire version is refused plainly', async () => {
    const f = await run();
    await f.log.close();
    const refused = await fetch(url(f.bot.id, `runId=${f.scope.runId}`), {
      headers: { ...owner.headers, 'X-Crewaid-Wire-Version': '1' },
    });
    expect(refused.status).toBe(426);
    expect(await refused.json()).toMatchObject({ code: 'WIRE_VERSION_UNSUPPORTED' });
    const served = await fetch(url(f.bot.id, `runId=${f.scope.runId}`), {
      headers: owner.headers,
    });
    expect(served.headers.get('x-crewaid-wire-version')).toBe('2');
  });

  it('a client dropped mid-run reconnects with Last-Event-ID and misses nothing', async () => {
    const t = await ownedThread(prisma, owner.userId);
    // A real producer: tokens, a tool call and an approval pause into the log.
    const producing = produceOwned(prisma, t, t.first, async () => 'never', undefined, {
      wakeups,
    });
    const first = await fetch(url(t.botId, `runId=${t.first.runId}`), { headers: owner.headers });
    const reader = first.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    while (frames(seen).length < 2) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    const before = frames(seen);
    const last = before.at(-1)?.id;
    expect(last).toBeDefined();
    expect((await producing).status).toBe('interrupted');
    const rest = await fetch(url(t.botId, `runId=${t.first.runId}`), {
      headers: { ...owner.headers, 'Last-Event-ID': last! },
    });
    const after = frames(await rest.text());
    const whole = frames(
      await (
        await fetch(url(t.botId, `runId=${t.first.runId}`), { headers: owner.headers })
      ).text(),
    );
    const ids = [...before, ...after].map((frame) => frame.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(whole.map((frame) => frame.id));
  });
});
