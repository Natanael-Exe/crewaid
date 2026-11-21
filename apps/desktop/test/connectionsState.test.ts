import { describe, expect, it } from 'vitest';
import type { ProviderConnection, ProviderConnectionWithModels } from '@crewaid/shared';
import type { ApiFailure } from '../src/renderer/api';
import {
  actionFailureMessage,
  addableKinds,
  apiKeyIssue,
  connectionDraftIssue,
  connectionStatus,
  credentialSummary,
  EMPTY_CONNECTION_DRAFT,
  EMPTY_MODEL_DRAFT,
  keyIsWriteOnly,
  modelDraftIssue,
  orderConnections,
  parseContextWindow,
  serverSentence,
  toCreateConnectionBody,
  toCreateModelBody,
} from '../src/renderer/settings/connectionsState';

/**
 * V1-12 — the Connections pane's decisions (D-082/D-083).
 *
 * Pure functions rather than a driven pane, for the reason
 * `connectionForm.test.ts` exists: the states that matter here are REFUSALS —
 * a built-in that already exists, a model a bot still points at, a context
 * window typed as "128k" — and every one of them needs a real orchestrator
 * refusing a real request to reach from a component test.
 */

const BASE: ProviderConnection = {
  id: 'clx1a2b3c4d5e6f7g8h9i0j1',
  userId: 'clx9z8y7x6w5v4u3t2s1r0q9',
  kind: 'openai',
  name: 'Work OpenAI',
  endpoint: null,
  authKind: 'api_key',
  state: 'ACTIVE',
  hasCredential: true,
  credentialSetAt: '2026-09-03T10:00:00.000Z',
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-03T10:00:00.000Z',
};

function connection(patch: Partial<ProviderConnection> = {}): ProviderConnection {
  return { ...BASE, ...patch };
}

function withModels(
  patch: Partial<ProviderConnectionWithModels> = {},
): ProviderConnectionWithModels {
  return { ...BASE, models: [], ...patch };
}

function failure(patch: Partial<ApiFailure>): ApiFailure {
  return { code: 'UNKNOWN', message: 'Something went wrong. Try again.', ...patch };
}

describe('V1-12 — which connections can still be added', () => {
  it('lists a taken built-in as blocked rather than dropping it', () => {
    // Dropping it makes "where did OpenAI go" the question, and the honest
    // answer is the one the blocked row gives.
    const kinds = addableKinds([connection({ kind: 'openai' })]);
    const openai = kinds.find((kind) => kind.kind === 'openai');

    expect(openai).toBeDefined();
    expect(openai?.blocked).toContain('Already connected');
  });

  it('never blocks custom, however many exist', () => {
    // D-082: one connection per BUILT-IN kind; custom is unbounded, because
    // two custom endpoints are two different providers that happen to share a
    // protocol.
    const kinds = addableKinds([
      connection({ kind: 'custom', id: 'a' }),
      connection({ kind: 'custom', id: 'b' }),
      connection({ kind: 'custom', id: 'c' }),
    ]);
    expect(kinds.find((kind) => kind.kind === 'custom')?.blocked).toBeNull();
  });

  it('offers every built-in on a fresh account', () => {
    expect(addableKinds([]).filter((kind) => kind.blocked !== null)).toEqual([]);
  });
});

describe('V1-12 — what is said about the key, which is never the key', () => {
  it('says a key is stored and when, and nothing else', () => {
    const summary = credentialSummary(connection({ hasCredential: true }));

    expect(summary).toContain('A key is stored');
    // The three things a masked field would leak by accident: a value, a
    // length, a prefix. `ProviderConnectionSchema` has no field for any of
    // them, and this is the sentence built from what it does have.
    expect(summary).not.toMatch(/[•*]/);
    expect(summary).not.toMatch(/sk-|\d+ characters/);
  });

  it('does not invent a date it was not given', () => {
    expect(credentialSummary(connection({ hasCredential: true, credentialSetAt: null }))).toBe(
      'A key is stored.',
    );
    expect(
      credentialSummary(connection({ hasCredential: true, credentialSetAt: 'not-a-date' })),
    ).toBe('A key is stored.');
  });

  it('says plainly when there is none', () => {
    expect(credentialSummary(connection({ hasCredential: false }))).toBe('No key stored.');
  });

  it('explains the absence of a masked field, because the absence is the surprise', () => {
    // Everywhere else in this app a saved value comes back. An operator who
    // does not know why this one does not reads the empty field as lost data
    // and hesitates to rotate — which is the failure this copy prevents.
    expect(keyIsWriteOnly()).toContain('never sends it back');
    expect(keyIsWriteOnly()).toContain('nothing here to lose');
  });
});

describe('V1-12 — connection state', () => {
  it('treats "never had a key" and "key removed" as one state', () => {
    // NEEDS_CREDENTIAL covers both by design: the difference is history, and
    // what the operator does next is identical.
    const status = connectionStatus(connection({ state: 'NEEDS_CREDENTIAL' }));
    expect(status.tone).toBe('warning');
    expect(status.line).toContain('cannot run');
  });

  it('distinguishes disabled from keyless, because the remedy differs', () => {
    const disabled = connectionStatus(connection({ state: 'DISABLED' }));
    expect(disabled.line).toContain('key is still stored');
    expect(disabled.tone).toBe('muted');
  });
});

describe('V1-12 — validating a new connection', () => {
  it('requires an endpoint for custom and refuses one for a built-in', () => {
    const custom = { ...EMPTY_CONNECTION_DRAFT, kind: 'custom' as const, name: 'Mine' };
    expect(connectionDraftIssue(custom)).toContain('base URL');
    expect(connectionDraftIssue({ ...custom, endpoint: 'https://api.example.com/v1' })).toBeNull();

    const builtIn = { ...EMPTY_CONNECTION_DRAFT, name: 'Work', endpoint: 'https://x.example' };
    expect(connectionDraftIssue(builtIn)).toContain('fixed endpoint');
  });

  it('refuses an endpoint that is not https, or carries credentials', () => {
    const draft = { ...EMPTY_CONNECTION_DRAFT, kind: 'custom' as const, name: 'Mine' };
    for (const endpoint of [
      'http://api.example.com',
      'https://user:pass@api.example.com',
      'https://api.example.com/#frag',
      'not a url',
    ]) {
      expect(connectionDraftIssue({ ...draft, endpoint })).not.toBeNull();
    }
  });

  it('does not claim to settle whether a host is private', () => {
    // A hostname that resolves onto the deployment's own network passes this
    // check and is refused by the orchestrator — twice, at connect time and
    // again per request (D-085). A verdict here would be the more confident
    // and less true of the two, because DNS can change in between.
    const draft = {
      ...EMPTY_CONNECTION_DRAFT,
      kind: 'custom' as const,
      name: 'Mine',
      endpoint: 'https://localhost.example.com/v1',
    };
    expect(connectionDraftIssue(draft)).toBeNull();
  });

  it('accepts a connection with no key at all', () => {
    // Defining it now and keying it later is the normal shape on a shared
    // install, not an oversight — it is born NEEDS_CREDENTIAL and says so.
    const draft = { ...EMPTY_CONNECTION_DRAFT, name: 'Work' };
    expect(connectionDraftIssue(draft)).toBeNull();
    expect(toCreateConnectionBody(draft)).toEqual({ kind: 'openai', name: 'Work' });
  });

  it('omits the endpoint for a built-in and includes it for custom', () => {
    expect(
      toCreateConnectionBody({
        kind: 'custom',
        name: ' Mine ',
        endpoint: ' https://api.example.com/v1 ',
        apiKey: ' sk-secret ',
      }),
    ).toEqual({
      kind: 'custom',
      name: 'Mine',
      endpoint: 'https://api.example.com/v1',
      apiKey: 'sk-secret',
    });
  });

  it('refuses an empty key on the set-key control', () => {
    expect(apiKeyIssue('   ')).toContain('Paste');
    expect(apiKeyIssue('sk-abc')).toBeNull();
  });
});

describe('V1-12 — defining a model', () => {
  it('reads a context window the way people type it', () => {
    expect(parseContextWindow('128000')).toBe(128_000);
    expect(parseContextWindow('128,000')).toBe(128_000);
    expect(parseContextWindow(' 200_000 ')).toBe(200_000);
  });

  it('refuses "128k" rather than reading it as 128', () => {
    // THE CASE THIS FUNCTION EXISTS FOR. `parseInt('128k')` is 128, and a
    // model defined with a context window a thousandth of its real size
    // surfaces much later as a CONTEXT_OVERFLOW on a turn that would have fit.
    expect(parseContextWindow('128k')).toBeNull();
    expect(parseContextWindow('1e6')).toBeNull();
    expect(parseContextWindow('-5')).toBeNull();
    expect(parseContextWindow('0')).toBeNull();
    expect(parseContextWindow('')).toBeNull();
  });

  it('requires the provider’s own id, not just a label', () => {
    const draft = { ...EMPTY_MODEL_DRAFT, label: 'Opus', contextWindow: '200000' };
    expect(modelDraftIssue(draft)).toContain("provider's own id");
    expect(modelDraftIssue({ ...draft, upstreamModelId: 'claude-opus-4-5' })).toBeNull();
  });

  it('refuses a model id with characters no provider uses', () => {
    const draft = {
      ...EMPTY_MODEL_DRAFT,
      label: 'X',
      contextWindow: '1000',
      upstreamModelId: 'has spaces',
    };
    expect(modelDraftIssue(draft)).toContain('letters, digits');
  });

  it('carries the capabilities as chosen, not as guessed', () => {
    // D-087: these describe what the MODEL can do, and nothing infers them
    // from the provider — a custom endpoint serving a vision model is exactly
    // the case a guess would get wrong.
    expect(
      toCreateModelBody({
        upstreamModelId: ' gpt-5.1 ',
        label: ' GPT-5.1 ',
        contextWindow: '400,000',
        tools: true,
        vision: true,
        reasoning: false,
      }),
    ).toEqual({
      upstreamModelId: 'gpt-5.1',
      label: 'GPT-5.1',
      contextWindow: 400_000,
      capabilities: { tools: true, vision: true, reasoning: false },
    });
  });
});

describe('V1-12 — what the server said', () => {
  it('recovers the orchestrator’s own sentence from a 409', () => {
    // These 409s are WRITTEN FOR THIS SCREEN and name a specific bot. The
    // client's normalized message throws all of it away.
    const detail = JSON.stringify({
      statusCode: 409,
      error: 'Conflict',
      message: 'still in use by Quill — point that bot at another model first.',
    });
    expect(serverSentence(failure({ code: 'CONFLICT', detail }))).toContain('Quill');
    expect(actionFailureMessage(failure({ code: 'CONFLICT', detail }), 'remove it')).toContain(
      'Quill',
    );
  });

  it('refuses a body that is not the orchestrator talking', () => {
    // A proxy's HTML 409, or JSON without a message, must not become a
    // sentence claiming to come from Crewaid.
    expect(serverSentence(failure({ detail: '<html>Conflict</html>' }))).toBeNull();
    expect(serverSentence(failure({ detail: '{"error":"Conflict"}' }))).toBeNull();
    expect(serverSentence(failure({ detail: '{"message":123}' }))).toBeNull();
    expect(serverSentence(failure({}))).toBeNull();
  });

  it('refuses a message long enough to be a stack trace', () => {
    const detail = JSON.stringify({ message: 'x'.repeat(401) });
    expect(serverSentence(failure({ detail }))).toBeNull();
  });

  it('still says something useful when the server said nothing', () => {
    const message = actionFailureMessage(failure({ code: 'CONFLICT' }), 'remove it');
    expect(message).toContain('Could not remove it');
    expect(message).toContain('still refers to it');
  });

  it('points an expired session at where it is fixed', () => {
    expect(actionFailureMessage(failure({ code: 'UNAUTHORIZED' }), 'save that key')).toContain(
      'General',
    );
  });

  it('says nothing changed when nothing could be sent', () => {
    expect(actionFailureMessage(failure({ code: 'NETWORK' }), 'remove it')).toContain(
      'Nothing was changed',
    );
  });
});

describe('V1-12 — ordering', () => {
  it('puts the built-ins first in a fixed order, then custom by name', () => {
    // Stable rather than by createdAt: this list is read by someone hunting a
    // specific provider, and a list that reorders when a key is set makes
    // them re-scan after every change.
    const ordered = orderConnections([
      withModels({ id: '1', kind: 'custom', name: 'Zeta' }),
      withModels({ id: '2', kind: 'anthropic', name: 'Anthropic' }),
      withModels({ id: '3', kind: 'custom', name: 'Alpha' }),
      withModels({ id: '4', kind: 'openai', name: 'OpenAI' }),
      withModels({ id: '5', kind: 'openrouter', name: 'OpenRouter' }),
    ]);

    expect(ordered.map((entry) => entry.name)).toEqual([
      'OpenAI',
      'Anthropic',
      'OpenRouter',
      'Alpha',
      'Zeta',
    ]);
  });

  it('puts the included models first: what a new account already has (D-157)', () => {
    const ordered = orderConnections([
      withModels({ id: '1', kind: 'openai', name: 'OpenAI' }),
      withModels({ id: '2', kind: 'crewaid', name: 'Crewaid' }),
    ]);
    expect(ordered.map((entry) => entry.name)).toEqual(['Crewaid', 'OpenAI']);
  });

  it('does not mutate what it was given', () => {
    const input = [
      withModels({ id: '1', kind: 'custom', name: 'Zeta' }),
      withModels({ id: '2', kind: 'openai', name: 'OpenAI' }),
    ];
    orderConnections(input);
    expect(input.map((entry) => entry.name)).toEqual(['Zeta', 'OpenAI']);
  });
});
