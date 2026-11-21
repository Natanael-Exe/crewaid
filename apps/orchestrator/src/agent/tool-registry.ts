import { Injectable } from '@nestjs/common';
import { toolInputValidator, type ToolDefinition, type ToolSet } from './tool-contract.js';
import type { Json, Locale } from '@crewaid/shared';
import type { ArgumentValidator } from './policy/validate-arguments.js';
import type { CommitAdapter } from './policy/policy.js';
import type { ToolDispatchPort } from './policy/runtime.js';

import type { ToolSandboxSession } from '@crewaid/sandbox-core';

import type { BrowserPage } from './browser-page.js';
import type { IdentityGrant } from '../sandbox/identity.service.js';
import type { SeatPort } from './seat-admission.js';
import { withSeatAdmission } from './seat-admission.js';
import { withCappedOutputs } from './tool-result-projection.js';

/**
 * The tool registry.
 *
 * Everything the model may call lands here: M5's built-ins (M5-BE-04/05/06),
 * M6's MCP tools, and the approved skills `run_skill` reaches. The registry
 * answers two questions, and it is the only place that answers either:
 *
 * 1. *What may the model call?* — `toolSetFor()`, a neutral server `ToolSet`, is
 * what an execution adapter converts for its library. The library has no opinion about
 * provenance or policy, and must not learn one: it should see exactly
 * the definitions the provider will validate.
 * 2. *What IS this tool?* — `behaviorOf(name)` returns the out-of-band
 * behavior descriptor. Classification and failure policy are read from
 * here by the approval matcher, the read-only classifier
 * (M6-BE-08), failure isolation (M6-BE-10) and namespacing (M6-BE-06).
 *
 * `resolveFor(context, extras)` answers BOTH at once, and it is the method a
 * turn actually calls. Not every tool a turn offers is registered:
 * an MCP tool belongs to one user's server and is resolved per turn,
 * so a `toolSet` handed back on its own would leave the caller holding
 * definitions from here and a `behaviorOf` that has never heard of half of
 * them — which the approval matcher answers with `deny`. One resolution, one
 * map, two views of it.
 *
 * ⚠️ The descriptor is deliberately NOT a field on the tool definition. The
 * tool's public shape is the provider's contract, and `AutoReviewRuleSchema`
 * (packages/shared/src/agent.ts) is ratified across five codebases — §0 rule 2
 * and D-005 both forbid growing either one to carry metadata an M6 plugin
 * happens to need. Keeping it beside the definition rather than on it is what
 * keeps the wire contract frozen; M6-BE-12 owns widening *this* shape.
 */

/**
 * Where a registered tool came from — the classification §6/M5 says all three
 * kinds need read from one place.
 *
 * A discriminated union rather than a `source: string`: each kind carries the
 * payload its consumers actually need, and a typo picks a branch at compile
 * time instead of at the first tool call. `builtin` needs none; `mcp` carries
 * the server (M6-BE-06 round-trips a call back to it, M6-BE-10 keys strike
 * state off it); `skill` carries the skill (M3-BE-09's APPROVED check is per
 * skill, not per name).
 */
export type ToolOrigin =
  | { readonly kind: 'builtin' }
  | { readonly kind: 'mcp'; readonly serverId: string }
  | { readonly kind: 'skill'; readonly skillId: string };

/**
 * What the turn does when a tool call fails.
 *
 * Both variants isolate — MCP plugins "One broken plugin must never fail a turn"
 * and §6/M5's rule that a denial "returns a tool result the model can react
 * to, not an exception". The model sees an error result and gets another step;
 * the turn does not end, ever, for either kind.
 *
 * What differs is what a failure MEANS, and therefore what is counted.
 *
 * `isolate` A built-in, or a skill. Its failure is this build's own
 * — a bug, a full disk, a page that did not load — and
 * there is nothing to disable: the tool will be there next
 * turn because it is part of the product.
 *
 * `isolate-remote` An MCP tool. Its failure is a third party's server, and
 * MCP plugins asks for two things a local failure does not need:
 * a bound on how long the turn waits, and a count of
 * consecutive failures after which the server stops being
 * offered at all. Both numbers live HERE rather than as
 * fields on the model-facing tool object (M6-BE-12's note), so
 * the timeout the caller enforces and the limit the
 * failure path counts against are read from one place.
 *
 * `validateBehavior` switches over this with `assertNever`, so a third variant
 * is a compile error in the registry rather than a field the one call site
 * that reads it silently ignores.
 */
export type ToolFailurePolicy =
  | { readonly kind: 'isolate' }
  | {
      readonly kind: 'isolate-remote';
      /** §7.4's "MCP tool call ≤ 30 s". Exceeded is a failure, not a hang. */
      readonly callTimeoutMs: number;
      /** MCP plugins "three consecutive failures move the server to ERROR". */
      readonly strikeLimit: number;
    };

/** Wire reach is a projection of the current call's effect and authority. */
export type ToolReach = 'contained' | 'sensitive';
export type ToolEffect = 'read' | 'draft' | 'unknown' | 'seat';
export type ToolBehavior = {
  readonly origin: ToolOrigin;
  readonly failure: ToolFailurePolicy;
  readonly effect: ToolEffect;
  readonly authority: boolean;
};

export const CONTAINED_BUILTIN: ToolBehavior = {
  origin: { kind: 'builtin' },
  failure: { kind: 'isolate' },
  effect: 'draft',
  authority: false,
};
export const SENSITIVE_BUILTIN: ToolBehavior = {
  origin: { kind: 'builtin' },
  failure: { kind: 'isolate' },
  effect: 'unknown',
  authority: false,
};
export const OBSERVING_BUILTIN: ToolBehavior = {
  origin: { kind: 'builtin' },
  failure: { kind: 'isolate' },
  effect: 'read',
  authority: false,
};
export const AUTHORITY_BUILTIN: ToolBehavior = {
  origin: { kind: 'builtin' },
  failure: { kind: 'isolate' },
  effect: 'draft',
  authority: true,
};
export const SEAT_BUILTIN: ToolBehavior = {
  origin: { kind: 'builtin' },
  failure: { kind: 'isolate' },
  effect: 'seat',
  authority: false,
};

export function toolReach(behavior: ToolBehavior, identity: string | null = null): ToolReach {
  const effect =
    behavior.effect === 'seat' ? (identity === null ? 'draft' : 'unknown') : behavior.effect;
  return effect === 'read' || (effect === 'draft' && !behavior.authority)
    ? 'contained'
    : 'sensitive';
}

/**
 * What a tool needs from the turn it is running in.
 *
 * Every accessor is a thunk, and that is the whole point: a turn that only
 * answers must start no desktop, so nothing here may do work until
 * a tool actually calls it. Building the DEFINITIONS is free — they are
 * schemas and a closure — and the definitions have to exist up front for the
 * model to know the tools are available at all.
 */
export type ToolContext = {
  readonly seat?: SeatPort | undefined;
  /** The principal every query a tool makes must be scoped by. */
  readonly userId: string;
  /** The bot acting. Which skills are reachable and whose computer is used. */
  readonly botId: string;
  /**
   * The bot's sidebar group, or null. Decides which group folder the
   * file tools treat as this bot's. Optional so a context built before groups
   * existed reads as "in no group" rather than failing.
   */
  readonly groupId?: string | null;
  /**
   * The transcript message an attachment this call produces claims
   * (D-019/D-021, D-190).
   *
   * A function of the CALL, not a value of the turn, because the two engines
   * have different answers and only one of them has a message before the call
   * exists: the AI SDK path is composing a draft reply and hands its id to
   * every call, so the download card lands on the reply the operator is
   * already watching; a TanStack run composes no draft and derives the
   * canonical tool result row of this call, which its backend reserved when
   * the call started.
   */
  readonly attachmentHost: (toolCallId: string) => Promise<string>;
  /**
   * The message that started this turn, as far as chain accounting needs it
   * (M7-BE-01).
   *
   * `send_message` derives the delivered message's `chainId` and `hopCount`
   * from here, so a hop is counted from the exchange the turn is actually
   * part of rather than from zero. Required, not optional with a default: a
   * missing trigger defaulting to hop 0 would restart the count on every hop,
   * which is a loop bound that never fires — the fail-open shape §6/M7's
   * protection exists to refuse.
   *
   * Plain data rather than a thunk, unlike everything below it: the turn
   * already holds all three values before any tool can run, so there is no
   * work to defer.
   */
  readonly trigger: {
    readonly id: string;
    readonly chainId: string | null;
    readonly hopCount: number;
  };
  /** The bot's browser, waking its computer on the first call. */
  readonly browser: () => Promise<BrowserPage>;
  /**
   * The bot's computer as a REDUCED session: file I/O, exec and spawn,
   * with no `destroy()`, `setNetworkPolicy()` or `setPorts()`.
   *
   * `ToolSandboxSession` rather than the plain reduced alias, because the
   * network session EXTENDS the reduced one and is therefore assignable to it:
   * with the alias, a thunk returning the wide session compiled, and R4 rested
   * on whoever wired it having read the comment. The infra members are declared
   * `never` on this type, so it is now the compiler that refuses.
   */
  readonly session: () => Promise<ToolSandboxSession>;
  /**
   * Move this bot onto a named shared browser identity.
   *
   * A thunk like the two above, and for a stronger reason than laziness: the
   * act has three parts that must happen together and in order — record the
   * grant, close the seat the bot is holding, forget the page this turn had
   * open on it. Only the turn can do the last one, so the sequence lives
   * where the turn is assembled and the tool sees one call.
   */
  readonly policy?: ToolDispatchPort;
  readonly useIdentity: (name: string) => Promise<IdentityGrant>;
  /**
   * The account's language, for words a tool writes for the person to
   * read — a template's card, the bots an install creates. Null when nothing
   * is known, and absent where no person is behind the call; both read English.
   */
  readonly language?: Locale | null;
};

/** One tool as registered: how to build it for a turn, and everything else. */
export type RegisteredTool = {
  /** The name the model calls, and the key both lookups use. */
  readonly name: string;
  /**
   * Build the neutral server definition for one turn — the ONLY part the model ever
   * sees.
   *
   * A builder rather than a value because a tool acts on a turn's bot: a
   * browser tool holds that bot's page, and a singleton definition would
   * either close over the wrong turn or need ambient state to find the right
   * one. Tools with nothing turn-specific to hold just ignore the argument.
   */
  readonly build: (context: ToolContext) => ToolDefinition;
  /** Out-of-band metadata. Never merged into the definition. */
  readonly behavior: ToolBehavior;
  readonly skillId?: string;
  readonly commitAdapter?: CommitAdapter;
  readonly validate?: ArgumentValidator;
  readonly resource?: { readonly toolName: string; readonly revision: string };
  /**
   * What a CALL to this definition is really about, when the definition is a
   * doorway rather than a tool.
   *
   * Absent for every tool that is what it says it is, which is all of them but
   * the plugin bridge's. Present, the call's identity — the name policy rules
   * are written in, the arguments the model produced, and the descriptor
   * classification and failure isolation are read from — is what this returns
   * instead of the name that was called.
   *
   * Why this is a field on the definition
   *
   * The alternative is a second lookup beside the registry keyed on the same
   * names, which is the drift D-105 exists to forbid: a door whose
   * `behaviorOf` and whose unwrap were written in two files can disagree about
   * whether the operator is asked, and the disagreement is silent. One
   * resolution, one map, both answers (`resolveFor`).
   *
   * Hermes does the same thing for the same reason — `_unwrap_tool_search_call`
   * peels its `tool_call` bridge before checkpoints, guardrails, plugins and
   * approvals run — and states the rule this field keeps: the transcript keeps
   * the wrapper, everything that DECIDES sees the tool.
   *
   * `undefined` means "this call is about the definition that was called", and
   * that covers a door that cannot read its own arguments: the door's own
   * classification applies, which for the plugin bridge is the fail-safe one.
   * A door that read its arguments and found a name it does not know returns
   * `behavior: undefined` instead, which the approval matcher answers with
   * `deny` — the same answer any unknown tool gets.
   */
  readonly unwrap?: ((args: unknown) => UnwrappedToolCall | undefined) | undefined;
};

/**
 * The tool a call is really about, when that is not the definition called.
 *
 * `behavior` is `undefined` for a name this turn does not have. That is not an
 * error and not an omission: it is exactly what `behaviorOf` returns for a
 * name nobody registered, and it is what makes a hallucinated call into the
 * bridge fail closed rather than run with the door's blanket classification.
 */
export type UnwrappedToolCall = {
  /** The name policy is decided on — for the plugin bridge, `<slug>__<tool>`. */
  readonly name: string;
  /** The arguments that name's own schema describes, not the door's envelope. */
  readonly args: unknown;
  readonly behavior: ToolBehavior | undefined;
  readonly skillId?: string;
  readonly commitAdapter?: CommitAdapter;
  readonly validate?: ArgumentValidator;
  readonly resource?: { readonly toolName: string; readonly revision: string };
  readonly repackArgs?: (args: Json) => Json;
};

/**
 * The tool-name shape the model providers accept (Anthropic's documented
 * `^[a-zA-Z0-9_-]{1,64}$`; OpenAI's is the same modulo the length).
 *
 * Validated at registration rather than at the provider boundary, where a
 * rejected name surfaces mid-turn as a 400 the model cannot act on. It is also
 * what M6-BE-06's `<serverSlug>__<toolName>` has to survive: an MCP server that
 * reports `foo.bar` must be slugified by the caller, not smuggled through here.
 */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The exhaustive-handler guard M6-BE-12's note asks for: "an unhandled variant
 * should be a compile error in the registry". A `default:` that swallows a new
 * union member is silent data loss; passing it through `assertNever` makes it
 * a type error at the switch instead.
 */
function assertNever(variant: never): never {
  throw new Error(`Unhandled tool behavior variant: ${JSON.stringify(variant)}`);
}

function requireNonEmptyId(field: string, toolName: string, value: string): void {
  if (value.trim() === '') {
    throw new Error(`Tool "${toolName}" declares ${field} but it is empty.`);
  }
}

/**
 * Registration-time validation of the descriptor.
 *
 * The switches are exhaustive over closed unions: a new origin kind or a new
 * failure policy is a compile error on the `assertNever` lines below, which is
 * the property M6-BE-12 exists to preserve.
 */
function validateBehavior(toolName: string, behavior: ToolBehavior): void {
  // Bound to a local so `assertNever` below is handed the whole origin rather
  // than its discriminant: the thrown message then names the payload of the
  // variant nobody handled, which is what says *which* registration did it.
  const origin: ToolOrigin = behavior.origin;
  switch (origin.kind) {
    case 'builtin':
      break;
    case 'mcp':
      requireNonEmptyId('an MCP serverId', toolName, origin.serverId);
      break;
    case 'skill':
      requireNonEmptyId('a skill skillId', toolName, origin.skillId);
      break;
    default:
      return assertNever(origin);
  }

  // Bound to a local for the same reason `origin` is: the thrown message then
  // names the payload of the variant nobody handled.
  const failure: ToolFailurePolicy = behavior.failure;
  switch (failure.kind) {
    case 'isolate':
      break;
    case 'isolate-remote':
      // Zero or negative would make a bound that can never be met read as a
      // bound. Both numbers are policy, and policy that is silently off is
      // worse than policy that is missing.
      if (failure.callTimeoutMs <= 0) {
        throw new Error(`Tool "${toolName}" declares a call timeout that is not positive.`);
      }
      if (failure.strikeLimit <= 0) {
        throw new Error(`Tool "${toolName}" declares a strike limit that is not positive.`);
      }
      break;
    default:
      return assertNever(failure);
  }

  switch (behavior.effect) {
    case 'read':
    case 'draft':
    case 'unknown':
    case 'seat':
      break;
    default:
      return assertNever(behavior.effect);
  }
  if (typeof behavior.authority !== 'boolean') {
    throw new Error(`Tool "${toolName}" must declare whether it changes authority.`);
  }
}

/**
 * The registry itself. A Nest singleton with no constructor collaborators:
 * later milestones register into it (M5-BE-04/05/06, M5-BE-20/21, M6's
 * per-bot enablement), and per-bot narrowing is a projection *over* it rather
 * than a second registry — the descriptor is what tells the projection which
 * server or skill a name belongs to.
 */
@Injectable()
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  /**
   * Add one tool. Throws rather than overwriting: a duplicate name is a wiring
   * bug (two built-ins claiming `shell`, an MCP slug colliding with a built-in
   * prefix), and silently keeping the last one makes it an intermittent bug
   * that depends on registration order.
   */
  register(tool: RegisteredTool): void {
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      throw new Error(
        `Tool name ${JSON.stringify(tool.name)} is not one the model providers accept ` +
          '(^[A-Za-z0-9_-]{1,64}$). Namespaced MCP tools are slug__name for this reason.',
      );
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered.`);
    }
    validateBehavior(tool.name, tool.behavior);
    this.tools.set(tool.name, tool);
  }

  /** Whether a name is registered. Used for collision checks (M6-BE-06). */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Every registered name, in registration order. */
  names(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * The descriptor for one tool.
   *
   * Throws on an unknown name: a caller asking for a tool that is not
   * registered is asking a question whose only safe answer is the failure. A
   * defaulted `isolate`/`builtin` would classify a tool nobody classified,
   * which is exactly the silent-allow M6-BE-08 warns about.
   */
  behaviorOf(name: string): ToolBehavior {
    const entry = this.tools.get(name);
    if (entry === undefined) {
      throw new Error(`No tool named ${JSON.stringify(name)} is registered.`);
    }
    return entry.behavior;
  }

  /**
   * The descriptor for one tool, or `undefined` when the name is unknown.
   *
   * The total counterpart to `behaviorOf`, and the two exist because they are
   * asked by different callers about different things. `behaviorOf` answers a
   * WIRING question — "classify this tool I registered" — where an absent
   * entry is a bug and a throw is the only honest answer. This answers a
   * RUNTIME question the approval matcher (M5-BE-08) asks once per tool call:
   * "is there anything registered under this name?", where `no` is an ordinary
   * result and an exception would fail the turn that asked. §6 is explicit
   * that a broken plugin must never do that.
   *
   * The third option — defaulting an unknown name to `builtin`/`isolate` — is
   * the one neither of these is, and it is the one that must not exist: it
   * classifies a tool nobody classified, which is the silent allow M6-BE-08
   * warns about.
   *
   * `has()` followed by `behaviorOf()` reaches the same answer with two lookups
   * and a shape that invites the second one to be forgotten.
   */
  tryBehaviorOf(name: string): ToolBehavior | undefined {
    return this.tools.get(name)?.behavior;
  }

  /**
   * The model-facing projection for one turn: definitions only, no descriptor.
   *
   * This is the object `TurnRunnerDeps.tools` takes, so the metadata cannot
   * reach the provider by accident — it never leaves the registry, and the
   * model sees the same shape it would see if the tools were hard-coded.
   *
   * Built per turn from `context`. That costs nothing — a builder returns
   * schemas and a closure, and the work each closure can do is deferred until
   * the model calls it.
   *
   * M5-BE-12 hangs §6/M5's 100 KB ceiling here, on the way out. This is the
   * one place every tool passes through — built-ins now, M6's MCP tools and
   * `run_skill`'s compiled skills later — and a cap each author has to
   * remember to apply is not a cap. `withCappedOutputs` composes onto a tool's
   * own `toModelOutput` rather than replacing it, and adds nothing the
   * provider is shown: `toModelOutput` is a server-side callback the SDK runs
   * when it builds the next step's messages, so the definition the model
   * validates is the one the tool declared.
   */
  toolSetFor(context: ToolContext): ToolSet {
    return this.resolveFor(context).toolSet;
  }

  /**
   * M6-BE-12 — everything one turn may call, and what each of those things IS.
   *
   * The registered tools plus `extras`: definitions that belong to ONE turn and
   * are gone with it. That is what an MCP tool is (D-104) — it belongs to a
   * user's server, changes when the server is re-listed, and must reach a turn
   * without a restart — and it is why a per-turn resolution exists at all
   * rather than a second `register()` call.
   *
   * ── WHY THIS RETURNS THE LOOKUP AND NOT JUST THE SET ────────────────────────
   *
   * The registry's promise is that a tool's definition and its behavior
   * descriptor are read from ONE place, so classification (M6-BE-08) and
   * failure policy (M6-BE-10) cannot drift from what the model was actually
   * offered. A `toolSet` returned on its own breaks that promise the moment a
   * turn has extras: the caller would hold definitions from here and a
   * `tryBehaviorOf` that has never heard of half of them, and an MCP tool would
   * classify as `unregistered` — which the approval matcher answers with
   * `deny`. So the resolution hands back both, over the same map, and
   * `AgentTurnService` passes the two halves of one object to `tools` and to
   * `toolApproval` rather than reaching for two sources.
   *
   * ── AN EXTRA IS DROPPED, NEVER THROWN ───────────────────────────────────────
   *
   * `register()` throws on a bad name or a duplicate, which is right at boot:
   * the stack names the caller and nothing has started. Here it would be
   * wrong twice — the caller is a turn in flight, and the material is a third
   * party's (§6/M6: "one broken plugin must never fail a turn"). So an extra
   * that a provider would reject, or that would shadow a registered tool, is
   * refused into `refusals` with the reason, and the turn runs with the rest.
   * Shadowing is refused rather than allowed to win, because the registered
   * tool is this build's own: a plugin quietly replacing `shell` is the shape
   * of the thing M6-BE-06's install-time slug check exists to prevent, and
   * this is the second fence under it.
   */
  resolveFor(context: ToolContext, extras: readonly RegisteredTool[] = []): ResolvedTools {
    const entries = new Map<string, RegisteredTool>(this.tools);
    const refusals: ToolRefusal[] = [];

    for (const extra of extras) {
      const refusal = refuseExtra(extra, entries);
      if (refusal !== undefined) {
        refusals.push(refusal);
        continue;
      }
      entries.set(extra.name, extra);
    }

    const set: ToolSet = {};
    for (const [name, entry] of entries) {
      const definition = entry.build(context);
      set[name] = definition;
      const policyPort = context.policy;
      if (policyPort !== undefined && definition.execute !== undefined) {
        const execute = definition.execute;
        set[name] = {
          ...definition,
          execute: async (args, options) =>
            policyPort.execute(name, args, options.toolCallId, async (finalArgs) => {
              const output: unknown = await execute(finalArgs, options);
              return output;
            }),
        };
      }
    }

    return {
      names: [...entries.keys()],
      toolSet: withCappedOutputs(withSeatAdmission(set, context.seat)),
      behaviorOf: (name) => entries.get(name)?.behavior,
      projectCall: (name, args) => {
        const entry = entries.get(name);
        if (entry === undefined) return { name, args, behavior: undefined };
        const definition = set[name];
        const validate: ArgumentValidator =
          entry.validate ??
          (definition === undefined
            ? () => Promise.resolve({ ok: false, reason: 'This tool is not offered.' })
            : toolInputValidator(definition.inputSchema));
        return (
          entry.unwrap?.(args) ?? {
            name,
            args,
            behavior: entry.behavior,
            validate,
            ...(entry.skillId !== undefined && { skillId: entry.skillId }),
            ...(entry.resource !== undefined && { resource: entry.resource }),
            ...(entry.commitAdapter !== undefined && { commitAdapter: entry.commitAdapter }),
          }
        );
      },
      refusals,
    };
  }
}

/** One extra that could not be offered, and the sentence that says why. */
export type ToolRefusal = {
  /** The name it would have been offered under. */
  readonly name: string;
  readonly reason: string;
};

/**
 * Everything one turn may call, resolved once.
 *
 * `toolSet` is what `TurnRunnerDeps.tools` takes — definitions only, so no
 * descriptor can reach the provider by accident. `behaviorOf` answers over the
 * SAME map, which is the property that makes "one place" true for a tool that
 * was never registered.
 */
export type ResolvedTools = {
  /** Registered names in registration order, then the extras that survived. */
  readonly names: readonly string[];
  readonly toolSet: ToolSet;
  /** The descriptor, or `undefined` for a name this turn does not offer. */
  behaviorOf(name: string): ToolBehavior | undefined;
  /**
   * D-113 — the same question asked about a CALL rather than a name.
   *
   * `behaviorOf` answers "what is `use_plugin_tool`", which is the right
   * question for a directory and the wrong one for a turn: the plugin bridge
   * is one definition over every plugin tool a bot has, and the tool being run
   * is named by the call's own arguments. So the approval matcher and the
   * operator's prompt read this, and the tool it names is what gets classified
   * (`readOnly` → `contained` → runs without asking), what the rules are
   * matched against, and what the failure path counts.
   *
   * Total, like everything else on this path: a name this turn does not offer,
   * arguments that will not parse, and a door that cannot read them all have
   * answers rather than exceptions.
   */
  projectCall(name: string, args: unknown): ToolCallProjection;
  /** Extras that were not offered, in the order they were given. */
  readonly refusals: readonly ToolRefusal[];
};

/** One call, as the things that decide about it have to see it (D-113). */
export type ToolCallProjection = {
  /** The name rules match and the operator is shown. */
  readonly name: string;
  /** The arguments that name's policy sees — the door's envelope, unwrapped. */
  readonly args: unknown;
  /** The descriptor, or `undefined` for a tool this turn does not have. */
  readonly behavior: ToolBehavior | undefined;
  readonly skillId?: string;
  readonly commitAdapter?: CommitAdapter;
  readonly validate?: ArgumentValidator;
  readonly resource?: { readonly toolName: string; readonly revision: string };
  readonly repackArgs?: (args: Json) => Json;
};

/**
 * Why one extra cannot be offered, or `undefined` when it can.
 *
 * The same three questions `register` asks, answered as a value instead of a
 * throw. Duplicated deliberately rather than shared with `register`: what
 * differs is not the questions but what a wrong answer MEANS, and a shared
 * helper parameterised on "throw or return" would hide exactly that.
 */
function refuseExtra(
  extra: RegisteredTool,
  offered: ReadonlyMap<string, RegisteredTool>,
): ToolRefusal | undefined {
  if (!TOOL_NAME_PATTERN.test(extra.name)) {
    return {
      name: extra.name,
      reason: 'the model providers do not accept that as a tool name',
    };
  }
  if (offered.has(extra.name)) {
    return {
      name: extra.name,
      reason: `a tool named "${extra.name}" is already offered this turn`,
    };
  }
  try {
    validateBehavior(extra.name, extra.behavior);
  } catch (error: unknown) {
    return {
      name: extra.name,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return undefined;
}
