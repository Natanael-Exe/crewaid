import { describe, expect, it, vi } from 'vitest';
import { ComposioToolkitNotFoundError, ToolRouterSession, type Tool } from '@composio/core';
import { McpServerSummarySchema } from '@crewaid/shared';
import { parseToolInput, toolInputJsonSchema } from '../src/agent/tool-contract.js';
import { CrewaidTanStackProvider } from '../src/integrations/composio/tanstack-provider.js';
import { curationFor, composioConfiguration } from '../src/integrations/composio/catalog.js';
import {
  ComposioSdk,
  redactResult,
  safeComposioFailure,
} from '../src/integrations/composio/sdk.js';

describe('Composio provider and project boundary', () => {
  it('preserves full nested schemas, refs, unions, required fields and constraints', async () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      $defs: {
        item: {
          type: 'object',
          required: ['count'],
          properties: { count: { type: 'integer', minimum: 1 } },
          additionalProperties: false,
        },
      },
      properties: {
        items: { type: 'array', minItems: 1, items: { $ref: '#/$defs/item' } },
        destination: {
          oneOf: [
            { type: 'string', enum: ['inbox'] },
            { type: 'integer', minimum: 10 },
          ],
        },
      },
    };
    const source = {
      slug: 'GMAIL_SEND_EMAIL',
      name: 'Send',
      description: 'Send a message',
      inputParameters: schema,
    } as Tool;
    const provider = new CrewaidTanStackProvider();
    const wrapped = provider.wrapTool(source);
    expect(toolInputJsonSchema(wrapped.inputSchema)).toEqual(schema);
    expect(wrapped.execute).toBeUndefined();
    expect(Object.keys(provider.wrapTools([source]))).toEqual([source.slug]);
    await expect(
      parseToolInput(wrapped.inputSchema, { items: [{ count: 1 }], destination: 'inbox' }),
    ).resolves.toEqual({ items: [{ count: 1 }], destination: 'inbox' });
    for (const invalid of [
      {},
      { items: [] },
      { items: [{ count: 0 }] },
      { items: [{ count: 2, secret: 'bad' }] },
      { items: [{ count: 1 }], destination: 'other' },
    ])
      await expect(parseToolInput(wrapped.inputSchema, invalid)).rejects.toThrow(
        'INVALID_ARGUMENTS',
      );
  });

  it('reads only the deployment API key, trimmed and explicit', () => {
    expect(composioConfiguration({}).apiKey).toBe('');
    expect(composioConfiguration({ COMPOSIO_API_KEY: '  project ' }).apiKey).toBe('project');
    // Per-app auth config ids are gone (D-204): provisioning happens at install.
    expect(
      composioConfiguration({ COMPOSIO_API_KEY: 'project', COMPOSIO_AUTH_CONFIG_GMAIL: 'ac-x' }),
    ).toEqual({ apiKey: 'project' });
  });

  it('pins an overlay app to its reviewed grant and the selected account on the wire', async () => {
    const sdk = new ComposioSdk('test-key');
    const client = sdk.client.getClient();
    const response = {
      session_id: 's1',
      mcp: { type: 'http', url: 'https://backend.composio.dev/mcp' },
      config: { user_id: 'u1' },
    };
    const create = vi
      .spyOn(client.toolRouter.session, 'create')
      .mockResolvedValue(response as never);
    const gmail = curationFor('gmail');
    if (gmail === undefined) throw new Error('gmail overlay missing');
    const signal = new AbortController().signal;
    await sdk.createSession('u1', gmail.toolkit, gmail, 'ac-gmail', 'ca1', signal);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'u1',
        connected_accounts: { gmail: ['ca1'] },
        auth_configs: { gmail: 'ac-gmail' },
        tools: { gmail: { enable: [...gmail.enabledTools] } },
        manage_connections: { enable: false },
        workbench: expect.objectContaining({ enable: false }),
        search: { enable: false },
        execute: { enable_multi_execute: false },
      }),
      { signal },
    );
    expect(client.maxRetries).toBe(0);
    const session = new ToolRouterSession(client, undefined, 's1', {
      type: 'http',
      url: 'https://backend.composio.dev/mcp',
      headers: {},
    });
    session.config = { ...session.config, connected_accounts: { gmail: ['ca1'] } };
    vi.spyOn(sdk.client.sessions, 'use').mockResolvedValue(session);
    const execute = vi.spyOn(client.toolRouter.session, 'execute').mockResolvedValue({
      data: { message: 'ok', access_token: 'secret' },
      error: null,
      log_id: 'log-1',
    } as never);
    expect(await sdk.execute('s1', 'ca1', 'GMAIL_SEND_EMAIL', { id: '1' }, signal)).toEqual({
      data: { message: 'ok', access_token: '[redacted]' },
      failed: false,
    });
    expect(execute).toHaveBeenCalledWith(
      's1',
      { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { id: '1' } },
      { signal },
    );
    for (const pinned of [{ gmail: ['ca-other'] }, { gmail: ['ca1', 'ca-other'] }, {}]) {
      session.config = { ...session.config, connected_accounts: pinned };
      await expect(
        sdk.execute('s1', 'ca1', 'GMAIL_SEND_EMAIL', { id: '1' }, signal),
      ).rejects.toMatchObject({ kind: 'SCOPE' });
    }
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('enables an uncurated toolkit as a whole, vendor-side', async () => {
    const sdk = new ComposioSdk('test-key');
    const client = sdk.client.getClient();
    const create = vi.spyOn(client.toolRouter.session, 'create').mockResolvedValue({
      session_id: 's2',
      mcp: { type: 'http', url: 'https://backend.composio.dev/mcp' },
      config: { user_id: 'u1' },
    } as never);
    const signal = new AbortController().signal;
    await sdk.createSession('u1', 'googlesheets', undefined, 'ac-googlesheets', 'ca9', signal);
    const config = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config).toEqual(
      expect.objectContaining({
        user_id: 'u1',
        // The SDK normalizes a bare toolkit list to an enable filter on the wire.
        toolkits: { enable: ['googlesheets'] },
        auth_configs: { googlesheets: 'ac-googlesheets' },
        connected_accounts: { googlesheets: ['ca9'] },
      }),
    );
    // No hand-picked grant leaves the build for a toolkit nobody reviewed.
    expect(config['tools']).toBeUndefined();
  });

  it('classifies tools: overlay reads, vendor tags, everything else asks', async () => {
    const sdk = new ComposioSdk('test-key');
    const gmail = curationFor('gmail');
    if (gmail === undefined) throw new Error('gmail overlay missing');
    const raw = (slug: string, extra: Partial<Tool> = {}): Tool =>
      ({
        slug,
        name: slug,
        description: `${slug} does things`,
        inputParameters: { type: 'object', properties: {} },
        tags: [],
        ...extra,
      }) as Tool;
    const sessionTools = vi
      .spyOn(sdk.client.tools, 'getRawToolRouterSessionTools')
      .mockResolvedValue([] as never);
    const signal = new AbortController().signal;
    // Overlay: the session's tools must equal the reviewed grant exactly.
    await expect(sdk.tools('s1', gmail, signal)).rejects.toMatchObject({ kind: 'SCOPE' });
    sessionTools.mockResolvedValue(gmail.enabledTools.map((slug) => raw(slug)) as never);
    const overlay = await sdk.tools('s1', gmail, signal);
    expect(overlay.map((tool) => tool.name)).toEqual([...gmail.enabledTools]);
    expect(overlay.find((tool) => tool.name === 'GMAIL_GET_PROFILE')?.readOnlyHint).toBe(true);
    expect(overlay.find((tool) => tool.name === 'GMAIL_SEND_EMAIL')?.readOnlyHint).toBe(false);
    // Dynamic: the vendor's readOnlyHint tag classifies, deprecated drops out,
    // and a tool with no tag defaults to asking.
    sessionTools.mockResolvedValue([
      raw('SHEETS_READ', { tags: ['readOnlyHint'] }),
      raw('SHEETS_WRITE'),
      raw('COMPOSIO_MANAGE_CONNECTIONS', { tags: ['readOnlyHint'] }),
      raw('SHEETS_OLD', { isDeprecated: true, tags: ['readOnlyHint'] }),
    ] as never);
    const dynamic = await sdk.tools('s1', undefined, signal);
    expect(dynamic.map((tool) => tool.name)).toEqual(['SHEETS_READ', 'SHEETS_WRITE']);
    expect(dynamic[0]?.readOnlyHint).toBe(true);
    expect(dynamic[1]?.readOnlyHint).toBe(false);
  });

  it('lists managed-OAuth toolkits only and provisions a managed auth config', async () => {
    const sdk = new ComposioSdk('test-key');
    const signal = new AbortController().signal;
    const get = vi.spyOn(sdk.client.getClient().toolkits, 'list').mockResolvedValue({
      items: [
        {
          slug: 'gmail',
          name: 'Gmail',
          // The API's deprecated object carries legacy IDs for active apps.
          deprecated: { toolkitId: 'legacy-toolkit-id' },
          meta: {
            categories: [{ slug: 'productivity', name: 'Productivity' }],
            logo: 'https://logos.composio.dev/api/gmail',
          },
          composio_managed_auth_schemes: ['OAUTH2'],
        },
        { slug: 'quickcharts', name: 'QuickCharts', meta: {}, no_auth: true },
        { slug: 'openai', name: 'OpenAI', meta: {}, composio_managed_auth_schemes: ['API_KEY'] },
      ],
      next_cursor: null,
    } as never);
    expect(await sdk.toolkits(signal)).toEqual([
      {
        slug: 'gmail',
        name: 'Gmail',
        category: 'Productivity',
        logo: 'https://logos.composio.dev/api/gmail',
      },
    ]);
    expect(get).toHaveBeenCalledWith({ limit: 1000, sort_by: 'usage' }, { signal });

    const list = vi
      .spyOn(sdk.client.authConfigs, 'list')
      .mockResolvedValue({ items: [], nextCursor: null, totalPages: 0 } as never);
    const create = vi.spyOn(sdk.client.authConfigs, 'create').mockResolvedValue({
      id: 'ac-new',
      authScheme: 'OAUTH2',
      isComposioManaged: true,
      toolkit: 'googlesheets',
    } as never);
    await expect(sdk.ensureAuthConfig('googlesheets', signal)).resolves.toBe('ac-new');
    expect(create).toHaveBeenCalledWith(
      'googlesheets',
      { type: 'use_composio_managed_auth', name: 'Crewaid googlesheets' },
      { signal },
    );
    list.mockResolvedValue({
      items: [
        {
          id: 'ac-existing',
          isComposioManaged: true,
          authScheme: 'OAUTH2',
          status: 'ENABLED',
          toolkit: { slug: 'googlesheets' },
        },
      ],
      nextCursor: null,
      totalPages: 1,
    } as never);
    await expect(sdk.ensureAuthConfig('googlesheets', signal)).resolves.toBe('ac-existing');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('follows catalog cursors and preserves tools beyond the first thousand', async () => {
    const sdk = new ComposioSdk('test-key');
    const list = vi.spyOn(sdk.client.getClient().toolkits, 'list');
    list
      .mockResolvedValueOnce({ items: [], next_cursor: 'page-2' } as never)
      .mockResolvedValueOnce({
        items: [
          {
            slug: 'googlesheets',
            name: 'Google Sheets',
            meta: {},
            composio_managed_auth_schemes: ['OAUTH2'],
          },
        ],
        next_cursor: null,
      } as never);
    expect(await sdk.toolkits(new AbortController().signal)).toEqual([
      { slug: 'googlesheets', name: 'Google Sheets', category: null, logo: null },
    ]);
    expect(list.mock.calls[1]?.[0]).toMatchObject({ cursor: 'page-2' });
  });

  it('skips disabled and non-OAuth configs and follows auth-config pagination', async () => {
    const sdk = new ComposioSdk('test-key');
    const list = vi.spyOn(sdk.client.authConfigs, 'list');
    const config = {
      toolkit: { slug: 'googlesheets' },
      isComposioManaged: true,
      status: 'ENABLED',
      authScheme: 'OAUTH2',
    };
    list
      .mockResolvedValueOnce({
        items: [
          { ...config, id: 'disabled', status: 'DISABLED' },
          { ...config, id: 'apikey', authScheme: 'API_KEY' },
        ],
        nextCursor: 'next',
      } as never)
      .mockResolvedValueOnce({ items: [{ ...config, id: 'correct' }], nextCursor: null } as never);
    const create = vi.spyOn(sdk.client.authConfigs, 'create');
    expect(await sdk.ensureAuthConfig('googlesheets', new AbortController().signal)).toBe(
      'correct',
    );
    expect(create).not.toHaveBeenCalled();
    expect(list.mock.calls[1]?.[0]).toMatchObject({ cursor: 'next' });
    expect(safeComposioFailure(new Error('hidden-secret', { cause: { status: 429 } })).kind).toBe(
      'RATE_LIMIT',
    );
    expect(safeComposioFailure(new Error('hidden-secret', { cause: { status: 403 } })).kind).toBe(
      'SCOPE',
    );
  });

  it('answers null for an unknown toolkit slug and surfaces other failures', async () => {
    const sdk = new ComposioSdk('test-key');
    const get = vi.spyOn(sdk.client.toolkits, 'get');
    const signal = new AbortController().signal;
    get.mockRejectedValue(new ComposioToolkitNotFoundError('vendor-secret'));
    await expect(sdk.toolkit('nope', signal)).resolves.toBeNull();
    get.mockRejectedValue(Object.assign(new Error('boom'), { status: 503 }));
    await expect(sdk.toolkit('nope', signal)).rejects.toMatchObject({ status: 503 });
  });

  it('rejects MCP transport fields on a Composio summary', () => {
    const row = {
      id: 'server-1',
      name: 'Gmail',
      slug: 'gmail',
      category: null,
      iconUrl: null,
      backend: 'COMPOSIO',
      access: { mode: 'SELECTED', selectedBotIds: [] },
      url: null,
      transport: null,
      isPrivate: false,
      authType: 'OAUTH2',
      status: 'CONNECTED',
      toolCount: 11,
      lastError: null,
    };
    expect(McpServerSummarySchema.safeParse(row).success).toBe(true);
    expect(
      McpServerSummarySchema.safeParse({ ...row, url: 'https://example.com/mcp' }).success,
    ).toBe(false);
  });

  it('projects failures without vendor secrets and redacts structured result credentials', () => {
    for (const [status, kind] of [
      [429, 'RATE_LIMIT'],
      [403, 'SCOPE'],
      [503, 'SERVICE'],
    ] as const) {
      const failure = safeComposioFailure({
        status,
        message: 'secret-token',
        response: { api_key: 'secret-token' },
      });
      expect(failure.kind).toBe(kind);
      expect(failure.message).not.toContain('secret-token');
    }
    // The SDK's typed wrappers hide the vendor status one cause down; the kind
    // must survive the wrapping or a permissions problem reads as an outage.
    const wrapped = Object.assign(new Error('Failed to create connected account link'), {
      cause: { status: 403, message: 'secret-token' },
    });
    expect(safeComposioFailure(wrapped).kind).toBe('SCOPE');
    expect(safeComposioFailure(wrapped).message).not.toContain('secret-token');
    const permissions = new Error('vendor-secret', {
      cause: {
        status: 403,
        error: { error: { slug: 'APIKey_InsufficientPermissions', message: 'secret-token' } },
      },
    });
    expect(safeComposioFailure(permissions).kind).toBe('CONFIGURATION');
    expect(safeComposioFailure(permissions).message).toContain('API key');
    expect(safeComposioFailure(permissions).message).not.toContain('secret-token');
    expect(
      redactResult({
        records: [{ refreshToken: 'secret', body: 'message' }],
        authorization: 'Bearer secret',
      }),
    ).toEqual({
      records: [{ refreshToken: '[redacted]', body: 'message' }],
      authorization: '[redacted]',
    });
  });
});
