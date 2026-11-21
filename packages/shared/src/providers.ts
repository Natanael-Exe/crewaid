import { z } from 'zod';
import { CuidSchema, DateTimeSchema, TimezoneSchema } from './primitives.js';
import { LocaleSchema } from './locale.js';
import { ModelCapabilitiesSchema } from './agent.js';

/**
 * Provider connections and the models they expose.
 *
 * This file replaces the assumption the model registry was built on: that a
 * provider is a process-wide singleton holding one key out of the environment.
 * A connection is a ROW, owned by a user, and its credential is encrypted
 * beside it. Everything downstream — the catalog, `Bot.modelId`, the agent
 * loop's model resolution — reads from here.
 *
 * NO CREDENTIAL MATERIAL CROSSES THIS FILE. There is deliberately no
 * plaintext key field, no ciphertext field, and no "reveal" body anywhere in
 * the contract: a key is write-only, and its presence is reported as
 * the boolean `hasCredential` plus a timestamp. The absence is the contract,
 * the same way `McpCredentialSchema` has no REST counterpart.
 */

// Provider identity

/**
 * What a connection talks to.
 *
 * `custom` is any public HTTPS endpoint speaking the OpenAI Chat Completions
 * shape. It is a KIND, not a name: two custom connections are two rows with
 * two ids, and neither is identified by what its owner called it.
 *
 * Deliberately wider than `ModelProviderSchema` in agent.ts, which names the
 * three providers the old boot-time registry composed. That enum stays for
 * the normalized-error vocabulary, which is per-vendor; this one is per-row.
 */
export const ProviderKindSchema = z.enum([
  'openai',
  'anthropic',
  'openrouter',
  'custom',
  'crewaid',
  /** A speech key. It holds no models and never serves a turn. */
  'elevenlabs',
]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

/**
 * The models included with a hosted plan. A `crewaid` connection is made
 * by the server for each account on a cloud server that bills, holds no key —
 * its calls go out on Crewaid's own and are charged to the plan's allowance —
 * and cannot be created, edited, keyed or deleted through the API.
 */
export const INCLUDED_PROVIDER_KIND = 'crewaid' as const;

/** The kinds a person can create a connection of: everything but `crewaid`. */
export const CreatableProviderKindSchema = ProviderKindSchema.exclude(['crewaid']);
export type CreatableProviderKind = z.infer<typeof CreatableProviderKindSchema>;

/** The built-in kinds, which allow exactly one connection each. */
export const BUILT_IN_PROVIDER_KINDS = ['openai', 'anthropic', 'openrouter'] as const;

/**
 * How a connection authenticates.
 *
 * V1 accepts `api_key` and nothing else. It is on the wire anyway — an
 * explicit kind is what lets a V2 subscription-backed connection arrive as a
 * versioned contract change rather than as a new nullable column nobody
 * branches on. A client that sees a kind it does not know must treat the
 * connection as unusable rather than assuming a key.
 */
export const ConnectionAuthKindSchema = z.enum(['api_key']);
export type ConnectionAuthKind = z.infer<typeof ConnectionAuthKindSchema>;

/**
 * Whether a connection can currently serve a turn.
 *
 * `NEEDS_CREDENTIAL` is the state a connection enters when its key is removed
 * and the state it is born in: the row exists, its models are listed, and
 * every one of them is unavailable until a key is supplied. That is why it is
 * a state rather than an inferred `hasCredential === false` — the renderer
 * shows the same badge for "you deleted the key" and "you have not added one
 * yet", and the resolution path refuses both with one branch.
 */
export const ConnectionStateSchema = z.enum(['ACTIVE', 'NEEDS_CREDENTIAL', 'DISABLED']);
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

// Endpoints

/**
 * A custom provider's base URL.
 *
 * Shape only. HTTPS and a non-empty host are checkable here; whether the host
 * resolves to a private address is NOT — that answer changes between this
 * parse and the request, so it is re-checked at connection time and again at
 * request time by the orchestrator's endpoint guard. A schema that
 * claimed to settle it would be the more dangerous of the two.
 */
export const ProviderEndpointSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (
      url.protocol === 'https:' &&
      url.hostname !== '' &&
      url.username === '' &&
      url.password === '' &&
      url.hash === ''
    );
  }, 'must be an absolute https:// URL with no credentials or fragment');

// Models

/**
 * The provider's own id for a model — what goes on the wire to the upstream
 * API, e.g. `gpt-5.1`, `claude-opus-4-5`, `moonshotai/kimi-k3`.
 *
 * Kept separate from the row's id and from its label. The row id is
 * what a Bot stores; this is what the provider is asked for; the label is what
 * a person reads. Collapsing any two of the three is how a rename silently
 * repoints every bot that used the model.
 */
export const UpstreamModelIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._\-/:]+$/, 'must be a provider model id');

export const ProviderModelSchema = z.object({
  id: CuidSchema,
  connectionId: CuidSchema,
  upstreamModelId: UpstreamModelIdSchema,
  /** Human label for the picker. NEVER an identifier. */
  label: z.string().min(1).max(128),
  /** Context window in tokens; drives the CONTEXT_OVERFLOW check. */
  contextWindow: z.number().int().positive(),
  /**
   * What the MODEL can do. Not what the execution backend can do — those are
   * two questions and D-087 keeps them apart, because a future runtime that
   * owns its own loop may refuse tools this model supports.
   */
  capabilities: ModelCapabilitiesSchema,
  createdAt: DateTimeSchema,
});
export type ProviderModel = z.infer<typeof ProviderModelSchema>;

// Connections

/**
 * A connection as the client sees it.
 *
 * `hasCredential` and `credentialSetAt` are the ONLY things said about the
 * key. There is no field that could carry it, which is what makes "never
 * return plaintext or ciphertext to the client" a property of the type rather
 * than a rule a handler has to remember.
 */
export const ProviderConnectionSchema = z.object({
  id: CuidSchema,
  userId: CuidSchema,
  kind: ProviderKindSchema,
  /** What the operator called it. Display only. */
  name: z.string().min(1).max(64),
  /** Set for `custom`; null for the built-ins, which have fixed endpoints. */
  endpoint: ProviderEndpointSchema.nullable(),
  authKind: ConnectionAuthKindSchema,
  state: ConnectionStateSchema,
  /** Whether a key is stored. Never the key, never its length, never a prefix. */
  hasCredential: z.boolean(),
  credentialSetAt: DateTimeSchema.nullable(),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type ProviderConnection = z.infer<typeof ProviderConnectionSchema>;

/** A connection with its models — the shape the settings pane renders. */
export const ProviderConnectionWithModelsSchema = ProviderConnectionSchema.extend({
  models: z.array(ProviderModelSchema),
});
export type ProviderConnectionWithModels = z.infer<typeof ProviderConnectionWithModelsSchema>;

// Model references

/**
 * What `Bot.modelId` holds.
 *
 * Either the literal alias `default`, resolved per-user against
 * `UserSettings.defaultModelId` at call time, or a `ProviderModel.id`.
 *
 * It is a row id rather than the old `provider:model` key because that key
 * stopped being unique the moment a user could have two custom connections:
 * `custom:llama-3` would name two different endpoints with two different
 * credentials, and nothing in the string says which. The id also survives
 * renaming both the connection and the model, which a composed key does not.
 */
export const MODEL_REF_DEFAULT = 'default' as const;

export const ModelRefSchema = z.union([z.literal(MODEL_REF_DEFAULT), CuidSchema]);
export type ModelRef = z.infer<typeof ModelRefSchema>;

/**
 * One row of the picker.
 *
 * The connection is carried alongside the model because the picker groups by
 * it and because `state` decides whether an entry is selectable — a model on
 * a connection with no key is listed and disabled, not hidden. Hiding it is
 * what makes "my model disappeared" the first symptom of a removed key.
 */
export const ModelOptionSchema = z.object({
  /** `ProviderModel.id` — what to store in `Bot.modelId`. */
  id: CuidSchema,
  connectionId: CuidSchema,
  connectionName: z.string().min(1).max(64),
  kind: ProviderKindSchema,
  upstreamModelId: UpstreamModelIdSchema,
  label: z.string().min(1).max(128),
  contextWindow: z.number().int().positive(),
  capabilities: ModelCapabilitiesSchema,
  /** False when the owning connection cannot currently serve a turn. */
  available: z.boolean(),
  connectionState: ConnectionStateSchema,
});
export type ModelOption = z.infer<typeof ModelOptionSchema>;

/**
 * `GET /api/v1/models`.
 *
 * Replaces `ModelCatalogResponse`'s static list. Still not a live fan-out to
 * the providers' own model endpoints — the entries come from the caller's
 * rows, so the D-003 property that mattered (one render is not three network
 * calls with three failure modes) survives the change that made the list
 * per-user.
 */
export const ListModelOptionsResponseSchema = z.object({
  models: z.array(ModelOptionSchema),
  /**
   * What the `default` alias resolves to for this caller, or null when they
   * have not chosen one. Sent alongside the list so the picker can mark it
   * without a second round trip, and so "default" is never rendered as a
   * model id the user did not recognise.
   */
  defaultModelId: CuidSchema.nullable(),
});
export type ListModelOptionsResponse = z.infer<typeof ListModelOptionsResponseSchema>;

// Per-user settings

/**
 * The user's settings row.
 *
 * `defaultModelId` replaces the `DEFAULT_MODEL_ID` environment variable: the
 * alias is per-user now because the key behind it is. An environment default
 * pointing at a model the signed-in user has no connection for resolves to a
 * 401 from someone else's provider account, which is exactly the fallback
 * D-083 removes.
 *
 * Null means the user has not chosen one; a bot on `default` then fails
 * resolution with a typed error the settings pane can act on, rather than
 * silently borrowing a model.
 *
 * Language and timezone are pairs: `language`/`timezone` are what the
 * person chose, null for "Follow System"/"Auto-detect", and
 * `systemLanguage`/`systemTimezone` are what a signed-in desktop last reported
 * for its computer. They are kept apart because a bot needs a value while the
 * person still means "whatever my computer says" — one column could not tell
 * a choice from a detection, and a second computer would overwrite a choice
 * it should have left alone. `resolveLocale`/`resolveTimezone` pick the value
 * in effect.
 */
export const UserSettingsSchema = z.object({
  userId: CuidSchema,
  defaultModelId: CuidSchema.nullable(),
  language: LocaleSchema.nullable(),
  timezone: TimezoneSchema.nullable(),
  systemLanguage: LocaleSchema.nullable(),
  systemTimezone: TimezoneSchema.nullable(),
  updatedAt: DateTimeSchema,
});
export type UserSettings = z.infer<typeof UserSettingsSchema>;
