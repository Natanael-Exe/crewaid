import type { Prisma, RunInterrupt } from '@prisma/client';
import type { GenericInterruptResolution } from '@tanstack/ai';
import type { InterruptCommitEntry } from '@tanstack/ai-persistence';
import { ToolApprovalAnswerSchema, ToolApprovalRequestSchema, type Json } from '@crewaid/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { toolApproval } from '../execution/tool-approval-interrupt.js';
import type {
  AuthorizedToolResolution,
  ToolResumeAuthorizer,
} from '../execution/tanstack-policy.js';
import { PolicyProposalSchema, ResolutionSchema } from '../policy/proposal-store.js';
import { InterruptStoreError } from './prisma-interrupt-store.js';
import { RunOwnershipError } from './run-lease.js';

/**
 * D-182's two authorities, applied before a resumed producer dispatches or
 * consumes anything. Both read the decision admission staged on the private
 * proposal row and treat it as the only truth: the runtime's claimed answer is
 * checked against it, never trusted. An approved call is handed the stored
 * definition input; the policy runtime's restored plan substitutes the staged
 * edit inside its final fence, so nothing the runtime re-supplies is run.
 *
 * Producer liveness is deliberately absent. The closing boundary's lease fence
 * owns it; these two own only the decision correspondence, so they read rows
 * the surrounding store already locked and scoped without reopening that work.
 */
type StagedDecision =
  | { readonly direction: 'cancelled' }
  | {
      readonly direction: 'approved' | 'declined';
      readonly approved: boolean;
      readonly reason: string | undefined;
      readonly args: Json;
    };

function notAdmitted(): InterruptStoreError {
  return new InterruptStoreError('INTERRUPT_NOT_ADMITTED');
}

/** A staged decision, or nothing — an unstaged proposal authorizes no claim. */
function readStagedDecision(row: RunInterrupt): StagedDecision {
  if (row.status === 'cancelled') return { direction: 'cancelled' };
  if (row.status !== 'resolved') throw notAdmitted();
  const staged = ResolutionSchema.safeParse(row.response);
  if (!staged.success) throw notAdmitted();
  return {
    direction: staged.data.approved ? 'approved' : 'declined',
    approved: staged.data.approved,
    reason: staged.data.reason,
    args: staged.data.args,
  };
}

type ClaimDirection = 'approved' | 'declined' | 'cancelled';

function claimDirection(
  resolution: GenericInterruptResolution<typeof toolApproval>,
): ClaimDirection {
  if (resolution.status === 'cancelled') return 'cancelled';
  const answer = ToolApprovalAnswerSchema.safeParse(resolution.response);
  if (!answer.success) throw notAdmitted();
  return answer.data.approved ? 'approved' : 'declined';
}

/**
 * The dispatch authorizer: every claimed tool resolution is verified against
 * the staged policy decision on its owned proposal row before a call may run.
 * A pending, foreign, missing or direction-mismatched claim fails the run
 * instead of dispatching, so a runtime that re-frames an answer can neither
 * widen a decision nor invent one.
 */
export function createOwnedToolDispatchAuthorizer(
  prisma: PrismaService,
  scope: { readonly userId: string; readonly botId: string },
): ToolResumeAuthorizer {
  return async (input) => {
    const parentRunId = input.parentRunId;
    if (parentRunId === undefined) throw new RunOwnershipError('RUN_NOT_OWNED');
    // The executing continuation must chain to the interrupted parent; a run
    // claiming somebody else's answers is exactly the forged case.
    const continuations = await prisma.agentTurn.findMany({
      where: {
        id: input.runId,
        botId: scope.botId,
        conversationId: input.threadId,
        bot: { userId: scope.userId },
      },
      select: { resumesRunId: true },
    });
    const continuation = continuations[0];
    if (continuation === undefined || continuation.resumesRunId !== parentRunId)
      throw new RunOwnershipError('RUN_NOT_OWNED');
    const rows = await prisma.runInterrupt.findMany({
      where: {
        id: { in: input.resolutions.map((resolution) => resolution.request.key) },
        userId: scope.userId,
        conversationId: input.threadId,
        runId: parentRunId,
        run: { botId: scope.botId, bot: { userId: scope.userId } },
      },
    });
    return input.resolutions.map((resolution): AuthorizedToolResolution => {
      const row = rows.find((candidate) => candidate.id === resolution.request.key);
      if (row === undefined) throw notAdmitted();
      const payload = ToolApprovalRequestSchema.safeParse(resolution.request.payload);
      const proposal = PolicyProposalSchema.safeParse(row.payload);
      if (!payload.success || !proposal.success) throw notAdmitted();
      if (
        payload.data.proposalId !== row.id ||
        payload.data.toolCallId !== proposal.data.toolCallId ||
        payload.data.botId !== scope.botId ||
        payload.data.runId !== parentRunId
      )
        throw notAdmitted();
      const staged = readStagedDecision(row);
      if (claimDirection(resolution) !== staged.direction) throw notAdmitted();
      const toolCallId = proposal.data.toolCallId;
      if (staged.direction === 'cancelled')
        return { toolCallId, approved: false, reason: 'Cancelled' };
      if (!staged.approved)
        return { toolCallId, approved: false, reason: staged.reason ?? 'Declined' };
      // The tool receives the definition input the model produced; the
      // restored plan substitutes the staged edit, so the claimed payload
      // never reaches the tool and a bridged call keeps its definition shape.
      return { toolCallId, approved: true, dispatchArgs: proposal.data.rawArgs };
    });
  };
}

/**
 * The commit authority: a native terminal write is admitted only when the
 * private proposal already carries its staged decision and the entry moves in
 * that decision's direction. Forged, pending or mismatched entries are refused
 * before any native column changes, so a batch that failed admission can never
 * be consumed and an approval is consumed exactly once.
 */
export function assertOwnedToolInterruptCommit(
  _tx: Prisma.TransactionClient,
  row: RunInterrupt,
  entry: InterruptCommitEntry,
): Promise<void> {
  // The rows are already locked and read by the store; nothing here awaits.
  return Promise.resolve().then(() => {
    const staged = readStagedDecision(row);
    if (entry.status === 'cancelled') {
      if (staged.direction !== 'cancelled') throw notAdmitted();
      return;
    }
    if (staged.direction === 'cancelled') throw notAdmitted();
    const answer = ToolApprovalAnswerSchema.safeParse(entry.response);
    if (!answer.success || answer.data.approved !== staged.approved) throw notAdmitted();
  });
}
