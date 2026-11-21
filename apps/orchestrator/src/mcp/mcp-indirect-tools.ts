import type { CommitAdapter } from '../agent/policy/policy.js';
import { JsonSchema, type Json } from '@crewaid/shared';
import { pluginArgumentValidator } from '../agent/policy/validate-arguments.js';
import { pluginRevision } from '../agent/policy/resource-revision.js';
import { tool } from '../agent/tool-contract.js';
import { z } from 'zod';
type JsonSchemaDocument = Record<string, unknown>;
import { PLUGIN_LISTING_TOKEN_BUDGET } from '@crewaid/shared';

import type { RegisteredTool, ToolBehavior, UnwrappedToolCall } from '../agent/tool-registry.js';
import { MCP_CALL_TIMEOUT_MS, MCP_STRIKE_LIMIT, mcpResultText } from './mcp-tool-binding.js';
import type { McpToolCaller } from './mcp-tool-binding.js';
import { FIND_PLUGIN_TOOLS, USE_PLUGIN_TOOL, pluginToolRequest } from './plugin-bridge-call.js';

/**
 * every plugin tool goes behind two doors, whatever the bot has.
 *
 * What this replaces, and why
 *
 * §7.4 capped a bot at forty resolved tool definitions and MCP plugins asked for the
 * overage to be refused with a clear error; implemented both literally
 * and recorded that the result is a cliff — a thirty-tool server is refused
 * beside this build's own tools. put the overflow behind
 * three doors, which removed the cliff for the tools that did NOT fit and left
 * the number doing no work: a bot with a 41st tool got a search box, a bot
 * with 39 got forty definitions and no way to search them.
 *
 * A count of DEFINITIONS was never the thing MCP plugins is protecting. Its own
 * sentence says what is: "ninety tool definitions in every single request …
 * degrades tool selection accuracy and burns input tokens on every step of
 * every turn." What costs is what the model is sent, and a count is a bad
 * proxy for it — two definitions of the same size can cost 80 tokens or 800.
 *
 * So: the bridge is the path, and the budget is tokens
 *
 * This is Hermes Agent's tool-search, which is public and which the operator
 * pointed at: MCP tools are always deferred, the model is given a small fixed
 * bridge instead, and what is bounded is the LISTING — by tokens, degrading as
 * it grows — rather than the number of tools behind it. Hermes' docstring
 * states the invariant this file keeps: "ANY deferrable tool activates the
 * bridge (the listing scales with budget, not activation)".
 *
 * Three consequences, all deliberate:
 *
 * 1. **Nothing is refused for size.** `PUT /bots/:id/plugins` has no
 * arithmetic left in it, and a 500-tool server is accepted like any
 * other. There is no number an operator can exceed and no configuration
 * they can want that the build will not take.
 * 2. **Every plugin tool is reachable, always.** The listing degrades —
 * name/plugin/one-line, then names, then the plugins' own names — and
 * reachability does not depend on it: `find_plugin_tools` with a query
 * searches the whole catalogue, and a name that is not advertised still
 * runs. A cut in the listing is a cut in what is ADVERTISED, never in
 * what works.
 * 3. **The prompt footprint stops growing with the catalogue.** A bot's
 * plugin surface is two definitions and at most
 * `PLUGIN_LISTING_TOKEN_BUDGET` tokens of listing, whether it has three
 * tools or three thousand.
 *
 * What it costs, said out loud
 *
 * Hermes' own guide lists the same trade-offs and they are real here: a plugin
 * call is one round trip longer (find, then run), the model gets no
 * provider-native validation of a plugin tool's arguments before the call (the
 * schema reaches it in the search answer instead), and a bot that would have
 * been fine with six direct definitions now pays for a search. What it buys is
 * that there is no size at which the product stops working, and no cliff for
 * an operator to fall off at. A build that wanted direct definitions for small
 * plugin sets would have to keep two surfaces, which is the situation that
 * produced the cliff in the first place.
 *
 * One call door, not two
 *
 * needed two call doors because approval is decided per tool NAME
 * and a single door has a single classification: it is either `sensitive`, and
 * "Tools classified `readOnly` default to `allow`" is lost for everything
 * behind it, or `contained`, and every write runs unasked. Hermes answers the
 * same problem differently and better: the bridge call is UNWRAPPED before the
 * guardrails see it, so what is classified is the tool the call is really
 * about, not the door it came through. `RegisteredTool.unwrap` is that seam
 * here, and `agent/tool-approval.ts` is where it is consulted. With it, one
 * door keeps both halves of MCP plugins approval rule and a read-only plugin tool
 * still runs without asking.
 */

/** How many definitions the bridge itself costs, however big the catalogue. */
export const BRIDGE_TOOL_SLOTS = 2;

/** One tool in the catalogue — everything a model needs to find and call it. */
export type CatalogueEntry = {
  /** The namespaced name, `<slug>__<tool>`, exactly as a direct tool would be. */
  readonly name: string;
  /** What the operator called the server. */
  readonly serverName: string;
  readonly serverId: string;
  /** The SERVER's own name for it — what a call goes back under. */
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaDocument;
  /** verdict, and what the search answer tells the model to expect. */
  readonly readOnly: boolean;
  /**
   * The descriptor the bound definition carries, NOT re-derived here.
   *
   * A call through the door is classified by this, so it has to be the
   * one binding produced — `origin` naming the real server, `reach`
   *'s ladder — or the door and the direct definition it replaced
   * could disagree about whether the operator is asked.
   */
  readonly behavior: ToolBehavior;
  readonly commitAdapter?: CommitAdapter;
  readonly dispatch?: RegisteredTool['build'];
  readonly source?: string;
  readonly normalize?: (input: unknown) => Json;
};

/**
 * The most matches a search answers with, before the token budget has its say.
 *
 * Two bounds rather than one because they stop different things: this one
 * keeps an answer readable when the matches are small, and the budget in
 * `search` keeps it affordable when they are not. Whichever binds first wins,
 * and the withheld count is reported the same way either way.
 */
const MAX_MATCHES = 10;

/**
 * What one estimated token costs, for the listing budget.
 *
 * Hermes estimates the same way and for the same reason: a tokenizer is a real
 * dependency and a real cost on the path that assembles every turn's tool set,
 * and this number is a budget rather than a fence — what it decides is which
 * FORM the listing takes, not whether a tool exists. It is close for English
 * prose and over-counts names and punctuation, which is the safe direction;
 * text a tokenizer would spend more on than this (CJK descriptions) is
 * admitted by the degradation order, which falls through to a shorter form
 * rather than to an unreachable tool.
 */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

const CONTAINED: ToolBehavior = {
  origin: { kind: 'builtin' },
  failure: { kind: 'isolate' },
  // Searching the plugin catalogue only reads it.
  effect: 'read',
  authority: false,
};

/**
 * The descriptor of the call door itself.
 *
 * ⚠️ A CALL IS NOT CLASSIFIED BY THIS. `unwrap` answers that with the
 * underlying tool's own descriptor, and this value is only what a reader that
 * asks about the NAME `use_plugin_tool` gets — so it is the fail-safe
 * direction: anything reaching this door is `sensitive`, which asks. The
 * remote failure policy is the real one, because a call through the door is a
 * call to a third party's server whichever tool it names.
 */
const DOOR_DEFAULT: ToolBehavior = {
  origin: { kind: 'builtin' },
  failure: {
    kind: 'isolate-remote',
    callTimeoutMs: MCP_CALL_TIMEOUT_MS,
    strikeLimit: MCP_STRIKE_LIMIT,
  },
  effect: 'unknown',
  authority: false,
};

/**
 * The two definitions, over one catalogue.
 *
 * Returns nothing when the catalogue is empty: two tools that can only answer
 * "there are none" are two slots and a paragraph spent saying so, and a bot
 * with no plugins is better served by a tool list that does not mention them.
 */
export function indirectPluginTools(
  catalogue: readonly CatalogueEntry[],
  callTool: McpToolCaller,
): RegisteredTool[] {
  if (catalogue.length === 0) return [];
  const byName = new Map(catalogue.map((entry) => [entry.name, entry]));

  return [
    {
      name: FIND_PLUGIN_TOOLS,
      behavior: CONTAINED,
      build: () =>
        tool({
          // The listing rides in the DEFINITION, which is the half that saves
          // the round trip (Hermes measured models declaring a capability
          // missing, or shelling out to a CLI, when the bridge advertised
          // nothing). It is bounded by the budget and degrades in form.
          description: [
            'Every plugin tool this bot has, listed below by name. They are not in your tool list:',
            'there are too many to spend a definition on each, so one is run by name with',
            `${USE_PLUGIN_TOOL}. Call this tool with a query to get the argument schema for the ones`,
            'that match a tool name or description.',
            '',
            listing(catalogue),
          ].join('\n'),
          inputSchema: z.object({
            query: z
              .string()
              .describe('Words to match against a tool name or description, e.g. "issue"')
              .optional(),
          }),
          // Not async: searching a list this turn already holds touches
          // nothing, so there is no failure to isolate and nothing to count.
          execute: (input: { query?: string | undefined }) => search(catalogue, input.query),
        }),
    },
    {
      name: USE_PLUGIN_TOOL,
      behavior: DOOR_DEFAULT,
      build: (context) =>
        tool({
          description:
            'Run one plugin tool by its exact name. Pass the name find_plugin_tools listed and ' +
            'arguments matching the schema it returned. The operator is asked before a tool that ' +
            'writes runs; a read-only one runs without asking.',
          inputSchema: z.object({
            tool: z
              .string()
              // Non-empty, so an absent name is the provider's error rather
              // than a catalogue lookup that misses and a "did you mean" built
              // by asking every entry whether it contains the empty string.
              .min(1)
              .describe('The exact name from find_plugin_tools, e.g. github__create_issue'),
            arguments: z
              .record(z.string(), z.unknown())
              .describe('Arguments matching the schema find_plugin_tools returned')
              .optional(),
          }),
          execute: async (
            input: {
              tool: string;
              arguments?: Record<string, unknown> | undefined;
            },
            options,
          ) => {
            const entry = byName.get(input.tool);
            if (entry === undefined) return unknownTool(input.tool, catalogue);
            if (entry.dispatch) {
              const definition = entry.dispatch(context);
              if (!definition.execute) return 'The plugin tool has no execution handler.';
              const result = await definition.execute(input.arguments ?? {}, options);
              return result;
            }
            return run(entry, input.arguments ?? {}, callTool, options.abortSignal);
          },
          toModelOutput: ({ output }) => ({
            type: 'text',
            value: typeof output === 'string' ? output : mcpResultText(output),
          }),
        }),
      /**
       * D-113's seam: what this CALL is really about.
       *
       * The approval matcher and the operator both ask this question, and both
       * have to get the plugin tool rather than the door — otherwise §6/M6's
       * `readOnly` defaults to allow" would be decided for every plugin tool
       * by the door's one classification, which is D-110's problem returning
       * with the door count changed.
       *
       * The behaviour comes from the catalogue (the binding's own descriptor),
       * and a name that is NOT in the catalogue has none — which
       * `decideAutoReview` answers with `deny`, the same fail-closed direction
       * it takes for any name it does not know. A hallucinated tool cannot
       * reach a server, and the model gets a refusal it can read.
       */
      unwrap: (args: unknown): UnwrappedToolCall | undefined => {
        const requested = pluginToolRequest(args);
        if (requested === undefined) return undefined;
        const entry = byName.get(requested.name);
        return {
          name: requested.name,
          args: entry?.normalize ? entry.normalize(requested.args) : requested.args,
          behavior: entry?.behavior,
          ...(entry !== undefined && {
            validate: pluginArgumentValidator(entry.inputSchema),
            ...(entry.commitAdapter ? { commitAdapter: entry.commitAdapter } : {}),
            resource: {
              toolName: entry.toolName,
              revision: pluginRevision(entry.serverId, {
                name: entry.toolName,
                inputSchema: entry.inputSchema,
                readOnly: entry.readOnly,
                ...(entry.source ? { source: entry.source } : {}),
              }),
            },
          }),
          repackArgs: (edited) => JsonSchema.parse({ tool: requested.name, arguments: edited }),
        };
      },
    },
  ];
}

/**
 * The catalogue as text, in the most informative form that fits the budget.
 *
 * The three rungs are ordered by what they cost the model to use rather than
 * by what they cost to send: name + plugin + one line needs no round trip to
 * choose from; names alone need a search to learn what one does; the plugins'
 * own names need a search to learn that anything exists. Each rung is tried
 * whole, so the shape of the listing never depends on how far down it got.
 */
export function listing(
  catalogue: readonly CatalogueEntry[],
  budgetTokens: number = PLUGIN_LISTING_TOKEN_BUDGET,
): string {
  const head = `${String(catalogue.length)} plugin tool(s)`;
  const rungs: readonly { readonly lines: readonly string[]; readonly note: string }[] = [
    {
      lines: catalogue.map(
        (entry) => `${entry.name} (${entry.serverName}) — ${firstLine(entry.description)}`,
      ),
      note: '',
    },
    {
      lines: catalogue.map((entry) => entry.name),
      note: ' (names only — call find_plugin_tools with a query for what one takes)',
    },
    {
      lines: byServer(catalogue).map(
        ([serverName, tools]) => `${serverName} — ${String(tools.length)} tool(s)`,
      ),
      note: ' (call find_plugin_tools with a query to find one)',
    },
  ];

  for (const rung of rungs) {
    const body = [head, ...rung.lines].join('\n');
    const withNote = rung.note === '' ? body : `${body}\n${rung.note.trim()}`;
    if (estimateTokens(withNote) <= budgetTokens) return withNote;
  }

  // The third rung did not fit either, which takes thousands of installed
  // plugins. Cut it at the budget and say how many are left out rather than
  // returning a listing that overruns the number this file promises.
  const servers = rungs[2]?.lines ?? [];
  const note = (rungs[2]?.note ?? '').trim();
  const kept: string[] = [];
  for (const line of servers) {
    const remaining = servers.length - kept.length - 1;
    const tail = remaining > 0 ? [`…and ${String(remaining)} more plugin(s)`] : [];
    if (estimateTokens([head, ...kept, line, ...tail, note].join('\n')) > budgetTokens) break;
    kept.push(line);
  }
  const omitted = servers.length - kept.length;
  return [
    head,
    ...kept,
    ...(omitted > 0 ? [`…and ${String(omitted)} more plugin(s)`] : []),
    note,
  ].join('\n');
}

/** The catalogue grouped by plugin, in catalogue order — stable per turn. */
function byServer(catalogue: readonly CatalogueEntry[]): [string, CatalogueEntry[]][] {
  const groups = new Map<string, CatalogueEntry[]>();
  for (const entry of catalogue) {
    const group = groups.get(entry.serverName);
    if (group === undefined) groups.set(entry.serverName, [entry]);
    else group.push(entry);
  }
  return [...groups.entries()];
}

/**
 * One match, as the model needs to see it to call the tool.
 *
 * The schema is the whole point of a query — it is the half a direct
 * definition would have carried — so it goes in whole or not at all. A
 * truncated JSON Schema is not a smaller schema, it is an unparseable one, and
 * a model handed half an object literal will either guess the rest or give up.
 */
function matchBlock(entry: CatalogueEntry): string {
  return [
    `${entry.name} (${entry.serverName})`,
    entry.description === '' ? '(the server gave no description)' : entry.description,
    `arguments: ${JSON.stringify(entry.inputSchema)}`,
    // Said per tool, because it is what the model should expect at the
    // approval: the answer is the same for both, the prompt in front of the
    // operator is not.
    entry.readOnly
      ? 'read-only — it runs without asking'
      : 'this one writes — the operator is asked to approve it',
  ].join('\n');
}

/**
 * The catalogue, or the matches with their schemas.
 *
 * No query is the cheap answer — the same listing the definition carries, so
 * the two can never describe the bot's plugins differently. A query
 * materializes the schema for what matched, which is the half that would have
 * cost a slot per tool.
 *
 * ── THE ANSWER IS BUDGETED TOO, AND IT IS THE EXPENSIVE HALF ────────────────
 *
 * The listing rides in a tool DESCRIPTION: it is part of the prompt prefix, it
 * is identical across a conversation's turns, and a provider's prefix cache
 * therefore pays for it once (D-094's reason for keeping the prefix stable).
 * This answer is a tool RESULT. It lands in the message history behind that
 * prefix and is re-sent on every subsequent step of the turn, uncached — which
 * is §6/M6's sentence exactly: "burns input tokens on every step of every
 * turn". Ten schemas at a kilobyte each is a bigger recurring cost than the
 * whole advertisement, so it cannot be the half that goes unbounded.
 *
 * `MAX_MATCHES` alone did not bound it: a count of schemas is the same bad
 * proxy for cost that a count of definitions was, which is the premise this
 * whole file rejects. So the same `PLUGIN_LISTING_TOKEN_BUDGET` applies, and
 * the same rule as the listing decides what gives: the FORM degrades, the
 * reachability never does.
 *
 * ⚠️ WHICH IS WHY THE FIRST MATCH IS ADMITTED WHATEVER IT COSTS. A tool whose
 * schema alone exceeds the budget must still be callable, and the schema is
 * what makes it callable; refusing it would put a tool behind a search that
 * cannot answer for it, and "a name the listing omitted still runs" would stop
 * being true. Every match after the first is admitted while it fits, and the
 * ones that do not are named as a count so the model knows to narrow rather
 * than concluding they do not exist.
 */
function search(catalogue: readonly CatalogueEntry[], query: string | undefined): string {
  const words = (query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0) return listing(catalogue);

  const matches = catalogue.filter((entry) => {
    const haystack = `${entry.name} ${entry.serverName} ${entry.description}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
  if (matches.length === 0) {
    return `Nothing matches "${String(query)}". Call ${FIND_PLUGIN_TOOLS} with no query to see every name.`;
  }

  const blocks: string[] = [];
  let spent = 0;
  for (const entry of matches.slice(0, MAX_MATCHES)) {
    const block = matchBlock(entry);
    const cost = estimateTokens(block);
    // `blocks.length === 0` is the reachability floor, not an off-by-one: the
    // first match is answered even when it alone is over budget.
    if (blocks.length > 0 && spent + cost > PLUGIN_LISTING_TOKEN_BUDGET) break;
    blocks.push(block);
    spent += cost;
  }

  const withheld = matches.length - blocks.length;
  const more =
    withheld > 0 ? [`(${String(withheld)} more match; narrow the query to see them.)`] : [];
  return [...blocks, ...more].join('\n\n');
}

async function run(
  entry: CatalogueEntry,
  args: Record<string, unknown>,
  callTool: McpToolCaller,
  abortSignal?: AbortSignal,
): Promise<unknown> {
  try {
    const valid = await pluginArgumentValidator(entry.inputSchema)(args);
    if (!valid.ok) return `INVALID_ARGUMENTS: ${valid.reason}`;
    return await callTool({
      serverId: entry.serverId,
      // The SERVER's name, exactly as a direct binding sends it (D-104).
      toolName: entry.toolName,
      args,
      timeoutMs: MCP_CALL_TIMEOUT_MS,
      ...(abortSignal !== undefined && { abortSignal }),
    });
  } catch (error: unknown) {
    // `isolate-remote`, same as a direct call: the model reads a refusal and
    // gets another step, and the turn does not end because a third party's
    // server did.
    return `${entry.name} could not be called: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

/**
 * A name that is not in the catalogue.
 *
 * Names the closest few rather than only refusing: the model reached for a
 * tool it believes exists, and "no such tool" with nothing else sends it round
 * the search again for something it may have spelled one character wrong.
 */
function unknownTool(name: string, catalogue: readonly CatalogueEntry[]): string {
  const near = catalogue
    .filter((entry) => entry.name.includes(name) || name.includes(entry.name.split('__')[0] ?? ''))
    .slice(0, 5)
    .map((entry) => entry.name);
  const hint =
    near.length === 0
      ? `Call ${FIND_PLUGIN_TOOLS} to see what is available.`
      : `Did you mean: ${near.join(', ')}?`;
  return `No plugin tool named "${name}" is available to this bot. ${hint}`;
}

function firstLine(description: string): string {
  const line = description.split('\n')[0]?.trim() ?? '';
  return line === '' ? '(no description)' : line;
}
