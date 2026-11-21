import { PLUGIN_LISTING_TOKEN_BUDGET } from '@crewaid/shared';
import type { ChatMiddleware, ModelMessage, Tool } from '@tanstack/ai';
import { z } from 'zod';

/**
 * which deferred tools a step is sent.
 *
 * The run is given every tool it may call; this decides, before each model
 * call, which of the deferred ones the model sees. A deferred tool is in the
 * list when the run's history loaded it (`find_plugin_tools` answered with its
 * name) or called it, most recent first, until their definitions would cost
 * more than budget — and always when a call to it is still waiting on
 * a result, because a resumed run executes those calls from this list.
 *
 * Read back from history rather than remembered, for two reasons: a resumed
 * run is a new engine with nothing remembered, and the history is the one
 * record both a later turn and an approval continuation share. The engine's
 * own lazy tools scan history once, before this app's persistence has loaded
 * any, which is why they are not used.
 */
export function deferredTools(input: {
  readonly tools: readonly Tool[];
  readonly discovery: string;
  readonly names: ReadonlySet<string>;
  readonly budgetTokens?: number;
  readonly enabled?: () => boolean;
}): ChatMiddleware {
  const deferred = input.tools.filter((tool) => input.names.has(tool.name));
  const cost = new Map(deferred.map((tool) => [tool.name, definitionCost(tool)]));
  const budget = input.budgetTokens ?? PLUGIN_LISTING_TOKEN_BUDGET;
  return {
    name: 'crewaid-deferred-tools',
    onConfig(_ctx, config) {
      if (input.enabled?.() === false) return { tools: [] };
      const active = activeNames(config.messages, input, cost, budget);
      return {
        tools: [
          ...config.tools.filter((tool) => !input.names.has(tool.name)),
          ...deferred.filter((tool) => active.has(tool.name)),
        ],
      };
    },
  };
}

function definitionCost(tool: Tool): number {
  return Math.ceil(
    `${tool.name}${tool.description}${JSON.stringify(tool.inputSchema ?? {})}`.length / 4,
  );
}

function activeNames(
  messages: readonly ModelMessage[],
  input: Parameters<typeof deferredTools>[0],
  cost: ReadonlyMap<string, number>,
  budget: number,
): Set<string> {
  const discoveryCalls = new Set<string>();
  const answered = new Set<string>();
  // Oldest first; each mention of a deferred name, by load or by call.
  const mentions: string[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        if (call.function.name === input.discovery) discoveryCalls.add(call.id);
        else if (input.names.has(call.function.name)) mentions.push(call.function.name);
      }
    } else if (message.role === 'tool' && message.toolCallId !== undefined) {
      answered.add(message.toolCallId);
      if (discoveryCalls.has(message.toolCallId))
        for (const name of loadedNames(message.content))
          if (input.names.has(name)) mentions.push(name);
    }
  }
  const active = new Set<string>();
  // A call still waiting on its result runs from this list on a resume.
  for (const message of messages)
    if (message.role === 'assistant')
      for (const call of message.toolCalls ?? [])
        if (!answered.has(call.id) && input.names.has(call.function.name))
          active.add(call.function.name);
  let spent = [...active].reduce((total, name) => total + (cost.get(name) ?? 0), 0);
  for (const name of mentions.reverse()) {
    if (active.has(name)) continue;
    const next = cost.get(name) ?? 0;
    if (spent + next > budget) break;
    active.add(name);
    spent += next;
  }
  return active;
}

const LoadAnswerSchema = z.object({ loaded: z.array(z.string()) });

/**
 * The names a stored discovery result loaded: `{ loaded: string[] }`, as the
 * discovery tool answers (`mcp-deferred-tools.ts`), stored as JSON text.
 * Anything else loaded nothing.
 */
export function loadedNames(output: unknown): readonly string[] {
  let value = output;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  const parsed = LoadAnswerSchema.safeParse(value);
  return parsed.success ? parsed.data.loaded : [];
}
