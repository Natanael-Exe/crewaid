import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { recordFileDeliverable } from '../src/work/file-deliverable.js';
import { DeliverablesService } from '../src/work/deliverables.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { WorkEvents } from '../src/work/work-events.js';

interface StoredDeliverable {
  id: string;
  userId: string;
  kind: 'FILE' | 'LINK' | 'MESSAGE';
  title: string;
  summary: string | null;
  botId: string | null;
  attachmentId: string | null;
  url: string | null;
  messageId: string | null;
  taskId: string | null;
  goalId: string | null;
  projectId: string | null;
  sourcePath: string | null;
  searchText: string | null;
  reviewState: 'READY' | 'REVIEWED' | 'ARCHIVED';
  supersededById: string | null;
  createdAt: Date;
}

function makeMemoryTx() {
  const deliverables: StoredDeliverable[] = [];
  const taskEvents: Array<Record<string, unknown>> = [];
  let seq = 0;

  const tx = {
    message: {
      findFirst: async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        taskId: null,
        conversation: { bot: { id: 'bot_gideon', name: 'Gideon' } },
      }),
    },
    task: {
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where.id?.startsWith('task_') === true
          ? { id: where.id, goalId: null, projectId: null, title: where.id }
          : null,
      findMany: async () => [],
    },
    goal: {
      findFirst: async () => null,
      findMany: async () => [],
    },
    project: {
      findFirst: async () => null,
      findMany: async () => [],
    },
    taskEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        taskEvents.push(data);
        return data;
      },
    },
    deliverable: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        deliverables
          .filter((row) =>
            Object.entries(where).every(([key, value]) => {
              if (value === undefined) return true;
              const actual = (row as unknown as Record<string, unknown>)[key];
              if (typeof value === 'object' && value !== null && 'in' in value) {
                return (value as { in: unknown[] }).in.includes(actual);
              }
              return actual === value;
            }),
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((row) => ({
            ...row,
            attachment:
              row.attachmentId === null
                ? null
                : {
                    id: row.attachmentId,
                    messageId: 'msg_1',
                    filename: row.title,
                    mimeType: 'text/markdown',
                    sizeBytes: 128,
                    storageKey: `2026-11-25/${row.title}`,
                    kind: 'FILE',
                    durationMs: null,
                  },
            bot: row.botId === null ? null : { name: 'Gideon' },
            task: null,
            goal: null,
          })),
      findFirst: async ({ where }: { where: { id?: string; userId?: string } }) =>
        deliverables.find(
          (row) =>
            (where.id === undefined || row.id === where.id) &&
            (where.userId === undefined || row.userId === where.userId),
        ) ?? null,
      create: async ({ data }: { data: Partial<StoredDeliverable> }) => {
        seq += 1;
        const row: StoredDeliverable = {
          id: `deliv_v${seq}`,
          userId: data.userId!,
          kind: data.kind ?? 'FILE',
          title: data.title!,
          summary: data.summary ?? null,
          botId: data.botId ?? null,
          attachmentId: data.attachmentId ?? null,
          url: data.url ?? null,
          messageId: data.messageId ?? null,
          taskId: data.taskId ?? null,
          goalId: data.goalId ?? null,
          projectId: data.projectId ?? null,
          sourcePath: data.sourcePath ?? null,
          searchText: data.searchText ?? null,
          reviewState: data.reviewState ?? 'READY',
          supersededById: data.supersededById ?? null,
          createdAt: new Date(1_764_000_000_000 + seq * 1_000),
        };
        deliverables.push(row);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { userId: string; id: { in: string[] }; supersededById: null };
        data: { supersededById: string };
      }) => {
        let count = 0;
        for (const row of deliverables) {
          if (
            row.userId === where.userId &&
            where.id.in.includes(row.id) &&
            row.supersededById === null
          ) {
            row.supersededById = data.supersededById;
            count += 1;
          }
        }
        return { count };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string; userId: string };
        data: Partial<StoredDeliverable>;
      }) => {
        const row = deliverables.find(
          (item) => item.id === where.id && item.userId === where.userId,
        );
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      },
    },
    attachment: {
      findMany: async () => [],
    },
    bot: {
      findMany: async () => [{ id: 'bot_gideon', name: 'Gideon' }],
    },
  };

  return { tx: tx as unknown as Prisma.TransactionClient, deliverables };
}

describe('Phase 3 — Deliverable immutable snapshots & exact lookup', () => {
  it('preserves prior snapshots sharing a filename and chains supersededById to the latest version', async () => {
    const { tx, deliverables } = makeMemoryTx();

    const first = await recordFileDeliverable(tx, {
      userId: 'user_1',
      attachmentId: 'att_1',
      replyId: 'msg_1',
      title: 'launch-packet.md',
      filing: { triggerMessageId: 'trig_1', sourcePath: '/home/bot/launch-packet.md' },
    });

    expect(first).toEqual({
      deliverableId: 'deliv_v1',
      taskId: null,
      version: 1,
      supersededDeliverableId: null,
    });

    const second = await recordFileDeliverable(tx, {
      userId: 'user_1',
      attachmentId: 'att_2',
      replyId: 'msg_2',
      title: 'launch-packet.md',
      filing: { triggerMessageId: 'trig_2', sourcePath: '/home/bot/launch-packet.md' },
    });

    expect(second).toEqual({
      deliverableId: 'deliv_v2',
      taskId: null,
      version: 2,
      supersededDeliverableId: 'deliv_v1',
    });

    const unrelated = await recordFileDeliverable(tx, {
      userId: 'user_1',
      attachmentId: 'att_3',
      replyId: 'msg_3',
      title: 'ad-copy.md',
      filing: { triggerMessageId: 'trig_3', sourcePath: '/home/bot/ad-copy.md' },
    });

    expect(unrelated.version).toBe(1);
    expect(unrelated.supersededDeliverableId).toBeNull();

    // Both snapshots remain immutable records; v1 points at v2, v2 and ad-copy remain active.
    const v1 = deliverables.find((row) => row.id === 'deliv_v1')!;
    const v2 = deliverables.find((row) => row.id === 'deliv_v2')!;
    const adCopy = deliverables.find((row) => row.id === 'deliv_v3')!;
    expect(v1.attachmentId).toBe('att_1');
    expect(v1.supersededById).toBe('deliv_v2');
    expect(v2.attachmentId).toBe('att_2');
    expect(v2.supersededById).toBeNull();
    expect(v2.reviewState).toBe('READY');
    expect(adCopy.supersededById).toBeNull();
  });

  it('never chains same-named files filed on different tasks or at different workspace paths', async () => {
    const { tx, deliverables } = makeMemoryTx();

    await recordFileDeliverable(tx, {
      userId: 'user_1',
      attachmentId: 'att_alpha',
      replyId: 'msg_1',
      title: 'report.md',
      filing: { triggerMessageId: 'trig_1', taskId: 'task_alpha' },
    });
    const beta = await recordFileDeliverable(tx, {
      userId: 'user_1',
      attachmentId: 'att_beta',
      replyId: 'msg_2',
      title: 'report.md',
      filing: { triggerMessageId: 'trig_2', taskId: 'task_beta' },
    });
    expect(beta.version).toBe(1);
    expect(beta.supersededDeliverableId).toBeNull();

    await recordFileDeliverable(tx, {
      userId: 'user_1',
      attachmentId: 'att_one',
      replyId: 'msg_3',
      title: 'report.md',
      filing: { triggerMessageId: 'trig_3', sourcePath: '/home/bot/one/report.md' },
    });
    const two = await recordFileDeliverable(tx, {
      userId: 'user_1',
      attachmentId: 'att_two',
      replyId: 'msg_4',
      title: 'report.md',
      filing: { triggerMessageId: 'trig_4', sourcePath: '/home/bot/two/report.md' },
    });
    expect(two.version).toBe(1);
    expect(two.supersededDeliverableId).toBeNull();

    const alphaRevision = await recordFileDeliverable(tx, {
      userId: 'user_1',
      attachmentId: 'att_alpha_2',
      replyId: 'msg_5',
      title: 'report.md',
      filing: { triggerMessageId: 'trig_5', taskId: 'task_alpha' },
    });
    expect(alphaRevision.version).toBe(2);
    expect(alphaRevision.supersededDeliverableId).toBe('deliv_v1');
    expect(deliverables.filter((row) => row.supersededById !== null).map((row) => row.id)).toEqual([
      'deliv_v1',
    ]);
  });

  it('serves GET /deliverables/:id with publisherName, reviewState, and supersededById and enforces ownership', async () => {
    const { tx } = makeMemoryTx();
    await recordFileDeliverable(tx, {
      userId: 'user_1',
      attachmentId: 'att_1',
      replyId: 'msg_1',
      title: 'launch-packet.md',
      filing: { triggerMessageId: 'trig_1' },
    });
    await recordFileDeliverable(tx, {
      userId: 'user_1',
      attachmentId: 'att_2',
      replyId: 'msg_2',
      title: 'launch-packet.md',
      filing: { triggerMessageId: 'trig_2' },
    });

    const prisma = {
      ...(tx as unknown as Record<string, unknown>),
      $transaction: async <T>(fn: (client: Prisma.TransactionClient) => Promise<T>) => fn(tx),
    } as unknown as PrismaService;
    const events = {
      deliverable: () => undefined,
      task: () => undefined,
    } as unknown as WorkEvents;
    const service = new DeliverablesService(prisma, events);

    const v1 = await service.get('user_1', 'deliv_v1');
    expect(v1.id).toBe('deliv_v1');
    expect(v1.publisherName).toBe('Gideon');
    expect(v1.reviewState).toBe('READY');
    expect(v1.supersededById).toBe('deliv_v2');

    const reviewed = await service.update('user_1', 'deliv_v2', { reviewState: 'REVIEWED' });
    expect(reviewed.reviewState).toBe('REVIEWED');
    expect(reviewed.supersededById).toBeNull();

    await expect(service.get('user_2', 'deliv_v1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.get('user_1', 'deliv_missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});
