import { FIND_PLUGIN_TOOLS, PLUGIN_LISTING_TOKEN_BUDGET } from '@crewaid/shared';
import { z } from 'zod';
import { tool } from '../agent/tool-contract.js';
import type { RegisteredTool, ToolBehavior } from '../agent/tool-registry.js';
import { estimateTokens, listing, type CatalogueEntry } from './mcp-indirect-tools.js';

/**
 * a TanStack run's plugin surface: every granted plugin tool as itself,
 * plus one tool that loads them.
 *
 * The tools are the bindings, unchanged. What is new is that none of
 * them is sent to the model until it asks: `find_plugin_tools` answers with the
 * names it LOADED, and the run's deferred-tools middleware (agent/execution)
 * puts the loaded definitions in the next step's tool list, reading them back
 * from the run's history. The listing in this tool's description is,
 * under the same token budget, so the prompt still does not grow with the
 * catalogue.
 */

/** The most tools one answer loads, before the token budget has its say. */
const MAX_LOADED = 10;

const CONTAINED: ToolBehavior = {
  origin: { kind: 'builtin' },
  failure: { kind: 'isolate' },
  effect: 'read',
  authority: false,
};

/** What one plugin tool's definition costs the model, estimated does. */
export function definitionTokens(entry: CatalogueEntry): number {
  return estimateTokens(`${entry.name}${entry.description}${JSON.stringify(entry.inputSchema)}`);
}

/** What `find_plugin_tools` answers: names, never schemas — the definitions carry those. */
export type PluginLoadAnswer = {
  readonly loaded: readonly string[];
  readonly unknown?: readonly string[];
  readonly more?: number;
  readonly listing?: string;
  readonly note: string;
};

function load(
  catalogue: readonly CatalogueEntry[],
  input: { query?: string | undefined; names?: readonly string[] | undefined },
): PluginLoadAnswer {
  const byName = new Map(catalogue.map((entry) => [entry.name, entry]));
  const named = input.names ?? [];
  const words = (input.query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
  if (named.length === 0 && words.length === 0) {
    return {
      loaded: [],
      listing: listing(catalogue),
      note: 'Nothing loaded. Pass names from this listing, or a query, to load tools.',
    };
  }
  const wanted = [
    ...named.flatMap((name) => {
      const entry = byName.get(name);
      return entry === undefined ? [] : [entry];
    }),
    ...(words.length === 0
      ? []
      : catalogue.filter((entry) => {
          const haystack = `${entry.name} ${entry.serverName} ${entry.description}`.toLowerCase();
          return words.every((word) => haystack.includes(word));
        })),
  ].filter((entry, index, all) => all.indexOf(entry) === index);
  const loaded: string[] = [];
  let spent = 0;
  for (const entry of wanted) {
    const cost = definitionTokens(entry);
    if (loaded.length === MAX_LOADED || spent + cost > PLUGIN_LISTING_TOKEN_BUDGET) break;
    loaded.push(entry.name);
    spent += cost;
  }
  const unknown = named.filter((name) => !byName.has(name));
  const more = wanted.length - loaded.length;
  return {
    loaded,
    ...(unknown.length > 0 && { unknown }),
    ...(more > 0 && { more }),
    note:
      loaded.length === 0
        ? 'No plugin tool matched. Try other words, or call this with no arguments for the list.'
        : 'Loaded: these are in your tool list from your next step. Call them by name.' +
          (more > 0 ? ` ${String(more)} more matched; narrow the query to load them.` : ''),
  };
}

/** The plugin tools as themselves, behind `find_plugin_tools`. Empty without a catalogue. */
export function deferredPluginTools(
  catalogue: readonly CatalogueEntry[],
  bound: readonly RegisteredTool[],
): RegisteredTool[] {
  if (catalogue.length === 0) return [];
  return [
    {
      name: FIND_PLUGIN_TOOLS,
      behavior: CONTAINED,
      build: () =>
        tool({
          description: [
            'Load plugin tools. The plugin tools this bot has are listed below; they are not in',
            'your tool list until you load them. Pass their names, or a query that matches a name',
            'or description, and the ones loaded are callable by name from your next step.',
            '',
            listing(catalogue),
          ].join('\n'),
          inputSchema: z.object({
            names: z
              .array(z.string().min(1))
              .max(MAX_LOADED)
              .describe('Exact names from the list, e.g. github__create_issue')
              .optional(),
            query: z
              .string()
              .describe('Words to match against a tool name or description, e.g. "issue"')
              .optional(),
          }),
          execute: (input: { names?: string[] | undefined; query?: string | undefined }) =>
            load(catalogue, input),
        }),
    },
    ...bound,
  ];
}
