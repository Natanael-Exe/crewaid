import { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';
import type { Prisma } from '@prisma/client';
import { EventType, type StreamChunk, type StreamDurability } from '@tanstack/ai';
import { JsonSchema } from '@crewaid/shared';
import { z } from 'zod';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { RunLease } from './run-lease.js';

/** How long a closed run's events stay replayable. */
export const RUN_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const READ_BATCH = 500;
const ChunkRowSchema = z.record(z.string(), JsonSchema);
const IDLE_POLL_MS = 1_000;

export type RunEventScope = {
  readonly userId: string;
  readonly botId: string;
  readonly threadId: string;
  readonly runId: string;
};
export class RunEventLogError extends Error {
  constructor(
    readonly code:
      | 'RUN_NOT_OWNED'
      | 'OFFSET_UNKNOWN'
      | 'OFFSET_EXPIRED'
      | 'STALE_WRITER'
      | 'READ_ONLY'
      | 'INVALID_EVENT',
  ) {
    super(code);
    this.name = 'RunEventLogError';
  }
}

/**
 * "Thread T has events after N" — a wake-up, never content. Local listeners
 * always hear it; a bridge (Redis pub/sub) carries it to other workers so a
 * reader joined on one worker tails a producer running on another.
 */
export class RunEventWakeups {
  private readonly local = new EventEmitter().setMaxListeners(0);
  private bridge: ((threadId: string, offset: string) => void) | undefined;

  /** Installs the cross-worker sender; received wake-ups come back through `deliver`. */
  bridgeTo(send: (threadId: string, offset: string) => void): void {
    this.bridge = send;
  }
  publish(threadId: string, offset: string): void {
    this.deliver(threadId, offset);
    this.bridge?.(threadId, offset);
  }
  deliver(threadId: string, offset: string): void {
    this.local.emit(threadId, offset);
  }
  /** Resolves on the next wake-up for the thread, after `ms`, or on abort. */
  next(threadId: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.local.off(threadId, done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.local.once(threadId, done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}

const EVENT_TYPES = new Set<unknown>(Object.values(EventType));

/** Rows are written only by `append` from library chunks; a row that is not one is corrupt. */
export function isRunEventChunk(value: unknown): value is StreamChunk {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'type' in value &&
    EVENT_TYPES.has(value.type)
  );
}

function parseOffset(offset: string): bigint {
  if (offset === '-1' || offset === '0') return 0n;
  if (!/^[1-9]\d{0,18}$/.test(offset)) throw new RunEventLogError('OFFSET_UNKNOWN');
  return BigInt(offset);
}

/**
 * One run's delivery log over `RunEvent`. Reads are owned
 * by the bot's principal; writes additionally need the producer's lease, and
 * are fenced by its epoch rather than its liveness, because the terminal event
 * is appended after the closing transaction released the lease. A taken-over
 * worker has a stale epoch and cannot write. Replay never starts a producer.
 */
export function createRunEventLog(
  prisma: PrismaService,
  scope: RunEventScope,
  options: {
    readonly wakeups: RunEventWakeups;
    readonly writer?: RunLease;
    readonly resumeFrom?: string | null;
    readonly idlePollMs?: number;
    readonly now?: () => number;
  },
): StreamDurability<string> {
  const owned = ownedRun(scope);
  const writer = options.writer;
  if (
    writer !== undefined &&
    (writer.runId !== scope.runId ||
      writer.botId !== scope.botId ||
      writer.threadId !== scope.threadId ||
      writer.userId !== scope.userId)
  )
    throw new RunEventLogError('RUN_NOT_OWNED');

  async function fenceWriter(tx: Prisma.TransactionClient, lease: RunLease): Promise<void> {
    // Inserts acquire a conversation FK lock. Taking the run first can
    // deadlock with canonical saves or admission holding the conversation.
    const threads = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM "Conversation" c JOIN "Bot" b ON b.id = c."botId"
      WHERE c.id = ${lease.threadId} AND b.id = ${lease.botId}
        AND b."userId" = ${lease.userId} FOR UPDATE OF c`;
    if (threads.length !== 1) throw new RunEventLogError('STALE_WRITER');
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT r.id FROM "AgentTurn" r JOIN "Bot" b ON b.id = r."botId"
      JOIN "Conversation" c ON c.id = r."conversationId" AND c."botId" = b.id
      WHERE r.id = ${lease.runId} AND b.id = ${lease.botId} AND b."userId" = ${lease.userId}
        AND c.id = ${lease.threadId}
        AND r."driverEpoch" = ${lease.epoch} AND r."eventsClosedAt" IS NULL
        AND ((r."workerId" = ${lease.workerId} AND r."leaseExpiresAt" > clock_timestamp())
          OR (r."workerId" IS NULL AND r.status::text <> 'running'))
      FOR UPDATE OF r`;
    if (rows.length !== 1) throw new RunEventLogError('STALE_WRITER');
  }

  const assertReadable = () => readRunState(prisma, scope);
  const assertOffset = (after: bigint) =>
    assertRunEventOffset(prisma, scope, after, options.now?.() ?? Date.now());

  function rows(after: bigint, limit: number) {
    return prisma.runEvent.findMany({
      where: {
        runId: scope.runId,
        userId: scope.userId,
        conversationId: scope.threadId,
        id: { gt: after },
        run: { botId: scope.botId, bot: { userId: scope.userId } },
      },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true, chunk: true },
    });
  }

  function entry(row: { id: bigint; chunk: Prisma.JsonValue }) {
    if (!isRunEventChunk(row.chunk)) throw new RunEventLogError('INVALID_EVENT');
    return { offset: row.id.toString(), chunk: row.chunk };
  }

  return {
    resumeFrom: () => options.resumeFrom ?? null,
    async append(chunks) {
      if (writer === undefined) throw new RunEventLogError('READ_ONLY');
      if (chunks.length === 0) return [];
      const ids = await prisma.$transaction(async (tx) => {
        await fenceWriter(tx, writer);
        const written = await tx.runEvent.createManyAndReturn({
          data: chunks.map((chunk) => ({
            runId: scope.runId,
            conversationId: scope.threadId,
            userId: scope.userId,
            chunk: ChunkRowSchema.parse(JSON.parse(JSON.stringify(chunk))),
          })),
          select: { id: true },
        });
        // RETURNING order is unspecified; identity allocation orders this VALUES batch.
        return written.map((row) => row.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      });
      const offsets = ids.map((id) => id.toString());
      const last = offsets.at(-1);
      if (last !== undefined) options.wakeups.publish(scope.threadId, last);
      return offsets;
    },
    async *read(offset, signal) {
      let cursor = parseOffset(offset);
      await assertOffset(cursor);
      while (signal?.aborted !== true) {
        // Listen before reading. A wake-up is published once, so one that
        // lands between this pass's reads and its wait is otherwise lost, and
        // the reader sleeps a whole idle poll on rows that are already there.
        const pass = new AbortController();
        const endPass = () => pass.abort();
        signal?.addEventListener('abort', endPass, { once: true });
        const woken = options.wakeups.next(
          scope.threadId,
          options.idlePollMs ?? IDLE_POLL_MS,
          pass.signal,
        );
        try {
          // Read the state before the rows: a close that lands between the two
          // still leaves its last rows for this pass to find.
          const state = await assertReadable();
          const batch = await rows(cursor, READ_BATCH);
          for (const row of batch) {
            yield entry(row);
            cursor = row.id;
          }
          if (batch.length === READ_BATCH) continue;
          if (state.closed || state.terminal) return;
          await woken;
        } finally {
          pass.abort();
          signal?.removeEventListener('abort', endPass);
        }
      }
    },
    async snapshot() {
      await assertReadable();
      const all = [];
      let cursor = 0n;
      for (;;) {
        const batch = await rows(cursor, READ_BATCH);
        all.push(...batch.map(entry));
        if (batch.length < READ_BATCH) return all;
        cursor = batch[batch.length - 1]!.id;
      }
    },
    async close() {
      if (writer === undefined) throw new RunEventLogError('READ_ONLY');
      await prisma.$transaction(async (tx) => {
        await fenceWriter(tx, writer);
        await tx.agentTurn.updateMany({
          where: { ...owned, eventsClosedAt: null },
          data: { eventsClosedAt: new Date() },
        });
      });
      options.wakeups.publish(scope.threadId, '0');
    },
  };
}

/** Deletes the events of logs closed longer ago than the retention period. */
export async function purgeExpiredRunEvents(
  prisma: PrismaService,
  now = Date.now(),
): Promise<number> {
  const result = await prisma.runEvent.deleteMany({
    where: { run: { eventsClosedAt: { lte: new Date(now - RUN_EVENT_RETENTION_MS) } } },
  });
  return result.count;
}

const WAKEUP_CHANNEL = 'crewaid:run-event-wakeups';

/**
 * Carries wake-ups between workers over Redis pub/sub: a thread id and an
 * offset, never an event. Without Redis a deployment is one
 * worker and local wake-ups are all there is.
 */
export async function bridgeRunEventWakeups(
  wakeups: RunEventWakeups,
  redisUrl: string,
): Promise<{ readonly close: () => Promise<void> }> {
  const publisher = new Redis(redisUrl, { lazyConnect: true });
  const subscriber = new Redis(redisUrl, { lazyConnect: true });
  await Promise.all([publisher.connect(), subscriber.connect()]);
  await subscriber.subscribe(WAKEUP_CHANNEL);
  subscriber.on('message', (_channel: string, message: string) => {
    const [threadId, offset] = message.split(' ');
    if (threadId !== undefined && offset !== undefined) wakeups.deliver(threadId, offset);
  });
  wakeups.bridgeTo((threadId, offset) => {
    void publisher.publish(WAKEUP_CHANNEL, `${threadId} ${offset}`).catch(() => undefined);
  });
  return {
    close: async () => {
      await subscriber.quit();
      await publisher.quit();
    },
  };
}

function ownedRun(scope: RunEventScope) {
  return {
    id: scope.runId,
    botId: scope.botId,
    conversationId: scope.threadId,
    bot: { userId: scope.userId },
  };
}

async function readRunState(
  prisma: PrismaService,
  scope: RunEventScope,
): Promise<{ closed: boolean; terminal: boolean }> {
  const run = await prisma.agentTurn.findFirst({
    where: ownedRun(scope),
    select: { status: true, eventsClosedAt: true },
  });
  if (run === null) throw new RunEventLogError('RUN_NOT_OWNED');
  return {
    closed: run.eventsClosedAt !== null,
    terminal: run.status !== 'running' && run.status !== 'interrupted',
  };
}

async function assertRunEventOffset(
  prisma: PrismaService,
  scope: RunEventScope,
  after: bigint,
  now: number,
): Promise<void> {
  if (after === 0n) return;
  const row = await prisma.runEvent.findFirst({
    where: { id: after, runId: scope.runId, userId: scope.userId, conversationId: scope.threadId },
    select: { id: true },
  });
  if (row !== null) return;
  // A purged log is a deterministic answer, not a missing row to wait for.
  const run = await prisma.agentTurn.findFirst({
    where: ownedRun(scope),
    select: { eventsClosedAt: true },
  });
  const closedAt = run?.eventsClosedAt;
  if (
    closedAt !== null &&
    closedAt !== undefined &&
    closedAt.getTime() <= now - RUN_EVENT_RETENTION_MS
  )
    throw new RunEventLogError('OFFSET_EXPIRED');
  throw new RunEventLogError('OFFSET_UNKNOWN');
}

/**
 * What a join must establish before it opens a stream, so its refusals are
 * status codes rather than a stream that errors: the run is owned and on this
 * thread, and the offset is the start or one of this run's rows.
 */
export async function checkRunEventJoin(
  prisma: PrismaService,
  scope: RunEventScope,
  offset: string,
  now = Date.now(),
): Promise<void> {
  await readRunState(prisma, scope);
  await assertRunEventOffset(prisma, scope, parseOffset(offset), now);
}

/** A canceled recovery has no producer left to publish its terminal event. */
export async function closeCancelledRunLog(
  prisma: PrismaService,
  lease: RunLease,
  wakeups: RunEventWakeups,
): Promise<void> {
  const log = createRunEventLog(prisma, lease, { wakeups, writer: lease });
  await log.append([
    {
      type: EventType.RUN_ERROR,
      runId: lease.runId,
      threadId: lease.threadId,
      code: 'RUN_CANCELLED',
      message: 'The bot was stopped.',
      timestamp: Date.now(),
    },
  ]);
  await log.close();
}
