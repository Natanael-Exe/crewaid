import { BadRequestException } from '@nestjs/common';
import type { McpAuthType, McpDirectoryEntry, McpTransport } from '@crewaid/shared';
import type { ComposioService } from '../integrations/composio/composio.service.js';
import {
  admitEndpoint,
  EndpointRefusedError,
  parseEndpoint,
  type AddressResolver,
} from '../providers/endpoint-guard.js';
import { collidingBuiltinTool } from './mcp-namespace.js';
import { deriveMcpSlug } from './mcp-slug.js';

/**
 * the curated plugin directory, and the only place a catalog entry
 * is written down.
 *
 * Why this is a constant and not a table
 *
 * REST calls `GET /mcp/directory` a "curated catalog", which is a statement
 * about who owns the list: us, in a review, not an operator and not a row
 * somebody upserts at runtime. A `McpDirectoryEntry` table would need a seed
 * migration for every addition, would reach production through a different
 * deployment path than the code that reads it ( rule — schema and code
 * deploy together or not at all), and would make "which plugins ship in this
 * build?" a question you answer by querying a database. A frozen array
 * answers it by reading this file.
 *
 * What is in an entry, and what is not
 *
 * `url` and `transport` are here because installing an entry needs them, and
 * they are deliberately NOT part of `McpDirectoryEntrySchema` (REST fixes that
 * shape at name/slug/category/icon/auth type, and `toDirectoryEntry` is the
 * one-way door between the two). Nothing is hidden by that: the client is
 * handed an entry it may install by slug, and the endpoint an install opens is
 * ours to resolve server-side.
 *
 * `iconUrl` is null for every entry rather than a favicon guessed from the
 * host. An icon URL is a claim that an image renders at that address, and this
 * build has verified none — a broken icon in the modal is a small lie that
 * costs a user's trust in the rest of the card. A null renders as the entry's
 * initial and is honest about being a placeholder.
 *
 * The urls were probed, not guessed
 *
 * Every entry below was called on 2026-09-21 with a JSON-RPC
 * `server/discover` (and, where discovery is unsupported, `initialize`), over
 * `POST` with `accept: application/json, text/event-stream`:
 *
 * - `mcp.deepwiki.com/mcp` and `mcp.context7.com/mcp` answer 200
 * `text/event-stream` unauthenticated — deepwiki completes `initialize`
 * and lists tools, context7 is a legacy-only server. Both are `NONE`.
 * - the remaining six answer 401 without an `Authorization` header, which is
 * what `OAUTH2` means here: connect them through flow first.
 *
 * The twenty-four entries added on 2026-09-22 were probed the same
 * way, with `initialize` over `POST`. A 401 is a PASS and not a failure: every
 * one of them answered with `WWW-Authenticate: Bearer`, most carrying
 * `resource_metadata` pointing at `/.well-known/oauth-protected-resource`,
 * which is the MCP auth spec's own discovery and is what distinguishes a real
 * MCP endpoint from a host that 401s everything. Shopify is the exception and
 * the only `NONE` among them: it completed `initialize` unauthenticated and
 * named itself `shopify-mcp-server`.
 *
 * Gmail, Google Calendar and Google Drive were added on 2026-09-22
 * after an earlier probe had missed them: it tried `mcp.gmail.com`, and
 * Google's servers are at `<product>mcp.googleapis.com/mcp/v1`. All three
 * complete `initialize` AND `tools/list` without a credential — only a
 * `tools/call` needs one — and serve no RFC 9728 metadata, which is why they
 * are the entries that carry an `oauth` block.
 *
 * ⚠️ SIX REQUESTED SERVICES ARE DELIBERATELY ABSENT, because probing found no
 * vendor-hosted remote endpoint: OneDrive (no MCP host answers), 1Password
 * and Clay (404 / no such host),
 * Mobbin (no such host), AWS Core (awslabs' servers are stdio, and v1 is
 * remote-only) and Atlassian Forge (covered by the Atlassian
 * entry rather than a separate endpoint). Guessing a URL for any of them is
 * exactly what the paragraph above exists to prevent.
 *
 * A directory entry is a claim about somebody else's server, and one that 404s
 * makes the whole modal look broken. Re-probe when adding an entry; nothing in
 * the build can do it for us without turning a unit test into a network call.
 */

/** One curated entry, as the installer needs it. */
export type CuratedMcpServer = {
  readonly name: string;
  /** The namespace MCP plugins gives this server's tools: `<slug>__<toolName>`. */
  readonly slug: string;
  readonly category: string;
  readonly iconUrl: string | null;
  readonly authType: McpAuthType;
  /** The endpoint an install opens. Never on the wire as an `iconUrl`'s peer. */
  readonly url: string;
  readonly transport: McpTransport;
  /**
   * An authorization server this build NAMES rather than discovers.
   *
   * Absent for servers that accept dynamic client registration. GitHub requires
   * a registered OAuth client; Google's
   * Workspace servers do neither: they answer `tools/list` unauthenticated,
   * never challenge, and its authorization server has no registration
   * endpoint. So the entry carries what discovery would have found, and the
   * client comes from an app registration the operator already has.
   *
   * Server-side only: `toDirectoryEntry` copies fields one by one, so none of
   * this reaches the wire — and the environment variables it names are
   * looked up here, never sent.
   */
  readonly oauth?: CuratedOAuthConfig;
};

/** A curated authorization server whose client the administrator registers. */
export type CuratedOAuthConfig = {
  readonly issuer: string;
  /** Verbatim from the vendor's configuration guide, not a guess at least privilege. */
  readonly scopes: readonly string[];
  /** Parameters the authorization server needs beyond the spec's. */
  readonly authorizeParams?: Readonly<Record<string, string>>;
  /**
   * The environment variables holding the operator's client — registered for this integration. Google can share its sign-in registration;
   * GitHub shares the sign-in app with an additional plugin callback.
   */
  readonly clientEnv: { readonly id: string; readonly secret: string };
  /** What the operator enables in their cloud console, named in the refusal. */
  readonly api: string;
};

/**
 * Google's Workspace servers, sharing one configuration apart from scopes.
 *
 * `access_type=offline` because Google issues no refresh token without it, and
 * `prompt=consent` because it only re-issues one on a fresh consent — without
 * both, a connection would quietly stop working an hour after it was made.
 * `select_account` rides beside it because otherwise Google goes straight to
 * whichever account the browser is signed into, and the inbox a bot gets would
 * be decided by the browser rather than by the person connecting it.
 */
function googleWorkspace(scopes: readonly string[], api: string): CuratedOAuthConfig {
  return {
    issuer: 'https://accounts.google.com',
    scopes,
    authorizeParams: { access_type: 'offline', prompt: 'select_account consent' },
    clientEnv: { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' },
    api,
  };
}

/**
 * The catalog: the entries this build ships, in the order they were probed
 * (see below). It happens to be grouped by `category`, but it is not sorted by
 * it, and REST fixes an entry's FIELDS rather than the order of this array —
 * the modal does its own grouping and sorting, so a client that wants an order
 * should impose one rather than read this array as one.
 *
 * Frozen rather than merely `readonly`, because the array is reachable by
 * reference from every request and a module that reordered it once would
 * reorder it for every later reader of the same process.
 */
export const CURATED_MCP_SERVERS: readonly CuratedMcpServer[] = Object.freeze([
  {
    name: 'Context7',
    slug: 'context7',
    category: 'Documentation',
    iconUrl: null,
    authType: 'NONE',
    url: 'https://mcp.context7.com/mcp',
    transport: 'HTTP',
  },
  {
    name: 'DeepWiki',
    slug: 'deepwiki',
    category: 'Documentation',
    iconUrl: null,
    authType: 'NONE',
    url: 'https://mcp.deepwiki.com/mcp',
    transport: 'HTTP',
  },
  {
    name: 'GitHub',
    slug: 'github',
    category: 'Developer Tools',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://api.githubcopilot.com/mcp/',
    transport: 'HTTP',
    oauth: {
      issuer: 'https://github.com/login/oauth',
      scopes: ['repo', 'read:org', 'workflow', 'offline_access'],
      authorizeParams: { prompt: 'select_account' },
      clientEnv: { id: 'GITHUB_CLIENT_ID', secret: 'GITHUB_CLIENT_SECRET' },
      api: 'GitHub OAuth app',
    },
  },
  {
    name: 'Linear',
    slug: 'linear',
    category: 'Project Management',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.linear.app/mcp',
    transport: 'HTTP',
  },
  {
    name: 'Neon',
    slug: 'neon',
    category: 'Databases',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.neon.tech/mcp',
    transport: 'HTTP',
  },
  {
    name: 'Notion',
    slug: 'notion',
    category: 'Knowledge Base',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.notion.com/mcp',
    transport: 'HTTP',
  },
  {
    name: 'Sentry',
    slug: 'sentry',
    category: 'Monitoring',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.sentry.dev/mcp',
    transport: 'HTTP',
  },
  {
    name: 'Stripe',
    slug: 'stripe',
    category: 'Payments',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.stripe.com/',
    transport: 'HTTP',
  },
  {
    name: 'Airtable',
    slug: 'airtable',
    category: 'Productivity',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.airtable.com/mcp',
    transport: 'HTTP',
  },
  {
    name: 'Asana',
    slug: 'asana',
    category: 'Project Management',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.asana.com/sse',
    transport: 'SSE',
  },
  {
    name: 'Atlassian',
    slug: 'atlassian',
    category: 'Project Management',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.atlassian.com/v1/mcp',
    transport: 'HTTP',
  },
  {
    name: 'Monday.com',
    slug: 'monday',
    category: 'Project Management',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.monday.com/mcp',
    transport: 'HTTP',
  },
  {
    name: 'Miro',
    slug: 'miro',
    category: 'Design',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.miro.com/mcp',
    transport: 'HTTP',
  },
  {
    name: 'Canva',
    slug: 'canva',
    category: 'Design',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.canva.com/mcp',
    transport: 'HTTP',
  },
  {
    name: 'Runway',
    slug: 'runway',
    category: 'Design',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.runwayml.com/mcp',
    transport: 'HTTP',
  },
  {
    name: 'Sanity',
    slug: 'sanity',
    category: 'Knowledge Base',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.sanity.io/mcp',
    transport: 'HTTP',
  },
  {
    name: 'Typeform',
    slug: 'typeform',
    category: 'Productivity',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://api.typeform.com/mcp',
    transport: 'HTTP',
  },
  {
    name: 'Otter.ai',
    slug: 'otter',
    category: 'Productivity',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.otter.ai/mcp',
    transport: 'HTTP',
  },
  {
    name: 'Apollo',
    slug: 'apollo',
    category: 'Sales & CRM',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.apollo.io/mcp',
    transport: 'HTTP',
  },
  {
    name: 'Attio',
    slug: 'attio',
    category: 'Sales & CRM',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.attio.com/mcp',
    transport: 'HTTP',
  },
  {
    name: 'Intercom',
    slug: 'intercom',
    category: 'Sales & CRM',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.intercom.com/mcp',
    transport: 'HTTP',
  },
  {
    name: 'Resend',
    slug: 'resend',
    category: 'Marketing',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.resend.com/mcp',
    transport: 'HTTP',
  },
  {
    name: 'MailerLite',
    slug: 'mailerlite',
    category: 'Marketing',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.mailerlite.com/mcp',
    transport: 'HTTP',
  },
  {
    name: 'PostHog',
    slug: 'posthog',
    category: 'Analytics',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.posthog.com/mcp',
    transport: 'HTTP',
  },
  {
    name: 'Mixpanel',
    slug: 'mixpanel',
    category: 'Analytics',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.mixpanel.com/mcp',
    transport: 'HTTP',
  },
  {
    name: 'Amplitude',
    slug: 'amplitude',
    category: 'Analytics',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.amplitude.com/mcp',
    transport: 'HTTP',
  },
  {
    name: 'Similarweb',
    slug: 'similarweb',
    category: 'Analytics',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.similarweb.com/mcp',
    transport: 'HTTP',
  },
  {
    name: 'Semrush',
    slug: 'semrush',
    category: 'Analytics',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.semrush.com/v2/mcp',
    transport: 'HTTP',
  },
  {
    name: 'Ahrefs',
    slug: 'ahrefs',
    category: 'Analytics',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://api.ahrefs.com/mcp/mcp',
    transport: 'HTTP',
  },
  {
    name: 'Apify',
    slug: 'apify',
    category: 'Developer Tools',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.apify.com',
    transport: 'HTTP',
  },
  {
    name: 'Shopify',
    slug: 'shopify',
    category: 'Payments',
    iconUrl: null,
    authType: 'NONE',
    url: 'https://setup.shopify.com/mcp',
    transport: 'HTTP',
  },
  {
    name: 'Mercury',
    slug: 'mercury',
    category: 'Payments',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://mcp.mercury.com/mcp',
    transport: 'HTTP',
  },
  {
    name: 'Google Drive',
    slug: 'google-drive',
    category: 'Productivity',
    iconUrl: null,
    authType: 'OAUTH2',
    url: 'https://drivemcp.googleapis.com/mcp/v1',
    transport: 'HTTP',
    oauth: googleWorkspace(
      [
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/drive.file',
      ],
      'Google Drive API',
    ),
  },
]);

/**
 * The entry a `{slug}` install names, or undefined.
 *
 * A lookup rather than an index built at module load: the array is a few dozen
 * entries, and a Map here would be a second structure to keep in step with it.
 */
export function findCuratedMcpServer(slug: string): CuratedMcpServer | undefined {
  return CURATED_MCP_SERVERS.find((server) => server.slug === slug);
}

/**
 * Entry → the REST wire shape. The ONLY way a curated entry becomes a response.
 *
 * Explicit field by field rather than a spread with `url`/`transport` deleted:
 * a new internal field on `CuratedMcpServer` is then a compile error here (the
 * returned type lacks a property the spread would have included) instead of a
 * value that silently ships to every client.
 */
export function toDirectoryEntry(server: CuratedMcpServer): McpDirectoryEntry {
  return {
    name: server.name,
    slug: server.slug,
    category: server.category,
    iconUrl: server.iconUrl,
    authType: server.authType,
  };
}

/**
 * Merges the live Composio catalog with curated direct-MCP entries.
 * Curated entries win slug collisions so an install by slug always resolves
 * to the vetted direct-MCP endpoint.
 */
export async function listDirectory(
  composio: Pick<ComposioService, 'directory'>,
): Promise<McpDirectoryEntry[]> {
  const [composioEntries, curated] = await Promise.all([
    composio.directory(),
    Promise.resolve(CURATED_MCP_SERVERS.map(toDirectoryEntry)),
  ]);
  const curatedSlugs = new Set(curated.map((entry) => entry.slug));
  return [...composioEntries.filter((entry) => !curatedSlugs.has(entry.slug)), ...curated];
}

/**
 * Resolves a directory install by slug without performing DNS I/O for curated
 * URLs (which are re-verified at connect/refresh time by the guarded fetch).
 */
export async function fromDirectory(slug: string, composio: Pick<ComposioService, 'installation'>) {
  const entry = findCuratedMcpServer(slug);
  if (entry !== undefined) {
    return {
      backend: 'DIRECT' as const,
      name: entry.name,
      slug: entry.slug,
      category: entry.category,
      iconUrl: entry.iconUrl,
      transport: entry.transport,
      url: admitShape(entry.url),
      isPrivate: false,
      authType: entry.authType,
    };
  }
  const integration = await composio.installation(slug);
  if (integration !== undefined) return integration;
  throw new BadRequestException(
    `"${slug}" is not in the plugin directory — read GET /mcp/directory for the slugs ` +
      'this deployment offers, or install a private server by URL.',
  );
}

/**
 * Validates an operator-supplied private MCP server URL against SSRF rules
 * before persisting any row, and derives its tool namespace slug.
 */
export async function fromPrivate(
  body: {
    name: string;
    url: string;
    transport: 'HTTP' | 'SSE';
    bearerToken?: string | undefined;
  },
  resolver?: AddressResolver,
) {
  let url: string;
  try {
    url = (await admitEndpoint(body.url, resolver)).toString();
  } catch (error: unknown) {
    if (error instanceof EndpointRefusedError) throw new BadRequestException(error.message);
    throw error;
  }

  const name = body.name.trim();
  const slug = deriveMcpSlug(name);
  if (slug === null) {
    throw new BadRequestException(
      `"${body.name}" yields no usable tool namespace — every MCP tool is named ` +
        '<server>__<tool>, so a name has to produce a slug of 1–64 characters that starts ' +
        'with a letter and uses only letters, digits and dashes: "Café Inc" becomes ' +
        '"cafe-inc", and "42 App" does not, because a slug cannot start with a digit.',
    );
  }

  return {
    backend: 'DIRECT' as const,
    name,
    slug,
    category: null,
    iconUrl: null,
    transport: body.transport,
    url,
    isPrivate: true,
    authType: body.bearerToken === undefined ? ('NONE' as const) : ('HEADER' as const),
  };
}

/** Rejects a server slug that would collide with any registered built-in tool prefix. */
export function refuseBuiltinCollision(slug: string, builtinToolNames: readonly string[]): void {
  const collides = collidingBuiltinTool(slug, builtinToolNames);
  if (collides === undefined) return;
  throw new BadRequestException(
    `"${slug}" is the namespace this build's own "${collides}" tool already uses — every ` +
      `tool from this server would be named ${slug}__something, which every bot would read ` +
      `beside "${collides}" and have to tell apart by an underscore. Install it under a ` +
      'different name.',
  );
}

/** Shape-only admission for curated URLs shipped with this build. */
function admitShape(raw: string): string {
  try {
    return parseEndpoint(raw).toString();
  } catch (error: unknown) {
    if (error instanceof EndpointRefusedError) {
      throw new Error(`curated MCP server URL is not admissible: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}
