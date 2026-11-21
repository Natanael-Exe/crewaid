import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl,
  codeChallengeFor,
  createCodeVerifier,
  createOAuthState,
  discoverAuthorizationServer,
  exchangeAuthorizationCode,
  McpOAuthError,
  oauthCallbackUrl,
  OAUTH_CLIENT_NAME,
  refreshAccessToken,
  registerOAuthClient,
  resourceMetadataUrl,
} from '../src/mcp/mcp-oauth.js';

/**
 * M6-BE-03 — the OAuth protocol layer, against a fetch that answers whatever
 * the case is about.
 *
 * ── WHAT THIS SUITE IS, AND WHAT IT IS NOT ─────────────────────────────────
 *
 * No socket, no database, no Nest: every request this module makes goes to a
 * stub `fetch`, so what is under test is exactly the part that decides what to
 * ASK and what to BELIEVE. That is where the third-party-shaped failures live
 * — a metadata document served for somebody else's resource, an authorization
 * server with no registration endpoint (GitHub), a registration that hands
 * back a client secret, a token response that says `token_type: "DPoP"` — and
 * every one of them is cheaper to write here than to reach through a live
 * flow. The suite at `mcp-oauth.integration.test.ts` is the other half: the
 * same protocol with a real socket, a real redirect, and real rows.
 *
 * ── THE SHAPES ARE THE ONES THE SERVERS ACTUALLY SERVE ─────────────────────
 *
 * The fixtures below are not invented: the trailing-slash split (Stripe
 * serves `/.well-known/oauth-protected-resource` while the spec's insertion
 * point is `/.well-known/oauth-protected-resource<path>`), the unquoted
 * `resource_metadata=` parameter, and the issuer with a path (`/mcp`, which
 * moves the well-known suffix in front of it) were each read off the six
 * curated servers on 2026-09-21. A fixture that is tidier than the wire would
 * have made this suite agree with a bug.
 *
 * Needs no environment: `https://` URLs are admitted by SHAPE here, so
 * nothing resolves and nothing connects.
 */

type Recorded = {
  readonly method: string;
  readonly url: string;
  readonly body: string | undefined;
  readonly headers: Headers;
};

const recorded: Recorded[] = [];
const routes = new Map<string, (request: Request) => Response | Promise<Response>>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function route(
  method: string,
  url: string,
  handler: (request: Request) => Response | Promise<Response>,
): void {
  routes.set(`${method} ${url}`, handler);
}

/** `GET` a metadata path, or 404 when the case did not put anything there. */
function routeMetadata(url: string, document: unknown): void {
  route('GET', url, () => json(document));
}

const stubFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const body = init?.body === undefined ? undefined : String(init.body);
  recorded.push({ method: request.method, url: request.url, body, headers: request.headers });
  const handler = routes.get(`${request.method} ${request.url}`);
  if (handler === undefined) return new Response('not found', { status: 404 });
  return handler(request);
};

const deps = { fetch: stubFetch };

const RESOURCE = 'https://mcp.example.test/mcp';
const RESOURCE_METADATA = 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp';
const ISSUER = 'https://auth.example.test/tenant';
const AS_METADATA = 'https://auth.example.test/.well-known/oauth-authorization-server/tenant';
const AUTHORIZE = 'https://auth.example.test/tenant/authorize';
const TOKEN = 'https://auth.example.test/tenant/token';
const REGISTER = 'https://auth.example.test/tenant/register';

const RESOURCE_DOCUMENT = {
  resource: RESOURCE,
  authorization_servers: [ISSUER],
  scopes_supported: ['read', 'write'],
};

const SERVER_DOCUMENT = {
  issuer: ISSUER,
  authorization_endpoint: AUTHORIZE,
  token_endpoint: TOKEN,
  registration_endpoint: REGISTER,
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
  scopes_supported: ['read'],
};

/** The happy path's four documents, each overridable per case. */
function happyPath(overrides: {
  resource?: Record<string, unknown>;
  server?: Record<string, unknown>;
}): void {
  routeMetadata(RESOURCE_METADATA, { ...RESOURCE_DOCUMENT, ...overrides.resource });
  routeMetadata(AS_METADATA, { ...SERVER_DOCUMENT, ...overrides.server });
}

async function refusalOf(promise: Promise<unknown>): Promise<McpOAuthError> {
  try {
    await promise;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(McpOAuthError);
    return error as McpOAuthError;
  }
  throw new Error('expected the call to refuse, and it resolved');
}

beforeEach(() => {
  recorded.length = 0;
  routes.clear();
});

afterEach(() => {
  routes.clear();
});

describe('discovery', () => {
  it('reads the protected-resource document, then the authorization server it names', async () => {
    happyPath({});

    const discovery = await discoverAuthorizationServer(RESOURCE, deps);

    expect(discovery.resource).toBe(RESOURCE);
    expect(discovery.issuer).toBe(ISSUER);
    expect(discovery.authorizationEndpoint.href).toBe(AUTHORIZE);
    expect(discovery.tokenEndpoint.href).toBe(TOKEN);
    expect(discovery.registrationEndpoint?.href).toBe(REGISTER);
    // The resource's own list wins: it is what the server that will receive
    // the token asked for, and MCP's spec says to use it.
    expect(discovery.scopes).toEqual(['read', 'write']);
    expect(recorded.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      `GET ${RESOURCE_METADATA}`,
      `GET ${AS_METADATA}`,
    ]);
  });

  it.each(['oauth-authorization-server', 'openid-configuration'])(
    'discovers a root issuer at /.well-known/%s without a trailing slash',
    async (suffix) => {
      const issuer = 'https://auth.example.test';
      happyPath({ resource: { authorization_servers: [issuer] } });
      routeMetadata(`${issuer}/.well-known/${suffix}`, { ...SERVER_DOCUMENT, issuer });
      const discovery = await discoverAuthorizationServer(RESOURCE, deps);
      expect(discovery.tokenEndpoint.href).toBe(TOKEN);
      expect(recorded.some((entry) => entry.url.endsWith(`${suffix}/`))).toBe(false);
    },
  );

  it('tries OIDC path appending after both insertion paths are absent', async () => {
    happyPath({});
    routes.delete(`GET ${AS_METADATA}`);
    routeMetadata(`${ISSUER}/.well-known/openid-configuration`, SERVER_DOCUMENT);
    const discovery = await discoverAuthorizationServer(RESOURCE, deps);
    expect(discovery.tokenEndpoint.href).toBe(TOKEN);
    expect(recorded.slice(1).map((entry) => entry.url)).toEqual([
      AS_METADATA,
      'https://auth.example.test/.well-known/openid-configuration/tenant',
      `${ISSUER}/.well-known/openid-configuration`,
    ]);
  });

  it('treats a trailing slash as the same resource', async () => {
    // Two curated servers disagree with themselves about the trailing slash:
    // the row holds one spelling and the protected-resource document names the
    // other. The comparison normalizes it, and the value reported back is the
    // ADMITTED server URL — what this orchestrator will dial — not the
    // document's spelling of it.
    happyPath({ resource: { resource: `${RESOURCE}/` } });

    const discovery = await discoverAuthorizationServer(RESOURCE, deps);
    expect(discovery.resource).toBe(RESOURCE);
    expect(discovery.issuer).toBe(ISSUER);
  });

  it('falls back to scopes_supported on the authorization server', async () => {
    happyPath({ resource: { scopes_supported: undefined } });

    const discovery = await discoverAuthorizationServer(RESOURCE, deps);
    expect(discovery.scopes).toEqual(['read']);
  });

  it('asks for no scope when neither document lists one', async () => {
    happyPath({
      resource: { scopes_supported: undefined },
      server: { scopes_supported: undefined },
    });

    const discovery = await discoverAuthorizationServer(RESOURCE, deps);
    expect(discovery.scopes).toEqual([]);

    const url = buildAuthorizeUrl(discovery, {
      clientId: 'client-1',
      redirectUri: 'https://orchestrator.example.test/api/v1/mcp/oauth/callback',
      state: 'state-1',
      codeChallenge: 'challenge-1',
      resource: discovery.resource,
    });
    expect(url.searchParams.has('scope')).toBe(false);
  });

  /**
   * The Stripe shape, end to end: the well-known path the SPEC names is not
   * served (Stripe's document is at the same path without the resource's
   * trailing slash), the 401 carries the URL unquoted, and the authorization
   * server's issuer has a path — so the RFC 8414 suffix goes in FRONT of it.
   */
  it('takes the 401 challenge when the well-known path answers 404', async () => {
    const resource = 'https://mcp.stripe.test/';
    const advertised = 'https://mcp.stripe.test/.well-known/oauth-protected-resource';
    const issuer = 'https://access.stripe.test/mcp';

    route('POST', resource, () => {
      const body = JSON.stringify({
        error: 'invalid_token',
        error_description: 'No access token provided',
      });
      return new Response(body, {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'www-authenticate': `Bearer resource_metadata=${advertised}`,
        },
      });
    });
    routeMetadata(advertised, {
      resource,
      authorization_servers: [issuer],
      scopes_supported: ['payment_intents.read'],
    });
    routeMetadata('https://access.stripe.test/.well-known/oauth-authorization-server/mcp', {
      ...SERVER_DOCUMENT,
      issuer,
      authorization_endpoint: 'https://access.stripe.test/mcp/authorize',
      token_endpoint: 'https://access.stripe.test/mcp/token',
      registration_endpoint: 'https://access.stripe.test/mcp/register',
    });

    const discovery = await discoverAuthorizationServer(resource, deps);

    expect(discovery.issuer).toBe(issuer);
    expect(discovery.tokenEndpoint.href).toBe('https://access.stripe.test/mcp/token');
    expect(discovery.scopes).toEqual(['payment_intents.read']);
    // The challenge probe is the initialize handshake, and it is a POST.
    const probe = recorded.filter((entry) => entry.method === 'POST');
    expect(probe).toHaveLength(1);
    expect(probe[0]?.url).toBe(resource);
  });

  it('refuses a document that describes a different resource', async () => {
    // The metadata IS served, just for somebody else — which is the case a
    // 200-status check would call success.
    happyPath({ resource: { resource: 'https://somewhere.else.test/mcp' } });

    const error = await refusalOf(discoverAuthorizationServer(RESOURCE, deps));
    expect(error.code).toBe('OAUTH_METADATA');
    expect(error.message).toContain('describes the resource https://somewhere.else.test/mcp');
  });

  it('refuses a resource document that names no authorization server', async () => {
    happyPath({ resource: { authorization_servers: [] } });

    const error = await refusalOf(discoverAuthorizationServer(RESOURCE, deps));
    expect(error.code).toBe('OAUTH_METADATA');
    expect(error.message).toContain('advertises no authorization server');
    // The document was trusted enough to read, and that is what it said the
    // problem is: not a discovery failure, an empty answer.
    expect(recorded).toHaveLength(1);
  });

  it('refuses when neither the well-known path nor the 401 challenge helps', async () => {
    route('POST', RESOURCE, () => new Response('unauthorized', { status: 401 }));

    const error = await refusalOf(discoverAuthorizationServer(RESOURCE, deps));
    expect(error.code).toBe('OAUTH_DISCOVERY');
    expect(error.message).toContain('serves no OAuth protected-resource metadata');
    // Both spellings of the question were asked.
    expect(recorded.map((entry) => entry.method)).toEqual(['GET', 'POST']);
  });

  it('refuses when the challenge names a metadata document that does not exist', async () => {
    route('POST', RESOURCE, () => {
      return new Response('unauthorized', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp.example.test/gone"' },
      });
    });

    const error = await refusalOf(discoverAuthorizationServer(RESOURCE, deps));
    expect(error.code).toBe('OAUTH_DISCOVERY');
    expect(error.message).toContain('points at https://mcp.example.test/gone');
  });

  it('refuses an authorization server that serves no metadata at any well-known path', async () => {
    happyPath({});
    routes.delete(`GET ${AS_METADATA}`);

    const error = await refusalOf(discoverAuthorizationServer(RESOURCE, deps));
    expect(error.code).toBe('OAUTH_DISCOVERY');
    expect(error.message).toContain('serves no metadata document at any well-known path');
    // Both placements were tried before giving up.
    expect(recorded.some((entry) => entry.url.includes('/openid-configuration/tenant'))).toBe(true);
  });

  it('refuses a non-https endpoint inside a trusted document', async () => {
    // The document is served over https and is otherwise perfect; the URL it
    // names for the token is not. Shape admission is what catches it, because
    // a document is data, not a witness.
    happyPath({ server: { token_endpoint: 'http://auth.example.test/tenant/token' } });

    const error = await refusalOf(discoverAuthorizationServer(RESOURCE, deps));
    expect(error.code).toBe('OAUTH_METADATA');
    expect(error.message).toContain('the token endpoint is not usable');
    expect(error.message).toContain('must use https');
  });

  it('refuses a server that does not advertise PKCE S256', async () => {
    happyPath({ server: { code_challenge_methods_supported: ['plain'] } });

    const error = await refusalOf(discoverAuthorizationServer(RESOURCE, deps));
    expect(error.code).toBe('OAUTH_METADATA');
    expect(error.message).toContain('does not accept PKCE challenge method S256');
    expect(error.message).toContain('plain');
  });

  it('names an absent code_challenge_methods_supported as absent', async () => {
    happyPath({ server: { code_challenge_methods_supported: undefined } });

    const error = await refusalOf(discoverAuthorizationServer(RESOURCE, deps));
    expect(error.message).toContain('code_challenge_methods_supported: absent');
  });

  it('refuses a document whose issuer is not the one that was asked', async () => {
    happyPath({ server: { issuer: 'https://auth.other.test/tenant' } });

    const error = await refusalOf(discoverAuthorizationServer(RESOURCE, deps));
    expect(error.code).toBe('OAUTH_METADATA');
    expect(error.message).toContain('declares the issuer https://auth.other.test/tenant');
  });

  it('refuses a server that cannot complete an authorization code grant', async () => {
    happyPath({ server: { response_types_supported: ['token'] } });

    const error = await refusalOf(discoverAuthorizationServer(RESOURCE, deps));
    expect(error.message).toContain('but not the authorization code');
  });
});

describe('resourceMetadataUrl', () => {
  const base = new URL('https://mcp.example.test/mcp');

  it.each([
    [
      'quoted, and not the last parameter',
      'Bearer realm="mcp", resource_metadata="https://a.test/.well-known/oauth-protected-resource", error="invalid_token"',
      'https://a.test/.well-known/oauth-protected-resource',
    ],
    [
      'unquoted, as Stripe sends it',
      'Bearer resource_metadata=https://a.test/meta',
      'https://a.test/meta',
    ],
    [
      'relative, resolved against the resource',
      'Bearer resource_metadata="/meta"',
      'https://mcp.example.test/meta',
    ],
  ])('reads the URL when it is %s', (_name, header, expected) => {
    expect(resourceMetadataUrl(header, base)?.href).toBe(expected);
  });

  it.each([
    ['no parameter at all', 'Bearer realm="mcp"'],
    ['an empty value', 'Bearer resource_metadata=""'],
    ['an unparseable value', 'Bearer resource_metadata="http://["'],
  ])('returns nothing for %s', (_name, header) => {
    expect(resourceMetadataUrl(header, base)).toBeUndefined();
  });
});

describe('dynamic client registration', () => {
  const endpoints = {
    issuer: ISSUER,
    authorizationEndpoint: new URL(AUTHORIZE),
    tokenEndpoint: new URL(TOKEN),
    registrationEndpoint: new URL(REGISTER),
    scopes: ['read'],
  };
  const redirectUri = 'https://orchestrator.example.test/api/v1/mcp/oauth/callback';

  it('registers a public PKCE client and returns its id', async () => {
    route('POST', REGISTER, () =>
      json({
        client_id: 'client-abc',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
      }),
    );

    const { clientId } = await registerOAuthClient(
      endpoints,
      { redirectUri, scopes: ['read'] },
      deps,
    );

    expect(clientId).toBe('client-abc');
    const body = JSON.parse(recorded[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body['client_name']).toBe(OAUTH_CLIENT_NAME);
    expect(body['redirect_uris']).toEqual([redirectUri]);
    expect(body['grant_types']).toEqual(['authorization_code', 'refresh_token']);
    expect(body['response_types']).toEqual(['code']);
    // The whole decision in one field: a CONFIDENTIAL client would need a
    // second secret column, which this build does not have (M6-BE-04).
    expect(body['token_endpoint_auth_method']).toBe('none');
    expect(body['scope']).toBe('read');
  });

  it('refuses an authorization server with no registration endpoint, naming it', async () => {
    // GitHub, exactly: valid metadata, no way to register a client, and this
    // build ships no client id for somebody else's authorization server.
    const error = await refusalOf(
      registerOAuthClient(
        { ...endpoints, registrationEndpoint: undefined },
        { redirectUri, scopes: [] },
        deps,
      ),
    );

    expect(error.code).toBe('OAUTH_NO_REGISTRATION');
    expect(error.message).toContain('advertises no registration_endpoint');
    // Nothing was dialled: the refusal is decided from the document.
    expect(recorded).toEqual([]);
  });

  it('refuses a registration that hands back a client secret', async () => {
    route('POST', REGISTER, () =>
      json({ client_id: 'client-abc', client_secret: 'shhh', redirect_uris: [redirectUri] }),
    );

    const error = await refusalOf(
      registerOAuthClient(endpoints, { redirectUri, scopes: [] }, deps),
    );
    expect(error.code).toBe('OAUTH_REGISTRATION');
    expect(error.message).toContain('nowhere to store a client secret');
  });

  it('refuses a non-public token_endpoint_auth_method even without a secret', async () => {
    route('POST', REGISTER, () =>
      json({
        client_id: 'client-abc',
        token_endpoint_auth_method: 'client_secret_basic',
        redirect_uris: [redirectUri],
      }),
    );

    const error = await refusalOf(
      registerOAuthClient(endpoints, { redirectUri, scopes: [] }, deps),
    );
    expect(error.message).toContain('"client_secret_basic"');
  });

  it('refuses a registration that echoed a different redirect_uri', async () => {
    route('POST', REGISTER, () =>
      json({ client_id: 'client-abc', redirect_uris: ['https://attacker.test/callback'] }),
    );

    const error = await refusalOf(
      registerOAuthClient(endpoints, { redirectUri, scopes: [] }, deps),
    );
    expect(error.message).toContain('instead of');
  });

  it('refuses a registration the server rejected', async () => {
    route('POST', REGISTER, () => json({ error: 'invalid_redirect_uri' }, 400));

    const error = await refusalOf(
      registerOAuthClient(endpoints, { redirectUri, scopes: [] }, deps),
    );
    expect(error.code).toBe('OAUTH_REGISTRATION');
    expect(error.message).toContain('refused to register a client (400)');
  });
});

describe('the authorize URL', () => {
  it('carries PKCE, the state, and the RFC 8707 resource indicator', () => {
    const url = buildAuthorizeUrl(
      {
        issuer: ISSUER,
        authorizationEndpoint: new URL(AUTHORIZE),
        tokenEndpoint: new URL(TOKEN),
        registrationEndpoint: undefined,
        scopes: ['read', 'write'],
      },
      {
        clientId: 'client-abc',
        redirectUri: 'https://orchestrator.example.test/api/v1/mcp/oauth/callback',
        state: 'state-abc',
        codeChallenge: 'challenge-abc',
        resource: RESOURCE,
      },
    );

    expect(url.origin + url.pathname).toBe(AUTHORIZE);
    const params = url.searchParams;
    expect(params.get('response_type')).toBe('code');
    expect(params.get('client_id')).toBe('client-abc');
    expect(params.get('redirect_uri')).toBe(
      'https://orchestrator.example.test/api/v1/mcp/oauth/callback',
    );
    expect(params.get('state')).toBe('state-abc');
    expect(params.get('code_challenge')).toBe('challenge-abc');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('resource')).toBe(RESOURCE);
    expect(params.get('scope')).toBe('read write');
  });

  it('keeps a query the authorization endpoint already had', () => {
    const url = buildAuthorizeUrl(
      {
        issuer: ISSUER,
        authorizationEndpoint: new URL(`${AUTHORIZE}?tenant=hint`),
        tokenEndpoint: new URL(TOKEN),
        registrationEndpoint: undefined,
        scopes: [],
      },
      {
        clientId: 'c',
        redirectUri: 'https://orchestrator.example.test/cb',
        state: 's',
        codeChallenge: 'k',
        resource: RESOURCE,
      },
    );
    expect(url.searchParams.get('tenant')).toBe('hint');
  });
});

describe('the verifier and the state', () => {
  it('mints a verifier whose S256 challenge matches RFC 7636', () => {
    const verifier = createCodeVerifier();
    // The one published test vector, so the encoding is checked against the
    // spec rather than against this implementation.
    expect(codeChallengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('mints a distinct state each time', () => {
    const states = new Set(Array.from({ length: 20 }, () => createOAuthState()));
    expect(states.size).toBe(20);
  });
});

describe('the code exchange', () => {
  const request = {
    tokenEndpoint: TOKEN,
    clientId: 'client-abc',
    redirectUri: 'https://orchestrator.example.test/api/v1/mcp/oauth/callback',
    code: 'code-abc',
    codeVerifier: 'verifier-abc',
    resource: RESOURCE,
  };

  it('sends the code, the verifier and the resource, and reads the token', async () => {
    route('POST', TOKEN, () =>
      json({
        access_token: 'tok_live_000',
        refresh_token: 'ref_live_000',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'read write',
      }),
    );

    const before = Date.now();
    const tokens = await exchangeAuthorizationCode(request, deps);

    expect(tokens.accessToken).toBe('tok_live_000');
    expect(tokens.refreshToken).toBe('ref_live_000');
    expect(tokens.scopes).toEqual(['read', 'write']);
    expect(tokens.expiresAt).toBeInstanceOf(Date);
    // `expiresAt` is now + expires_in, and `now` is read a moment after
    // `before` was captured, so the difference is within a few milliseconds of
    // the hour rather than exactly it.
    const lifetime = (tokens.expiresAt?.getTime() ?? 0) - before;
    expect(Math.abs(lifetime - 3_600_000)).toBeLessThan(5_000);

    const sent = recorded[0];
    expect(sent?.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(sent?.body ?? '');
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('code-abc');
    expect(form.get('code_verifier')).toBe('verifier-abc');
    expect(form.get('client_id')).toBe('client-abc');
    expect(form.get('redirect_uri')).toBe(request.redirectUri);
    expect(form.get('resource')).toBe(RESOURCE);
  });

  it('accepts a form-encoded token response, which some servers still send', async () => {
    route(
      'POST',
      TOKEN,
      () =>
        new Response('access_token=tok_form&token_type=bearer&expires_in=60', {
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        }),
    );

    const tokens = await exchangeAuthorizationCode(request, deps);
    expect(tokens.accessToken).toBe('tok_form');
    expect((tokens.expiresAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(55_000);
    expect(tokens.refreshToken).toBeUndefined();
    expect(tokens.scopes).toEqual([]);
  });

  it('quotes only the error fields the standard defines', async () => {
    route('POST', TOKEN, () =>
      json(
        {
          error: 'invalid_grant',
          error_description: 'The code has expired',
          access_token: 'tok_must_never_appear',
        },
        400,
      ),
    );

    const error = await refusalOf(exchangeAuthorizationCode(request, deps));
    expect(error.code).toBe('OAUTH_EXCHANGE');
    expect(error.message).toContain('invalid_grant: The code has expired');
    // §7.3: a partial success is exactly what must not be quoted into a
    // string that reaches `lastError` and the user's screen.
    expect(error.message).not.toContain('tok_must_never_appear');
  });

  it('refuses a 200 that carries no access token', async () => {
    route('POST', TOKEN, () => json({ token_type: 'Bearer' }));

    const error = await refusalOf(exchangeAuthorizationCode(request, deps));
    expect(error.message).toContain('without an access token');
  });

  it('refuses a token this build cannot present', async () => {
    route('POST', TOKEN, () => json({ access_token: 'tok', token_type: 'DPoP' }));

    const error = await refusalOf(exchangeAuthorizationCode(request, deps));
    expect(error.message).toContain('issued a "DPoP" token');
  });

  it('refuses a token endpoint that is not https', async () => {
    // The URL comes from the flow row, which was written from a document that
    // was checked — this is the second, request-time check of the same fact.
    const error = await refusalOf(
      exchangeAuthorizationCode(
        { ...request, tokenEndpoint: 'http://auth.example.test/token' },
        deps,
      ),
    );
    expect(error.code).toBe('OAUTH_METADATA');
    expect(error.message).toContain('must use https');
    expect(recorded).toEqual([]);
  });
});

describe('the refresh grant (M6-BE-05)', () => {
  const base = {
    tokenEndpoint: TOKEN,
    clientId: 'client-abc',
    resource: RESOURCE,
    refreshToken: 'ref_stored_000',
  };

  it('sends the grant with no verifier and no redirect, and reads the new token', async () => {
    route('POST', TOKEN, () =>
      json({
        access_token: 'tok_renewed_000',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    );

    const before = Date.now();
    const tokens = await refreshAccessToken(base, deps);

    expect(tokens.accessToken).toBe('tok_renewed_000');
    // Absent, NOT empty: the server did not rotate, so the stored grant is
    // still the one to use and writing null over it would strand the row.
    expect(tokens.refreshToken).toBeUndefined();
    expect((tokens.expiresAt?.getTime() ?? 0) - before).toBeGreaterThan(3_590_000);

    const sent = recorded[0];
    expect(sent?.method).toBe('POST');
    expect(sent?.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(sent?.body ?? '');
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('ref_stored_000');
    expect(form.get('client_id')).toBe('client-abc');
    expect(form.get('resource')).toBe(RESOURCE);
    // A refresh has no code and no verifier to prove anything with.
    expect(form.get('code')).toBeNull();
    expect(form.get('code_verifier')).toBeNull();
    expect(form.get('redirect_uri')).toBeNull();
  });

  it('carries a rotated refresh token through, and a named scope with it', async () => {
    route('POST', TOKEN, () =>
      json({
        access_token: 'tok_renewed_001',
        refresh_token: 'ref_rotated_001',
        token_type: 'Bearer',
        expires_in: 60,
        scope: 'issues.read',
      }),
    );

    const tokens = await refreshAccessToken(base, deps);
    expect(tokens.refreshToken).toBe('ref_rotated_001');
    expect(tokens.scopes).toEqual(['issues.read']);
  });

  it('leaves the scope undefined when the server does not name one', async () => {
    // RFC 6749 §6: an omitted `scope` means "the scope of the original grant".
    // Reporting `[]` here would silently narrow a credential to nothing.
    route('POST', TOKEN, () => json({ access_token: 'tok_renewed_002' }));

    const tokens = await refreshAccessToken(base, deps);
    expect(tokens.scopes).toBeUndefined();
    expect(tokens.expiresAt).toBeUndefined();
  });

  it('accepts a form-encoded refresh response, numeric string and all', async () => {
    route(
      'POST',
      TOKEN,
      () =>
        new Response(
          'access_token=tok_form_000&token_type=bearer&expires_in=120&refresh_token=ref_form_000',
          { headers: { 'content-type': 'application/x-www-form-urlencoded' } },
        ),
    );

    const tokens = await refreshAccessToken(base, deps);
    expect(tokens.accessToken).toBe('tok_form_000');
    expect(tokens.refreshToken).toBe('ref_form_000');
    expect((tokens.expiresAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(110_000);
  });

  it('names the refresh as the thing that was refused, never the body', async () => {
    route('POST', TOKEN, () =>
      json(
        {
          error: 'invalid_grant',
          error_description: 'the grant was revoked',
          access_token: 'tok_must_never_appear',
        },
        400,
      ),
    );

    const error = await refusalOf(refreshAccessToken(base, deps));
    expect(error.code).toBe('OAUTH_REFRESH');
    expect(error.message).toContain('refused the refresh (400)');
    expect(error.message).toContain('invalid_grant: the grant was revoked');
    expect(error.message).not.toContain('tok_must_never_appear');
    expect(error.message).not.toContain('ref_stored_000');
  });

  it('refuses a 200 that carries no access token', async () => {
    route('POST', TOKEN, () => json({ token_type: 'Bearer' }));

    const error = await refusalOf(refreshAccessToken(base, deps));
    expect(error.code).toBe('OAUTH_REFRESH');
    expect(error.message).toContain('without an access token');
  });

  it('refuses a token this build cannot present', async () => {
    route('POST', TOKEN, () => json({ access_token: 'tok', token_type: 'DPoP' }));
    const error = await refusalOf(refreshAccessToken(base, deps));
    expect(error.code).toBe('OAUTH_REFRESH');
    expect(error.message).toContain('issued a "DPoP" token');
  });

  it('reports an endpoint it could not reach as a refresh failure', async () => {
    route('POST', 'https://unreachable.example.test/token', () => {
      throw new Error('connect ECONNREFUSED');
    });
    const unreachable = await refusalOf(
      refreshAccessToken(
        { ...base, tokenEndpoint: 'https://unreachable.example.test/token' },
        deps,
      ),
    );
    expect(unreachable.code).toBe('OAUTH_REFRESH');
    expect(unreachable.message).toContain('could not be reached');
  });

  it('refuses a token endpoint that is not https, without dialling it', async () => {
    recorded.length = 0;
    const error = await refusalOf(
      refreshAccessToken({ ...base, tokenEndpoint: 'http://auth.example.test/token' }, deps),
    );
    expect(error.code).toBe('OAUTH_METADATA');
    expect(error.message).toContain('must use https');
    expect(recorded).toEqual([]);
  });
});

describe('oauthCallbackUrl', () => {
  const original = process.env['BETTER_AUTH_URL'];

  afterEach(() => {
    if (original === undefined) delete process.env['BETTER_AUTH_URL'];
    else process.env['BETTER_AUTH_URL'] = original;
  });

  it('is the public origin plus the §4.1 path, read at use', () => {
    process.env['BETTER_AUTH_URL'] = 'https://crewaid.example.test';
    expect(oauthCallbackUrl()).toBe('https://crewaid.example.test/api/v1/mcp/oauth/callback');
  });

  it('does not double the slash on an origin that has one', () => {
    process.env['BETTER_AUTH_URL'] = 'https://crewaid.example.test/';
    expect(oauthCallbackUrl()).toBe('https://crewaid.example.test/api/v1/mcp/oauth/callback');
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['not a URL', 'crewaid.example.test'],
  ])('refuses to guess when BETTER_AUTH_URL is %s', (_name, value) => {
    if (value === undefined) delete process.env['BETTER_AUTH_URL'];
    else process.env['BETTER_AUTH_URL'] = value;

    expect(() => oauthCallbackUrl()).toThrow(/BETTER_AUTH_URL/);
  });
});
