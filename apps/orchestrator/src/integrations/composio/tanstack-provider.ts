import { BaseNonAgenticProvider, type Tool } from '@composio/core';
import type { ToolDefinition, ToolSet } from '../../agent/tool-contract.js';
import { jsonSchema } from '../../agent/tool-contract.js';

/** TanStack owns dispatch. A catalog definition cannot invoke a vendor callback. */
export class CrewaidTanStackProvider extends BaseNonAgenticProvider<ToolSet, ToolDefinition> {
  readonly name = 'CrewaidTanStackProvider';

  wrapTool(source: Tool): ToolDefinition {
    if (source.inputParameters === undefined) throw new Error('COMPOSIO_SCHEMA_INVALID');
    return {
      description: source.description ?? source.name,
      inputSchema: jsonSchema(source.inputParameters),
    };
  }

  wrapTools(sources: Tool[]): ToolSet {
    return Object.fromEntries(sources.map((source) => [source.slug, this.wrapTool(source)]));
  }
}
