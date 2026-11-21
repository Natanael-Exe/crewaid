import { z } from 'zod';
import { JsonSchema } from '@crewaid/shared';
import type { TokenUsage } from '@tanstack/ai';

const counter = z.number().int().nonnegative().max(2_147_483_647);
const total = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const measure = z.number().nonnegative();
const details = z.record(z.string(), counter);
const nonNullJson = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(JsonSchema),
  z.record(z.string(), JsonSchema),
]);

/** Validate the known library fields while preserving future JSON extensions. */
export const RunUsageSchema = z
  .object({
    promptTokens: counter,
    completionTokens: counter,
    totalTokens: total,
    promptTokensDetails: details.optional(),
    completionTokensDetails: details.optional(),
    billed: z
      .object({ quantity: measure, unit: z.string().min(1) })
      .catchall(JsonSchema)
      .optional(),
    durationSeconds: measure.optional(),
    unitsBilled: measure.optional(),
    providerUsageDetails: z.record(z.string(), nonNullJson).optional(),
    cost: measure.optional(),
    costDetails: z.record(z.string(), measure).optional(),
  })
  .catchall(JsonSchema);

/** Zod optional keys may be explicit undefined; the library requires omission. */
export function parseRunUsage(input: unknown): TokenUsage {
  const {
    promptTokensDetails,
    completionTokensDetails,
    billed,
    durationSeconds,
    unitsBilled,
    providerUsageDetails,
    cost,
    costDetails,
    ...rest
  } = RunUsageSchema.parse(input);
  return {
    ...rest,
    ...optional('promptTokensDetails', promptTokensDetails),
    ...optional('completionTokensDetails', completionTokensDetails),
    ...optional('billed', billed),
    ...optional('durationSeconds', durationSeconds),
    ...optional('unitsBilled', unitsBilled),
    ...optional('providerUsageDetails', providerUsageDetails),
    ...optional('cost', cost),
    ...optional('costDetails', costDetails),
  };
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  const result: { [P in K]?: V } = {};
  if (value !== undefined) result[key] = value;
  return result;
}
