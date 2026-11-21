import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { ToolRegistry } from '../src/agent/tool-registry.js';
import { McpServersService } from '../src/mcp/mcp-servers.service.js';
import { BotPluginsService } from '../src/mcp/bot-plugins.service.js';
import { ComposioService } from '../src/integrations/composio/composio.service.js';
import { ComposioFailure } from '../src/integrations/composio/sdk.js';
import { ToolPolicyStateService } from '../src/agent/policy/state.service.js';
import { FakeComposio } from './composio-fixture.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

// Database fixtures are owned by this suite; external application writes are mocked.
describe.skipIf(!process.env['DATABASE_URL'])('Composio durable connection lifecycle', () => {
  const prisma = new PrismaService();
  const events = { emitMcpStatus: vi.fn() } as unknown as TurnEventBus;
  let owner: SignedInUser;
  let other: SignedInUser;
  let port: FakeComposio;
  let composio: ComposioService;
  let servers: McpServersService;

  beforeAll(async () => {
    // D-204: the per-app auth config ids are gone; only the project key remains.
    vi.stubEnv('COMPOSIO_API_KEY', 'test-project-secret');
    await prisma.$connect();
    owner = await signIn(prisma, { label: 'composio-owner' });
    other = await signIn(prisma, { label: 'composio-other' });
  });
  beforeEach(async () => {
    await prisma.mcpServer.deleteMany({ where: { userId: { in: [owner.userId, other.userId] } } });
    port = new FakeComposio();
    composio = new ComposioService(prisma, events);
    composio.setPortForTests(port);
    servers = new McpServersService(prisma, events, new ToolRegistry(), composio);
  });
  afterAll(async () => {
    await signOutAndDelete(prisma, owner.userId);
    await signOutAndDelete(prisma, other.userId);
    await prisma.$disconnect();
    vi.unstubAllEnvs();
  });

  async function install(slug = 'gmail', user = owner) {
    return servers.install(user.userId, { slug });
  }
  async function connect(id: string, user = owner) {
    await servers.connect(user.userId, id);
    const connection = await prisma.composioConnection.findUniqueOrThrow({
      where: { serverId: id },
    });
    port.activate(connection.pendingAccountId!);
    await servers.list(user.userId);
    return prisma.composioConnection.findUniqueOrThrow({ where: { serverId: id } });
  }

  // D-204: a directory slug IS the vendor toolkit slug — the calendar installs
  // as `googlecalendar`, the slug its ComposioConnection row always carried.
  it.each(['gmail', 'googlecalendar', 'slack'])(
    'connects %s and exposes no credentials or MCP transport',
    async (slug) => {
      const installed = await install(slug);
      expect(installed).toMatchObject({
        backend: 'COMPOSIO',
        url: null,
        transport: null,
        status: 'DISCONNECTED',
      });
      const connection = await connect(installed.id);
      const [summary] = await servers.list(owner.userId);
      expect(summary?.status).toBe('CONNECTED');
      expect(summary!.toolCount).toBeGreaterThan(0);
      expect(JSON.stringify(summary)).not.toMatch(/test-project-secret|ac-|ca-test|s-usr/);
      expect(connection.pendingAccountId).toBeNull();
      expect(connection.sessionId).not.toBeNull();
      expect(await prisma.mcpCredential.count({ where: { serverId: installed.id } })).toBe(0);
    },
  );

  it('installs a catalog toolkit dynamically and classifies its tools by vendor tag', async () => {
    port.catalog.push({
      slug: 'googlesheets',
      name: 'Google Sheets',
      category: 'spreadsheets',
      logo: 'https://logos.composio.dev/api/googlesheets',
    });
    port.seedTools('googlesheets', [
      { name: 'GOOGLESHEETS_GET_VALUES', tags: ['readOnlyHint'] },
      { name: 'GOOGLESHEETS_UPDATE_CELLS' },
    ]);
    // The directory offers it as a Composio entry, logo and all.
    const directory = await servers.listDirectory();
    expect(directory).toContainEqual(
      expect.objectContaining({ slug: 'googlesheets', backend: 'COMPOSIO' }),
    );
    // Install provisions the auth config itself — no environment named this app.
    const installed = await install('googlesheets');
    expect(port.ensureAuthConfig).toHaveBeenCalledWith('googlesheets', expect.anything());
    expect(installed).toMatchObject({
      backend: 'COMPOSIO',
      iconUrl: 'https://logos.composio.dev/api/googlesheets',
      status: 'DISCONNECTED',
    });
    await connect(installed.id);
    const summary = (await servers.list(owner.userId)).find((row) => row.id === installed.id);
    expect(summary?.status).toBe('CONNECTED');
    expect(summary?.toolCount).toBe(2);
    // Vendor tag classifies: the read runs without asking, the write asks.
    const cached = await prisma.mcpTool.findMany({ where: { serverId: installed.id } });
    expect(cached.find((row) => row.name === 'GOOGLESHEETS_GET_VALUES')?.readOnly).toBe(true);
    expect(cached.find((row) => row.name === 'GOOGLESHEETS_UPDATE_CELLS')?.readOnly).toBe(false);
    // A tool this connection's refresh never cached is refused outright.
    await expect(
      servers.callTool(owner.userId, installed.id, 'GOOGLESHEETS_UNKNOWN_TOOL', { id: '1' }, 1000),
    ).rejects.toThrow('Refresh this app before using its tools.');
  });

  async function makeBot(userId = owner.userId, name = 'access-fixture') {
    return prisma.bot.create({
      data: { userId, name, role: 'test', avatarColor: '#123456', systemPrompt: '' },
    });
  }

  it('grants current and future bots except exclusions, with owner isolation', async () => {
    const installed = await install();
    await connect(installed.id);
    const allowed = await makeBot();
    const excluded = await makeBot();
    const foreign = await makeBot(other.userId);
    const plugins = new BotPluginsService(prisma, servers);
    await plugins.setAccess(owner.userId, installed.id, {
      mode: 'ALL',
      excludedBotIds: [excluded.id],
    });
    const future = await makeBot();
    expect((await plugins.toolsForBot(owner.userId, allowed.id)).deferred.length).toBeGreaterThan(
      0,
    );
    expect((await plugins.toolsForBot(owner.userId, future.id)).deferred.length).toBeGreaterThan(0);
    expect((await plugins.toolsForBot(owner.userId, excluded.id)).deferred).toEqual([]);
    expect((await plugins.toolsForBot(other.userId, foreign.id)).deferred).toEqual([]);
    expect((await plugins.toolsForBot(owner.userId, foreign.id)).deferred).toEqual([]);
    expect((await servers.list(owner.userId))[0]?.access).toEqual({
      mode: 'ALL',
      excludedBotIds: [excluded.id],
    });
    await plugins.replace(owner.userId, allowed.id, []);
    expect((await plugins.list(owner.userId, allowed.id))[0]?.enabled).toBe(false);
    await plugins.replace(owner.userId, allowed.id, [installed.id]);
    expect((await plugins.list(owner.userId, allowed.id))[0]?.enabled).toBe(true);
    expect((await plugins.list(owner.userId, excluded.id))[0]?.enabled).toBe(false);
  });

  it('selects multiple bots without including future bots and rejects foreign IDs atomically', async () => {
    const installed = await install();
    await connect(installed.id);
    const a = await makeBot();
    const b = await makeBot();
    const foreign = await makeBot(other.userId);
    const plugins = new BotPluginsService(prisma, servers);
    await plugins.setAccess(owner.userId, installed.id, {
      mode: 'SELECTED',
      selectedBotIds: [a.id, b.id, a.id],
    });
    await expect(
      plugins.setAccess(owner.userId, installed.id, { mode: 'ALL', excludedBotIds: [foreign.id] }),
    ).rejects.toThrow('unavailable');
    await expect(
      plugins.setAccess(other.userId, installed.id, { mode: 'ALL', excludedBotIds: [] }),
    ).rejects.toThrow('No installed');
    const future = await makeBot();
    expect((await plugins.toolsForBot(owner.userId, a.id)).deferred.length).toBeGreaterThan(0);
    expect((await plugins.toolsForBot(owner.userId, b.id)).deferred.length).toBeGreaterThan(0);
    expect((await plugins.toolsForBot(owner.userId, future.id)).deferred).toEqual([]);
    expect((await servers.list(owner.userId))[0]?.access).toEqual({
      mode: 'SELECTED',
      selectedBotIds: [a.id, b.id].sort(),
    });
    await plugins.setAccess(owner.userId, installed.id, { mode: 'SELECTED', selectedBotIds: [] });
    expect((await plugins.toolsForBot(owner.userId, a.id)).deferred).toEqual([]);
  });

  it('keeps ALL mode disabled after an uninstall cleanup failure', async () => {
    const installed = await install();
    await connect(installed.id);
    const bot = await makeBot();
    const plugins = new BotPluginsService(prisma, servers);
    await plugins.setAccess(owner.userId, installed.id, { mode: 'ALL', excludedBotIds: [] });
    port.deleteAccount.mockRejectedValueOnce(new ComposioFailure('SERVICE'));
    await expect(servers.remove(owner.userId, installed.id)).rejects.toThrow(
      'remote cleanup failed',
    );
    expect((await plugins.toolsForBot(owner.userId, bot.id)).deferred).toEqual([]);
    await expect(
      plugins.setAccess(owner.userId, installed.id, { mode: 'ALL', excludedBotIds: [] }),
    ).rejects.toThrow('No installed');
    await servers.remove(owner.userId, installed.id);
  });

  it('recovers a restart after accepting the account before caching tools', async () => {
    const installed = await install();
    await servers.connect(owner.userId, installed.id);
    const pending = await prisma.composioConnection.findUniqueOrThrow({
      where: { serverId: installed.id },
    });
    port.activate(pending.pendingAccountId!);
    await prisma.composioConnection.update({
      where: { serverId: installed.id },
      data: {
        accountId: pending.pendingAccountId,
        pendingAccountId: null,
        pendingExpiresAt: null,
        revision: { increment: 1 },
      },
    });
    composio = new ComposioService(prisma, events);
    composio.setPortForTests(port);
    servers = new McpServersService(prisma, events, new ToolRegistry(), composio);
    expect((await servers.list(owner.userId))[0]?.status).toBe('CONNECTED');
    expect(port.createSession).toHaveBeenCalledTimes(1);
  });

  it('recovers completion after restart and reuses the installed session', async () => {
    const installed = await install();
    await servers.connect(owner.userId, installed.id);
    const pending = await prisma.composioConnection.findUniqueOrThrow({
      where: { serverId: installed.id },
    });
    port.activate(pending.pendingAccountId!);
    composio = new ComposioService(prisma, events);
    composio.setPortForTests(port);
    servers = new McpServersService(prisma, events, new ToolRegistry(), composio);
    expect((await servers.list(owner.userId))[0]?.status).toBe('CONNECTED');
    const selected = await prisma.composioConnection.findUniqueOrThrow({
      where: { serverId: installed.id },
    });
    await servers.refreshTools(owner.userId, installed.id);
    await servers.callTool(owner.userId, installed.id, 'GMAIL_GET_PROFILE', { id: 'me' }, 1000);
    expect(port.createSession).toHaveBeenCalledTimes(1);
    expect(port.execute).toHaveBeenCalledWith(
      selected.sessionId,
      selected.accountId,
      'GMAIL_GET_PROFILE',
      { id: 'me' },
      expect.any(AbortSignal),
    );
  });

  it('keeps selected accounts and plugin tools isolated by user and bot', async () => {
    const a = await install();
    const b = await install('gmail', other);
    const accountA = await connect(a.id);
    const accountB = await connect(b.id, other);
    await expect(
      servers.callTool(other.userId, a.id, 'GMAIL_GET_PROFILE', { id: '1' }, 1000),
    ).rejects.toThrow('not found');
    await expect(servers.connect(other.userId, a.id)).rejects.toThrow('not found');
    expect(await servers.list(other.userId)).toHaveLength(1);
    await servers.callTool(owner.userId, a.id, 'GMAIL_GET_PROFILE', { id: '1' }, 1000);
    await servers.callTool(other.userId, b.id, 'GMAIL_GET_PROFILE', { id: '1' }, 1000);
    expect(port.execute.mock.calls.map((call) => call[1])).toEqual([
      accountA.accountId,
      accountB.accountId,
    ]);
    const botA = await prisma.bot.create({
      data: {
        userId: owner.userId,
        name: 'Allowed',
        role: 'test',
        avatarColor: '#123456',
        systemPrompt: '',
      },
    });
    const botB = await prisma.bot.create({
      data: {
        userId: owner.userId,
        name: 'Unconnected',
        role: 'test',
        avatarColor: '#123456',
        systemPrompt: '',
      },
    });
    const plugins = new BotPluginsService(prisma, servers);
    await plugins.replace(owner.userId, botA.id, [a.id]);
    expect((await plugins.toolsForBot(owner.userId, botA.id)).deferred.length).toBeGreaterThan(0);
    expect((await plugins.toolsForBot(owner.userId, botB.id)).deferred).toEqual([]);
    expect((await plugins.toolsForBot(other.userId, botA.id)).deferred).toEqual([]);
  });

  it.each(['FAILED', 'EXPIRED'])(
    'settles a %s connection and removes the pending remote account',
    async (status) => {
      const installed = await install();
      await servers.connect(owner.userId, installed.id);
      const pending = await prisma.composioConnection.findUniqueOrThrow({
        where: { serverId: installed.id },
      });
      port.accounts.get(pending.pendingAccountId!)!.status = status;
      expect((await servers.list(owner.userId))[0]?.status).toBe('DISCONNECTED');
      expect(port.deleteAccount).toHaveBeenCalledWith(
        pending.pendingAccountId,
        expect.any(AbortSignal),
      );
      const settled = await prisma.composioConnection.findUniqueOrThrow({
        where: { serverId: installed.id },
      });
      expect(settled.pendingExpiresAt).toBeNull();
      expect(settled.revision).toBeGreaterThan(pending.revision);
    },
  );

  it('expires a persisted link after restart without accepting a late completion', async () => {
    const installed = await install();
    await servers.connect(owner.userId, installed.id);
    const pending = await prisma.composioConnection.update({
      where: { serverId: installed.id },
      data: { pendingExpiresAt: new Date(0) },
    });
    port.activate(pending.pendingAccountId!);
    expect((await servers.list(owner.userId))[0]).toMatchObject({
      status: 'DISCONNECTED',
      lastError: expect.stringContaining('expired'),
    });
    expect(port.createSession).not.toHaveBeenCalled();
  });

  it.each(['owner', 'toolkit', 'authConfigId'])(
    'refuses a completion with the wrong %s',
    async (coordinate) => {
      const installed = await install();
      await servers.connect(owner.userId, installed.id);
      const pending = await prisma.composioConnection.findUniqueOrThrow({
        where: { serverId: installed.id },
      });
      port.activate(pending.pendingAccountId!);
      Object.assign(port.accounts.get(pending.pendingAccountId!)!, { [coordinate]: 'foreign' });
      expect((await servers.list(owner.userId))[0]?.status).toBe('DISCONNECTED');
      expect(port.createSession).not.toHaveBeenCalled();
    },
  );

  it('reconnects with a new account, revokes the old one and changes approval grants', async () => {
    const installed = await install();
    const first = await connect(installed.id);
    const bot = await prisma.bot.create({
      data: {
        userId: owner.userId,
        name: 'Policy',
        role: 'test',
        avatarColor: '#123456',
        systemPrompt: '',
        mcpServers: { create: { serverId: installed.id } },
      },
    });
    const policy = new ToolPolicyStateService(prisma, {} as never, {} as never);
    const stateBefore = await policy.read(
      owner.userId,
      bot.id,
      { name: 'local', args: {}, validate: async () => ({ ok: true, value: {} }) },
      false,
    );
    const second = await connect(installed.id);
    const stateAfter = await policy.read(
      owner.userId,
      bot.id,
      { name: 'local', args: {}, validate: async () => ({ ok: true, value: {} }) },
      false,
    );
    expect(second.accountId).not.toBe(first.accountId);
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(stateAfter.snapshot.grantRevision).not.toEqual(stateBefore.snapshot.grantRevision);
    expect(port.deleteAccount).toHaveBeenCalledWith(first.accountId, expect.any(AbortSignal));
  });

  it('invalidates revoked grants and does not dispatch the call', async () => {
    const installed = await install();
    const first = await connect(installed.id);
    port.accounts.get(first.accountId!)!.status = 'REVOKED';
    await expect(
      servers.callTool(owner.userId, installed.id, 'GMAIL_SEND_EMAIL', { id: '1' }, 1000),
    ).rejects.toThrow('revoked');
    expect(port.execute).not.toHaveBeenCalled();
    expect((await servers.list(owner.userId))[0]?.status).toBe('NEEDS_REAUTH');
  });

  it('does not let a late revocation response invalidate a reconnected account', async () => {
    const installed = await install();
    const first = await connect(installed.id);
    let finish: (value: Awaited<ReturnType<FakeComposio['account']>>) => void = () => {};
    port.account.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const oldCall = servers.callTool(
      owner.userId,
      installed.id,
      'GMAIL_GET_PROFILE',
      { id: 'me' },
      5000,
    );
    const refused = expect(oldCall).rejects.toThrow('connection changed');
    await vi.waitFor(() =>
      expect(port.account).toHaveBeenLastCalledWith(
        owner.userId,
        'gmail',
        first.authConfigId,
        first.accountId,
        expect.any(AbortSignal),
      ),
    );
    const second = await connect(installed.id);
    finish({ ...port.accounts.get(second.accountId!)!, id: first.accountId!, status: 'REVOKED' });
    await refused;
    expect((await servers.list(owner.userId))[0]?.status).toBe('CONNECTED');
    expect(
      (await prisma.composioConnection.findUniqueOrThrow({ where: { serverId: installed.id } }))
        .accountId,
    ).toBe(second.accountId);
    expect(port.execute).not.toHaveBeenCalled();
  });

  it('removes local grants despite a remote cleanup failure, then retries cleanup', async () => {
    const installed = await install();
    const selected = await connect(installed.id);
    const bot = await prisma.bot.create({
      data: {
        userId: owner.userId,
        name: 'Remove',
        role: 'test',
        avatarColor: '#123456',
        systemPrompt: '',
        mcpServers: { create: { serverId: installed.id } },
      },
    });
    port.deleteAccount.mockRejectedValueOnce({ status: 503, message: 'secret-token' });
    await expect(servers.remove(owner.userId, installed.id)).rejects.toThrow(
      'remote cleanup failed',
    );
    expect(await prisma.botMcpServer.count({ where: { botId: bot.id } })).toBe(0);
    expect(await prisma.mcpTool.count({ where: { serverId: installed.id } })).toBe(0);
    expect((await servers.list(owner.userId))[0]?.lastError).toContain('remote cleanup failed');
    await expect(
      servers.callTool(owner.userId, installed.id, 'GMAIL_SEND_EMAIL', { id: '1' }, 1000),
    ).rejects.toThrow();
    await servers.remove(owner.userId, installed.id);
    expect(await servers.list(owner.userId)).toEqual([]);
    expect(port.accounts.has(selected.accountId!)).toBe(false);
  });

  it('validates arguments and stops already-cancelled calls before SDK dispatch', async () => {
    const installed = await install();
    await connect(installed.id);
    await expect(
      servers.callTool(owner.userId, installed.id, 'GMAIL_SEND_EMAIL', { id: 3 }, 1000),
    ).rejects.toThrow('schema');
    await expect(
      servers.callTool(
        owner.userId,
        installed.id,
        'COMPOSIO_MULTI_EXECUTE_TOOL',
        { id: 'x' },
        1000,
      ),
      // D-204: the static allowlist is gone; the vendor meta-tool is not in
      // the cache this connection's refresh wrote, which is the same refusal
      // any unvouched tool gets.
    ).rejects.toThrow('Refresh this app before using its tools.');
    await expect(
      servers.callTool(
        owner.userId,
        installed.id,
        'GMAIL_SEND_EMAIL',
        { id: '1' },
        1000,
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
    expect(port.execute).not.toHaveBeenCalled();
  });

  it('forwards cancellation during execution and never retries an uncertain write', async () => {
    const installed = await install();
    await connect(installed.id);
    port.execute.mockImplementationOnce(
      async (_session, _account, _tool, _args, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('secret-token')), { once: true });
        }),
    );
    const controller = new AbortController();
    const call = servers.callTool(
      owner.userId,
      installed.id,
      'GMAIL_SEND_EMAIL',
      { id: '1' },
      1000,
      controller.signal,
    );
    await vi.waitFor(() => expect(port.execute).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(call).rejects.toThrow('may have completed');
    expect(port.execute).toHaveBeenCalledTimes(1);
  });

  it.each([429, 503])(
    'isolates a %s outage without leaking vendor errors or replaying writes',
    async (status) => {
      const installed = await install();
      await connect(installed.id);
      port.execute.mockRejectedValueOnce({ status, message: 'test-project-secret' });
      await expect(
        servers.callTool(owner.userId, installed.id, 'GMAIL_SEND_EMAIL', { id: '1' }, 1000),
      ).rejects.toBeInstanceOf(ComposioFailure);
      expect(port.execute).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(await servers.list(owner.userId))).not.toContain('test-project-secret');
    },
  );

  it('keeps pending connection recovery available during a polling service outage', async () => {
    const installed = await install();
    await servers.connect(owner.userId, installed.id);
    port.account.mockRejectedValueOnce({ status: 503, message: 'secret-token' });
    expect((await servers.list(owner.userId))[0]).toMatchObject({
      status: 'CONNECTING',
      lastError: expect.not.stringContaining('secret-token'),
    });
    const pending = await prisma.composioConnection.findUniqueOrThrow({
      where: { serverId: installed.id },
    });
    port.activate(pending.pendingAccountId!);
    expect((await servers.list(owner.userId))[0]?.status).toBe('CONNECTED');
  });

  it('settles a permanent session permissions failure with an actionable error after sign-in', async () => {
    const installed = await install();
    await servers.connect(owner.userId, installed.id);
    const pending = await prisma.composioConnection.findUniqueOrThrow({
      where: { serverId: installed.id },
    });
    port.activate(pending.pendingAccountId!);
    port.createSession.mockRejectedValueOnce(
      new Error('SDK wrapper', {
        cause: {
          status: 403,
          error: {
            error: { slug: 'APIKey_InsufficientPermissions', message: 'test-project-secret' },
          },
        },
      }),
    );
    expect((await servers.list(owner.userId))[0]).toMatchObject({
      status: 'ERROR',
      lastError: expect.stringContaining('API key'),
    });
    expect(JSON.stringify(await servers.list(owner.userId))).not.toContain('test-project-secret');
    await connect(installed.id);
    expect((await servers.list(owner.userId))[0]?.status).toBe('CONNECTED');
  });

  it('reports a scoped project key rejection and allows a new link after configuration is fixed', async () => {
    const installed = await install();
    port.link.mockRejectedValueOnce(
      new Error('SDK wrapper', {
        cause: {
          status: 403,
          error: {
            error: { slug: 'APIKey_InsufficientPermissions', message: 'test-project-secret' },
          },
        },
      }),
    );
    await expect(servers.connect(owner.userId, installed.id)).rejects.toThrow('API key');
    expect((await servers.list(owner.userId))[0]).toMatchObject({
      status: 'ERROR',
      lastError: expect.stringContaining('API key'),
    });
    const failed = await prisma.composioConnection.findUniqueOrThrow({
      where: { serverId: installed.id },
    });
    expect(failed.pendingAccountId).toBeNull();
    expect(failed.pendingExpiresAt).toBeNull();
    await connect(installed.id);
    expect((await servers.list(owner.userId))[0]?.status).toBe('CONNECTED');
    expect(port.link).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(await servers.list(owner.userId))).not.toContain('test-project-secret');
  });
});
