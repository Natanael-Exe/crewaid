import type { ChatMiddleware, GenericInterruptResolution } from '@tanstack/ai';
import { JsonSchema, ToolApprovalRequestSchema, type Json } from '@crewaid/shared';
import type { PendingToolApproval, TurnApprovalPolicy } from '../tool-approval.js';
import type { PolicyPrompt } from '../policy/runtime.js';
import { parseToolInput, type ToolSet } from '../tool-contract.js';
import type { PrivacyVault } from './privacy-vault.js';
import { toolApproval } from './tool-approval-interrupt.js';

export type AuthorizedToolResolution =
  | { readonly toolCallId: string; readonly approved: true; readonly dispatchArgs: Json }
  | { readonly toolCallId: string; readonly approved: false; readonly reason: string };
export type ToolResumeAuthorizer = (input: {
  readonly runId: string;
  readonly parentRunId: string | undefined;
  readonly threadId: string;
  readonly resolutions: ReadonlyArray<GenericInterruptResolution<typeof toolApproval>>;
}) => Promise<ReadonlyArray<AuthorizedToolResolution>>;

type PreparedCall = { args: Json } | { reason: string };

/** Per-call assessment and interrupt framing. Owned resume validation is mandatory. */
export function tanstackPolicy(deps: {
  readonly botId: string;
  readonly tools: ToolSet;
  readonly policy: Pick<TurnApprovalPolicy, 'decide'> & {
    readonly prompt: (pending: PendingToolApproval) => PolicyPrompt;
    readonly restore: () => Promise<void>;
  };
  readonly authorizeResume: ToolResumeAuthorizer;
  /** Resolves privacy vault tokens back to real values before validation, approval, and dispatch. */
  readonly vault?: PrivacyVault;
}): ChatMiddleware<unknown, typeof toolApproval> {
  const prepared = new Map<string, PreparedCall>();
  return {
    name: 'crewaid-tool-policy',
    async onInterruptBoundary(ctx) {
      if (ctx.phase !== 'beforeTools') return;
      const assistant = [...ctx.messages].reverse().find((message) => message.role === 'assistant');
      const completed = new Set(
        ctx.messages
          .filter((message) => message.role === 'tool')
          .map((message) => message.toolCallId),
      );
      // a tool this step was not sent (a deferred tool not yet loaded)
      // is answered "Unknown tool" by the engine, so it is never assessed and
      // never put to the operator.
      const sent = ctx.toolNames === undefined ? undefined : new Set(ctx.toolNames);
      const interrupts = [];
      for (const call of assistant?.toolCalls ?? []) {
        if (completed.has(call.id) || prepared.has(call.id)) continue;
        if (sent !== undefined && !sent.has(call.function.name)) {
          prepared.set(call.id, { reason: 'POLICY_DENIED: this tool is not offered.' });
          continue;
        }
        try {
          const definition = deps.tools[call.function.name];
          if (definition === undefined) throw new Error('POLICY_DENIED: this tool is not offered.');
          const rawInput: unknown = JSON.parse(call.function.arguments);
          const resolvedInput =
            deps.vault === undefined ? rawInput : deps.vault.resolveValue(rawInput);
          const args = JsonSchema.parse(
            await parseToolInput(definition.inputSchema, resolvedInput),
          );
          const decision = await deps.policy.decide({
            toolCall: { toolCallId: call.id, toolName: call.function.name, input: args },
          });
          if (typeof decision === 'object') {
            prepared.set(call.id, { reason: decision.reason });
            continue;
          }
          prepared.set(call.id, { args });
          if (decision !== 'user-approval') continue;
          const prompt = deps.policy.prompt({
            approvalId: call.id,
            toolCallId: call.id,
            toolName: call.function.name,
            args,
          });
          const payload = ToolApprovalRequestSchema.parse({
            proposalId: prompt.toolCallId,
            toolCallId: call.id,
            botId: deps.botId,
            runId: ctx.runId,
            definitionName: call.function.name,
            toolName: prompt.toolName,
            args: prompt.args,
            binding: prompt.binding,
          });
          // A prepared ASK call remains non-executable until the owned authorizer answers it.
          prepared.set(call.id, { reason: 'APPROVAL_REQUIRED: no action was dispatched.' });
          interrupts.push(
            toolApproval.interrupt({
              key: payload.proposalId,
              reason: 'policy',
              message: `Allow ${payload.toolName}?`,
              payload,
            }),
          );
        } catch (error) {
          prepared.set(call.id, {
            reason:
              error instanceof Error
                ? error.message
                : 'POLICY_UNAVAILABLE: no action was dispatched.',
          });
        }
      }
      return interrupts.length === 0 ? undefined : { interrupts };
    },
    async onInterruptResolution(ctx, resolutions) {
      const authorized = await deps.authorizeResume({
        runId: ctx.runId,
        parentRunId: ctx.parentRunId,
        threadId: ctx.threadId,
        resolutions: resolutions.for(toolApproval),
      });
      // A resumed run is a new policy runtime: the dispatch port can only run
      // what it rebuilds from durable rows, never what this process remembers.
      await deps.policy.restore();
      for (const answer of authorized)
        prepared.set(
          answer.toolCallId,
          answer.approved ? { args: answer.dispatchArgs } : { reason: answer.reason },
        );
      return { toolResume: 'continue' };
    },
    onBeforeToolCall(ctx, hook) {
      if (ctx.signal?.aborted)
        return { type: 'skip', result: 'TOOL_CANCELLED: no action was dispatched.' };
      const call = prepared.get(hook.toolCallId);
      if (call === undefined)
        return { type: 'skip', result: 'POLICY_UNAVAILABLE: this call has no owned assessment.' };
      if ('reason' in call) return { type: 'skip', result: call.reason };
      return { type: 'transformArgs', args: call.args };
    },
  };
}
