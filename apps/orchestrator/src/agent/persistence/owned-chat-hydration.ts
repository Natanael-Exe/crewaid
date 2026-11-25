import { uiMessagesToWire, type UIMessage } from '@tanstack/ai';
import { ChatHydrationSchema } from '@crewaid/shared';
import type { Prisma } from '@prisma/client';
import { defineAIPersistence, reconstructChat } from '@tanstack/ai-persistence';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { createPrismaInterruptStore, InterruptStoreError } from './prisma-interrupt-store.js';
import { createPrismaMessageStore } from './prisma-message-store.js';
import { createPrismaRunStore, projectRunError, RunStoreError } from './prisma-run-store.js';

/**
 * `GET /bots/:id/chat?threadId=`: the library's hydration over
 * read-only views of the owned stores. Every write authority refuses, so a read
 * can never admit, attach or consume anything, and only the bot's own thread is
 * authorized — any other id is the library's 403 before a row is read.
 */
export async function hydrateOwnedChat(
  prisma: PrismaService,
  userId: string,
  threadId: string,
  request: Request,
): Promise<Response> {
  const notRun = () => Promise.reject(new RunStoreError('RUN_NOT_ADMITTED'));
  const notInterrupt = () => Promise.reject(new InterruptStoreError('INTERRUPT_NOT_ADMITTED'));
  const transaction = <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
    prisma.$transaction(operation);
  // A hydrate reads the thread for the operator, not for the model.
  const messages = createPrismaMessageStore(prisma, { userId, runId: null, view: 'operator' });
  const runs = createPrismaRunStore(
    prisma,
    { userId },
    { transaction, admitNew: notRun, assertWrite: notRun, projectError: projectRunError },
  );
  const interrupts = createPrismaInterruptStore(
    prisma,
    { userId },
    {
      transaction,
      locateProposal: notInterrupt,
      assertAttach: notInterrupt,
      assertCommit: notInterrupt,
    },
  );
  const response = await reconstructChat(
    defineAIPersistence({ stores: { messages, runs, interrupts } }),
    request,
    {
      authorize: (requested) => requested === threadId,
    },
  );
  if (!response.ok) return response;
  // This trusted library result is translated by its own codec, once, on the server.
  const body = (await response.json()) as {
    messages: UIMessage[];
    activeRun: unknown;
    interrupts: unknown;
    page?: unknown;
  };
  const wire = uiMessagesToWire(body.messages, { includeSnapshotStructuredOutput: true });
  // Provider reasoning stays internal to the execution engine and is excluded
  // from operator hydration payloads.
  const attributed = wire.filter((message) => message.role !== 'reasoning');
  const envelope = ChatHydrationSchema.parse({ ...body, messages: attributed });
  if (envelope.activeRun !== null) {
    const active = await runs.get(envelope.activeRun.runId);
    if (active?.threadId === threadId) envelope.activeRun.startedAt = active.startedAt;
  }
  return Response.json(envelope, { headers: response.headers });
}
