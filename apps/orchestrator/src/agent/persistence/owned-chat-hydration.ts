import { uiMessagesToWire, type UIMessage } from '@tanstack/ai';
import { ChatHydrationSchema } from '@crewaid/shared';
import type { Prisma } from '@prisma/client';
import { defineAIPersistence, reconstructChat } from '@tanstack/ai-persistence';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { createPrismaInterruptStore, InterruptStoreError } from './prisma-interrupt-store.js';
import { createPrismaMessageStore } from './prisma-message-store.js';
import { createPrismaRunStore, projectRunError, RunStoreError } from './prisma-run-store.js';

/**
 * `GET /bots/:id/chat?threadId=` (D-159 §3.2): the library's hydration over
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
  // The codec's reasoning fan-outs omit metadata. Associate them with their
  // following anchor so hydration can replace all active-run parts during replay.
  let anchor: (typeof wire)[number] | undefined;
  const attributed = wire
    .toReversed()
    .map((message) => {
      if (message.role === 'assistant') anchor = message;
      else if (message.role === 'user' || message.role === 'system') anchor = undefined;
      if (message.role === 'reasoning' && anchor?.metadata !== undefined)
        return { ...message, metadata: anchor.metadata };
      return message;
    })
    .reverse();
  const envelope = ChatHydrationSchema.parse({ ...body, messages: attributed });
  if (envelope.activeRun !== null) {
    const active = await runs.get(envelope.activeRun.runId);
    if (active?.threadId === threadId) envelope.activeRun.startedAt = active.startedAt;
  }
  return Response.json(envelope, { headers: response.headers });
}
