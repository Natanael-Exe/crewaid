import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import {
  ApprovalBindingSchema,
  AutoReviewRulesSchema,
  JsonSchema,
  type ApprovalBinding,
  type ApprovalMode,
  type AutoReviewDecision,
  type Json,
  type ToolEffect,
  type ToolPolicyRefusalCode,
} from '@crewaid/shared';

/** SDK-independent facts. Only server registration and state readers build these. */
export type PolicyBehavior = {
  readonly effect: ToolEffect | 'seat';
  readonly authority: boolean;
};

export type PolicySnapshot = {
  readonly mode: ApprovalMode;
  readonly rules: unknown;
  readonly grantRevision: string;
  readonly grantValid: boolean;
  readonly seat: ApprovalBinding['seat'];
  readonly resourceRevision: string | null;
};

export type PolicyMemory = {
  readonly binding: ApprovalBinding;
  readonly mode: ApprovalMode;
  readonly authority: boolean;
};

export type PolicyAssessment = {
  readonly decision: AutoReviewDecision;
  readonly source:
    'unregistered' | 'grant' | 'unreadable-rules' | 'rule' | 'mode' | 'default' | 'memory';
  readonly binding: ApprovalBinding | null;
  readonly code?: ToolPolicyRefusalCode;
  readonly ruleIndex?: number;
};

/** RFC 8785 handles object ordering, Unicode and numeric serialization. */
export function policyHash(value: unknown): string {
  const json = JsonSchema.parse(value);
  const bytes = canonicalize(json);
  if (bytes === undefined) throw new Error('Policy arguments must be JSON.');
  return createHash('sha256').update(bytes).digest('hex');
}

export function assessPolicy(input: {
  readonly name: string;
  readonly args: Json;
  readonly behavior: PolicyBehavior | undefined;
  readonly snapshot: PolicySnapshot;
  readonly memory: readonly PolicyMemory[];
  readonly commit?: ApprovalBinding['commit'];
}): PolicyAssessment {
  const { name, args, behavior, snapshot } = input;
  if (behavior === undefined) return { decision: 'deny', source: 'unregistered', binding: null };
  if (!snapshot.grantValid) {
    return { decision: 'deny', source: 'grant', binding: null, code: 'GRANT_REVOKED' };
  }

  const effect: ToolEffect =
    input.commit !== undefined && input.commit !== null
      ? 'commit'
      : behavior.effect === 'seat'
        ? snapshot.seat?.identity === null || snapshot.seat === null
          ? 'draft'
          : 'unknown'
        : behavior.effect;
  const scope =
    effect === 'unknown' &&
    behavior.effect === 'seat' &&
    snapshot.seat?.identity !== null &&
    snapshot.seat !== null &&
    snapshot.mode === 'AUTO'
      ? 'identity-turn'
      : 'call';
  const binding = ApprovalBindingSchema.parse({
    toolName: name,
    effect,
    scope,
    argsHash: policyHash(args),
    grantRevision: snapshot.grantRevision,
    resourceRevision: snapshot.resourceRevision,
    seat: behavior.effect === 'seat' ? snapshot.seat : null,
    commit: input.commit ?? null,
  });

  const rules = AutoReviewRulesSchema.safeParse(snapshot.rules);
  if (!rules.success) return { decision: 'ask', source: 'unreadable-rules', binding };
  const serialized = JSON.stringify(args);
  const ruleIndex = rules.data.findIndex(
    (rule) =>
      (rule.toolPattern.endsWith('*')
        ? name.startsWith(rule.toolPattern.slice(0, -1))
        : name === rule.toolPattern) &&
      (rule.argMatch === undefined || serialized.includes(rule.argMatch)),
  );
  const matched = rules.data[ruleIndex];
  if (matched?.decision === 'deny') return { decision: 'deny', source: 'rule', binding, ruleIndex };

  let decision: AutoReviewDecision;
  let source: PolicyAssessment['source'];
  switch (snapshot.mode) {
    case 'FULL':
      decision = 'allow';
      source = 'mode';
      break;
    case 'ASK':
      decision = effect === 'read' ? 'allow' : 'ask';
      source = 'mode';
      break;
    case 'AUTO':
      if (behavior.authority) {
        decision = 'ask';
        source = 'default';
      } else if (matched !== undefined) {
        decision = matched.decision;
        source = 'rule';
      } else {
        decision = effect === 'read' || effect === 'draft' ? 'allow' : 'ask';
        source = 'default';
      }
      break;
  }
  if (
    decision === 'ask' &&
    input.memory.some((record) => covers(record, binding, snapshot.mode, behavior))
  ) {
    return { decision: 'allow', source: 'memory', binding };
  }
  return { decision, source, binding, ...(source === 'rule' && { ruleIndex }) };
}

function covers(
  record: PolicyMemory,
  binding: ApprovalBinding,
  mode: ApprovalMode,
  behavior: PolicyBehavior,
): boolean {
  if (record.binding.scope === 'identity-turn') {
    return (
      mode === 'AUTO' &&
      record.mode === 'AUTO' &&
      behavior.effect === 'seat' &&
      binding.scope === 'identity-turn' &&
      record.binding.grantRevision === binding.grantRevision &&
      policyHash(record.binding.seat) === policyHash(binding.seat)
    );
  }
  if (
    mode === 'ASK' &&
    record.mode === 'ASK' &&
    binding.effect === 'draft' &&
    record.binding.effect === 'draft' &&
    !behavior.authority &&
    !record.authority
  ) {
    return (
      binding.toolName === record.binding.toolName &&
      binding.grantRevision === record.binding.grantRevision &&
      binding.resourceRevision === record.binding.resourceRevision &&
      policyHash(binding.seat) === policyHash(record.binding.seat)
    );
  }
  return sameBinding(record.binding, binding);
}

export function sameBinding(left: ApprovalBinding, right: ApprovalBinding): boolean {
  return policyHash(left) === policyHash(right);
}

/** Even automatically allowed calls are fenced against changes before dispatch. */
export function recheckPolicy(
  planned: ApprovalBinding,
  current: PolicyAssessment,
):
  | {
      readonly ok: true;
    }
  | { readonly ok: false; readonly code: ToolPolicyRefusalCode | 'POLICY_DENIED' } {
  if (current.code === 'GRANT_REVOKED') return { ok: false, code: 'GRANT_REVOKED' };
  if (current.decision === 'deny') return { ok: false, code: 'POLICY_DENIED' };
  if (current.binding === null || !sameBinding(planned, current.binding)) {
    return { ok: false, code: 'APPROVAL_STALE' };
  }
  return current.decision === 'allow' ? { ok: true } : { ok: false, code: 'APPROVAL_STALE' };
}

/** Service adapters choose whether destinations are case insensitive. */
export function normalizePolicyDestinations(
  destinations: readonly string[],
  caseInsensitive = false,
): string[] {
  return [
    ...new Set(
      destinations.map((destination) => {
        const trimmed = destination.trim();
        return caseInsensitive ? trimmed.toLowerCase() : trimmed;
      }),
    ),
  ].sort();
}

export type CommitOutcome =
  | { readonly status: 'committed'; readonly reference: string }
  | { readonly status: 'uncertain' }
  | { readonly status: 'refused'; readonly code: string };

/** Only trusted server code registers an adapter. Remote descriptions are data. */
export type CommitAdapter = {
  readonly proposal: (args: Json) => Promise<NonNullable<ApprovalBinding['commit']>>;
  readonly outcome: (output: unknown) => Promise<CommitOutcome>;
};
