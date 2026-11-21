import { z } from 'zod';

/**
 * Agent-layer contracts: auto-review rules, the model catalog, and the
 * normalized provider error vocabulary.
 *
 * These shapes are contractual across the orchestrator and desktop client:
 * the transcript switches on `ModelErrorCode`, the model picker consumes
 * `ModelCatalogEntry`, and
 * matcher validates against `AutoReviewRuleSchema`. Do not extend or
 * rename without a PRD revision.
 */

// Auto-review rules (, ratified into M0-03)

/**
 * A single auto-review rule. Stored as an ordered array in `Bot.autoReviewRules`
 * (a Json column — the list is always read whole, per bot, and never queried
 * across bots, so a table would buy nothing and cost a join plus ordering).
 *
 * `toolPattern` matches a tool name and supports a trailing `*` wildcard, which
 * is what makes `gmail__*` express "every tool from this MCP server".
 * `argMatch` is an optional substring test against the serialized arguments.
 */
export const AutoReviewDecisionSchema = z.enum(['allow', 'ask', 'deny']);
export type AutoReviewDecision = z.infer<typeof AutoReviewDecisionSchema>;

export const AutoReviewRuleSchema = z.object({
  toolPattern: z.string().min(1).max(128),
  argMatch: z.string().min(1).max(512).optional(),
  decision: AutoReviewDecisionSchema,
});
export type AutoReviewRule = z.infer<typeof AutoReviewRuleSchema>;

/** `Bot.autoReviewRules` — ordered, first match wins. */
export const AutoReviewRulesSchema = z.array(AutoReviewRuleSchema);

/**
 * How a bot's actions are approved, chosen per bot from the composer.
 *
 * - `ASK` — every action that changes something asks first; looking never does.
 * - `AUTO` — the rules and each tool's reach decide: actions on the
 * bot's own computer and workspace run, the sensitive ones ask. The default.
 * - `FULL` — nothing asks. A rule that says `deny` still denies, because a
 * prohibition is not an approval, and an unknown tool is still refused.
 */
export const ApprovalModeSchema = z.enum(['ASK', 'AUTO', 'FULL']);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;
export type AutoReviewRules = z.infer<typeof AutoReviewRulesSchema>;

/**
 * The decision applied when the rules cannot be consulted, and when a tool's
 * own reach says a human should be asked.
 *
 * It was the flat fallthrough for every unmatched call. That is what made a
 * fresh bot ask permission to attach a file it had just written, or to note
 * something down — an interruption per act, for acts that never leave the
 * bot's own computer. The orchestrator now asks the TOOL (`ToolReach`), and
 * this stays as the answer for `sensitive` and for a rule list that would not
 * parse: every uncertain branch still lands here, never on `allow`.
 */
export const DEFAULT_AUTO_REVIEW_DECISION: AutoReviewDecision = 'ask';

/**
 * The rule list a bot is created with when the caller supplies none (,
 * rewritten).
 *
 * **What changed and why.** The first list drew its line at "observes vs
 * acts", which put an approval prompt in front of saving a file, attaching a
 * report to the chat it was written for, and making a note — acts that touch
 * nothing but the bot's own computer and the operator's own conversation. In
 * use that is not a safety property, it is a bot that has to be babysat: the
 * operator answers yes twenty times per task and stops reading the question,
 * which is worse than not asking, because the one prompt that mattered is now
 * indistinguishable from the nineteen that did not.
 *
 * The line draws instead is **"could this destroy something, spend
 * money, or act as the user outside the sandbox?"** Tools answer that for
 * themselves through `ToolReach`, so this list no longer has to name the
 * allowed ones at all — what is left is the two refinements a classification
 * cannot express:
 *
 * 1. **`shell` is classified `sensitive`** because a shell is unbounded,
 * and a bot with an EMPTY list is therefore asked about every command.
 * But what makes a command dangerous is the command, not the tool, so
 * the rules below ask about the destructive forms and allow the rest.
 * `ls -la` is how an agent orients itself; `rm -rf` is a decision.
 * 2. **`use_identity` is named explicitly**, though its own reach already
 * says `ask`, so an operator who reads their bot's rules sees the one
 * act that borrows their real session written down where they can
 * change it.
 *
 * `argMatch` is a substring test over the serialized arguments ( chose
 * that over a predicate precisely so a rule can never be code), so these are
 * literal fragments, not patterns. They are a floor, not a sandbox: a command
 * can be written to miss all of them, and the thing that actually contains a
 * shell is that it runs in the bot's own container. What they buy is that the
 * destructive forms a model reaches for by habit stop and ask.
 *
 * To be asked about everything, an operator writes one rule — `{ toolPattern:
 * '*', decision: 'ask' }` — which is what an empty list used to mean before
 * the fallthrough learned to read the tool.
 */
export const DEFAULT_AUTO_REVIEW_RULES: AutoReviewRules = [
  // Ordered, first match wins: every destructive form comes before the
  // `shell` → allow that follows them.
  { toolPattern: 'shell', argMatch: 'rm -rf', decision: 'ask' },
  { toolPattern: 'shell', argMatch: 'rm -fr', decision: 'ask' },
  { toolPattern: 'shell', argMatch: 'sudo ', decision: 'ask' },
  { toolPattern: 'shell', argMatch: 'mkfs', decision: 'ask' },
  { toolPattern: 'shell', argMatch: 'dd if=', decision: 'ask' },
  // Piping something off the network into an interpreter — the shape of
  // `curl … | sh`, whatever fetched it.
  { toolPattern: 'shell', argMatch: '| sh', decision: 'ask' },
  { toolPattern: 'shell', argMatch: '| bash', decision: 'ask' },
  // Taking the machine away from underneath the turn that is running.
  { toolPattern: 'shell', argMatch: 'shutdown', decision: 'ask' },
  { toolPattern: 'shell', argMatch: 'reboot', decision: 'ask' },
  { toolPattern: 'shell', decision: 'allow' },
  // Its reach already says `ask`; this is the line an operator can find.
  { toolPattern: 'use_identity', decision: 'ask' },
];

// Model catalog

/** The three first-party providers composed by `createProviderRegistry`. */
export const ModelProviderSchema = z.enum(['openrouter', 'openai', 'anthropic']);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

/**
 * The registry separator. `createProviderRegistry` defaults to ':' and we keep
 * it, so a catalog `id` is literally the registry key: `anthropic:claude-opus-4.8`.
 */
export const MODEL_ID_SEPARATOR = ':' as const;

/**
 * `ModelIdSchema`, `BotModelIdSchema`, `DEFAULT_MODEL_ALIAS`,
 * `ModelCatalogEntrySchema` and `ModelCatalogResponseSchema` LIVED HERE AND
 * ARE GONE.
 *
 * They described a world with one registry built at boot from three
 * environment keys, where a model was named by a `provider:model` string that
 * was globally unique because there was exactly one connection per provider.
 * That stopped being expressible when a user could hold two custom
 * connections. `ModelRefSchema`, `ProviderModelSchema` and `ModelOptionSchema`
 * in `providers.ts` replace them; the alias literal is `MODEL_REF_DEFAULT`.
 *
 * `ModelProviderSchema` and `MODEL_ID_SEPARATOR` above deliberately survive:
 * the first is the vocabulary a normalized error is reported against, which is
 * per-VENDOR and not per-connection, and the second keys the telemetry price
 * table.
 */

/** Capability flags driving the model picker and `prepareStep` model swaps. */
export const ModelCapabilitiesSchema = z.object({
  tools: z.boolean(),
  vision: z.boolean(),
  reasoning: z.boolean(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

// Normalized provider errors

/**
 * The complete normalized error vocabulary. Three providers produce three error
 * shapes; every one of them lands on exactly one of these codes before it
 * reaches the transcript.
 *
 * The rule that gives this teeth: the transcript never renders a raw vendor
 * error. If a UI layer is regexing a provider message, the normalization is in
 * the wrong place. The raw provider error rides along in a non-displayed
 * `detail` field for logs only; the one vendor sentence a person may read is
 * the server-cleaned `explanation`.
 */
export const ModelErrorCodeSchema = z.enum([
  'RATE_LIMITED',
  'CONTEXT_OVERFLOW',
  'CONTENT_REFUSED',
  'AUTH_FAILED',
  'PROVIDER_UNAVAILABLE',
  'TIMEOUT',
  'QUOTA_EXCEEDED',
  // the plan's included model use for this period is spent. Ours, not
  // the provider's — QUOTA_EXCEEDED is a provider account out of credit.
  'ALLOWANCE_EXHAUSTED',
  'INVALID_REQUEST',
  'UNKNOWN',
]);
export type ModelErrorCode = z.infer<typeof ModelErrorCodeSchema>;

/**
 * the provider's own reason for refusing a call, when it is one a
 * person can act on: "the free tier only works inside OpenCode", "add 10
 * credits to unlock more free requests". The normalized sentence cannot know
 * those, and they are exactly what tells someone which of their next moves
 * will work.
 *
 * The server decides whether there is one, and cleans it: no status prefix,
 * no JSON or markup, no transport plumbing, nothing shaped like a key, and
 * bounded. A client renders it as given and never second-guesses it — that
 * judgement is the server's, which is why this is not just `detail`.
 */
export const ProviderExplanationSchema = z.object({
  /** Who said it: the name the person gave the connection. */
  source: z.string().min(1).max(80),
  text: z.string().min(1).max(400),
});
export type ProviderExplanation = z.infer<typeof ProviderExplanationSchema>;

/**
 * A normalized model error as carried to the client.
 *
 * `retryable` is derived, not vendor-reported: it tells the UI whether offering
 * a retry affordance makes sense. `retryAfterMs` is populated only when the
 * provider supplied a concrete value (e.g. a `retry-after` header).
 */
export const NormalizedModelErrorSchema = z.object({
  code: ModelErrorCodeSchema,
  /** Operator-facing, provider-neutral. Safe to render. */
  message: z.string().min(1),
  provider: ModelProviderSchema.optional(),
  modelId: z.string().min(1).optional(),
  retryable: z.boolean(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  /** Safe to render beside `message`; absent when the provider said nothing usable. */
  explanation: ProviderExplanationSchema.optional(),
  /**
   * Raw provider payload for logs. NEVER rendered in the transcript and never
   * parsed by the client — if you are reading this field in the UI, stop.
   */
  detail: z.string().optional(),
});
export type NormalizedModelError = z.infer<typeof NormalizedModelErrorSchema>;

/**
 * Codes worth retrying without user intervention. `CONTEXT_OVERFLOW` is absent
 * deliberately: retrying an oversized prompt unchanged just fails again — it
 * needs `prepareStep` to trim first.
 */
export const RETRYABLE_MODEL_ERROR_CODES: readonly ModelErrorCode[] = [
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'TIMEOUT',
] as const;

// The plugin bridge

/**
 * The two definitions every plugin tool reaches a model through.
 *
 * Why these names are shared vocabulary and not the orchestrator's
 *
 * They were internal for exactly as long as only the orchestrator had to
 * recognise them. They stopped being internal the moment a bridge call reached
 * a WebSocket transcript part: the renderer has to know that a `tool-call` part
 * named `use_plugin_tool` is a doorway, or it shows the operator the door
 * ("Use plugin tool") for every plugin call a bot ever makes, which is the
 * name of a mechanism rather than the name of the thing acting on their
 * account.
 *
 * So the name lives here, where both sides read it from one place, rather than
 * being spelled out twice — once in `mcp/plugin-bridge-call.ts` and once in a
 * renderer string literal that nothing would fail if it drifted.
 */
export const FIND_PLUGIN_TOOLS = 'find_plugin_tools' as const;

/** @see FIND_PLUGIN_TOOLS */
export const USE_PLUGIN_TOOL = 'use_plugin_tool' as const;

/**
 * The arguments a `use_plugin_tool` call carries.
 *
 * Deliberately dumb — a name and an opaque bag — because both readers have to
 * understand it without the bot's catalogue in hand: the approval prompt is
 * built while a turn is suspended, and the renderer is a different process
 * entirely. What neither recovers from this is the CLASSIFICATION; whether the
 * operator is asked is read from the server's listing by the side that decides,
 * never from a string the model produced.
 */
export const PluginBridgeCallSchema = z.object({
  /** The namespaced name, `<slug>__<tool>`, exactly as a direct tool would be. */
  tool: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
});
export type PluginBridgeCall = z.infer<typeof PluginBridgeCallSchema>;
