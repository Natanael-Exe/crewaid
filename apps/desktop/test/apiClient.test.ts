import { describe, expect, it, vi } from 'vitest';
import {
  API_ROUTES,
  ATTACHMENT_MAX_BYTES,
  ListBotsResponseSchema,
  type ModelOption,
} from '@crewaid/shared';
import { ApiClient, resolveRoute } from '../src/renderer/api/apiClient';
import { fetchModelCatalog } from '../src/renderer/api/models';
import { listBots, updateBot } from '../src/renderer/api/bots';
import { deleteMessage } from '../src/renderer/api/messages';
import { downloadAttachment, uploadAttachment } from '../src/renderer/api/attachments';
import { getRecordingStatus, startRecording, stopRecording } from '../src/renderer/api/recordings';
import {
  approveSkill,
  deleteSkill,
  getSkill,
  reviseSkill,
  updateSkill,
} from '../src/renderer/api/skills';
import {
  clearCredential,
  createModel,
  deleteModel,
  listConnections,
  setCredential,
} from '../src/renderer/api/connections';

const CUID = 'clx1a2b3c4d5e6f7g8h9i0j1';
const CUID_2 = 'clx9z8y7x6w5v4u3t2s1r0q9';

const model: ModelOption = {
  // D-082: the row id, not a `provider:model` key. The upstream name the
  // provider knows it by is its own field.
  id: 'clx4m5n6o7p8q9r0s1t2u3v4',
  connectionId: CUID_2,
  connectionName: 'Work Anthropic',
  kind: 'anthropic',
  upstreamModelId: 'claude-haiku-4-5',
  label: 'Claude Haiku 4.5',
  contextWindow: 200_000,
  capabilities: { tools: true, vision: true, reasoning: false },
  available: true,
  connectionState: 'ACTIVE',
};

const botRow = {
  id: CUID,
  userId: CUID_2,
  name: 'Quill',
  role: 'Outbound Writer',
  avatarColor: '#8B6F47',
  avatarShape: null,
  avatarUrl: null,
  systemPrompt: 'You write outbound email.',
  modelId: 'default',
  status: 'IDLE',
  sortOrder: 0,
  pinned: true,
  hiddenFromSidebar: false,
  autoReviewRules: [],
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-01T12:00:00.000Z',
  sandboxId: null,
  sandbox: null,
  thread: { id: CUID_2 },
};

function response(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function client(
  fetchFn: typeof fetch,
  credentials = {
    orchestratorToken: 'secret-token',
    orchestratorBaseUrl: 'https://orchestrator.example',
  },
) {
  return new ApiClient({
    credentialsProvider: async () => credentials,
    fetchFn: fetchFn as unknown as ConstructorParameters<typeof ApiClient>[0]['fetchFn'],
  });
}

describe('resolveRoute (URLs are built from the shared registry, never literals)', () => {
  it('splits a registry entry into its method and path', () => {
    expect(resolveRoute('GET /bots')).toEqual({ method: 'GET', path: '/bots' });
  });

  it('substitutes and percent-encodes :params', () => {
    expect(resolveRoute('GET /bots/:id/chat', { id: 'a/b' })).toEqual({
      method: 'GET',
      path: '/bots/a%2Fb/chat',
    });
  });

  it('throws on a missing param rather than requesting a literal ":id" path', () => {
    expect(() => resolveRoute('GET /bots/:id/chat', {})).toThrow(/missing the ":id"/);
  });
});

describe('ApiClient', () => {
  it('prefixes /api/v1 and sends the safeStorage token as a bearer credential', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ models: [model], defaultModelId: model.id }));
    const result = await fetchModelCatalog(client(fetchFn));

    // D-086: the envelope carries the caller's default alongside the list, so
    // the picker resolves `default` without a second round trip.
    expect(result).toEqual({ models: [model], defaultModelId: model.id });
    expect(fetchFn).toHaveBeenCalledWith(
      'https://orchestrator.example/api/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: 'Bearer secret-token' },
      }),
    );
  });

  it('returns an empty validated catalog without inventing fallback models', async () => {
    // A user with no provider connections has no models, and the client must
    // not paper over that with a built-in list — D-083 removed the
    // environment fallback, so an invented entry would resolve to nothing.
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ models: [], defaultModelId: null }));
    expect(await fetchModelCatalog(client(fetchFn))).toEqual({
      models: [],
      defaultModelId: null,
    });
  });

  it('parses GET /bots as the bare array the controller returns', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response([botRow]));
    const bots = await listBots(client(fetchFn));
    expect(bots).toHaveLength(1);
    expect(bots[0]?.name).toBe('Quill');
  });

  it('passes query parameters on the route it was given', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ deletedCount: 1, forgottenCount: 1 }));
    await deleteMessage(client(fetchFn), CUID, CUID_2, true);

    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      `https://orchestrator.example/api/v1/bots/${CUID}/messages/${CUID_2}?forget=true`,
    );
  });

  it('omits absent query parameters instead of sending "undefined"', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response([botRow]));
    await client(fetchFn).request(API_ROUTES.bots.list, {
      query: { before: undefined, limit: 25 },
      schema: ListBotsResponseSchema,
    });

    expect(fetchFn.mock.calls[0]?.[0]).toBe('https://orchestrator.example/api/v1/bots?limit=25');
  });

  /**
   * A response stored before a contract change is replayed after it, so the
   * client rejects its own server and blames it for an unreadable body. That
   * is not hypothetical: Chromium cached a bot list, served it across a
   * schema change, and emptied the sidebar. The orchestrator now sends
   * `no-store`; this is the half that also holds against an older server.
   */
  it('never reads or writes the HTTP cache, on the JSON and the bytes path alike', async () => {
    const jsonFn = vi.fn<typeof fetch>().mockResolvedValue(response([botRow]));
    await listBots(client(jsonFn));
    expect(jsonFn.mock.calls[0]?.[1]?.cache).toBe('no-store');

    const bytesFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(new Blob(['x']), { status: 200 }));
    await downloadAttachment(client(bytesFn), CUID);
    expect(bytesFn.mock.calls[0]?.[1]?.cache).toBe('no-store');
  });

  it('JSON-encodes a body and sets Content-Type', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(botRow));
    await updateBot(client(fetchFn), CUID, { name: 'Quill' });

    const init = fetchFn.mock.calls[0]?.[1];
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe(JSON.stringify({ name: 'Quill' }));
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('leaves multipart uploads without a Content-Type so the boundary survives', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        id: CUID,
        filename: 'leads.csv',
        mimeType: 'text/csv',
        sizeBytes: 12,
        storageKey: 'artifacts/leads.csv',
      }),
    );
    const file = new File(['id,name\n1,a'], 'leads.csv', { type: 'text/csv' });
    await uploadAttachment(client(fetchFn), file);

    const init = fetchFn.mock.calls[0]?.[1];
    expect(init?.body).toBeInstanceOf(FormData);
    expect(init?.headers).not.toHaveProperty('Content-Type');
  });

  it('normalizes unauthorized, network and non-JSON failures without leaking server text', async () => {
    const unauthorized = fetchModelCatalog(
      client(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            response({ message: 'vendor secret should not render' }, { status: 401 }),
          ),
      ),
    );
    await expect(unauthorized).rejects.toMatchObject({ failure: { code: 'UNAUTHORIZED' } });
    await expect(unauthorized).rejects.not.toThrow('vendor secret');

    const network = fetchModelCatalog(
      client(vi.fn<typeof fetch>().mockRejectedValue(new Error('socket detail should not render'))),
    );
    await expect(network).rejects.toMatchObject({ failure: { code: 'NETWORK' } });
    await expect(network).rejects.not.toThrow('socket detail');
  });

  it('raises CONTRACT — not UNKNOWN — for a 2xx body that fails the shared schema', async () => {
    const malformed = fetchModelCatalog(
      client(vi.fn<typeof fetch>().mockResolvedValue(response({ models: [{ id: 'bad' }] }))),
    );
    await expect(malformed).rejects.toMatchObject({ failure: { code: 'CONTRACT' } });
  });

  it('fails closed when the credential store is empty rather than guessing a host', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(fetchModelCatalog(client(fetchFn, {} as never))).rejects.toMatchObject({
      failure: { code: 'CONFIGURATION' },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects a non-HTTP base URL as a configuration error', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      fetchModelCatalog(
        client(fetchFn, {
          orchestratorToken: 't',
          orchestratorBaseUrl: 'file:///tmp/orchestrator',
        }),
      ),
    ).rejects.toMatchObject({ failure: { code: 'CONFIGURATION' } });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('keeps a base URL path prefix instead of resolving the route against the origin', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ models: [model], defaultModelId: null }));
    await fetchModelCatalog(
      client(fetchFn, {
        orchestratorToken: 't',
        orchestratorBaseUrl: 'https://ops.example.com/crewaid',
      }),
    );
    // An orchestrator behind a reverse-proxy subpath: dropping "/crewaid" here
    // 404s at the proxy, which reads as a missing resource rather than a
    // misconfigured base URL.
    expect(fetchFn.mock.calls[0]?.[0]).toBe('https://ops.example.com/crewaid/api/v1/models');
  });

  it('treats 403 as UNAUTHORIZED — "try again" cannot help a token that is refused', async () => {
    const forbidden = fetchModelCatalog(
      client(vi.fn<typeof fetch>().mockResolvedValue(response({}, { status: 403 }))),
    );
    await expect(forbidden).rejects.toMatchObject({ failure: { code: 'UNAUTHORIZED' } });
  });

  it('fetches a download with the bearer — an <a href> would answer 401 (M1-FE-14)', async () => {
    const bytes = new Blob(['id,name\n1,a'], { type: 'text/csv' });
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(bytes, { status: 200, headers: { 'content-type': 'text/csv' } }),
      );

    const blob = await downloadAttachment(client(fetchFn), CUID);

    expect(await blob.text()).toBe('id,name\n1,a');
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      `https://orchestrator.example/api/v1/attachments/${CUID}/download`,
    );
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer secret-token',
    });
  });

  it('does not ask a file route for JSON — a bytes response is not a §4.1 body', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Blob(['x'])));
    await downloadAttachment(client(fetchFn), CUID);

    expect(fetchFn.mock.calls[0]?.[1]?.headers).toMatchObject({ Accept: '*/*' });
  });

  it('rejects a declared oversized download before reading its body', async () => {
    let bodyRead = false;
    const oversized = {
      ok: true,
      headers: new Headers({ 'content-length': String(ATTACHMENT_MAX_BYTES + 1) }),
      get body() {
        bodyRead = true;
        throw new Error('body should not be read');
      },
    } as Response;
    const attempt = downloadAttachment(
      client(vi.fn<typeof fetch>().mockResolvedValue(oversized)),
      CUID,
    );

    await expect(attempt).rejects.toMatchObject({ failure: { code: 'TOO_LARGE' } });
    expect(bodyRead).toBe(false);
  });

  it('stops an oversized streamed download when Content-Length is absent', async () => {
    const bytes = new Uint8Array(ATTACHMENT_MAX_BYTES + 1);
    const attempt = downloadAttachment(
      client(vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes))),
      CUID,
    );

    await expect(attempt).rejects.toMatchObject({ failure: { code: 'TOO_LARGE' } });
  });

  it('preserves an AbortError raised while reading download bytes', async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(abort);
      },
    });
    const attempt = downloadAttachment(
      client(vi.fn<typeof fetch>().mockResolvedValue(new Response(body))),
      CUID,
    );

    await expect(attempt).rejects.toBe(abort);
  });

  it('passes the caller abort signal through to fetch', async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Blob(['x'])));
    await downloadAttachment(client(fetchFn), CUID, controller.signal);

    expect(fetchFn.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it('normalizes a 410 on download so an expired attachment reads as GONE, not UNKNOWN', async () => {
    const expired = downloadAttachment(
      client(vi.fn<typeof fetch>().mockResolvedValue(new Response('gone', { status: 410 }))),
      CUID,
    );
    await expect(expired).rejects.toMatchObject({ failure: { code: 'GONE' } });
  });

  it('fails closed on an unconfigured store rather than downloading from a guessed host', async () => {
    const unconfigured = new ApiClient({
      credentialsProvider: async () => ({ orchestratorBaseUrl: 'https://orchestrator.example' }),
      fetchFn: vi.fn<typeof fetch>() as never,
    });
    await expect(downloadAttachment(unconfigured, CUID)).rejects.toMatchObject({
      failure: { code: 'CONFIGURATION' },
    });
  });

  it('normalizes a safeStorage/token-provider failure without surfacing its detail', async () => {
    const failing = new ApiClient({
      credentialsProvider: () => Promise.reject(new Error('safeStorage IPC detail')),
      fetchFn: vi.fn<typeof fetch>() as never,
    });
    const attempt = fetchModelCatalog(failing);
    await expect(attempt).rejects.toMatchObject({ failure: { code: 'CONFIGURATION' } });
    await expect(attempt).rejects.not.toThrow('safeStorage IPC detail');
  });
});

describe('recordings (§4.1, M3-FE-01)', () => {
  const status = {
    id: CUID,
    state: 'READY' as const,
    intent: null,
    cdpAvailable: false,
    warning: null,
    error: null,
    counts: { x11: 42, cdp: 0, atspi: 0 },
    skillId: null,
  };

  it('starts a recording on the bot route and parses the new id', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response({ recordingId: CUID }));

    const started = await startRecording(client(fetchFn), CUID, {});

    expect(started).toEqual({ recordingId: CUID });
    expect(fetchFn).toHaveBeenCalledWith(
      `https://orchestrator.example/api/v1/bots/${CUID}/recordings`,
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });

  it('stops through the direct-by-id route and parses the settled status', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(status));

    const settled = await stopRecording(client(fetchFn), CUID);

    expect(settled.state).toBe('READY');
    expect(fetchFn).toHaveBeenCalledWith(
      `https://orchestrator.example/api/v1/recordings/${CUID}/stop`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('reads the status route — where the D-042 warning actually lives', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ ...status, warning: 'TIME_LIMIT' }));

    const read = await getRecordingStatus(client(fetchFn), CUID);

    expect(read.warning).toBe('TIME_LIMIT');
    expect(fetchFn).toHaveBeenCalledWith(
      `https://orchestrator.example/api/v1/recordings/${CUID}`,
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

describe('skills (§4.1, M3-FE-02)', () => {
  const skillRow = {
    id: CUID,
    botId: CUID_2,
    name: 'open_example_site',
    description: 'Opens example.com and screenshots it.',
    paramsSchema: { type: 'object', properties: {} },
    // D-098: the compiler's plain-language summary, part of the wire shape now.
    steps: ['Open Chrome.', 'Go to example.com.'],
    script: 'export default async function run() {}',
    version: 1,
    status: 'DRAFT' as const,
    sourceRecordingId: null,
    createdAt: '2026-09-01T12:00:00.000Z',
  };

  it('reads a skill with its source through GET /skills/:id', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(skillRow));

    const skill = await getSkill(client(fetchFn), CUID);

    expect(skill.script).toBe(skillRow.script);
    expect(skill.version).toBe(1);
    expect(fetchFn).toHaveBeenCalledWith(
      `https://orchestrator.example/api/v1/skills/${CUID}`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('sends only the edited fields with PATCH, and adopts the bumped version', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({ ...skillRow, script: 'export default async () => 2;', version: 2 }),
      );

    const skill = await updateSkill(client(fetchFn), CUID, {
      script: 'export default async () => 2;',
    });

    expect(skill.version).toBe(2);
    expect(fetchFn).toHaveBeenCalledWith(
      `https://orchestrator.example/api/v1/skills/${CUID}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ script: 'export default async () => 2;' }),
      }),
    );
  });

  it('approves through POST /skills/:id/approve and parses the approved skill', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ ...skillRow, status: 'APPROVED' }));

    const skill = await approveSkill(client(fetchFn), CUID);

    expect(skill.status).toBe('APPROVED');
    expect(fetchFn).toHaveBeenCalledWith(
      `https://orchestrator.example/api/v1/skills/${CUID}/approve`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('sends a revision as a sentence, and adopts the version it compiled into', async () => {
    // D-098: the request body carries the operator's words and nothing else —
    // the script is the compiler's to write, and the answer is a version row
    // like any other write's.
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response({ ...skillRow, version: 2 }));

    const skill = await reviseSkill(client(fetchFn), CUID, 'Use Firefox instead of Chrome.');

    expect(skill.version).toBe(2);
    expect(fetchFn).toHaveBeenCalledWith(
      `https://orchestrator.example/api/v1/skills/${CUID}/revise`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ instruction: 'Use Firefox instead of Chrome.' }),
      }),
    );
  });

  it('discards a draft with a DELETE that answers no body', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

    await expect(deleteSkill(client(fetchFn), CUID)).resolves.toBeUndefined();

    expect(fetchFn).toHaveBeenCalledWith(
      `https://orchestrator.example/api/v1/skills/${CUID}`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('refuses a 2xx response that is not a skill — CONTRACT, never a cast', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ ...skillRow, version: 'two' }));

    await expect(getSkill(client(fetchFn), CUID)).rejects.toMatchObject({
      failure: { code: 'CONTRACT' },
    });
  });
});

/**
 * V1-12 — the provider-connection routes (D-082/D-083).
 *
 * These matter more than most route tests because two of them carry a
 * credential and one of them is keyed by a different id than the rest. A
 * `PUT` that went to the wrong connection would store a key against somebody
 * else's row, and a model route that composed `/connections/:id/models/:mid`
 * would be addressing a model by a path segment that can disagree with the
 * one that matters.
 */
describe('provider connections', () => {
  const connectionRow = {
    id: CUID,
    userId: CUID_2,
    kind: 'anthropic',
    name: 'Work Anthropic',
    endpoint: null,
    authKind: 'api_key',
    state: 'ACTIVE',
    hasCredential: true,
    credentialSetAt: '2026-09-03T10:00:00.000Z',
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-03T10:00:00.000Z',
  };

  const modelRow = {
    id: 'clx4m5n6o7p8q9r0s1t2u3v4',
    connectionId: CUID,
    upstreamModelId: 'claude-opus-4-5',
    label: 'Claude Opus 4.5',
    contextWindow: 200_000,
    capabilities: { tools: true, vision: true, reasoning: true },
    createdAt: '2026-09-01T12:00:00.000Z',
  };

  it('parses the list with its models', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ connections: [{ ...connectionRow, models: [modelRow] }] }));

    const { connections } = await listConnections(client(fetchFn));

    expect(connections[0]?.models[0]?.upstreamModelId).toBe('claude-opus-4-5');
    expect(fetchFn).toHaveBeenCalledWith(
      'https://orchestrator.example/api/v1/providers/connections',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('refuses a connection row carrying anything that looks like a key', async () => {
    // D-083 is a property of the TYPE: there is no field a key could arrive
    // in. A server that grew one would be answering a contract this client
    // never agreed to, and CONTRACT — not UNKNOWN — is the right verdict.
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({ connections: [{ ...connectionRow, models: [], apiKey: 'sk' }] }),
      );

    const { connections } = await listConnections(client(fetchFn));
    expect(connections[0]).not.toHaveProperty('apiKey');
  });

  it('PUTs a key to the connection it was typed on, and reads nothing back', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

    await setCredential(client(fetchFn), CUID, { apiKey: 'sk-secret' });

    expect(fetchFn).toHaveBeenCalledWith(
      `https://orchestrator.example/api/v1/providers/connections/${CUID}/credential`,
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ apiKey: 'sk-secret' }) }),
    );
  });

  it('clears a key with a DELETE that carries no body', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

    await clearCredential(client(fetchFn), CUID);

    const [, init] = fetchFn.mock.calls[0] ?? [];
    expect(init?.method).toBe('DELETE');
    expect(init?.body).toBeUndefined();
  });

  it('addresses a model by its own id, not through its connection', async () => {
    // A model id is already unique and already what `Bot.modelId` stores
    // (D-082), so a nested path would add a segment that can disagree.
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

    await deleteModel(client(fetchFn), modelRow.id);

    expect(fetchFn).toHaveBeenCalledWith(
      `https://orchestrator.example/api/v1/providers/models/${modelRow.id}`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('creates a model under the connection that will serve it', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(modelRow, { status: 201 }));

    const created = await createModel(client(fetchFn), CUID, {
      upstreamModelId: 'claude-opus-4-5',
      label: 'Claude Opus 4.5',
      contextWindow: 200_000,
      capabilities: { tools: true, vision: true, reasoning: true },
    });

    expect(created.id).toBe(modelRow.id);
    expect(fetchFn).toHaveBeenCalledWith(
      `https://orchestrator.example/api/v1/providers/connections/${CUID}/models`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('surfaces a 409 with the orchestrator’s own sentence intact', async () => {
    // The pane reads `detail` to recover "still in use by Quill". If the
    // client dropped the body, that sentence would never reach the screen it
    // was written for.
    const body = JSON.stringify({
      statusCode: 409,
      error: 'Conflict',
      message: 'still in use by Quill — point that bot at another model first.',
    });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 409 }));

    await expect(deleteModel(client(fetchFn), modelRow.id)).rejects.toMatchObject({
      failure: { code: 'CONFLICT', detail: body },
    });
  });
});
