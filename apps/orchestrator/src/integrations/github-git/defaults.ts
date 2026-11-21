import { JsonSchema, type Json } from '@crewaid/shared';

/** The neutral request default used by policy projection and execution. */
export function defaultDraft(input: unknown): Json {
  const value = JsonSchema.parse(input);
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value['draft'] === undefined
    ? { ...value, draft: true }
    : value;
}
import type { RegisteredTool } from '../../agent/tool-registry.js';

/** Project and execute the same default before schema validation or policy hashing. */
export function draftPullRequests(tool: RegisteredTool): RegisteredTool {
  return {
    ...tool,
    unwrap: (args) => ({
      name: tool.name,
      args: defaultDraft(args),
      behavior: tool.behavior,
      ...(tool.commitAdapter ? { commitAdapter: tool.commitAdapter } : {}),
      ...(tool.validate ? { validate: tool.validate } : {}),
      ...(tool.resource ? { resource: tool.resource } : {}),
      repackArgs: (value) => value,
    }),
    build: (context) => {
      const definition = tool.build(context);
      const execute = definition.execute;
      return execute
        ? { ...definition, execute: (args, options) => execute(defaultDraft(args), options) }
        : definition;
    },
  };
}
