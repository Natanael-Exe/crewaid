import { isDeepStrictEqual } from 'node:util';
import type { Prisma, RunInterrupt } from '@prisma/client';
import { readInterruptBinding, type InterruptBinding } from '@tanstack/ai';
import { createInterruptBinding } from '@tanstack/ai/adapter-internals';
import { JsonSchema, ToolApprovalRequestSchema } from '@crewaid/shared';
import { z } from 'zod';
import { PolicyProposalSchema } from '../policy/proposal-store.js';
import { toolApproval } from '../execution/tool-approval-interrupt.js';
import { InterruptStoreError, type CreateInterrupt } from './prisma-interrupt-store.js';
import type { RunLease, RunScope } from './run-lease.js';

const descriptorSchema = z
  .object({
    id: z.string().min(1),
    reason: z.string().min(1),
    message: z.string(),
    expiresAt: z.string().optional(),
    metadata: z.record(z.string(), JsonSchema),
  })
  .catchall(JsonSchema);

/** Parsing locates a proposal; it does not authorize attachment or an answer. */
export function nativeToolProposalId(input: CreateInterrupt): string {
  const descriptor = descriptorSchema.parse(input.payload);
  return ToolApprovalRequestSchema.parse(descriptor.metadata['tanstack:interruptPayload'])
    .proposalId;
}

/** Called inside the adapter transaction with its captured boundary fence. */
export async function assertOwnedToolInterruptAttachment(
  tx: Prisma.TransactionClient,
  row: RunInterrupt,
  input: CreateInterrupt,
  lease: RunLease,
  fence: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
  await fence(tx);
  if (row.status !== 'pending' || row.nativeInterruptId !== null)
    throw new InterruptStoreError('INTERRUPT_NOT_ADMITTED');
  readBoundToolInterrupt(row, input, lease);
}

/** Rebuild only from a server-owned row and expected scope; this confers no policy authorization. */
export interface BoundToolInterruptRead {
  readonly request: z.infer<typeof ToolApprovalRequestSchema>;
  readonly nativeRequest: ReturnType<typeof toolApproval.interrupt>;
  readonly binding: InterruptBinding;
  readonly proposal: z.infer<typeof PolicyProposalSchema>;
}

export function readBoundToolInterrupt(
  row: RunInterrupt,
  input: CreateInterrupt,
  scope: RunScope & { readonly runId: string },
): BoundToolInterruptRead {
  const descriptor = descriptorSchema.parse(input.payload);
  const request = ToolApprovalRequestSchema.parse(descriptor.metadata['tanstack:interruptPayload']);
  const proposal = PolicyProposalSchema.parse(row.payload);
  const binding = readInterruptBinding({
    id: descriptor.id,
    reason: descriptor.reason,
    message: descriptor.message,
    metadata: descriptor.metadata,
  });
  if (
    row.userId !== scope.userId ||
    row.runId !== scope.runId ||
    row.conversationId !== scope.threadId ||
    input.runId !== scope.runId ||
    input.threadId !== scope.threadId ||
    descriptor.id !== input.interruptId ||
    request.proposalId !== row.id ||
    request.botId !== scope.botId ||
    request.runId !== scope.runId ||
    request.toolCallId !== proposal.toolCallId ||
    request.definitionName !== proposal.definitionName ||
    request.toolName !== proposal.toolName ||
    !isDeepStrictEqual(request.args, proposal.args) ||
    !isDeepStrictEqual(request.binding, proposal.binding) ||
    descriptor.reason !== 'policy' ||
    descriptor.message !== `Allow ${proposal.toolName}?` ||
    descriptor.expiresAt !== undefined ||
    binding?.kind !== 'generic' ||
    binding.generation !== 0 ||
    binding.batchIndex === undefined ||
    binding.interruptedRunId !== scope.runId
  )
    throw new InterruptStoreError('INTERRUPT_NOT_ADMITTED');
  const nativeRequest = toolApproval.interrupt({
    key: row.id,
    reason: 'policy',
    message: descriptor.message,
    payload: request,
  });
  const current = createInterruptBinding(nativeRequest, {
    threadId: scope.threadId,
    interruptedRunId: scope.runId,
    generation: 0,
    batchIndex: binding.batchIndex,
  });
  const {
    payloadSchemaCanonicalJson: _payloadSchema,
    responseSchemaCanonicalJson: responseSchema,
    threadId: _threadId,
    ...expected
  } = current.descriptor;
  if (
    !isDeepStrictEqual(descriptor.metadata['tanstack:interruptBinding'], {
      ...expected,
      interruptId: input.interruptId,
    }) ||
    responseSchema === undefined ||
    !isDeepStrictEqual(descriptor['responseSchema'], JSON.parse(responseSchema))
  )
    throw new InterruptStoreError('INTERRUPT_NOT_ADMITTED');
  return { request, nativeRequest, binding, proposal };
}
