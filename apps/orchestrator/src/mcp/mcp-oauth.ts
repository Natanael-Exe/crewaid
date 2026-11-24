import { createHash, randomBytes } from 'node:crypto';
import { API_PREFIX, MCP_OAUTH_CALLBACK_PATH } from '@crewaid/shared';
import {
  createGuardedFetch,
  EndpointRefusedError,
  parseEndpoint,
  type AddressResolver,
} from '../providers/endpoint-guard.js';

/**
 * the OAuth half of a plugin connection: where a server wants its
 * user sent, how this orchestrator registers itself as a client, and how the
 * code that comes back becomes a token.
 *
 * adds the second grant this module speaks, `refresh_token`: the same
 * exchange against the same endpoint, with a different body and no browser in
 * the loop. It does NOT re-discover anything on the way — the endpoint, the
 * client id and the resource arrive from the credential's own `authMetadata`,
 * because the servers that need refreshing are usually the private
 * ones that will not answer an unauthenticated question.
 *
 * NOTHING HERE IS `endpoint`-SHAPED BY GUESS
 *
 * Every URL below arrives from a THIRD PARTY at runtime: the resource
 * metadata, the authorization server it names, the authorization and token
 * endpoints inside that server's document. That is the same SSRF primitive
 * closed for custom model endpoints — a hostile MCP server could point
 * the orchestrator at `https://169.254.169.254/` and this process would fetch
 * it — so every hop goes through the same two checks the rest of the codebase
 * uses: `parseEndpoint` for shape (https, no credentials in the URL — actually
 * `admitEndpoint`'s shape half) and the guarded fetch for the request itself
 * (re-parsed and re-resolved per request, redirects refused). A URL that is
 * only ever handed to a browser — the authorize endpoint — is admitted by
 * shape before Electron is told to open it: it is still a URL chosen by the
 * server, and it is refused outright unless it is https with no credentials in
 * it. There is no address check on it, and there cannot be one — this process
 * never dials it, so there is nothing to re-resolve; the browser is the one
 * that connects, and what makes that trip safe is that it carries nothing but
 * a `state` and an S256 challenge, with the verifier staying here.
 *
 * Discovery is the spec's, not a convention
 *
 * The chain is the one MCP's authorization spec describes, and each step was
 * probed against the six curated OAuth servers on 2026-09-21 rather than
 * assumed:
 *
 * 1. RFC 9728 protected-resource metadata, from
 * `/.well-known/oauth-protected-resource<path>` of the server URL. All
 * six serve it, four at exactly that path and GitHub at it with the
 * trailing slash its resource has. Stripe serves it at the SAME path
 * only without the trailing slash, which is why the `WWW-Authenticate`
 * fallback below is not decoration: it is the difference between Stripe
 * connecting and Stripe reporting "no metadata".
 * 2. The fallback: one unauthenticated `initialize` — the probe every MCP
 * client sends anyway — whose 401 carries
 * `WWW-Authenticate: Bearer resource_metadata="…"`. Stripe answers that,
 * unquoted, which is why the parser takes both forms.
 * 3. RFC 8414 authorization-server metadata, at the well-known path inserted
 *      BEFORE the issuer's path (`https://access.stripe.com/.well-known/
 * oauth-authorization-server/mcp`), with OIDC discovery as the fallback.
 * 4. RFC 7591 dynamic client registration — the client is registered per
 * attempt, because this build ships no client id for anybody else's
 * authorization server. Five of the six advertise a registration
 * endpoint; GitHub does not, and GitHub is therefore REFUSED BY NAME
 * rather than attempted with a borrowed client id.
 *
 * The three things this module will not do
 *
 * It will not REGISTER a confidential client. The registration requests
 * `token_endpoint_auth_method: "none"` and refuses a response that hands back
 * a client secret, because a secret minted per connect would have to be
 * stored, and `McpCredential` holds one secret, not two. A confidential client
 * the OPERATOR registered is a different thing: its secret already
 * lives in the environment — Google's is the one Better Auth signs people in
 * with — so it is passed through to the token endpoint and never stored.
 *
 * It will not proceed without PKCE S256. A server that does not advertise it
 * is refused at connect time, with the field named — a browser error a user
 * cannot act on is worse than a refusal an operator can read.
 *
 * It will not log or return a token, a code, or a verifier. Errors carry a
 * status, an `error` and an `error_description` from the authorization
 * server's own error body — never the body itself, which for a token request
 * is where a partial success would appear.
 */

/** How long one round trip to a third party may take (the nearest budget). */
const REQUEST_TIMEOUT_MS = 25_000;

/**
 * How long the user has to finish in the browser.
 *
 * Ten minutes is a compromise with a person's actual behaviour — reading a
 * consent screen, signing in, fetching a password from somewhere — and it is
 * also the point at which the row goes back to saying DISCONNECTED, so an
 * abandoned attempt stops looking like one in progress.
 */
export const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;

/** The product name an authorization server shows on its consent screen. */
export const OAUTH_CLIENT_NAME = 'Crewaid';

/**
 * The `redirect_uri` registered with the authorization server and built into
 * the authorize URL.
 *
 * `BETTER_AUTH_URL` is the documented public origin this orchestrator is
 * reached at and what the compose example already tells operators to get
 * right — "OAuth callbacks are built from it, so a value that does not match
 * what the browser actually loaded fails as a redirect_uri mismatch at the
 * provider, not as anything Crewaid logs". Read at USE rather than at import:
 * this module is imported by tests that never build a URL, and a module-scope
 * throw would make importing the protocol a boot requirement.
 */
export function oauthCallbackUrl(): string {
  const origin = process.env['BETTER_AUTH_URL'];
  if (origin === undefined || origin === '') {
    throw new Error('BETTER_AUTH_URL is required to build the MCP OAuth callback URL');
  }
  const base = origin.replace(/\/+$/, '');
  try {
    new URL(base);
  } catch {
    throw new Error(
      `BETTER_AUTH_URL must be an absolute URL to build the MCP OAuth callback URL (got "${origin}")`,
    );
  }
  return `${base}${API_PREFIX}${MCP_OAUTH_CALLBACK_PATH}`;
}

export type McpOAuthDeps = {
  /** Test seam; production uses the guarded fetch. */
  readonly fetch?: typeof fetch;
  /** Test seam for address resolution; used only when `fetch` is not given. */
  readonly resolve?: AddressResolver;
};

/**
 * Every way this module can refuse, in one type.
 *
 * The service maps these to HTTP statuses and to the sentence it stores on the
 * server row, so the code is what a caller branches on and the message is what
 * an operator reads. Nothing here carries a token.
 */
export type McpOAuthErrorCode =
  | 'OAUTH_DISCOVERY'
  | 'OAUTH_METADATA'
  | 'OAUTH_NO_REGISTRATION'
  | 'OAUTH_REGISTRATION'
  | 'OAUTH_EXCHANGE'
  | 'OAUTH_REFRESH';

export class McpOAuthError extends Error {
  constructor(
    readonly code: McpOAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'McpOAuthError';
  }
}

/** The authorization server, resolved and checked, as connect needs it. */
export type McpOAuthEndpoints = {
  readonly issuer: string;
  readonly authorizationEndpoint: URL;
  readonly tokenEndpoint: URL;
  readonly registrationEndpoint: URL | undefined;
  /** Scopes to ask for: the resource's list, or the server's own. */
  readonly scopes: readonly string[];
};

// PKCE and state

/** 32 bytes of base64url entropy — RFC 7636's minimum is 43 characters. */
export function createCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** `BASE64URL(SHA256(verifier))` — the only challenge method this build sends. */
export function codeChallengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * The CSRF binding and the only name a callback row has.
 *
 * 32 bytes, for the same reason a session token gets them: this value is
 * handed to a third party and travels back through a browser, and it is the
 * sole authority for "which flow is this" — the address bar is not.
 */
export function createOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

// Discovery

export type McpOAuthDiscovery = McpOAuthEndpoints & {
  /** The resource metadata document's own view of the resource. */
  readonly resource: string;
};

/**
 * Walk the chain for one server URL and return what a connect needs.
 *
 * Fails with a named reason at the first link that is missing or malformed,
 * because "GitHub offers no dynamic registration" and "their well-known path
 * 404s" are different problems for whoever has to fix it.
 */
export async function discoverAuthorizationServer(
  serverUrl: string,
  deps: McpOAuthDeps = {},
): Promise<McpOAuthDiscovery> {
  const request = deps.fetch ?? createGuardedFetch(deps.resolve);
  const resource = admit(serverUrl, 'the server URL');

  const metadata = await protectedResourceMetadata(resource, request);
  const resourceName = requireString(metadata, 'resource', 'the resource metadata');
  if (!sameUrl(resourceName, resource.href)) {
    throw new McpOAuthError(
      'OAUTH_METADATA',
      `the metadata at ${resource.href} describes the resource ${resourceName} instead — ` +
        'it was not served for this server, so nothing in it can be trusted for it.',
    );
  }

  // Typed `unknown` before the narrowing, not after: `Array.isArray` widens to
  // `any[]`, and an `any` that reaches `admit` below would be a value from a
  // third party flowing into a URL without a check anybody wrote.
  const servers: unknown = metadata['authorization_servers'];
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new McpOAuthError(
      'OAUTH_METADATA',
      `${resource.href} advertises no authorization server, so there is nowhere to send the user.`,
    );
  }
  const firstLayer: unknown = servers[0];
  if (typeof firstLayer !== 'string') {
    throw new McpOAuthError(
      'OAUTH_METADATA',
      `${resource.href} lists an authorization server that is not a URL.`,
    );
  }
  // The first entry, because RFC 9728 allows several and the spec gives no
  // preference to rank — and a build that picked by a rule of its own would be
  // inventing one. A server list longer than one entry is a selection UI this
  // build does not have.
  const issuer = admit(firstLayer, 'the advertised authorization server');

  const document = await authorizationServerMetadata(issuer, request);
  return {
    resource: resource.href,
    issuer: issuer.href,
    ...readEndpoints(document, issuer),
    // The resource's own list first: it is what the server that is about to
    // receive the token asked for, and MCP's spec says to use it. The
    // authorization server's list is the fallback for a resource document
    // that names none, and no list at all means no scope parameter — a
    // server that wants one of the two will have supplied it.
    scopes: scopesFor(metadata, document),
  };
}

/**
 * The same result as `discoverAuthorizationServer`, for a server that does not
 * say where its authorization server is.
 *
 * Google's Workspace MCP servers answer `initialize` and `tools/list` without
 * a credential and serve no RFC 9728 metadata — the well-known path 404s and
 * no call ever returns a `WWW-Authenticate` challenge — so the first two links
 * of the discovery chain do not exist. The issuer and the scopes therefore
 * come from the curated entry, which is this build's own claim and was taken
 * from Google's configuration guide rather than guessed.
 *
 * Everything after that is the ordinary path, deliberately: the issuer's
 * metadata is still fetched through the guarded fetch, and `readEndpoints`
 * still refuses a document that speaks for another issuer or does not accept
 * S256. A configured issuer skips DISCOVERY, not verification.
 */
export async function discoverConfiguredAuthorizationServer(
  config: { readonly issuer: string; readonly scopes: readonly string[] },
  serverUrl: string,
  deps: McpOAuthDeps = {},
): Promise<McpOAuthDiscovery> {
  const request = deps.fetch ?? createGuardedFetch(deps.resolve);
  const resource = admit(serverUrl, 'the server URL');
  const issuer = admit(config.issuer, 'the configured authorization server');
  const document = await authorizationServerMetadata(issuer, request);
  return {
    resource: resource.href,
    issuer: issuer.href,
    ...readEndpoints(document, issuer),
    scopes: [...config.scopes],
  };
}

/** Requested scopes: the resource's, or failing that the server's own. */
function scopesFor(
  resource: Record<string, unknown>,
  server: Record<string, unknown>,
): readonly string[] {
  const fromResource = stringArray(resource['scopes_supported']);
  return fromResource.length > 0 ? fromResource : stringArray(server['scopes_supported']);
}

/** Where the resource metadata should be, then where the server says it is. */
async function protectedResourceMetadata(
  resource: URL,
  request: typeof fetch,
): Promise<Record<string, unknown>> {
  const wellKnown = new URL(
    `/.well-known/oauth-protected-resource${resource.pathname}`,
    resource.origin,
  );
  const served = await fetchMetadataDocument(wellKnown, request, 'the resource metadata');
  if (served !== undefined) return served;

  const advertised = await resourceMetadataFromChallenge(resource, request);
  if (advertised === undefined) {
    throw new McpOAuthError(
      'OAUTH_DISCOVERY',
      `${resource.href} serves no OAuth protected-resource metadata: ${wellKnown.href} ` +
        'answered without one, and an unauthenticated request to the server named no ' +
        'resource_metadata in its WWW-Authenticate header either.',
    );
  }
  const document = await fetchMetadataDocument(
    advertised,
    request,
    'the advertised resource metadata',
  );
  if (document === undefined) {
    throw new McpOAuthError(
      'OAUTH_DISCOVERY',
      `${resource.href} points at ${advertised.href} for its resource metadata, and that ` +
        'document does not exist.',
    );
  }
  return document;
}

/**
 * The 401's `WWW-Authenticate`, read for `resource_metadata`.
 *
 * The request is the initialize handshake an MCP client sends on its way to
 * being refused anyway (see mcp-directory.ts: six of the eight curated
 * servers answer 401 to exactly this). Its body is discarded unread — it is
 * the header that is the answer, and a body from a server that just refused
 * authentication is not something to buffer.
 */
async function resourceMetadataFromChallenge(
  resource: URL,
  request: typeof fetch,
): Promise<URL | undefined> {
  let response: Response;
  try {
    response = await request(resource, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'oauth-discovery',
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'crewaid', version: '1' },
        },
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    throw new McpOAuthError(
      'OAUTH_DISCOVERY',
      `${resource.href} could not be reached to discover its authorization server: ${reasonFor(error)}`,
    );
  }
  await response.body?.cancel().catch(() => undefined);

  const header = response.headers.get('www-authenticate');
  if (header === null) return undefined;
  const target = resourceMetadataUrl(header, resource);
  if (target === undefined) {
    throw new McpOAuthError(
      'OAUTH_DISCOVERY',
      `${resource.href} answered ${response.status} with a WWW-Authenticate header that ` +
        'names no usable resource_metadata URL.',
    );
  }
  return target;
}

/**
 * `resource_metadata=` out of a `WWW-Authenticate: Bearer …` challenge.
 *
 * Both the quoted form (`resource_metadata="https://…"`, Linear, Notion,
 * GitHub) and the bare one (`resource_metadata=https://…`, Stripe) are in
 * live use, and the parameter is not necessarily last.
 */
export function resourceMetadataUrl(header: string, base: URL): URL | undefined {
  const match = /\bresource_metadata\s*=\s*(?:"([^"]*)"|([^,\s]+))/i.exec(header);
  const raw = match?.[1] ?? match?.[2];
  if (raw === undefined || raw === '') return undefined;
  try {
    return new URL(raw, base);
  } catch {
    return undefined;
  }
}

/**
 * RFC 8414 metadata, at the well-known path for this issuer.
 *
 * RFC 8414 inserts the suffix before the issuer path. OIDC servers may
 * use that placement or append the suffix after the issuer path; try both.
 * A root issuer's URL.pathname is '/', but the well-known URL has no trailing
 * slash. Treating that slash as a tenant path makes ordinary root issuers 404.
 */
async function authorizationServerMetadata(
  issuer: URL,
  request: typeof fetch,
): Promise<Record<string, unknown>> {
  const issuerPath = issuer.pathname.replace(/\/+$/, '');
  const paths = new Set([
    `/.well-known/oauth-authorization-server${issuerPath}`,
    `/.well-known/openid-configuration${issuerPath}`,
    `${issuerPath}/.well-known/openid-configuration`,
  ]);
  for (const path of paths) {
    const candidate = new URL(path, issuer.origin);
    const document = await fetchMetadataDocument(
      candidate,
      request,
      'the authorization server metadata',
    );
    if (document !== undefined) return document;
  }
  throw new McpOAuthError(
    'OAUTH_DISCOVERY',
    `the authorization server ${issuer.href} serves no metadata document at any well-known ` +
      'path, so this build cannot find its authorize and token endpoints.',
  );
}

/** Validate the AS document and pull out the three endpoints. */
function readEndpoints(
  document: Record<string, unknown>,
  issuer: URL,
): {
  authorizationEndpoint: URL;
  tokenEndpoint: URL;
  registrationEndpoint: URL | undefined;
} {
  const declaredIssuer = requireString(document, 'issuer', 'the authorization server metadata');
  if (!sameUrl(declaredIssuer, issuer.href)) {
    throw new McpOAuthError(
      'OAUTH_METADATA',
      `the metadata served for ${issuer.href} declares the issuer ${declaredIssuer}. A document ` +
        'that speaks for another issuer says nothing about this one.',
    );
  }

  const responseTypes = stringArray(document['response_types_supported']);
  if (responseTypes.length > 0 && !responseTypes.includes('code')) {
    throw new McpOAuthError(
      'OAUTH_METADATA',
      `${issuer.href} supports ${responseTypes.join(', ')} but not the authorization code ` +
        'grant, which is the only one this build can complete.',
    );
  }

  const challengeMethods = stringArray(document['code_challenge_methods_supported']);
  if (!challengeMethods.includes('S256')) {
    throw new McpOAuthError(
      'OAUTH_METADATA',
      `${issuer.href} does not accept PKCE challenge method S256 ` +
        `(code_challenge_methods_supported: ${challengeMethods.length === 0 ? 'absent' : challengeMethods.join(', ')}). ` +
        'Every request this build sends carries an S256 challenge, and a code without PKCE is ' +
        'a code anyone who sees the redirect can spend.',
    );
  }

  return {
    authorizationEndpoint: admit(
      requireString(document, 'authorization_endpoint', 'the authorization server metadata'),
      'the authorization endpoint',
    ),
    tokenEndpoint: admit(
      requireString(document, 'token_endpoint', 'the authorization server metadata'),
      'the token endpoint',
    ),
    registrationEndpoint: optionalUrl(document['registration_endpoint']),
  };
}

// Registration

/**
 * RFC 7591 dynamic client registration, public client, PKCE only.
 *
 * The redirect URI is registered once and echoed back; a response that
 * registers a DIFFERENT one is refused rather than trusted, because the
 * browser is about to be told to come back to ours and a mismatch here is how
 * a code would end up delivered somewhere else.
 */
export async function registerOAuthClient(
  endpoints: McpOAuthEndpoints,
  options: { redirectUri: string; scopes: readonly string[] },
  deps: McpOAuthDeps = {},
): Promise<{ clientId: string }> {
  const registration = endpoints.registrationEndpoint;
  if (registration === undefined) {
    throw new McpOAuthError(
      'OAUTH_NO_REGISTRATION',
      `${endpoints.issuer} advertises no registration_endpoint: connecting to it needs a client ` +
        'already registered with it, and this build ships no client id for somebody else’s ' +
        'authorization server. Every other curated OAuth server registers this orchestrator ' +
        'dynamically.',
    );
  }

  const request = deps.fetch ?? createGuardedFetch(deps.resolve);
  const body: Record<string, unknown> = {
    client_name: OAUTH_CLIENT_NAME,
    redirect_uris: [options.redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
  if (options.scopes.length > 0) body['scope'] = options.scopes.join(' ');

  let response: Response;
  try {
    response = await request(registration, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    throw new McpOAuthError(
      'OAUTH_REGISTRATION',
      `registering this orchestrator with ${endpoints.issuer} failed: ${reasonFor(error)}`,
    );
  }
  if (!response.ok) {
    throw new McpOAuthError(
      'OAUTH_REGISTRATION',
      `${endpoints.issuer} refused to register a client (${response.status}).`,
    );
  }

  const document = await parseJsonObject(response, 'the registration response');
  const clientId = requireString(document, 'client_id', 'the registration response');

  const registered = document['redirect_uris'];
  if (Array.isArray(registered)) {
    const uris = stringArray(registered);
    if (uris.length !== 1 || uris[0] !== options.redirectUri) {
      throw new McpOAuthError(
        'OAUTH_REGISTRATION',
        `${endpoints.issuer} registered the redirect URI ${uris.join(', ') || '(none)'} instead of ` +
          `${options.redirectUri} — a code sent there would never reach this orchestrator.`,
      );
    }
  }

  // A secret in the response means a confidential client, which would need a
  // second encrypted column and a client_secret on every refresh.
  // Refused by name rather than dropped: silently ignoring it fails later, at
  // the token endpoint, with a message nobody can act on.
  const method = document['token_endpoint_auth_method'];
  const secret = document['client_secret'];
  if (
    (typeof secret === 'string' && secret !== '') ||
    (typeof method === 'string' && method !== 'none')
  ) {
    throw new McpOAuthError(
      'OAUTH_REGISTRATION',
      `${endpoints.issuer} registered a client that authenticates with ` +
        `"${typeof method === 'string' ? method : 'client_secret'}" instead of a public PKCE ` +
        'client. This build has nowhere to store a client secret yet.',
    );
  }

  return { clientId };
}

// The authorize URL

/**
 * The URL Electron opens in the system browser.
 *
 * `resource` is RFC 8707's resource indicator — the MCP server URL — and the
 * spec requires it on both this request and the token request so that a token
 * minted for one server is not usable at another that shares an authorization
 * server. `state` and the S256 challenge are the two values the callback
 * checks; nothing else in this URL is secret.
 */
export function buildAuthorizeUrl(
  endpoints: McpOAuthEndpoints,
  params: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    resource: string;
    /**
     * Parameters an authorization server needs beyond the spec's.
     * Google issues no refresh token without `access_type=offline`, and only
     * re-issues one after consent with `prompt=consent` — without them a
     * connection would quietly die an hour after it was made.
     */
    extra?: Readonly<Record<string, string>> | undefined;
  },
): URL {
  const url = new URL(endpoints.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', params.resource);
  if (endpoints.scopes.length > 0) url.searchParams.set('scope', endpoints.scopes.join(' '));
  // Added, never overwritten: an entry that named `state`, `redirect_uri` or
  // `code_challenge` would be replacing the three values that make a code safe
  // to pass through a browser, so a collision keeps the value set above.
  for (const [name, value] of Object.entries(params.extra ?? {})) {
    if (!url.searchParams.has(name)) url.searchParams.set(name, value);
  }
  return url;
}

// The exchange

/** A stored credential, as the token endpoint described it. */
export type McpOAuthTokens = {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  readonly expiresAt: Date | undefined;
  readonly scopes: readonly string[];
};

export type McpOAuthExchangeRequest = {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly resource: string;
  /**
   * Present only for a CONFIDENTIAL client the operator registered.
   * A dynamically registered client is public and has none.
   */
  readonly clientSecret?: string | undefined;
};

/**
 * How a redirect ended, as the flow decides it — not as a page words it.
 *
 * The refusal carries a code rather than a sentence so the copy lives in one
 * place (`mcp-oauth-callback-page.ts`) and the facts live here: what happened
 * to a flow is decided where the row is read, and what a human is told about
 * it is decided where the HTML is written. There is deliberately no status on
 * the refusal: the route answers 200 whatever happened, so that no proxy
 * between the authorization server and the person's browser can replace the
 * page with an error body of its own, and `X-Crewaid-Mcp-Connect` is the
 * channel a caller reads the verdict from.
 */
export type McpOAuthCallbackOutcome =
  | { readonly ok: true; readonly serverName: string; readonly toolCount: number }
  | {
      readonly ok: false;
      readonly code: McpOAuthCallbackRefusal;
      /** A sentence for the operator. Never contains a token, code or verifier. */
      readonly detail?: string;
    };

export type McpOAuthCallbackRefusal =
  /** The redirect was missing the parameters that make it a callback. */
  | 'invalid-request'
  /** No flow by that state: forged, replayed, superseded, or already consumed. */
  | 'unknown-state'
  /** A real flow, past its ten minutes. */
  | 'expired'
  /** The browser is signed in to a different Crewaid account than the flow's. */
  | 'other-account'
  /** The user (or the provider) declined; nothing was connected. */
  | 'denied'
  /** The code did not become a token. */
  | 'exchange-failed'
  /** The issued token could not be saved for this connection. */
  | 'storage-failed'
  /** A token was stored, but the server did not answer when listing tools. */
  | 'tools-failed';

/**
 * `grant_type=authorization_code`, with the verifier and the resource.
 *
 * The response is read for exactly four fields and the raw body is never
 * quoted into an error — this is the one response in the flow that carries a
 * live access token, and the "never logged" starts with never building the
 * string that would be logged.
 */
export async function exchangeAuthorizationCode(
  request: McpOAuthExchangeRequest,
  deps: McpOAuthDeps = {},
): Promise<McpOAuthTokens> {
  const fetchImpl = deps.fetch ?? createGuardedFetch(deps.resolve);
  const endpoint = admit(request.tokenEndpoint, 'the token endpoint');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: request.code,
    redirect_uri: request.redirectUri,
    client_id: request.clientId,
    code_verifier: request.codeVerifier,
    resource: request.resource,
  });
  // `client_secret_post`, which Google advertises alongside `_basic`. The
  // secret goes in the body of a request this function never logs, and the
  // error paths below quote only the server's `error` fields, never the body.
  if (request.clientSecret !== undefined) body.set('client_secret', request.clientSecret);

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    throw new McpOAuthError(
      'OAUTH_EXCHANGE',
      `the token endpoint ${endpoint.origin} could not be reached: ${reasonFor(error)}`,
    );
  }

  const document = await parseTokenResponse(response, endpoint, 'code exchange');

  return {
    accessToken: readBearer(document, response, endpoint),
    refreshToken: refreshTokenFrom(document),
    expiresAt: expiresAtFrom(document),
    scopes: scopesFrom(document) ?? [],
  };
}

// The refresh grant

export type McpOAuthRefreshRequest = {
  /** Where the credential's own `authMetadata` says the grant lives. */
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly resource: string;
  readonly refreshToken: string;
  /** As on the exchange: only for a client the operator registered. */
  readonly clientSecret?: string | undefined;
};

/**
 * A refreshed grant, as the token endpoint described it.
 *
 * THREE OF THESE FIELDS ARE `undefined` FOR A REASON THAT IS NOT "EMPTY",
 * and folding any of them into an empty value loses a fact RFC 6749 states:
 *
 *  - `refreshToken` absent means the server did NOT rotate — the stored one is
 *    still the grant, and writing `null` over it would strand the credential.
 *  - `expiresAt` absent means the server named no lifetime. The stale
 *    timestamp from the old token is not a substitute.
 *  - `scopes` absent means "the scope of the original grant", so the caller
 *    keeps what it already stored rather than replacing it with nothing.
 */
export type McpOAuthRefreshedTokens = {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  readonly expiresAt: Date | undefined;
  readonly scopes: readonly string[] | undefined;
};

/**
 * `grant_type=refresh_token`, without a verifier or a redirect.
 *
 * The endpoint, the client id and the resource are the three things the
 * connect flow learned and the credential kept (`authMetadata`, D-103) —
 * there is no discovery here on purpose. A token that has to be refreshed is
 * usually a credential whose server will not answer an unauthenticated
 * request, so asking it where its token endpoint is would be asking the one
 * question the expired token cannot authorize.
 *
 * The response body is never quoted into an error. This is the second of the
 * two responses in this module that carry a live token, and the "never
 * logged" starts with never building the string that would be logged.
 */
export async function refreshAccessToken(
  request: McpOAuthRefreshRequest,
  deps: McpOAuthDeps = {},
): Promise<McpOAuthRefreshedTokens> {
  const fetchImpl = deps.fetch ?? createGuardedFetch(deps.resolve);
  const endpoint = admit(request.tokenEndpoint, 'the token endpoint');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: request.refreshToken,
    client_id: request.clientId,
    resource: request.resource,
  });
  if (request.clientSecret !== undefined) body.set('client_secret', request.clientSecret);

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    throw new McpOAuthError(
      'OAUTH_REFRESH',
      `the token endpoint ${endpoint.origin} could not be reached to refresh: ${reasonFor(error)}`,
    );
  }

  const document = await parseTokenResponse(response, endpoint, 'refresh', 'OAUTH_REFRESH');

  return {
    accessToken: readBearer(document, response, endpoint, 'OAUTH_REFRESH'),
    refreshToken: refreshTokenFrom(document),
    expiresAt: expiresAtFrom(document),
    scopes: scopesFrom(document),
  };
}

// Shared plumbing

/** The shape half of D-085, with the field named in the refusal. */
function admit(raw: string, what: string): URL {
  try {
    return parseEndpoint(raw);
  } catch (error: unknown) {
    if (error instanceof EndpointRefusedError) {
      throw new McpOAuthError('OAUTH_METADATA', `${what} is not usable: ${error.message}`);
    }
    throw error;
  }
}

function optionalUrl(value: unknown): URL | undefined {
  return typeof value === 'string' && value !== ''
    ? admit(value, 'the registration endpoint')
    : undefined;
}

/**
 * A metadata document, or undefined when it is simply not there.
 *
 * A 404 is "not served here" and belongs to the caller's fallback chain. Every
 * other non-2xx is an answer — a 500 from the well-known path is not a reason
 * to ask a different question.
 */
async function fetchMetadataDocument(
  url: URL,
  request: typeof fetch,
  what: string,
): Promise<Record<string, unknown> | undefined> {
  let response: Response;
  try {
    response = await request(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    throw new McpOAuthError(
      'OAUTH_DISCOVERY',
      `${what} at ${url.href} could not be read: ${reasonFor(error)}`,
    );
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new McpOAuthError(
      'OAUTH_DISCOVERY',
      `${what} at ${url.href} answered ${response.status}.`,
    );
  }
  return parseJsonObject(response, `${what} at ${url.href}`);
}

/** JSON in, or a named refusal — never the body, which may carry a token. */
async function parseJsonObject(response: Response, what: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new McpOAuthError(
      'OAUTH_METADATA',
      `${what} is not a JSON object (content-type ${response.headers.get('content-type') ?? 'absent'}).`,
    );
  }
}

/**
 * A token response — JSON, or the form encoding RFC 6749's own example used
 * and some servers still send. Refusals quote only the standard `error` and
 * `error_description` fields.
 *
 * Both grants share this because they share the response format and the
 * refusal rule. `what` and `code` are parameters so "refused the refresh"
 * cannot be reported as "refused the code exchange": an operator reading
 * `lastError` needs to know which of the two failed, and the one that failed
 * for a server the user cannot re-authorize is the interesting one.
 */
async function parseTokenResponse(
  response: Response,
  endpoint: URL,
  what: string,
  code: McpOAuthErrorCode = 'OAUTH_EXCHANGE',
): Promise<Record<string, unknown>> {
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';

  let document: Record<string, unknown>;
  if (contentType.includes('application/x-www-form-urlencoded')) {
    document = Object.fromEntries(new URLSearchParams(text));
  } else {
    try {
      const parsed: unknown = JSON.parse(text);
      document =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
    } catch {
      document = {};
    }
  }

  if (response.ok) return document;

  const described = [document['error'], document['error_description']]
    .filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    .join(': ');
  throw new McpOAuthError(
    code,
    `${endpoint.origin} refused the ${what} (${response.status})${described === '' ? '' : `: ${described}`}.`,
  );
}

/**
 * The access token, or a refusal — the two checks every grant makes.
 *
 * Shared rather than duplicated so a response this build cannot present is
 * refused identically whichever grant produced it: a token that is not a
 * Bearer is one this client cannot send, and `DPoP` needs a proof header per
 * request that nothing here mints. A missing `token_type` defaults to Bearer
 * per RFC 6749 §7.1.
 */
function readBearer(
  document: Record<string, unknown>,
  response: Response,
  endpoint: URL,
  code: McpOAuthErrorCode = 'OAUTH_EXCHANGE',
): string {
  const accessToken = document['access_token'];
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new McpOAuthError(
      code,
      `${endpoint.origin} answered ${response.status} without an access token.`,
    );
  }

  const tokenType = document['token_type'];
  if (typeof tokenType === 'string' && tokenType.toLowerCase() !== 'bearer') {
    throw new McpOAuthError(
      code,
      `${endpoint.origin} issued a "${tokenType}" token, and this build can only present a Bearer one.`,
    );
  }
  return accessToken;
}

/**
 * `expires_in`, as an absolute instant, or `undefined` when the server named
 * no usable lifetime.
 *
 * A numeric string is decoded rather than discarded: PR #253's review found a
 * real server sending `"expires_in": "3600"`, and a credential that lost its
 * expiry to a JSON serializer looks exactly like one that never had one —
 * which is the difference between refreshing ahead of time and finding out
 * from a 401.
 */
function expiresAtFrom(document: Record<string, unknown>): Date | undefined {
  const raw = document['expires_in'];
  const seconds = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? new Date(Date.now() + seconds * 1000)
    : undefined;
}

/** `scope`, space-delimited per RFC 6749 §5.1, or undefined when not named. */
function scopesFrom(document: Record<string, unknown>): string[] | undefined {
  const scope = document['scope'];
  return typeof scope === 'string'
    ? scope.split(/[\s,]+/).filter((entry) => entry !== '')
    : undefined;
}

/** A rotated refresh token, or undefined — which means "keep the stored one". */
function refreshTokenFrom(document: Record<string, unknown>): string | undefined {
  const refreshToken = document['refresh_token'];
  return typeof refreshToken === 'string' && refreshToken !== '' ? refreshToken : undefined;
}

function requireString(document: Record<string, unknown>, field: string, what: string): string {
  const value = document[field];
  if (typeof value !== 'string' || value === '') {
    throw new McpOAuthError('OAUTH_METADATA', `${what} has no usable "${field}".`);
  }
  return value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** Trailing slashes are not a difference: `https://a/mcp` and `https://a/mcp/` are one resource. */
function sameUrl(left: string, right: string): boolean {
  const strip = (value: string): string => value.replace(/\/+$/, '');
  try {
    return strip(new URL(left).href) === strip(new URL(right).href);
  } catch {
    return false;
  }
}

/** One line for an operator, without ever echoing a body. */
function reasonFor(error: unknown): string {
  if (error instanceof McpOAuthError) return error.message;
  if (error instanceof Error) {
    return error.cause instanceof Error
      ? `${error.message}: ${error.cause.message}`
      : error.message;
  }
  return String(error);
}
