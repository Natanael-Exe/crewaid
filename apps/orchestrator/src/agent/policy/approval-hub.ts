import { Inject, Injectable } from '@nestjs/common';
import { JsonSchema } from '@crewaid/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TurnEventBus } from '../turn-event.bus.js';
import type { ApprovalDecision } from '../tool-approval.js';
import type { PolicyPrompt } from './runtime.js';
import { PolicyProposalSchema, type ProposalStoreScope } from './proposal-store.js';

type Waiter = {
  readonly scope: ProposalStoreScope;
  readonly answer: (reply: ApprovalDecision) => Promise<ApprovalDecision | null>;
  readonly cancel: () => Promise<void>;
  readonly listeners: Set<(reply: ApprovalDecision) => void>;
  readonly failures: Set<(error: Error) => void>;
  pending: Promise<void>;
  error: Error | undefined;
  result: ApprovalDecision | null;
};

/** Shared operator transport for model calls and scheduled skills. Rows own authority. */
@Injectable()
export class ToolApprovalHub {
  private readonly waiters = new Map<string, Waiter>();
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
  ) {}

  async list(userId: string, botId: string) {
    const rows = await this.prisma.runInterrupt.findMany({
      where: {
        userId,
        status: 'pending',
        run: { botId, bot: { userId }, status: { in: ['running', 'interrupted'] } },
      },
      select: { id: true, runId: true, payload: true },
      orderBy: { sequence: 'asc' },
    });
    return rows.flatMap((row) => {
      const parsed = PolicyProposalSchema.safeParse(row.payload);
      return parsed.success
        ? [
            {
              botId,
              turnId: row.runId,
              toolCallId: row.id,
              toolName: parsed.data.toolName,
              args: parsed.data.args,
              binding: parsed.data.binding,
            },
          ]
        : [];
    });
  }
  /** Register as soon as the proposal commits, before either GET or WS can show it. */
  register(
    scope: ProposalStoreScope,
    id: string,
    answer: (id: string, reply: ApprovalDecision) => Promise<ApprovalDecision | null>,
    cancel: (id: string) => Promise<void>,
  ): void {
    if (this.waiters.has(id)) throw new Error('This approval is already registered.');
    const complete = (reply: ApprovalDecision) => {
      if (entry.result !== null) return;
      entry.result = reply;
      this.events.emitApprovalResolved(scope.botId, {
        turnId: scope.runId,
        toolCallId: id,
        approved: reply.approved,
        ...(reply.reason !== undefined && { reason: reply.reason }),
      });
      for (const listener of entry.listeners) listener(reply);
    };
    const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = entry.pending.then(operation);
      entry.pending = result.then(
        () => undefined,
        (error: unknown) => {
          entry.error = error instanceof Error ? error : new Error('Approval persistence failed.');
          for (const failure of entry.failures) failure(entry.error);
        },
      );
      return result;
    };
    const entry: Waiter = {
      scope,
      answer: (reply) =>
        serialize(async () => {
          if (entry.result !== null) return null;
          if (entry.error !== undefined) throw entry.error;
          const result = await answer(id, reply);
          if (result === null || entry.result !== null) return null;
          complete(result);
          return result;
        }),
      cancel: () =>
        serialize(async () => {
          if (entry.result !== null) return;
          await cancel(id);
          complete({ approved: false, reason: 'The run was cancelled.' });
        }),
      result: null,
      listeners: new Set(),
      failures: new Set(),
      pending: Promise.resolve(),
      error: undefined,
    };
    this.waiters.set(id, entry);
  }
  async respond(userId: string, id: string, reply: ApprovalDecision): Promise<boolean> {
    const entry = this.waiters.get(id);
    return entry?.scope.userId === userId && entry.result === null
      ? (await entry.answer(reply)) !== null
      : false;
  }
  cancelBot(userId: string, botId: string): boolean {
    const waiting = [...this.waiters.values()].filter(
      (entry) =>
        entry.scope.userId === userId && entry.scope.botId === botId && entry.result === null,
    );
    for (const entry of waiting) void entry.cancel().catch(() => undefined);
    return waiting.length > 0;
  }
  /**
   * Let go of a run's questions without answering them.
   *
   * For a run that parked: its questions are still open, and the answer comes
   * back as a resume, a new run that reads them from the store. Nothing here
   * waits on them any more, so the entries go and the rows are left alone.
   */
  forgetRun(userId: string, runId: string): void {
    for (const [id, entry] of this.waiters) {
      if (entry.scope.userId === userId && entry.scope.runId === runId) this.waiters.delete(id);
    }
  }
  async finishRun(userId: string, runId: string): Promise<void> {
    for (const [id, entry] of this.waiters) {
      if (entry.scope.userId !== userId || entry.scope.runId !== runId) continue;
      try {
        await entry.cancel();
      } finally {
        this.waiters.delete(id);
      }
    }
  }
  wait(
    scope: ProposalStoreScope,
    prompt: PolicyPrompt,
    answer: (id: string, reply: ApprovalDecision) => Promise<ApprovalDecision | null>,
    cancel: (id: string) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision> {
    if (!this.waiters.has(prompt.toolCallId))
      this.register(scope, prompt.toolCallId, answer, cancel);
    const entry = this.waiters.get(prompt.toolCallId);
    if (
      entry === undefined ||
      entry.scope.userId !== scope.userId ||
      entry.scope.runId !== scope.runId
    )
      return Promise.reject(new Error('This approval is not owned by this run.'));
    if (entry.result !== null) {
      this.waiters.delete(prompt.toolCallId);
      return Promise.resolve(entry.result);
    }
    if (entry.error !== undefined) return Promise.reject(entry.error);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        entry.listeners.delete(settle);
        entry.failures.delete(fail);
        this.waiters.delete(prompt.toolCallId);
      };
      const settle = (reply: ApprovalDecision) => {
        cleanup();
        resolve(reply);
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        void entry.cancel().catch(reject);
      };
      entry.listeners.add(settle);
      entry.failures.add(fail);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.events.emitApprovalRequested(scope.botId, {
        turnId: scope.runId,
        toolCallId: prompt.toolCallId,
        toolName: prompt.toolName,
        args: JsonSchema.parse(prompt.args),
        binding: prompt.binding,
      });
    });
  }
}
