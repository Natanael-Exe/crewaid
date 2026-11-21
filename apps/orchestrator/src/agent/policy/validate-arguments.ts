import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { policyHash } from './policy.js';
import { JsonSchema, type Json } from '@crewaid/shared';

export type ArgumentValidation =
  { readonly ok: true; readonly value: Json } | { readonly ok: false; readonly reason: string };

export type ArgumentValidator = (
  input: unknown,
) => ArgumentValidation | Promise<ArgumentValidation>;

const validators = new Map<string, ArgumentValidator>();
const MAX_CACHED_SCHEMAS = 256;

/** No schema network loader or custom executable keyword is registered. */
export function pluginArgumentValidator(schema: unknown): ArgumentValidator {
  let validate: ValidateFunction;
  let key: string;
  try {
    key = policyHash(schema);
    const cached = validators.get(key);
    if (cached !== undefined) return cached;
    // Separate registries prevent a remote $id from shadowing another server's schema.
    const ajv = new Ajv({
      strictSchema: true,
      strictTypes: false,
      strictTuples: false,
      strictRequired: false,
      allErrors: false,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
    });
    addFormats(ajv);
    const json = JsonSchema.parse(schema);
    if (
      typeof json !== 'boolean' &&
      (json === null || Array.isArray(json) || typeof json !== 'object')
    ) {
      throw new Error('A plugin argument schema must be an object or boolean.');
    }
    validate = ajv.compile(json);
  } catch {
    return () => ({ ok: false, reason: 'The plugin argument schema is invalid or unsupported.' });
  }
  const validator: ArgumentValidator = (input) => {
    const parsed = JsonSchema.safeParse(input);
    if (!parsed.success || !validate(parsed.data)) {
      return { ok: false, reason: 'Arguments do not match the plugin tool schema.' };
    }
    return { ok: true, value: parsed.data };
  };
  if (validators.size >= MAX_CACHED_SCHEMAS) {
    const oldest = validators.keys().next().value;
    if (oldest !== undefined) validators.delete(oldest);
  }
  validators.set(key, validator);
  return validator;
}
