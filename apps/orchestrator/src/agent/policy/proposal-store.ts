import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  ApprovalBindingSchema,
  ApprovalModeSchema,
  JsonSchema,
  type ApprovalBinding,
  type Json,
} from '@crewaid/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { policyHash, type PolicyMemory, type CommitOutcome } from './policy.js';

/** Internal server records; a client cannot submit these as an approval reply. */
export const PolicyProposalSchema = z
  .object({
    type: z.literal('crewaid.tool-approval'),
    toolCallId: z.string().min(1),
    definitionName: z.string().min(1),
    toolName: z.string().min(1),
    /** The reviewed projection: what the prompt shows and the binding hashes. */
    args: JsonSchema,
    /** The definition's normalized input, which a restored plan dispatches and matches against. */
    rawArgs: JsonSchema,
    binding: ApprovalBindingSchema,
    mode: ApprovalModeSchema,
    authority: z.boolean(),
    skillRevision: z.string().min(1).optional(),
  })
  .strict()
  .refine((p) => p.toolName === p.binding.toolName, 'The proposal must name its bound tool.');
export type PolicyProposal = z.infer<typeof PolicyProposalSchema>;

const CommitOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('committed'), reference: z.string().min(1) }).strict(),
  z.object({ status: z.literal('uncertain') }).strict(),
  z.object({ status: z.literal('refused'), code: z.string().min(1) }).strict(),
]);
export const ResolutionSchema = z
  .object({
    approved: z.boolean(),
    source: z.enum(['operator', 'policy']).optional(),
    outcome: CommitOutcomeSchema.optional(),
    reason: z.string().optional(),
    args: JsonSchema,
    binding: ApprovalBindingSchema,
    /** Written before the action runs. Without an outcome beside it, the effect is uncertain. */
    dispatchedAt: z.iso.datetime().optional(),
  })
  .strict();
export type PolicyResolution = z.infer<typeof ResolutionSchema>;

const WindowSchema = z
  .object({
    type: z.literal('crewaid.identity-window'),
    sourceId: z.string().min(1),
    binding: ApprovalBindingSchema,
  })
  .strict()
  .refine(
    (p) => p.binding.scope === 'identity-turn',
    'An identity window must bind a named login.',
  );

export type ProposalStoreScope = {
  readonly userId: string;
  readonly botId: string;
  readonly conversationId: string;
  /** The durable AgentTurn id, rather than a logging correlation id. */
  readonly runId: string;
};

/** An answered proposal of the run this continuation resumes. */
export type StagedProposal = {
  readonly id: string;
  readonly proposal: PolicyProposal;
  readonly resolution: PolicyResolution | null;
};

export type PolicyProposalStore = {
  /** The parked parent's answered proposals; empty when this run resumes nothing. */
  readonly staged: () => Promise<StagedProposal[]>;
  /**
   * Records the binding a restored edit was re-assessed to, before anything
   * dispatches it; admission staged the edit without live policy state.
   */
  readonly rebind: (id: string, args: Json, binding: ApprovalBinding) => Promise<boolean>;
  /** Durably marks an approved proposal dispatched, once; false when it already was. */
  readonly claimDispatch: (id: string) => Promise<boolean>;
  readonly recordOutcome: (id: string, outcome: CommitOutcome) => Promise<void>;
  readonly assertLive: () => Promise<boolean>;
  readonly create: (proposal: PolicyProposal) => Promise<string>;
  readonly read: (id: string) => Promise<PolicyProposal | null>;
  readonly resolve: (id: string, resolution: PolicyResolution) => Promise<boolean>;
  readonly cancel: (id: string) => Promise<void>;
  readonly memory: () => Promise<PolicyMemory[]>;
  readonly openIdentityWindow: (sourceId: string, binding: ApprovalBinding) => Promise<void>;
};

export function createPolicyProposalStore(
  prisma: PrismaService,
  scope: ProposalStoreScope,
): PolicyProposalStore {
  // A continuation dispatches the decisions answered on the run it resumes, so
  // receipts and dispatch markers land on that parent's rows as well as its own.
  async function actingRunIds(): Promise<string[]> {
    const run = await prisma.agentTurn.findFirst({
      where: {
        id: scope.runId,
        botId: scope.botId,
        conversationId: scope.conversationId,
        bot: { userId: scope.userId },
      },
      select: { resumesRunId: true },
    });
    if (run === null) throw new Error('The approval run is not owned by this bot.');
    return run.resumesRunId === null ? [scope.runId] : [scope.runId, run.resumesRunId];
  }
  return {
    async staged() {
      const [, parentRunId] = await actingRunIds();
      if (parentRunId === undefined) return [];
      const rows = await prisma.runInterrupt.findMany({
        where: {
          runId: parentRunId,
          userId: scope.userId,
          conversationId: scope.conversationId,
          status: { in: ['resolved', 'cancelled'] },
          run: { botId: scope.botId, bot: { userId: scope.userId } },
        },
        select: { id: true, status: true, payload: true, response: true },
        orderBy: { sequence: 'asc' },
      });
      return rows.flatMap((row): StagedProposal[] => {
        // Identity windows share the table; only tool proposals restore plans.
        const proposal = PolicyProposalSchema.safeParse(row.payload);
        if (!proposal.success) return [];
        if (row.status === 'cancelled')
          return [{ id: row.id, proposal: proposal.data, resolution: null }];
        const resolution = ResolutionSchema.safeParse(row.response);
        if (!resolution.success) throw new Error('An answered proposal has no valid resolution.');
        return [{ id: row.id, proposal: proposal.data, resolution: resolution.data }];
      });
    },
    async rebind(id, args, input) {
      const binding = ApprovalBindingSchema.parse(input);
      const runIds = await actingRunIds();
      return prisma.$transaction(async (tx) => {
        if (!(await lockLiveRun(tx, scope))) return false;
        const rows = await tx.$queryRaw<Array<{ response: Prisma.JsonValue }>>`
          SELECT i.response FROM "RunInterrupt" i
          JOIN "AgentTurn" r ON r.id = i."runId"
          JOIN "Bot" b ON b.id = r."botId"
          WHERE i.id = ${id} AND i."runId" = ANY(${runIds}) AND i."userId" = ${scope.userId}
            AND i.status::text = 'resolved' AND b.id = ${scope.botId}
            AND b."userId" = ${scope.userId} FOR UPDATE OF i`;
        const response = ResolutionSchema.safeParse(rows[0]?.response);
        // Only the operator's still-undispatched edit of exactly these arguments.
        if (
          !response.success ||
          !response.data.approved ||
          response.data.source !== 'operator' ||
          response.data.dispatchedAt !== undefined ||
          response.data.outcome !== undefined ||
          policyHash(response.data.args) !== policyHash(args)
        )
          return false;
        const updated = await tx.runInterrupt.updateMany({
          where: { id, runId: { in: runIds }, userId: scope.userId, status: 'resolved' },
          data: { response: { ...response.data, binding } },
        });
        return updated.count === 1;
      });
    },
    async claimDispatch(id) {
      const runIds = await actingRunIds();
      return prisma.$transaction(async (tx) => {
        if (!(await lockLiveRun(tx, scope))) return false;
        const rows = await tx.$queryRaw<Array<{ response: Prisma.JsonValue }>>`
          SELECT i.response FROM "RunInterrupt" i
          JOIN "AgentTurn" r ON r.id = i."runId"
          JOIN "Bot" b ON b.id = r."botId"
          WHERE i.id = ${id} AND i."runId" = ANY(${runIds}) AND i."userId" = ${scope.userId}
            AND i.status::text = 'resolved' AND b.id = ${scope.botId}
            AND b."userId" = ${scope.userId} FOR UPDATE OF i`;
        const response = ResolutionSchema.safeParse(rows[0]?.response);
        if (
          !response.success ||
          !response.data.approved ||
          response.data.dispatchedAt !== undefined ||
          response.data.outcome !== undefined
        )
          return false;
        const marked = await tx.runInterrupt.updateMany({
          where: { id, runId: { in: runIds }, userId: scope.userId, status: 'resolved' },
          data: { response: { ...response.data, dispatchedAt: new Date().toISOString() } },
        });
        return marked.count === 1;
      });
    },
    async recordOutcome(id, input) {
      const outcome = CommitOutcomeSchema.parse(input);
      const runIds = await actingRunIds();
      const row = await prisma.runInterrupt.findFirst({
        where: {
          id,
          runId: { in: runIds },
          userId: scope.userId,
          status: 'resolved',
          run: { botId: scope.botId, bot: { userId: scope.userId } },
        },
        select: { response: true },
      });
      const response = ResolutionSchema.parse(row?.response);
      if (!response.approved) throw new Error('A declined proposal cannot carry a commit receipt.');
      const recorded = await prisma.runInterrupt.updateMany({
        where: {
          id,
          runId: { in: runIds },
          userId: scope.userId,
          status: 'resolved',
          run: { botId: scope.botId, bot: { userId: scope.userId } },
        },
        data: { response: { ...response, outcome } },
      });
      if (recorded.count !== 1) throw new Error('The owned proposal could not store its outcome.');
    },
    async assertLive() {
      return (
        (await prisma.agentTurn.findFirst({
          where: {
            id: scope.runId,
            botId: scope.botId,
            conversationId: scope.conversationId,
            status: { in: ['running', 'interrupted'] },
            bot: { userId: scope.userId },
          },
          select: { id: true },
        })) !== null
      );
    },
    create(input) {
      return prisma.$transaction(async (tx) => {
        const proposal = PolicyProposalSchema.parse(input);
        if (!(await lockLiveRun(tx, scope)))
          throw new Error('The approval run is no longer active or owned.');
        const row = await tx.runInterrupt.create({
          data: {
            runId: scope.runId,
            conversationId: scope.conversationId,
            userId: scope.userId,
            payload: proposal,
          },
          select: { id: true },
        });
        return row.id;
      });
    },
    async read(id) {
      const row = await prisma.runInterrupt.findFirst({
        where: {
          id,
          runId: scope.runId,
          userId: scope.userId,
          status: 'pending',
          run: { botId: scope.botId, bot: { userId: scope.userId } },
        },
        select: { payload: true },
      });
      if (row === null) return null;
      const parsed = PolicyProposalSchema.safeParse(row.payload);
      return parsed.success ? parsed.data : null;
    },
    resolve(id, input) {
      return prisma.$transaction(async (tx) => {
        const resolution = ResolutionSchema.parse(input);
        if (!(await lockLiveRun(tx, scope))) return false;
        const result = await tx.runInterrupt.updateMany({
          where: {
            id,
            runId: scope.runId,
            userId: scope.userId,
            status: 'pending',
            run: { botId: scope.botId, bot: { userId: scope.userId } },
          },
          data: { status: 'resolved', resolvedAt: new Date(), response: resolution },
        });
        return result.count === 1;
      });
    },
    async cancel(id) {
      await prisma.runInterrupt.updateMany({
        where: {
          id,
          runId: scope.runId,
          userId: scope.userId,
          status: 'pending',
          run: { botId: scope.botId, bot: { userId: scope.userId } },
        },
        data: { status: 'cancelled', resolvedAt: new Date() },
      });
    },
    async memory() {
      const runIds: string[] = [];
      let next: string | null = scope.runId;
      const seen = new Set<string>();
      while (next !== null) {
        if (seen.has(next)) throw new Error('An approval continuation chain is cyclic.');
        seen.add(next);
        const run: { id: string; resumesRunId: string | null } | null =
          await prisma.agentTurn.findFirst({
            where: {
              id: next,
              botId: scope.botId,
              conversationId: scope.conversationId,
              bot: { userId: scope.userId },
            },
            select: { id: true, resumesRunId: true },
          });
        if (run === null) throw new Error('An approval continuation is not owned by this bot.');
        runIds.push(run.id);
        next = run.resumesRunId;
      }
      const rows = await prisma.runInterrupt.findMany({
        where: {
          runId: { in: runIds },
          userId: scope.userId,
          status: 'resolved',
          run: { botId: scope.botId, bot: { userId: scope.userId } },
        },
        select: { payload: true, response: true },
        orderBy: { sequence: 'asc' },
      });
      const memory: PolicyMemory[] = [];
      for (const row of rows) {
        const window = WindowSchema.safeParse(row.payload);
        if (window.success) {
          memory.push({ binding: window.data.binding, mode: 'AUTO', authority: false });
          continue;
        }
        const proposal = PolicyProposalSchema.safeParse(row.payload);
        const resolution = ResolutionSchema.safeParse(row.response);
        if (
          proposal.success &&
          resolution.success &&
          resolution.data.approved &&
          resolution.data.source !== 'policy'
        ) {
          memory.push({
            binding: resolution.data.binding,
            mode: proposal.data.mode,
            authority: proposal.data.authority,
            dispatched: resolution.data.dispatchedAt !== undefined,
          });
        }
      }
      return memory;
    },
    openIdentityWindow(sourceId, binding) {
      return prisma.$transaction(async (tx) => {
        const payload = WindowSchema.parse({ type: 'crewaid.identity-window', sourceId, binding });
        if (!(await lockLiveRun(tx, scope)))
          throw new Error('The identity-window run is no longer active.');
        const source = await tx.runInterrupt.findFirst({
          where: {
            id: sourceId,
            runId: scope.runId,
            userId: scope.userId,
            status: 'resolved',
            run: { botId: scope.botId, bot: { userId: scope.userId } },
          },
          select: { payload: true, response: true },
        });
        const proposal = PolicyProposalSchema.safeParse(source?.payload);
        const resolution = ResolutionSchema.safeParse(source?.response);
        const args: Json | undefined = resolution.success ? resolution.data.args : undefined;
        if (
          !proposal.success ||
          !resolution.success ||
          !resolution.data.approved ||
          proposal.data.mode !== 'AUTO' ||
          proposal.data.toolName !== 'use_identity' ||
          args === null ||
          typeof args !== 'object' ||
          Array.isArray(args) ||
          args?.['identity'] !== binding.seat?.identity
        ) {
          throw new Error('An identity window requires an approved selection of that login.');
        }
        await tx.runInterrupt.create({
          data: {
            runId: scope.runId,
            conversationId: scope.conversationId,
            userId: scope.userId,
            status: 'resolved',
            resolvedAt: new Date(),
            payload,
            response: { approved: true },
          },
        });
      });
    },
  };
}

async function lockLiveRun(
  tx: Prisma.TransactionClient,
  scope: ProposalStoreScope,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT r.status FROM "AgentTurn" r
    JOIN "Bot" b ON b.id = r."botId"
    JOIN "Conversation" c ON c.id = r."conversationId" AND c."botId" = b.id
    WHERE r.id = ${scope.runId} AND b.id = ${scope.botId}
      AND c.id = ${scope.conversationId} AND b."userId" = ${scope.userId}
    FOR UPDATE OF r`;
  return rows[0]?.status === 'running' || rows[0]?.status === 'interrupted';
}
