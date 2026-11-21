import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { JsonSchema } from '@crewaid/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { ExecutionResume } from '../execution/execution-backend.port.js';
import { InterruptStoreError } from './prisma-interrupt-store.js';
import { RUN_LEASE_MS, RunOwnershipError, type RunLease } from './run-lease.js';
import {
  validateOwnedToolResumeBatch,
  type OwnedResumeBatch,
  type OwnedResumeScope,
} from './owned-resume-batch.js';

/**
 * The one successful boundary for an operator's whole answer batch: admission
 * repeats the whole-batch validation under its own locks, stages the private
 * policy decisions on the parked run's proposals, and creates the fresh
 * continuation run whose `resumesRunId` answers them — or nothing changes.
 *
 * Answers are admission, not dispatch. The native facet stays pending so the
 * resumed producer consumes it inside its own closing transaction;
 * this transaction grants no tool authority, approves no effect, and never
 * repeats a possibly committed action. A second admission finds no pending
 * private proposal and is refused, so an approval is answered exactly once.
 *
 * `runId` is the id the client chose for the continuation (D-160 §3.1). The
 * client's run id IS the run id: a client that streams its answer under one id
 * and receives a run under another cannot tell the reply it is watching from
 * one another window started, and renders both.
 */
export async function admitOwnedToolResumeBatch(
  prisma: PrismaService,
  scope: OwnedResumeScope,
  resume: readonly ExecutionResume[],
  options: { readonly leaseMs?: number; readonly runId?: string } = {},
): Promise<{ readonly lease: RunLease; readonly batch: OwnedResumeBatch }> {
  const leaseMs = options.leaseMs ?? RUN_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0)
    throw new Error('Invalid continuation lease timing.');
  try {
    return await prisma.$transaction(async (tx) => {
      const batch = await validateOwnedToolResumeBatch(tx, scope, resume);
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      if (clock === undefined) throw new Error('PostgreSQL clock unavailable.');
      for (const item of batch.pending) {
        // The batch validator refuses incomplete batches; this is a local invariant.
        const answer = batch.resume.find((entry) => entry.interruptId === item.record.interruptId);
        if (answer === undefined) throw new InterruptStoreError('INVALID_INTERRUPT_BATCH');
        const staged = await tx.runInterrupt.updateMany({
          where: { id: item.row.id, userId: scope.userId, status: 'pending' },
          data:
            answer.status === 'cancelled'
              ? { status: 'cancelled', resolvedAt: clock.now }
              : {
                  status: 'resolved',
                  resolvedAt: clock.now,
                  response: {
                    approved: answer.payload.approved,
                    source: 'operator' as const,
                    ...(answer.payload.reason === undefined
                      ? {}
                      : { reason: answer.payload.reason }),
                    // An edit takes effect only on approval; a denial records the
                    // reviewed args unchanged, mirroring the policy runtime.
                    args:
                      answer.payload.approved && answer.payload.editedArgs !== undefined
                        ? JsonSchema.parse(answer.payload.editedArgs)
                        : item.proposal.args,
                    binding: item.proposal.binding,
                  },
                },
        });
        if (staged.count !== 1) throw new InterruptStoreError('INVALID_INTERRUPT_BATCH');
      }
      // D-160's active key is unique across every run: a same-bot owner admits nothing.
      const workerId = randomUUID();
      const continuation = await tx.agentTurn.create({
        data: {
          ...(options.runId === undefined ? {} : { id: options.runId }),
          botId: scope.botId,
          conversationId: scope.threadId,
          triggerMessageId: batch.run.triggerMessageId,
          status: 'running',
          activeKey: scope.botId,
          workerId,
          driverEpoch: 1,
          leaseExpiresAt: new Date(clock.now.getTime() + leaseMs),
          resumesRunId: batch.run.id,
        },
        select: { id: true },
      });
      return {
        lease: Object.freeze({
          userId: scope.userId,
          botId: scope.botId,
          threadId: scope.threadId,
          runId: continuation.id,
          workerId,
          epoch: 1,
        }),
        batch,
      };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      throw new RunOwnershipError('RUN_BUSY');
    throw error;
  }
}
