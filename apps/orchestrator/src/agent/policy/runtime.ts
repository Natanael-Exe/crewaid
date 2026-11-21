import { JsonSchema, type ApprovalBinding, type Json } from '@crewaid/shared';
import type {
  ApprovalDecision,
  PendingToolApproval,
  TurnApprovalPolicy,
} from '../tool-approval.js';
import type { ToolCallProjection } from '../tool-registry.js';
import {
  assessPolicy,
  recheckPolicy,
  sameBinding,
  policyHash,
  type PolicySnapshot,
} from './policy.js';
import type { DispatchLedger, DispatchOutcome } from './dispatch-ledger.js';
import type { PolicyProposalStore } from './proposal-store.js';
import type { ArgumentValidator } from './validate-arguments.js';

export type PolicyCall = ToolCallProjection & {
  readonly args: Json;
  readonly requiredIdentity?: string;
};
export type PolicyState = {
  readonly snapshot: PolicySnapshot;
  readonly validate?: ArgumentValidator;
  readonly skillRevision?: string;
};
export type PolicyPrompt = PendingToolApproval & { readonly binding: ApprovalBinding };
export type ToolDispatchPort = {
  readonly execute: (
    name: string,
    args: unknown,
    id: string,
    action: (args: Json) => Promise<unknown>,
  ) => Promise<unknown>;
  readonly skillPermit: (id: string) => (revision: string, params: unknown) => Promise<void>;
};
type Plan = {
  readonly definitionName: string;
  readonly rawArgs: Json;
  call: PolicyCall;
  binding: ApprovalBinding;
  readonly mode: PolicySnapshot['mode'];
  readonly authority: boolean;
  proposalId: string | null;
  authorized: boolean;
  consumed: boolean;
  edited: boolean;
  skillRevision: string | undefined;
};

/** One run's policy ports. No SDK, Nest, database driver or transport is required. */
export function createPolicyRuntime(deps: {
  readonly project: (name: string, args: unknown) => ToolCallProjection;
  readonly read: (call: PolicyCall, prepare: boolean) => Promise<PolicyState>;
  readonly store: PolicyProposalStore;
  readonly preflight?: (name: string) => Promise<string | null>;
  readonly onProposal?: (id: string) => void;
  readonly afterIdentity?: () => Promise<PolicyState | null>;
  /** The run's dispatch ledger. Absent, nothing is recorded (unit tests). */
  readonly dispatches?: DispatchLedger;
}): TurnApprovalPolicy &
  ToolDispatchPort & {
    readonly prompt: (pending: PendingToolApproval) => PolicyPrompt;
    readonly answer: (id: string, reply: ApprovalDecision) => Promise<ApprovalDecision | null>;
    readonly cancel: (id: string) => Promise<void>;
    readonly restore: () => Promise<void>;
  } {
  const plans = new Map<string, Plan>();
  const proposals = new Map<string, Plan>();
  const evaluating = new Set<string>();
  async function assessment(call: PolicyCall, prepare: boolean) {
    const state = await deps.read(call, prepare);
    const validation = await state.validate?.(call.args);
    if (validation?.ok === false) throw new Error(`INVALID_ARGUMENTS: ${validation.reason}`);
    if (validation?.ok === true && !sameJson(call.args, validation.value))
      throw new Error(
        'INVALID_ARGUMENTS: schema transformations cannot change reviewed arguments.',
      );
    return {
      state,
      policy: assessPolicy({
        name: call.name,
        args: call.args,
        behavior: call.behavior,
        snapshot: state.snapshot,
        memory: await deps.store.memory(),
        ...(call.commitAdapter !== undefined && {
          commit: await call.commitAdapter.proposal(call.args),
        }),
      }),
    };
  }
  async function fence(plan: Plan): Promise<void> {
    if (!(await deps.store.assertLive()))
      throw new Error('APPROVAL_STALE: this run is no longer active.');
    const { policy } = await assessment(plan.call, false);
    const check = recheckPolicy(plan.binding, policy);
    if (!check.ok) throw new Error(`${check.code}: propose a fresh call for approval.`);
  }
  return {
    async decide({ toolCall }) {
      if (toolCall.toolCallId === undefined)
        return { type: 'denied', reason: 'Missing server tool-call id.' };
      if (evaluating.has(toolCall.toolCallId))
        return { type: 'denied', reason: 'APPROVAL_STALE: this call is already being evaluated.' };
      const existing = plans.get(toolCall.toolCallId);
      if (existing !== undefined) {
        if (
          existing.consumed ||
          existing.definitionName !== toolCall.toolName ||
          !sameJson(existing.rawArgs, toolCall.input)
        )
          return { type: 'denied', reason: 'APPROVAL_STALE: this call was consumed or changed.' };
        try {
          const current = await assessment(existing.call, false);
          if (
            current.policy.binding === null ||
            !sameBinding(existing.binding, current.policy.binding) ||
            current.policy.decision === 'deny'
          )
            return { type: 'denied', reason: current.policy.code ?? 'APPROVAL_STALE' };
          return current.policy.decision === 'allow' ? 'not-applicable' : 'user-approval';
        } catch (error) {
          return {
            type: 'denied',
            reason: error instanceof Error ? error.message : 'APPROVAL_STALE',
          };
        }
      }
      evaluating.add(toolCall.toolCallId);
      try {
        const blocked = await deps.preflight?.(toolCall.toolName);
        if (blocked !== undefined && blocked !== null) return { type: 'denied', reason: blocked };
        const rawArgs = JsonSchema.parse(toolCall.input);
        const projected = deps.project(toolCall.toolName, rawArgs);
        const call = { ...projected, args: JsonSchema.parse(projected.args) };
        const { state, policy } = await assessment(call, true);
        if (policy.decision === 'deny' || policy.binding === null) {
          return {
            type: 'denied',
            reason: policy.code ?? 'POLICY_DENIED: this call is not authorized.',
          };
        }
        const plan: Plan = {
          definitionName: toolCall.toolName,
          rawArgs,
          call: {
            ...call,
            ...(state.snapshot.seat?.identity !== null &&
              state.snapshot.seat?.identity !== undefined && {
                requiredIdentity: state.snapshot.seat.identity,
              }),
          },
          binding: policy.binding,
          mode: state.snapshot.mode,
          authority: call.behavior?.authority ?? false,
          proposalId: null,
          authorized: policy.decision === 'allow',
          consumed: false,
          edited: false,
          skillRevision: state.skillRevision,
        };
        plans.set(toolCall.toolCallId, plan);
        if (policy.decision === 'allow' && call.commitAdapter === undefined)
          return 'not-applicable';
        plan.proposalId = await deps.store.create({
          type: 'crewaid.tool-approval',
          toolCallId: toolCall.toolCallId,
          definitionName: toolCall.toolName,
          toolName: call.name,
          args: call.args,
          rawArgs,
          binding: plan.binding,
          mode: plan.mode,
          authority: plan.authority,
          ...(plan.skillRevision !== undefined && { skillRevision: plan.skillRevision }),
        });
        proposals.set(plan.proposalId, plan);
        if (policy.decision === 'allow') {
          if (
            !(await deps.store.resolve(plan.proposalId, {
              approved: true,
              source: 'policy',
              args: plan.call.args,
              binding: plan.binding,
            }))
          )
            throw new Error('APPROVAL_STALE: the policy approval could not be recorded.');
          return 'not-applicable';
        }
        deps.onProposal?.(plan.proposalId);
        return 'user-approval';
      } catch (error) {
        const failed = plans.get(toolCall.toolCallId);
        if (failed !== undefined) {
          failed.consumed = true;
          if (failed.proposalId !== null) await deps.store.cancel(failed.proposalId);
        }
        return {
          type: 'denied',
          reason:
            error instanceof Error
              ? error.message
              : 'POLICY_UNAVAILABLE: this call cannot be authorized.',
        };
      } finally {
        evaluating.delete(toolCall.toolCallId);
      }
    },
    // The durable resolution supplies memory. The SDK adapter never grants by name.
    remember() {},
    prompt(pending) {
      const plan = plans.get(pending.toolCallId);
      if (plan?.proposalId === null || plan === undefined)
        throw new Error('No durable proposal exists for this tool call.');
      return {
        ...pending,
        toolCallId: plan.proposalId,
        toolName: plan.call.name,
        args: plan.call.args,
        binding: plan.binding,
      };
    },
    async answer(id, reply) {
      const plan = proposals.get(id);
      if (plan === undefined || plan.consumed || (await deps.store.read(id)) === null) return null;
      let approved = reply.approved;
      let reason = reply.reason;
      let call = plan.call;
      let binding = plan.binding;
      let skillRevision = plan.skillRevision;
      try {
        // An edit cannot conceal a changed grant, resource, login or browser.
        const before = await assessment(plan.call, false);
        if (
          before.policy.binding === null ||
          !sameBinding(plan.binding, before.policy.binding) ||
          before.policy.decision === 'deny'
        ) {
          throw new Error(before.policy.code ?? 'APPROVAL_STALE');
        }
        if (approved && reply.editedArgs !== undefined) {
          if (plan.binding.scope !== 'call')
            throw new Error('INVALID_ARGUMENTS: identity-window approvals cannot edit a call.');
          call = { ...call, args: JsonSchema.parse(reply.editedArgs) };
          const edited = await assessment(call, false);
          if (edited.policy.binding === null || edited.policy.decision === 'deny')
            throw new Error(edited.policy.code ?? 'POLICY_DENIED');
          binding = edited.policy.binding;
          skillRevision = edited.state.skillRevision;
        }
      } catch (error) {
        approved = false;
        reason = error instanceof Error ? error.message : 'APPROVAL_STALE';
      }
      if (
        !(await deps.store.resolve(id, {
          approved,
          source: 'operator',
          ...(reason !== undefined && { reason }),
          args: call.args,
          binding,
        }))
      )
        return null;
      plan.call = call;
      plan.binding = binding;
      plan.authorized = approved;
      plan.skillRevision = skillRevision;
      plan.edited = approved && reply.editedArgs !== undefined;
      return { approved, ...(reason !== undefined && { reason }) };
    },
    /**
     * Rebuilds the plans a resumed run dispatches from the parent's durable
     * proposals, so no in-memory continuation is needed. A plan is restored
     * only from what was reviewed: the stored raw input must still project to
     * the reviewed call, an edit is re-assessed like a live answer, and a
     * proposal already marked dispatched is restored consumed — its effect
     * may have happened, so it is never run again.
     */
    async restore() {
      for (const staged of await deps.store.staged()) {
        const { proposal, resolution } = staged;
        // Policy-approved rows belong to calls the resumed step decides afresh.
        if (resolution?.source === 'policy') continue;
        // A plan this runtime decided or answered itself already carries its authority.
        if (plans.has(proposal.toolCallId)) continue;
        const projected = deps.project(proposal.definitionName, proposal.rawArgs);
        const plan: Plan = {
          definitionName: proposal.definitionName,
          rawArgs: proposal.rawArgs,
          call: {
            ...projected,
            args: proposal.args,
            ...(proposal.binding.seat?.identity !== null &&
              proposal.binding.seat?.identity !== undefined && {
                requiredIdentity: proposal.binding.seat.identity,
              }),
          },
          binding: proposal.binding,
          mode: proposal.mode,
          authority: proposal.authority,
          proposalId: staged.id,
          authorized: false,
          consumed:
            resolution === null ||
            resolution.dispatchedAt !== undefined ||
            resolution.outcome !== undefined,
          edited: false,
          skillRevision: proposal.skillRevision,
        };
        plans.set(proposal.toolCallId, plan);
        proposals.set(staged.id, plan);
        if (resolution === null || !resolution.approved || plan.consumed) continue;
        if (
          projected.name !== proposal.toolName ||
          !sameJson(JsonSchema.parse(projected.args), proposal.args)
        )
          continue;
        if (!sameJson(resolution.args, proposal.args)) {
          if (proposal.binding.scope !== 'call') continue;
          try {
            const call = { ...plan.call, args: resolution.args };
            const edited = await assessment(call, false);
            if (edited.policy.binding === null || edited.policy.decision === 'deny') continue;
            // Memory must hold the edited binding, as a live answer would, or the
            // final fence reads the approval as missing.
            if (!(await deps.store.rebind(staged.id, call.args, edited.policy.binding))) continue;
            plan.call = call;
            plan.binding = edited.policy.binding;
            plan.skillRevision = edited.state.skillRevision;
            plan.edited = true;
          } catch {
            continue;
          }
        }
        plan.authorized = true;
      }
    },
    async cancel(id) {
      await deps.store.cancel(id);
      const plan = proposals.get(id);
      if (plan !== undefined) plan.authorized = false;
    },
    async execute(name, args, id, action) {
      const plan = plans.get(id);
      if (
        plan === undefined ||
        !plan.authorized ||
        plan.consumed ||
        plan.definitionName !== name ||
        !sameJson(plan.rawArgs, args)
      ) {
        return plan?.consumed === true && plan.proposalId !== null
          ? DISPATCH_UNCERTAIN
          : 'APPROVAL_STALE: this call has no unused server authorization.';
      }
      // Consume before any uncertain side effect; a retry needs a fresh proposal.
      plan.consumed = true;
      try {
        await fence(plan);
        // The durable half of consuming: a restart that finds this marker
        // without an outcome treats the effect as uncertain, never as unrun.
        if (plan.proposalId !== null && !(await deps.store.claimDispatch(plan.proposalId)))
          return DISPATCH_UNCERTAIN;
        const finalArgs = plan.edited
          ? (plan.call.repackArgs?.(plan.call.args) ?? plan.call.args)
          : plan.rawArgs;
        // D-197: anything but a read reserves its row before it runs, and a
        // call that already has one is answered from it, never run again.
        const effect = plan.call.behavior?.effect ?? 'unknown';
        let dispatch: string | undefined;
        if (deps.dispatches !== undefined && effect !== 'read') {
          const reservation = await deps.dispatches.reserve({
            toolCallId: id,
            toolName: plan.call.name,
            effect,
            args: finalArgs,
          });
          if (reservation.kind === 'existing') {
            if (reservation.status === 'DISPATCHED') await deps.dispatches.abandon(id);
            return reservation.status === 'COMMITTED'
              ? ALREADY_DONE
              : reservation.status === 'REFUSED'
                ? REFUSED_BEFORE
                : OUTCOME_UNKNOWN;
          }
          dispatch = reservation.id;
        }
        const settle = (outcome: DispatchOutcome, reference?: string) =>
          dispatch === undefined
            ? Promise.resolve()
            : // A settle that fails leaves the row DISPATCHED, which reads as unknown.
              deps.dispatches?.settle(dispatch, outcome, reference).catch(() => undefined);
        let output: unknown;
        try {
          output = await action(finalArgs);
        } catch (error) {
          await settle(
            error instanceof Error && error.message.includes(NOTHING_DISPATCHED)
              ? 'REFUSED'
              : 'UNCERTAIN',
          );
          if (plan.call.commitAdapter === undefined || plan.proposalId === null) throw error;
          const outcome = { status: 'uncertain' as const };
          await deps.store.recordOutcome(plan.proposalId, outcome).catch(() => undefined);
          return { actualArguments: plan.call.args, outcome };
        }
        if (plan.call.commitAdapter !== undefined && plan.proposalId !== null) {
          let outcome;
          try {
            outcome = await plan.call.commitAdapter.outcome(output);
          } catch {
            outcome = { status: 'uncertain' as const };
          }
          try {
            await deps.store.recordOutcome(plan.proposalId, outcome);
          } catch {
            outcome = { status: 'uncertain' as const };
          }
          await settle(
            outcome.status === 'committed'
              ? 'COMMITTED'
              : outcome.status === 'refused'
                ? 'REFUSED'
                : 'UNCERTAIN',
            outcome.status === 'committed' ? outcome.reference : undefined,
          );
          return { actualArguments: plan.call.args, outcome, output };
        }
        await settle('COMMITTED');
        if (
          name === 'use_identity' &&
          plan.proposalId !== null &&
          plan.mode === 'AUTO' &&
          deps.afterIdentity !== undefined
        ) {
          try {
            const state = await deps.afterIdentity();
            if (state !== null) {
              const window = assessPolicy({
                name: 'browser_click',
                args: {},
                behavior: { effect: 'seat', authority: false },
                snapshot: state.snapshot,
                memory: [],
              });
              if (window.binding?.scope === 'identity-turn')
                await deps.store.openIdentityWindow(plan.proposalId, window.binding);
            }
          } catch {
            // Selection already happened. Failure to launch Chrome or save a
            // window must not describe that action as undispatched.
            return {
              output,
              policyWarning:
                'Login selection completed, but no automatic approval window opened. ' +
                'Further login actions require a fresh policy check.',
            };
          }
        }
        return plan.edited ? { actualArguments: plan.call.args, output } : output;
      } catch (error) {
        return error instanceof Error
          ? error.message
          : 'POLICY_UNAVAILABLE: no action was dispatched.';
      }
    },
    skillPermit(id) {
      const plan = plans.get(id);
      let used = false;
      return async (revision, params) => {
        if (used || plan === undefined || !plan.consumed || plan.call.name !== 'run_skill')
          throw new Error('APPROVAL_STALE: no skill dispatch authorization.');
        used = true;
        const args = plan.call.args;
        const expected =
          args !== null && typeof args === 'object' && !Array.isArray(args)
            ? (args['params'] ?? {})
            : null;
        // The state reader adds seat identity to the resource binding separately.
        if (plan.skillRevision !== revision || !sameJson(expected, params))
          throw new Error('APPROVAL_STALE: the resolved skill or parameters changed.');
        await fence(plan);
      };
    },
  };
}
// Same code as any other spent authorization: the caller cannot tell an
// uncertain effect from a missing approval, and must not retry either.
const DISPATCH_UNCERTAIN =
  'APPROVAL_STALE: this approved call was already dispatched and will not be repeated.';

/** How a tool says it refused before sending anything: the ledger reads it as REFUSED. */
const NOTHING_DISPATCHED = 'no action was dispatched';
const ALREADY_DONE =
  'ALREADY_DONE: this call completed before an interruption. It will not be repeated, and its ' +
  'result was not kept.';
const REFUSED_BEFORE =
  'REFUSED: an earlier attempt of this call was refused before anything was sent. Propose it ' +
  'again if it is still needed.';
const OUTCOME_UNKNOWN =
  'OUTCOME_UNKNOWN: this call was started before an interruption and may or may not have taken ' +
  'effect. It will not be repeated. Ask the operator to check before doing it again.';

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return JsonSchema.safeParse(right).success && policyHash(left) === policyHash(right);
  } catch {
    return false;
  }
}

/** The assembled runtime both engines hold: dispatch, approval and restore in one object. */
export type PolicyRuntime = ReturnType<typeof createPolicyRuntime>;
