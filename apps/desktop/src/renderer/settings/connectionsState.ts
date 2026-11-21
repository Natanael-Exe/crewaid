import {
  BUILT_IN_PROVIDER_KINDS,
  ProviderEndpointSchema,
  UpstreamModelIdSchema,
  type CreateProviderConnectionBody,
  type CreateProviderModelBody,
  type ProviderConnection,
  type ProviderConnectionWithModels,
  type CreatableProviderKind,
  type ProviderKind,
  type ProviderModel,
  type UpdateProviderModelBody,
} from '@crewaid/shared';
import type { ApiFailure } from '../api';
import { currentLocale, t } from '../i18n/i18n';

/**
 * The Connections pane, as pure functions.
 *
 * Here rather than in the components for the reason `connectionForm.ts`
 * exists: the states worth getting right are refusals — a key that cannot be
 * saved, a model a bot still points at, a built-in that already exists — and a
 * refusal that only appears when a real orchestrator refuses a real request is
 * a refusal nothing tests.
 *
 * The one rule this file is organised around
 *
 * There is no such thing as "the current key". The server never sends one back,
 * so this pane has nothing to pre-fill, nothing to mask, and nothing
 * to reveal. Everything below says whether a key IS STORED and when it was
 * set; nothing has a field for what it is.
 */

// Which connections can still be added

export type AddableKind = {
  readonly kind: CreatableProviderKind;
  readonly label: string;
  /** Null when it can be added; a sentence when it cannot. */
  readonly blocked: string | null;
};

// Product names, the same in every language; the two that describe themselves
// come from the catalog.
const KIND_LABELS: Record<ProviderKind, () => string> = {
  openai: () => 'OpenAI',
  anthropic: () => 'Anthropic',
  openrouter: () => 'OpenRouter',
  custom: () => t('settings.provider.custom'),
  crewaid: () => 'Crewaid',
  elevenlabs: () => t('settings.provider.elevenlabs'),
};

export function providerLabel(kind: ProviderKind): string {
  return KIND_LABELS[kind]();
}

/**
 * One connection per built-in kind, any number of custom ones.
 *
 * A kind already in use is listed and BLOCKED rather than dropped from the
 * menu. Dropping it makes "where did OpenAI go" the question, and the honest
 * answer — you already have one — is the thing the row now says. The server
 * enforces this with a unique index either way; this only moves the sentence
 * to before the request.
 */
export function addableKinds(connections: readonly ProviderConnection[]): readonly AddableKind[] {
  const taken = new Set(connections.map((connection) => connection.kind));
  return [
    ...BUILT_IN_PROVIDER_KINDS.map((kind) => ({
      kind,
      label: providerLabel(kind),
      blocked: taken.has(kind) ? t('settings.provider.alreadyConnected') : null,
    })),
    { kind: 'custom', label: providerLabel('custom'), blocked: null },
    // The speech key, one per account like a built-in.
    {
      kind: 'elevenlabs',
      label: providerLabel('elevenlabs'),
      blocked: taken.has('elevenlabs') ? t('settings.provider.alreadyConnected') : null,
    },
  ];
}

// What a connection's state means

export type ConnectionTone = 'ok' | 'warning' | 'muted';

export type ConnectionStatus = {
  readonly badge: string;
  readonly tone: ConnectionTone;
  readonly line: string;
};

/**
 * `NEEDS_CREDENTIAL` covers both "you have not added a key yet" and "you
 * removed one", and it says so in one sentence on purpose: the difference
 * changes nothing about what the operator has to do next, and a UI that
 * distinguished them would be reporting history rather than state.
 */
export function connectionStatus(connection: ProviderConnection): ConnectionStatus {
  switch (connection.state) {
    case 'ACTIVE':
      return {
        badge: t('settings.connection.active'),
        tone: 'ok',
        line: t('settings.connection.active.line'),
      };
    case 'NEEDS_CREDENTIAL':
      return {
        badge: t('settings.connection.needsKey'),
        tone: 'warning',
        line: t('settings.connection.needsKey.line'),
      };
    case 'DISABLED':
      return {
        badge: t('settings.connection.disabled'),
        tone: 'muted',
        line: t('settings.connection.disabled.line'),
      };
  }
}

/**
 * What is said about the key, which is only ever whether there is one.
 *
 * The date matters and the value never does: an operator rotating a key needs
 * to know which of two connections they already updated, and that question is
 * answerable without the secret. `credentialSetAt` is the only thing the
 * server will say about it, and this is the whole of what can be said.
 */
export function credentialSummary(connection: ProviderConnection): string {
  if (!connection.hasCredential) {
    return t('settings.key.none');
  }
  if (connection.credentialSetAt === null) {
    return t('settings.key.stored');
  }
  const when = new Date(connection.credentialSetAt);
  return Number.isNaN(when.getTime())
    ? t('settings.key.stored')
    : t('settings.key.storedOn', { date: when.toLocaleDateString(currentLocale()) });
}

/**
 * Why the pane never offers to show the stored key.
 *
 * Rendered as help text under the key row. It exists because the ABSENCE of a
 * masked field is the surprising part: everywhere else in this app a saved
 * value comes back, and an operator who does not know why this one does not
 * will read the empty field as lost data and hesitate to rotate.
 */
export function keyIsWriteOnly(): string {
  return t('settings.key.writeOnly');
}

// Validating what the operator typed

export type ConnectionDraft = {
  // Never `crewaid`, which the server makes.
  readonly kind: CreatableProviderKind;
  readonly name: string;
  readonly endpoint: string;
  readonly apiKey: string;
};

export const EMPTY_CONNECTION_DRAFT: ConnectionDraft = {
  kind: 'openai',
  name: '',
  endpoint: '',
  apiKey: '',
};

/**
 * Everything checkable without a round trip.
 *
 * These mirror the shared schemas rather than inventing rules: the server is
 * the authority and refuses the same shapes. Checking here only moves the
 * sentence to before the request, so an operator is not told "the server
 * rejected that" about a name they can see is empty.
 */
export function connectionDraftIssue(draft: ConnectionDraft): string | null {
  const name = draft.name.trim();
  if (name === '') return t('settings.connectionDraft.name');
  if (name.length > 64) return t('settings.connectionDraft.nameTooLong');

  if (draft.kind === 'custom') {
    const endpoint = draft.endpoint.trim();
    if (endpoint === '') return t('settings.connectionDraft.endpointMissing');
    if (!ProviderEndpointSchema.safeParse(endpoint).success) {
      // The private-address check is NOT repeated here. Whether a host
      // resolves somewhere it should not can change between this keystroke
      // and the request, so the orchestrator answers it twice and a
      // verdict from the renderer would be the more confident and less true
      // of the two.
      return t('settings.connectionDraft.endpointInvalid');
    }
  } else if (draft.endpoint.trim() !== '') {
    return t('settings.connectionDraft.fixedEndpoint', { provider: providerLabel(draft.kind) });
  }

  // The key is OPTIONAL on create, and that is a real workflow rather than an
  // oversight: a connection can be defined now and given its key by whoever
  // holds it. It is born NEEDS_CREDENTIAL and says so.
  return null;
}

export function toCreateConnectionBody(draft: ConnectionDraft): CreateProviderConnectionBody {
  const apiKey = draft.apiKey.trim();
  return {
    kind: draft.kind,
    name: draft.name.trim(),
    ...(draft.kind === 'custom' ? { endpoint: draft.endpoint.trim() } : {}),
    ...(apiKey === '' ? {} : { apiKey }),
  };
}

/** The key alone, for the Set/Replace control on an existing connection. */
export function apiKeyIssue(raw: string): string | null {
  const key = raw.trim();
  if (key === '') return t('settings.apiKey.missing');
  if (key.length > 512) return t('settings.apiKey.tooLong');
  return null;
}

// Model definitions

export type ModelDraft = {
  readonly upstreamModelId: string;
  readonly label: string;
  readonly contextWindow: string;
  readonly tools: boolean;
  readonly vision: boolean;
  readonly reasoning: boolean;
};

export const EMPTY_MODEL_DRAFT: ModelDraft = {
  upstreamModelId: '',
  label: '',
  contextWindow: '',
  tools: true,
  vision: false,
  reasoning: false,
};

/**
 * Parse the context window the way a person types it.
 *
 * `128000` and `128,000` are the same number and both get typed. Anything else
 * is refused rather than coerced, because `parseInt` would read `128k` as 128
 * and quietly define a model with a context window a hundredth of its real
 * size — which surfaces much later as a CONTEXT_OVERFLOW on a turn that would
 * have fit.
 */
export function parseContextWindow(raw: string): number | null {
  const cleaned = raw.trim().replace(/[,_\s]/g, '');
  if (!/^[0-9]+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isSafeInteger(value) && value > 0 && value <= 100_000_000 ? value : null;
}

export function modelDraftIssue(draft: ModelDraft): string | null {
  const upstream = draft.upstreamModelId.trim();
  if (upstream === '') return t('settings.modelDraft.idMissing');
  if (!UpstreamModelIdSchema.safeParse(upstream).success) {
    return t('settings.modelDraft.idInvalid');
  }
  if (draft.label.trim() === '') return t('settings.modelDraft.labelMissing');
  if (draft.label.trim().length > 128) return t('settings.modelDraft.labelTooLong');
  if (parseContextWindow(draft.contextWindow) === null) {
    return t('settings.modelDraft.contextWindow');
  }
  return null;
}

/** Fill the form from a model that already exists, so Edit starts where it is. */
export function modelDraftFrom(model: ProviderModel): ModelDraft {
  return {
    upstreamModelId: model.upstreamModelId,
    label: model.label,
    contextWindow: String(model.contextWindow),
    tools: model.capabilities.tools,
    vision: model.capabilities.vision,
    reasoning: model.capabilities.reasoning,
  };
}

/**
 * The same body shape the create route takes.
 *
 * `PATCH` accepts a partial, and this sends the whole draft rather than a diff:
 * the form is populated from the row it is editing, so every field is a value
 * the operator has seen and left or changed. A diff would also have to decide
 * what an unchanged-but-retyped field means, which is a question nobody asked.
 */
export function toUpdateModelBody(draft: ModelDraft): UpdateProviderModelBody {
  return toCreateModelBody(draft);
}

export function toCreateModelBody(draft: ModelDraft): CreateProviderModelBody {
  return {
    upstreamModelId: draft.upstreamModelId.trim(),
    label: draft.label.trim(),
    // Safe: `modelDraftIssue` refuses the draft when this is null, and every
    // caller checks it first.
    contextWindow: parseContextWindow(draft.contextWindow) ?? 1,
    capabilities: {
      tools: draft.tools,
      vision: draft.vision,
      reasoning: draft.reasoning,
    },
  };
}

// What the server said

/**
 * Recover the orchestrator's own sentence from a failure body.
 *
 * Normally the client's normalized message is the right thing to show, and
 * `apiError.ts` says why: a vendor string in a transcript is noise. The 409s
 * from this route tree are the exception, because they are WRITTEN FOR THIS
 * SCREEN — "still in use by Quill — point that bot at another model first" is
 * a specific instruction naming a specific bot, and "that conflicts with the
 * current state" throws all of it away.
 *
 * Parsed defensively: a proxy's HTML 409, or a body that is JSON but not
 * Nest's, must not become a sentence claiming to come from Crewaid.
 */
export function serverSentence(failure: ApiFailure): string | null {
  if (failure.detail === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(failure.detail);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const message = (parsed as { message?: unknown }).message;
    if (typeof message !== 'string') return null;
    const trimmed = message.trim();
    return trimmed === '' || trimmed.length > 400 ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * One sentence for a failed action on this pane.
 *
 * CONFLICT prefers the server's own words for the reason above. Everything
 * else is said in terms of THIS SCREEN rather than of the request: an operator
 * who just pressed Remove needs to know what happened to the connection, not
 * what happened to an HTTP call they did not make.
 */
export function actionFailureMessage(failure: ApiFailure, action: string): string {
  const sentence = serverSentence(failure);
  switch (failure.code) {
    case 'CONFLICT':
      return sentence === null
        ? t('settings.action.conflict', { action })
        : t('settings.action.conflictBecause', { action, reason: sentence });
    case 'INVALID_REQUEST':
      return sentence === null ? t('settings.action.refused', { action }) : sentence;
    case 'UNAUTHORIZED':
      return t('settings.action.unauthorized');
    case 'NOT_FOUND':
      return t('settings.action.gone');
    case 'NETWORK':
      return t('settings.action.network');
    default:
      return t('settings.action.failed', { action, reason: failure.message });
  }
}

// Ordering

/**
 * Built-ins first in a fixed order, then custom ones by name.
 *
 * Stable rather than by `createdAt`, because this list is read by someone
 * looking for a specific provider, and a list that reorders itself when a key
 * is set is a list they have to re-scan every time they change something.
 */
export function orderConnections(
  connections: readonly ProviderConnectionWithModels[],
): readonly ProviderConnectionWithModels[] {
  const rank = (kind: ProviderKind): number => {
    // The included models first — what a new account already has.
    if (kind === 'crewaid') return -1;
    const index = BUILT_IN_PROVIDER_KINDS.indexOf(kind as (typeof BUILT_IN_PROVIDER_KINDS)[number]);
    return index === -1 ? BUILT_IN_PROVIDER_KINDS.length : index;
  };
  return [...connections].sort((left, right) => {
    const byKind = rank(left.kind) - rank(right.kind);
    return byKind !== 0 ? byKind : left.name.localeCompare(right.name);
  });
}
