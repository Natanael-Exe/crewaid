/** D-187: the Postgres delivery log, read and written the way producers and readers will. */
import { batchRunEvents } from '../src/agent/persistence/batched-events.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventType, type StreamChunk } from '@tanstack/ai';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import { RunLeaseService, type RunLease } from '../src/agent/persistence/run-lease.js';
import {
  bridgeRunEventWakeups,
  createRunEventLog,
  purgeExpiredRunEvents,
  RUN_EVENT_RETENTION_MS,
  RunEventLogError,
  RunEventWakeups,
} from '../src/agent/persistence/run-event-log.js';
import { userMessage } from './mod-ai06-owned-harness.js';
import { computerTools } from '../src/agent/computer-tools.js';
import type { ToolContext } from '../src/agent/tool-registry.js';
import { createPrismaMessageStore } from '../src/agent/persistence/prisma-message-store.js';
import { assertRunLease } from '../src/agent/persistence/run-lease.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const REDIS_URL = process.env['REDIS_URL'];

function text(delta: string): StreamChunk {
  return {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: 'm1',
    delta,
    timestamp: Date.now(),
  };
}

async function collect(iterable: AsyncIterable<{ offset: string; chunk: StreamChunk }>) {
  const out: Array<{ offset: string; chunk: StreamChunk }> = [];
  for await (const entry of iterable) out.push(entry);
  return out;
}
const deltas = (entries: Array<{ chunk: StreamChunk }>) =>
  entries.map(({ chunk }) => (chunk.type === EventType.TEXT_MESSAGE_CONTENT ? chunk.delta : '?'));

describe.skipIf(!DATABASE_URL)('MOD-AI-07 run event log (real db)', () => {
  const prisma = new PrismaService();
  let owner: SignedInUser;
  let stranger: SignedInUser;
  beforeAll(async () => {
    await prisma.$connect();
    owner = await signIn(prisma, { label: 'runeventlog' });
    stranger = await signIn(prisma, { label: 'runeventlogx' });
  });
  afterAll(async () => {
    await signOutAndDelete(prisma, owner.userId);
    await signOutAndDelete(prisma, stranger.userId);
    await prisma.$disconnect();
  });

  async function leased(user = owner) {
    const bot = await prisma.bot.create({
      data: {
        userId: user.userId,
        name: `log-${randomUUID()}`,
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
    return { scope, lease: claim.lease, triggerMessageId };
  }
  const writer = (
    wakeups: RunEventWakeups,
    f: { scope: Parameters<typeof createRunEventLog>[1]; lease: RunLease },
  ) => createRunEventLog(prisma, f.scope, { wakeups, writer: f.lease });
  const reader = (
    wakeups: RunEventWakeups,
    scope: Parameters<typeof createRunEventLog>[1],
    idlePollMs = 50,
  ) => createRunEventLog(prisma, scope, { wakeups, idlePollMs });

  it('persists a binary fs_read refusal in both durable replay and canonical history', async () => {
    const f = await leased();
    const log = writer(new RunEventWakeups(), f);
    const fsRead = computerTools({
      machines: {
        ensureSeatFor: async () => {
          throw new Error('No desktop needed for fs_read.');
        },
      },
    })
      .find((entry) => entry.name === 'fs_read')!
      .build({
        botId: f.scope.botId,
        session: async () => ({ readTextFile: async () => '\uFFFDPNG\r\n\u001A\n\u0000\u0000' }),
      } as unknown as ToolContext);
    const result = await fsRead.execute!(
      { path: 'screenshots/screen.png' },
      { toolCallId: 'binary-read', messages: [] },
    );
    expect(result).toContain('fs_read refused');
    const content = JSON.stringify(result);
    await log.append([
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: 'binary-read',
        messageId: 'binary-result',
        role: 'tool',
        content,
        timestamp: Date.now(),
      },
    ]);
    const store = createPrismaMessageStore(prisma, {
      userId: f.scope.userId,
      runId: f.scope.runId,
      fence: (tx) => assertRunLease(tx, f.lease),
    });
    await store.saveThread(f.scope.threadId, [
      ...(await store.loadThread(f.scope.threadId)),
      {
        id: `binary-call-${f.scope.runId}`,
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'binary-read',
            type: 'function',
            function: { name: 'fs_read', arguments: '{"path":"screenshots/screen.png"}' },
          },
        ],
      },
      { role: 'tool', toolCallId: 'binary-read', content },
    ]);
    expect(await store.loadThread(f.scope.threadId)).toContainEqual(
      expect.objectContaining({
        role: 'tool',
        toolCallId: 'binary-read',
        content,
      }),
    );
    expect((await log.snapshot())[0]?.chunk).toMatchObject({
      type: EventType.TOOL_CALL_RESULT,
      content,
    });
    await log.close();
  });

  it('batches a 700-token reply into bounded fenced transactions and replays every delta', async () => {
    const f = await leased();
    const wakeups = new RunEventWakeups();
    const log = writer(wakeups, f);
    const transactions = vi.spyOn(prisma, '$transaction');
    const sizes: number[] = [];
    const buffered = batchRunEvents(
      async (batch) => {
        sizes.push(batch.length);
        await log.append(batch);
      },
      () => {},
    );
    try {
      for (let index = 0; index < 700; index++) await buffered.append(text(String(index)));
      await buffered.flush();
      expect(transactions).toHaveBeenCalledTimes(22);
      expect(Math.max(...sizes)).toBe(32);
    } finally {
      transactions.mockRestore();
    }
    await log.close();
    expect(deltas(await collect(reader(wakeups, f.scope).read('-1')))).toEqual(
      Array.from({ length: 700 }, (_, i) => String(i)),
    );
  });
  it('allows conversation-first admission to finish while a durable append waits', async () => {
    const f = await leased();
    const wakeups = new RunEventWakeups();
    const log = writer(wakeups, f);
    let proceed!: () => void;
    let locked!: (pid: number) => void;
    const ready = new Promise<number>((resolve) => {
      locked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const admission = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${f.scope.threadId} FOR UPDATE`;
      const [connection] = await tx.$queryRaw<
        Array<{ pid: number }>
      >`SELECT pg_backend_pid() AS pid`;
      locked(connection!.pid);
      await release;
      await tx.$queryRaw`SELECT id FROM "AgentTurn" WHERE id = ${f.scope.runId} FOR UPDATE`;
    });
    const pid = await ready;
    const appending = log.append([text('still working')]);
    // Observe the lock wait before advancing admission. If the writer took
    // the run first, admission now completes a real PostgreSQL deadlock cycle.
    try {
      await vi.waitFor(async () => {
        const [waiting] = await prisma.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) FROM pg_stat_activity
          WHERE ${pid} = ANY(pg_blocking_pids(pid))`;
        expect(Number(waiting!.count)).toBeGreaterThan(0);
      });
    } finally {
      proceed();
    }
    await Promise.all([admission, appending]);
    expect(deltas(await log.snapshot())).toEqual(['still working']);
    await new RunLeaseService(prisma).finish(f.lease, 'completed');
    await log.close();
  });

  it('replays strictly after an offset, in order, and ends when the log closes', async () => {
    const wakeups = new RunEventWakeups();
    const f = await leased();
    const log = writer(wakeups, f);
    const offsets = await log.append([text('a'), text('b'), text('c')]);
    expect(offsets.map(BigInt)).toEqual([...offsets.map(BigInt)].sort((x, y) => (x < y ? -1 : 1)));
    await log.close();
    expect(deltas(await collect(reader(wakeups, f.scope).read('-1')))).toEqual(['a', 'b', 'c']);
    // Overlap: a reader that saw "a" resumes at "b", never seeing "a" twice.
    expect(deltas(await collect(reader(wakeups, f.scope).read(offsets[0]!)))).toEqual(['b', 'c']);
    expect(await collect(reader(wakeups, f.scope).read(offsets[2]!))).toEqual([]);
  });

  it('tails a live producer by wake-up and stops at close; concurrent readers agree', async () => {
    const wakeups = new RunEventWakeups();
    const f = await leased();
    const log = writer(wakeups, f);
    // A long idle poll proves the reader woke on the event, not on a timer.
    const readers = [1, 2].map(() => collect(reader(wakeups, f.scope, 30_000).read('-1')));
    await log.append([text('x')]);
    await log.append([text('y')]);
    await log.close();
    const [one, two] = await Promise.all(readers);
    expect(deltas(one!)).toEqual(['x', 'y']);
    expect(two).toEqual(one);
  });

  it.skipIf(!REDIS_URL)('a reader on another worker tails through the Redis wake-up', async () => {
    const producerWorker = new RunEventWakeups();
    const readerWorker = new RunEventWakeups();
    const bridges = await Promise.all([
      bridgeRunEventWakeups(producerWorker, REDIS_URL!),
      bridgeRunEventWakeups(readerWorker, REDIS_URL!),
    ]);
    try {
      const f = await leased();
      const log = writer(producerWorker, f);
      const started = Date.now();
      const tail = collect(reader(readerWorker, f.scope, 30_000).read('-1'));
      await new Promise((resolve) => setTimeout(resolve, 100));
      await log.append([text('remote')]);
      await log.close();
      expect(deltas(await tail)).toEqual(['remote']);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await Promise.all(bridges.map((bridge) => bridge.close()));
    }
  });

  it('a taken-over writer is refused and writes nothing; the new owner continues', async () => {
    const wakeups = new RunEventWakeups();
    const f = await leased();
    const stale = writer(wakeups, f);
    await stale.append([text('first')]);
    await prisma.agentTurn.update({
      where: { id: f.lease.runId },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    const takeover = await new RunLeaseService(prisma).claim({
      ...f.scope,
      triggerMessageId: f.triggerMessageId,
    });
    if (takeover.kind !== 'claimed') throw new Error('fixture');
    await expect(stale.append([text('stale')])).rejects.toMatchObject({ code: 'STALE_WRITER' });
    await expect(stale.close()).rejects.toMatchObject({ code: 'STALE_WRITER' });
    const fresh = createRunEventLog(prisma, f.scope, { wakeups, writer: takeover.lease });
    await fresh.append([text('second')]);
    await fresh.close();
    expect(deltas(await collect(reader(wakeups, f.scope).read('-1')))).toEqual(['first', 'second']);
  });

  it('the terminal event lands after the run closes; nothing lands after the log closes', async () => {
    const wakeups = new RunEventWakeups();
    const f = await leased();
    const log = writer(wakeups, f);
    // What the owned boundary leaves after closing: status set, producer fields cleared.
    await prisma.agentTurn.update({
      where: { id: f.lease.runId },
      data: { status: 'completed', workerId: null, leaseExpiresAt: null, activeKey: null },
    });
    await log.append([text('terminal')]);
    await log.close();
    await expect(log.append([text('late')])).rejects.toMatchObject({ code: 'STALE_WRITER' });
    expect(deltas(await collect(reader(wakeups, f.scope).read('-1')))).toEqual(['terminal']);
  });

  it('refuses foreign readers and offsets from another run; a reader cannot write', async () => {
    const wakeups = new RunEventWakeups();
    const mine = await leased();
    const other = await leased();
    const [foreignOffset] = await writer(wakeups, other).append([text('other')]);
    await writer(wakeups, mine).append([text('mine')]);
    for (const scope of [
      { ...mine.scope, userId: stranger.userId },
      { ...mine.scope, botId: other.scope.botId },
      { ...mine.scope, threadId: other.scope.threadId },
    ])
      await expect(collect(reader(wakeups, scope).read('-1'))).rejects.toMatchObject({
        code: 'RUN_NOT_OWNED',
      });
    await expect(collect(reader(wakeups, mine.scope).read(foreignOffset!))).rejects.toMatchObject({
      code: 'OFFSET_UNKNOWN',
    });
    await expect(collect(reader(wakeups, mine.scope).read('banana'))).rejects.toBeInstanceOf(
      RunEventLogError,
    );
    await expect(reader(wakeups, mine.scope).append([text('x')])).rejects.toMatchObject({
      code: 'READ_ONLY',
    });
    expect(() => createRunEventLog(prisma, mine.scope, { wakeups, writer: other.lease })).toThrow(
      RunEventLogError,
    );
  });

  it('retention purges closed logs and an expired offset answers deterministically', async () => {
    const wakeups = new RunEventWakeups();
    const f = await leased();
    const log = writer(wakeups, f);
    const [offset] = await log.append([text('old')]);
    await log.close();
    const longAgo = new Date(Date.now() - RUN_EVENT_RETENTION_MS - 60_000);
    await prisma.agentTurn.update({
      where: { id: f.lease.runId },
      data: { eventsClosedAt: longAgo },
    });
    expect(await purgeExpiredRunEvents(prisma)).toBeGreaterThanOrEqual(1);
    expect(await prisma.runEvent.count({ where: { runId: f.lease.runId } })).toBe(0);
    await expect(collect(reader(wakeups, f.scope).read(offset!))).rejects.toMatchObject({
      code: 'OFFSET_EXPIRED',
    });
    expect(await collect(reader(wakeups, f.scope).read('-1'))).toEqual([]);
  });

  it('a dead producer is not hidden: the tail waits for recovery instead of ending', async () => {
    const wakeups = new RunEventWakeups();
    const f = await leased();
    await writer(wakeups, f).append([text('before')]);
    await prisma.agentTurn.update({
      where: { id: f.lease.runId },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    const seen: string[] = [];
    const controller = new AbortController();
    const tail = (async () => {
      for await (const entry of reader(wakeups, f.scope).read('-1', controller.signal))
        seen.push(...deltas([entry]));
    })();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen).toEqual(['before']);
    // Recovery takes the run over and continues the same log.
    const takeover = await new RunLeaseService(prisma).claim({
      ...f.scope,
      triggerMessageId: f.triggerMessageId,
    });
    if (takeover.kind !== 'claimed') throw new Error('fixture');
    const recovered = createRunEventLog(prisma, f.scope, { wakeups, writer: takeover.lease });
    await recovered.append([text('after')]);
    await recovered.close();
    await tail;
    expect(seen).toEqual(['before', 'after']);
    expect(controller.signal.aborted).toBe(false);
  });

  it('snapshot returns what is stored now without waiting on an open log', async () => {
    const wakeups = new RunEventWakeups();
    const f = await leased();
    const log = writer(wakeups, f);
    expect(await reader(wakeups, f.scope).snapshot()).toEqual([]);
    await log.append([text('one'), text('two')]);
    expect(deltas(await reader(wakeups, f.scope).snapshot())).toEqual(['one', 'two']);
  });
});
