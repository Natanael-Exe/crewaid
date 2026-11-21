import {
  AutoReviewRulesSchema,
  DEFAULT_AUTO_REVIEW_DECISION,
  JsonSchema,
  type ApprovalMode,
  type AutoReviewDecision,
  type AutoReviewRule,
} from '@crewaid/shared';

import type { StructuredLogger } from '../logging/structured-logger.js';
import type { ToolBehavior } from './tool-registry.js';
import { assessPolicy, policyHash } from './policy/policy.js';

/**
 * The auto-review matcher.
 *
 * One question, asked once per tool call: does this call run, wait for the
 * operator, or refuse? PRD §6/M5 and D-005 fix the answer's shape — an ordered
 * per-bot list, first match wins, default `ask`.
 *
 * Three properties are load-bearing, and each is a decision rather than an
 * implementation detail:
 *
 * 1. **It is total.** It is called from inside a turn, and §6 is explicit
 * that "one broken plugin must never fail a turn". So nothing here throws:
 * not a rules column holding a string, not an unknown tool, not arguments
 * that will not serialize. Every one of those has a decision instead.
 * 2. **It never runs the operator's input.** D-005 chose `argMatch`, a
 * substring test, over a predicate precisely so a rule cannot be code.
 * There is no regex either: an operator-supplied pattern is an ReDoS
 * surface on a per-tool-call path, and §7.3 bans the general form of this
 * (`eval`, `new Function`) for the same reason.
 * 3. **It fails toward the human.** Every uncertain branch lands on `ask`,
 * never `allow`. An operator whose rules stopped parsing gets asked about
 * things they had allowed, which is visible and recoverable; the inverse
 * is a silent policy hole.
 */

/** Why a call was decided the way it was — carried so the reason is auditable. */
export type AutoReviewSource =
  /** Rule `index` of the bot's ordered list matched first. */
  | { readonly kind: 'rule'; readonly index: number; readonly rule: AutoReviewRule }
  /** No rule matched, so the tool's own reach decided it. */
  | { readonly kind: 'default' }
  /** The bot's approval mode decided it, over the rules. */
  | { readonly kind: 'mode'; readonly mode: Exclude<ApprovalMode, 'AUTO'> }
  /** The tool is not in the registry, so no rule could be about it. */
  | { readonly kind: 'unregistered' }
  /** `Bot.autoReviewRules` did not parse; the whole list was set aside. */
  | { readonly kind: 'unreadable-rules' }
  /**
   * A rule said `ask` and the operator already approved this tool earlier in
   * the same turn. Never produced by `decideAutoReview` — the
   * matcher is stateless and stays that way; the turn's approval policy
   * synthesizes it so one log line can say both what happened and why.
   */
  | { readonly kind: 'turn-approved' };

export type AutoReviewOutcome = {
  readonly decision: AutoReviewDecision;
  readonly source: AutoReviewSource;
};

export type AutoReviewInput = {
  /**
   * `Bot.autoReviewRules` exactly as Prisma read it. `unknown`, not
   * `AutoReviewRule[]`, because it is a Json column: the type says array of
   * rules and the row says whatever was written to it, and the gap between
   * those two is this function's problem rather than its caller's.
   */
  readonly rules: unknown;
  readonly toolName: string;
  /** The arguments the model produced, already parsed by the SDK. */
  readonly args: unknown;
  /**
   * What the registry knows about this tool, or `undefined` if it knows
   * nothing. `ToolRegistry.tryBehaviorOf` is the total lookup that answers
   * this; `behaviorOf` throws, which is right for a wiring question and wrong
   * on this path.
   */
  readonly behavior: ToolBehavior | undefined;
  /**
   * `Bot.approvalMode`. Absent is `AUTO`, which is every bot's
   * behaviour before modes existed.
   */
  readonly mode?: ApprovalMode | undefined;
  readonly logger?: StructuredLogger | undefined;
};

/**
 * Decide one tool call.
 *
 * Order matters and is not arbitrary: registration is checked BEFORE the rules.
 * A rule expresses policy over a tool that exists, and `gmail__*` → allow
 * should not admit `gmail__wire_transfer` on the strength of a prefix when
 * nothing by that name is registered. The call cannot run either way — an
 * unregistered name has no `execute` — so the only question is whether it fails
 * as a denial the model can read or as an exception, and §6 answers that.
 */
export function decideAutoReview(input: AutoReviewInput): AutoReviewOutcome {
  if (input.behavior === undefined) return { decision: 'deny', source: { kind: 'unregistered' } };
  let args;
  try {
    args = JsonSchema.safeParse(input.args);
    if (args.success) policyHash(args.data);
  } catch {
    input.logger?.warn('agent.autoreview.args.unserializable', { toolName: input.toolName });
    return { decision: 'deny', source: { kind: 'unreadable-rules' } };
  }
  const parsedRules = AutoReviewRulesSchema.safeParse(input.rules);
  if (parsedRules.success)
    for (const [index, rule] of parsedRules.data.entries()) {
      if (rule.toolPattern.includes('*') && !rule.toolPattern.endsWith('*'))
        input.logger?.warn('agent.autoreview.rule.dead-wildcard', {
          toolPattern: rule.toolPattern,
          index,
        });
    }
  if (!args.success) return { decision: 'ask', source: { kind: 'unreadable-rules' } };
  const outcome = assessPolicy({
    name: input.toolName,
    args: args.data,
    behavior: input.behavior,
    memory: [],
    snapshot: {
      mode: input.mode ?? 'AUTO',
      rules: input.rules,
      grantRevision: policyHash([]),
      grantValid: true,
      seat: null,
      resourceRevision: null,
    },
  });
  switch (outcome.source) {
    case 'rule': {
      const rule = AutoReviewRulesSchema.parse(input.rules)[outcome.ruleIndex ?? -1];
      if (rule === undefined)
        return { decision: DEFAULT_AUTO_REVIEW_DECISION, source: { kind: 'unreadable-rules' } };
      return {
        decision: outcome.decision,
        source: { kind: 'rule', index: outcome.ruleIndex ?? -1, rule },
      };
    }
    case 'mode':
      return {
        decision: outcome.decision,
        source: { kind: 'mode', mode: input.mode === 'FULL' ? 'FULL' : 'ASK' },
      };
    case 'unregistered':
      return { decision: outcome.decision, source: { kind: 'unregistered' } };
    case 'unreadable-rules':
      input.logger?.warn('agent.autoreview.rules.unreadable', { toolName: input.toolName });
      return { decision: outcome.decision, source: { kind: 'unreadable-rules' } };
    case 'memory':
      return { decision: outcome.decision, source: { kind: 'turn-approved' } };
    case 'grant':
    case 'default':
      return { decision: outcome.decision, source: { kind: 'default' } };
  }
}
