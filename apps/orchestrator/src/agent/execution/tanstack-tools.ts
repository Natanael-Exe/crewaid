import { toolDefinition } from '@tanstack/ai';
import { JsonSchema } from '@crewaid/shared';
import { toolInputJsonSchema, type ToolSet } from '../tool-contract.js';

/** TanStack owns execution framing; dispatch remains inside registry guards. */
export function tanstackTools(definitions: ToolSet) {
  return Object.entries(definitions).map(([name, definition]) => {
    const execute = definition.execute;
    return toolDefinition({
      name,
      description: definition.description ?? name,
      inputSchema: toolInputJsonSchema(definition.inputSchema),
      outputSchema: JsonSchema,
    }).server(async (input, context) => {
      if (execute === undefined) throw new Error('TOOL_UNAVAILABLE: no server implementation.');
      if (!context?.toolCallId) throw new Error('TOOL_UNAVAILABLE: missing server call id.');
      if (context.abortSignal?.aborted)
        throw new Error('TOOL_CANCELLED: no action was dispatched.');
      const output = await execute(input, {
        toolCallId: context.toolCallId,
        messages: [],
        ...(context.abortSignal !== undefined && { abortSignal: context.abortSignal }),
      });
      return JsonSchema.parse(output ?? null);
    });
  });
}
