import { z } from 'zod';
import { JsonSchema, JsonSchemaObjectSchema, type Json } from '@crewaid/shared';
import { pluginArgumentValidator, type ArgumentValidator } from './policy/validate-arguments.js';

export type ToolCallOptions = {
  readonly toolCallId: string;
  readonly messages: readonly unknown[];
  readonly abortSignal?: AbortSignal;
};
export type ModelToolOutput =
  | { type: 'text' | 'error-text'; value: string }
  | { type: 'json' | 'error-json'; value: Json }
  | {
      type: 'content';
      value: Array<{ type: 'text'; text: string } | { type: 'file'; [key: string]: unknown }>;
    }
  | { type: 'execution-denied'; reason?: string };

export type JsonToolSchema<T = unknown> = {
  readonly jsonSchema: Record<string, Json>;
  readonly parse: (input: unknown) => Promise<T>;
};
export type ToolInputSchema = z.ZodType | JsonToolSchema;
type InputOf<S> = S extends z.ZodType
  ? z.output<S>
  : S extends JsonToolSchema<infer T>
    ? T
    : unknown;

/** Server values only. Neither SDK tool objects nor credentials belong here. */
export type ToolDefinition = {
  readonly description?: string;
  readonly inputSchema: ToolInputSchema;
  readonly outputSchema?: z.ZodType;
  readonly execute?: (input: unknown, options: ToolCallOptions) => unknown;
  readonly toModelOutput?: (options: {
    toolCallId: string;
    input: unknown;
    output: unknown;
  }) => ModelToolOutput | PromiseLike<ModelToolOutput>;
};
export type ToolSet = Record<string, ToolDefinition>;

/** Infer native arguments once, then expose one validated neutral dispatch. */
export function tool<S extends ToolInputSchema, O>(definition: {
  description?: string;
  inputSchema: S;
  outputSchema?: z.ZodType<O>;
  execute?: (input: InputOf<S>, options: ToolCallOptions) => O | PromiseLike<O>;
  toModelOutput?: (options: {
    toolCallId: string;
    input: InputOf<S>;
    output: O;
  }) => ModelToolOutput | PromiseLike<ModelToolOutput>;
}): ToolDefinition {
  const parseOutput = (output: unknown): O => {
    const raw = JsonSchema.parse(output ?? null);
    if (definition.outputSchema !== undefined) {
      const parsed = definition.outputSchema.parse(raw);
      if (!preservesSuppliedValues(raw, parsed) || !preservesSuppliedValues(parsed, raw))
        throw new Error('Output validation cannot transform a canonical result.');
    }
    return raw as O;
  };
  const execute = definition.execute;
  const project = definition.toModelOutput;
  return {
    ...(definition.description !== undefined && { description: definition.description }),
    inputSchema: definition.inputSchema,
    ...(definition.outputSchema !== undefined && { outputSchema: definition.outputSchema }),
    ...(execute !== undefined && {
      execute: async (input: unknown, options: ToolCallOptions) => {
        if (options.abortSignal?.aborted)
          throw new Error('TOOL_CANCELLED: no action was dispatched.');
        const args = await parseToolInput(definition.inputSchema, input);
        const output = await execute(args, options);
        try {
          return parseOutput(output);
        } catch {
          throw new Error('TOOL_OUTPUT_INVALID: the result does not match its server schema.');
        }
      },
    }),
    ...(project !== undefined && {
      toModelOutput: async (options: { toolCallId: string; input: unknown; output: unknown }) => {
        const input = await parseToolInput(definition.inputSchema, options.input);
        return project({ ...options, input, output: parseOutput(options.output) });
      },
    }),
  };
}

export async function parseToolInput<S extends ToolInputSchema>(
  schema: S,
  input: unknown,
): Promise<InputOf<S>> {
  const value: unknown =
    schema instanceof z.ZodType ? await schema.parseAsync(input) : await schema.parse(input);
  if (!preservesSuppliedValues(input, value)) {
    throw new Error('INVALID_ARGUMENTS: schema transformations cannot change supplied arguments.');
  }
  return value as InputOf<S>;
}

/** Defaults may fill absent fields; supplied values and keys must survive unchanged. */
function preservesSuppliedValues(input: unknown, output: unknown): boolean {
  if (Object.is(input, output)) return true;
  if (Array.isArray(input)) {
    return (
      Array.isArray(output) &&
      input.length === output.length &&
      input.every((value: unknown, index) => preservesSuppliedValues(value, output[index]))
    );
  }
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    if (output === null || typeof output !== 'object' || Array.isArray(output)) return false;
    const source: Record<string, unknown> = Object.fromEntries(Object.entries(input));
    const target: Record<string, unknown> = Object.fromEntries(Object.entries(output));
    return Object.entries(source).every(
      ([key, value]) => Object.hasOwn(target, key) && preservesSuppliedValues(value, target[key]),
    );
  }
  return false;
}

export function toolInputValidator(schema: ToolInputSchema): ArgumentValidator {
  return async (input) => {
    try {
      return { ok: true, value: JsonSchema.parse(await parseToolInput(schema, input)) };
    } catch {
      return { ok: false, reason: 'Arguments do not match the tool schema.' };
    }
  };
}

export function toolInputJsonSchema(schema: ToolInputSchema): Record<string, Json> {
  return schema instanceof z.ZodType
    ? JsonSchemaObjectSchema.parse(z.toJSONSchema(schema, { target: 'draft-07', io: 'input' }))
    : schema.jsonSchema;
}

/** Remote schemas use the same bounded Ajv validator as final policy dispatch. */
export function jsonSchema<T = Record<string, Json>>(schema: unknown): JsonToolSchema<T> {
  const jsonSchema = JsonSchemaObjectSchema.parse(schema);
  const validate = pluginArgumentValidator(jsonSchema);
  return {
    jsonSchema,
    parse: async (input) => {
      const result = await validate(input);
      if (!result.ok) throw new Error(`INVALID_ARGUMENTS: ${result.reason}`);
      return result.value as T;
    },
  };
}
