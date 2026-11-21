import {
  Composio,
  ComposioToolkitNotFoundError,
  SessionPreset,
  ToolRouterSession,
} from '@composio/core';
import { JsonSchema, type Json } from '@crewaid/shared';
import { toolInputJsonSchema } from '../../agent/tool-contract.js';
import type { McpToolDescriptor } from '../../mcp/mcp-tools.js';
import type { ComposioCuration } from './catalog.js';
import { CrewaidTanStackProvider } from './tanstack-provider.js';

export type AccountStatus = {
  id: string;
  status: string;
  toolkit: string;
  authConfigId: string;
  disabled: boolean;
};

/**
 * One toolkit of the deployment's live catalog, projected to what the
 * directory and the install draft need. `logo` is the vendor's own asset URL —
 * every toolkit's logo answers on one host, `logos.composio.dev`, which is the
 * single named host the renderer's CSP admits for it.
 */
export type CatalogToolkit = {
  slug: string;
  name: string;
  category: string | null;
  logo: string | null;
};

export interface ComposioPort {
  link(
    userId: string,
    authConfigId: string,
    signal: AbortSignal,
  ): Promise<{ id: string; redirectUrl: string }>;
  account(
    userId: string,
    toolkit: string,
    authConfigId: string,
    accountId: string,
    signal: AbortSignal,
  ): Promise<AccountStatus | null>;
  /**
   * `curation` pins the vendor session to reviewed tools when one exists; an
   * absent curation enables the toolkit as a whole, vendor-side.
   */
  createSession(
    userId: string,
    toolkit: string,
    curation: ComposioCuration | undefined,
    authConfigId: string,
    accountId: string,
    signal: AbortSignal,
  ): Promise<string>;
  tools(
    sessionId: string,
    curation: ComposioCuration | undefined,
    signal: AbortSignal,
  ): Promise<McpToolDescriptor[]>;
  execute(
    sessionId: string,
    accountId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ data: Json; failed: boolean }>;
  deleteAccount(id: string, signal: AbortSignal): Promise<void>;
  deleteSession(id: string, signal: AbortSignal): Promise<void>;
  /** The deployment's installable toolkits: Composio-managed OAuth2 only. */
  toolkits(signal: AbortSignal): Promise<CatalogToolkit[]>;
  /** One toolkit of the catalog, or null when the vendor does not know it. */
  toolkit(slug: string, signal: AbortSignal): Promise<CatalogToolkit | null>;
  /**
   * The auth config a toolkit's connections use, creating a Composio-managed
   * one when the project has none — provisioning at install, not a deploy
   * variable.
   */
  ensureAuthConfig(toolkit: string, signal: AbortSignal): Promise<string>;
}

export class ComposioFailure extends Error {
  constructor(
    readonly kind:
      'RATE_LIMIT' | 'SCOPE' | 'CONFIGURATION' | 'SERVICE' | 'CANCELLED' | 'INVALID_RESULT',
  ) {
    super(
      kind === 'CONFIGURATION'
        ? "The server's Composio API key lacks required permissions. Ask the administrator to replace it with a key that can manage app connections and sessions."
        : kind === 'SCOPE'
          ? 'The app grant is missing or revoked. Reconnect it in Plugins.'
          : kind === 'RATE_LIMIT'
            ? 'The app service is rate limited. Try again later.'
            : kind === 'CANCELLED'
              ? 'The app call was cancelled. A dispatched action may have completed; check before retrying.'
              : 'The app service could not complete this request. Check the app before retrying a write.',
    );
  }
}

/** No vendor messages, responses, credentials or stack traces cross this boundary. */
export function composioHttpStatus(error: unknown): number | undefined {
  // The SDK wraps vendor errors in typed failures of its own — a failed link
  // becomes a ComposioFailedToCreateConnectedAccountLink carrying the real
  // APIError only as `cause` — so the HTTP status that decides the kind may
  // sit a level down. Walk the chain: a wrapped 403 must read as a permissions
  // problem the operator can fix, not as a vendor outage. Text stays behind.
  let cause: unknown = error;
  for (let depth = 0; depth < 5 && cause !== null && typeof cause === 'object'; depth += 1) {
    const status =
      (cause as { status?: unknown; statusCode?: unknown }).status ??
      (cause as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number') return status;
    cause = (cause as { cause?: unknown }).cause;
  }
  return undefined;
}

export function safeComposioFailure(error: unknown, signal?: AbortSignal): ComposioFailure {
  if (error instanceof ComposioFailure) return error;
  if (signal?.aborted) return new ComposioFailure('CANCELLED');
  // Inspect only the structured vendor code. Its message and suggested fix
  // can contain request details and never become product copy.
  let cause: unknown = error;
  for (let depth = 0; depth < 5 && cause !== null && typeof cause === 'object'; depth += 1) {
    const payload = (cause as { error?: unknown }).error;
    if (payload !== null && typeof payload === 'object') {
      const detail = (payload as { error?: unknown }).error;
      if (
        detail !== null &&
        typeof detail === 'object' &&
        (detail as { slug?: unknown }).slug === 'APIKey_InsufficientPermissions'
      )
        return new ComposioFailure('CONFIGURATION');
    }
    cause = (cause as { cause?: unknown }).cause;
  }
  const status = composioHttpStatus(error);
  return new ComposioFailure(
    status === 429 ? 'RATE_LIMIT' : status === 401 || status === 403 ? 'SCOPE' : 'SERVICE',
  );
}

/** Project result data only; credentials and internal execution metadata are never returned. */
export function redactResult(value: unknown): Json {
  const data = JsonSchema.parse(value);
  const visit = (item: Json): Json => {
    if (Array.isArray(item)) return item.map(visit);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [
          key,
          /^(access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|client[_-]?secret|password)$/i.test(
            key,
          )
            ? '[redacted]'
            : visit(child),
        ]),
      );
    return item;
  };
  return visit(data);
}

/** D-204's directory scope: a toolkit this build can connect without a secret form. */
function isManagedOAuthToolkit(item: {
  noAuth?: boolean | undefined;
  composioManagedAuthSchemes?: string[] | undefined;
}): boolean {
  return item.noAuth !== true && (item.composioManagedAuthSchemes ?? []).includes('OAUTH2');
}

function toCatalogToolkit(item: {
  slug: string;
  name: string;
  meta?:
    | {
        categories?: { name: string }[] | undefined;
        logo?: string | undefined;
      }
    | undefined;
}): CatalogToolkit {
  return {
    slug: item.slug,
    name: item.name,
    category: item.meta?.categories?.[0]?.name ?? null,
    logo: item.meta?.logo ?? null,
  };
}

export class ComposioSdk implements ComposioPort {
  readonly client: Composio<CrewaidTanStackProvider>;
  private readonly authProvisioning = new Map<string, Promise<string>>();

  constructor(apiKey: string) {
    this.client = new Composio({
      apiKey,
      userApiKey: null,
      orgApiKey: null,
      provider: new CrewaidTanStackProvider(),
      allowTracking: false,
      disableVersionCheck: true,
      dangerouslyAllowAutoUploadDownloadFiles: false,
      logLevel: 'silent',
    });
    // Applies to link and execute as well: an uncertain POST must never be replayed.
    this.client.getClient().maxRetries = 0;
    this.client.getClient().timeout = 30_000;
  }

  async link(userId: string, authConfigId: string, signal: AbortSignal) {
    const link = await this.client.connectedAccounts.link(
      userId,
      authConfigId,
      { allowMultiple: true },
      { signal },
    );
    if (link.redirectUrl == null) throw new ComposioFailure('SERVICE');
    const url = new URL(link.redirectUrl);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new ComposioFailure('SERVICE');
    return { id: link.id, redirectUrl: url.toString() };
  }

  async account(
    userId: string,
    toolkit: string,
    authConfigId: string,
    accountId: string,
    signal: AbortSignal,
  ) {
    // get(id) omits owner identity in this SDK. A PRIVATE, owner-filtered listing
    // establishes ownership; never accept an arbitrary ID from a browser callback.
    let cursor: string | undefined;
    do {
      const page = await this.client.connectedAccounts.list(
        {
          userIds: [userId],
          toolkitSlugs: [toolkit],
          authConfigIds: [authConfigId],
          accountType: 'PRIVATE',
          limit: 100,
          ...(cursor && { cursor }),
        },
        { signal },
      );
      const account = page.items.find((item) => item.id === accountId);
      if (account !== undefined)
        return {
          id: account.id,
          status: account.status,
          toolkit: account.toolkit.slug,
          authConfigId: account.authConfig.id,
          disabled: account.isDisabled,
        };
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return null;
  }

  async createSession(
    userId: string,
    toolkit: string,
    curation: ComposioCuration | undefined,
    authConfigId: string,
    accountId: string,
    signal: AbortSignal,
  ) {
    const session = await this.client.sessions.create(
      userId,
      {
        sessionPreset: SessionPreset.DIRECT_TOOLS,
        ...(curation === undefined
          ? { toolkits: [toolkit] }
          : {
              toolkits: [toolkit],
              tools: { [toolkit]: { enable: [...curation.enabledTools] } },
            }),
        authConfigs: { [toolkit]: authConfigId },
        connectedAccounts: { [toolkit]: [accountId] },
        manageConnections: false,
        sandbox: { enable: false, enableProxyExecution: false },
      },
      { signal },
    );
    return session.sessionId;
  }

  async tools(sessionId: string, curation: ComposioCuration | undefined, signal: AbortSignal) {
    const raw = await this.client.tools.getRawToolRouterSessionTools(sessionId, undefined, {
      signal,
    });
    const pinned = curation?.enabledTools;
    const selected = raw.filter(
      (item) =>
        !item.isDeprecated &&
        !item.slug.startsWith('COMPOSIO_') &&
        (pinned === undefined || pinned.includes(item.slug)),
    );
    // Port output is checked too: test seams cannot widen production grants.
    if (pinned !== undefined) {
      if (selected.length !== pinned.length) throw new ComposioFailure('SCOPE');
      if (new Set(selected.map((item) => item.slug)).size !== pinned.length)
        throw new ComposioFailure('SCOPE');
    }
    if (new Set(selected.map((tool) => tool.slug)).size !== selected.length)
      throw new ComposioFailure('INVALID_RESULT');
    const wrapped = this.client.provider.wrapTools(selected);
    return selected.map((source) => {
      const definition = wrapped[source.slug];
      if (definition === undefined) throw new ComposioFailure('INVALID_RESULT');
      return {
        name: source.slug,
        description: definition.description ?? '',
        inputSchema: toolInputJsonSchema(definition.inputSchema),
        readOnlyHint:
          curation?.readTools.includes(source.slug) ??
          source.tags?.includes('readOnlyHint') === true,
      };
    });
  }

  async execute(
    sessionId: string,
    accountId: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    const session = await this.client.sessions.use(sessionId, undefined, { signal });
    // 0.22.0's public Session interface omits requestOptions on execute; its
    // exported concrete session supports it. Check the instance instead of casting.
    if (!(session instanceof ToolRouterSession)) throw new ComposioFailure('SERVICE');
    const accounts = Object.values(session.config.connected_accounts ?? {});
    if (
      accounts.length !== 1 ||
      !Array.isArray(accounts[0]) ||
      accounts[0].length !== 1 ||
      accounts[0][0] !== accountId
    )
      throw new ComposioFailure('SCOPE');
    // A single-account session selects its exact connected_accounts pin. The
    // per-call account option is reserved for projects with multi-account mode
    // enabled and otherwise fails before execution, even with a valid pin.
    const result = await session.execute(name, args, undefined, { signal });
    if (result.error !== null)
      return {
        failed: true,
        data: 'The app rejected the request. Check its permissions and arguments before retrying.',
      };
    return { failed: false, data: redactResult(result.data) };
  }

  async deleteAccount(id: string, signal: AbortSignal): Promise<void> {
    await this.client.connectedAccounts.delete(id, { signal });
  }
  async deleteSession(id: string, signal: AbortSignal): Promise<void> {
    await this.client.sessions.delete(id, { signal });
  }

  async toolkits(signal: AbortSignal): Promise<CatalogToolkit[]> {
    // get() drops next_cursor in 0.22.0; the public SDK client preserves it.
    const entries = new Map<string, CatalogToolkit>();
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const page = await this.client
        .getClient()
        .toolkits.list({ limit: 1000, sort_by: 'usage', ...(cursor && { cursor }) }, { signal });
      for (const item of page.items) {
        if (
          isManagedOAuthToolkit({
            noAuth: item.no_auth,
            composioManagedAuthSchemes: item.composio_managed_auth_schemes,
          })
        )
          entries.set(item.slug, toCatalogToolkit(item));
      }
      const next = page.next_cursor;
      if (!next) return [...entries.values()];
      if (seen.has(next)) throw new ComposioFailure('SERVICE');
      seen.add(next);
      cursor = next;
    }
    throw new ComposioFailure('SERVICE');
  }

  async toolkit(slug: string, signal: AbortSignal): Promise<CatalogToolkit | null> {
    try {
      const item = await this.client.toolkits.get(slug, { signal });
      return isManagedOAuthToolkit(item) ? toCatalogToolkit(item) : null;
    } catch (error: unknown) {
      // An unknown slug is an ordinary "not in the catalog" answer; anything
      // else is a failure the caller must see.
      if (error instanceof ComposioToolkitNotFoundError || composioHttpStatus(error) === 404)
        return null;
      throw error;
    }
  }

  async ensureAuthConfig(toolkit: string, signal: AbortSignal): Promise<string> {
    let pending = this.authProvisioning.get(toolkit);
    if (pending === undefined) {
      pending = this.provisionAuthConfig(toolkit, signal).finally(() =>
        this.authProvisioning.delete(toolkit),
      );
      this.authProvisioning.set(toolkit, pending);
    }
    const id = await pending;
    signal.throwIfAborted();
    return id;
  }

  private async provisionAuthConfig(toolkit: string, signal: AbortSignal): Promise<string> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const existing = await this.client.authConfigs.list(
        {
          toolkit,
          isComposioManaged: true,
          showDisabled: false,
          limit: 100,
          ...(cursor && { cursor }),
        },
        { signal },
      );
      const managed = existing.items.find(
        (item) =>
          item.isComposioManaged === true &&
          item.status === 'ENABLED' &&
          item.authScheme === 'OAUTH2' &&
          item.toolkit.slug === toolkit,
      );
      if (managed !== undefined) return managed.id;
      const next = existing.nextCursor;
      if (!next) break;
      if (seen.has(next) || page === 19) throw new ComposioFailure('SERVICE');
      seen.add(next);
      cursor = next;
    }
    const created = await this.client.authConfigs.create(
      toolkit,
      { type: 'use_composio_managed_auth', name: `Crewaid ${toolkit}` },
      { signal },
    );
    if (
      created.authScheme !== 'OAUTH2' ||
      !created.isComposioManaged ||
      created.toolkit !== toolkit
    )
      throw new ComposioFailure('SCOPE');
    return created.id;
  }
}
