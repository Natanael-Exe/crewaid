import { vi } from 'vitest';
import type { ComposioCuration } from '../src/integrations/composio/catalog.js';
import type {
  AccountStatus,
  CatalogToolkit,
  ComposioPort,
} from '../src/integrations/composio/sdk.js';

/** External writes are recorded locally; no application credentials are used. */
export class FakeComposio implements ComposioPort {
  accounts = new Map<string, AccountStatus & { owner: string }>();
  catalog: CatalogToolkit[] = [
    {
      slug: 'gmail',
      name: 'Gmail',
      category: 'Productivity',
      logo: 'https://logos.composio.dev/api/gmail',
    },
    {
      slug: 'googlecalendar',
      name: 'Google Calendar',
      category: 'Productivity',
      logo: 'https://logos.composio.dev/api/googlecalendar',
    },
    {
      slug: 'slack',
      name: 'Slack',
      category: 'Communication',
      logo: 'https://logos.composio.dev/api/slack',
    },
  ];
  /** Tools the vendor reports for an uncurated toolkit; tags drive the read-only fallback. */
  toolkitTools = new Map<string, { name: string; tags?: string[] }[]>();
  authConfigForToolkit = new Map<string, string>();
  private sessionToolkits = new Map<string, string>();
  links = 0;
  sessions = 0;
  link = vi.fn(async (owner: string, authConfigId: string) => {
    const id = `ca-test-${++this.links}`;
    const toolkit =
      [...this.authConfigForToolkit.entries()].find(([, config]) => config === authConfigId)?.[0] ??
      'gmail';
    this.accounts.set(id, {
      id,
      owner,
      toolkit,
      authConfigId,
      status: 'INITIATED',
      disabled: false,
    });
    return { id, redirectUrl: `https://connect.composio.dev/link/${id}` };
  });
  account = vi.fn(async (owner: string, _toolkit: string, _config: string, id: string) => {
    const account = this.accounts.get(id);
    return account?.owner === owner ? account : null;
  });
  createSession = vi.fn(
    async (
      owner: string,
      toolkit: string,
      _curation: ComposioCuration | undefined,
      _config: string,
      account: string,
    ) => {
      const id = `s-${owner}-${toolkit}-${account}-${++this.sessions}`;
      this.sessionToolkits.set(id, toolkit);
      return id;
    },
  );
  tools = vi.fn(async (sessionId: string, curation: ComposioCuration | undefined) => {
    const source = curation
      ? curation.enabledTools.map((name) => ({ name, tags: [] as string[] | undefined }))
      : (this.toolkitTools.get(this.sessionToolkits.get(sessionId) ?? '') ?? []);
    return source.map(({ name, tags }) => ({
      name,
      description: `App tool ${name}`,
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', minLength: 1 } },
        required: ['id'],
        additionalProperties: false,
      },
      readOnlyHint: curation?.readTools.includes(name) ?? tags?.includes('readOnlyHint') === true,
    }));
  });
  execute = vi.fn(
    async (
      sessionId: string,
      accountId: string,
      name: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      return { data: { received: String(args['id']) }, failed: false };
    },
  );
  deleteAccount = vi.fn(async (id: string) => {
    this.accounts.delete(id);
  });
  deleteSession = vi.fn(async (_id: string) => undefined);
  toolkits = vi.fn(async () => this.catalog);
  toolkit = vi.fn(async (slug: string) => this.catalog.find((item) => item.slug === slug) ?? null);
  ensureAuthConfig = vi.fn(async (toolkit: string) => {
    const existing = this.authConfigForToolkit.get(toolkit);
    if (existing !== undefined) return existing;
    const id = `ac-${toolkit}`;
    this.authConfigForToolkit.set(toolkit, id);
    return id;
  });
  activate(id: string) {
    const account = this.accounts.get(id);
    if (!account) throw new Error('missing test account');
    account.status = 'ACTIVE';
  }
  /** Seed the vendor tools an uncurated toolkit's session reports. */
  seedTools(toolkit: string, tools: { name: string; tags?: string[] }[]) {
    this.toolkitTools.set(toolkit, tools);
  }
}
