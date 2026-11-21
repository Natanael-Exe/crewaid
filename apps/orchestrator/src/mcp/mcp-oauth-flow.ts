import { BadGatewayException, ConflictException } from '@nestjs/common';
import type { McpServer } from '@prisma/client';
import type { McpServerSummary as WireServer } from '@crewaid/shared';
import { KeyringConfigError } from '../credentials/keyring.js';
import { parseMcpCredentialKey } from '../credentials/mcp-keyring.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { McpConnectionDeps } from './mcp-connection.js';
import { findCuratedMcpServer, type CuratedOAuthConfig } from './mcp-directory.js';
import { bounded, describeFailure, isMissingRow, isSerializationConflict } from './mcp-helpers.js';
import {
  buildAuthorizeUrl,
  codeChallengeFor,
  createCodeVerifier,
  createOAuthState,
  discoverAuthorizationServer,
  discoverConfiguredAuthorizationServer,
  exchangeAuthorizationCode,
  oauthCallbackUrl,
  OAUTH_FLOW_TTL_MS,
  refreshAccessToken,
  registerOAuthClient,
  type McpOAuthCallbackOutcome,
  type McpOAuthDiscovery,
  type McpOAuthRefreshedTokens,
  type McpOAuthTokens,
} from './mcp-oauth.js';

/** A safe refusal carried out of the credential transaction before status is written. */
export class McpRefreshRefusedError extends Error {}

export type RefreshableCredential = {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: Date | null;
  readonly scopes: readonly string[];
  readonly authMetadata: {
    readonly tokenEndpoint: string;
    readonly clientId: string;
    readonly resource: string;
  } | null;
};

export type OAuthFlowPrisma = Pick<PrismaService, '$transaction' | 'mcpOAuthFlow' | 'mcpServer'>;

export type OAuthFlowDeps = {
  readonly connectionDeps: McpConnectionDeps;
  readonly recordConnectFailure: (server: McpServer, message: string) => Promise<void>;
};

export type OAuthCallbackCredential = {
  readonly userId: string;
  readonly serverId: string;
  readonly accessToken: string;
  readonly refreshToken?: string | undefined;
  readonly expiresAt?: Date | undefined;
  readonly scopes: readonly string[];
  readonly authMetadata: {
    readonly tokenEndpoint: string;
    readonly clientId: string;
    readonly resource: string;
  };
};

export type OAuthCallbackDeps = OAuthFlowDeps & {
  readonly storeCredential: (input: OAuthCallbackCredential) => Promise<void>;
  readonly refreshTools: (userId: string, serverId: string) => Promise<WireServer>;
};

/**
 * Returns curated OAuth configuration only for non-private catalog entries so
 * operator-named private installs can never inherit a curated client secret.
 */
export function configuredOAuth(server: {
  readonly isPrivate: boolean;
  readonly slug: string;
}): CuratedOAuthConfig | undefined {
  if (server.isPrivate) return undefined;
  return findCuratedMcpServer(server.slug)?.oauth;
}

/** Reads the operator OAuth client credentials from env at use time, returning undefined if either is blank. */
export function operatorClientOf(
  config: CuratedOAuthConfig,
): { readonly clientId: string; readonly clientSecret: string } | undefined {
  const clientId = process.env[config.clientEnv.id]?.trim() ?? '';
  const clientSecret = process.env[config.clientEnv.secret]?.trim() ?? '';
  return clientId === '' || clientSecret === '' ? undefined : { clientId, clientSecret };
}

/**
 * Returns the operator client secret only when the server is curated and the
 * stored clientId matches the currently configured operator client.
 */
export function clientSecretFor(
  server: { readonly isPrivate: boolean; readonly slug: string },
  clientId: string,
): string | undefined {
  const configured = configuredOAuth(server);
  if (configured === undefined) return undefined;
  const client = operatorClientOf(configured);
  return client !== undefined && client.clientId === clientId ? client.clientSecret : undefined;
}

/**
 * Exchanges a stored refresh grant for a renewed token payload, preserving the
 * existing refresh token and scopes when the authorization server omits them.
 */
export async function renewOAuthCredential(
  server: { readonly isPrivate: boolean; readonly slug: string },
  credential: RefreshableCredential,
  connectionDeps: McpConnectionDeps,
): Promise<
  RefreshableCredential & {
    readonly authMetadata: NonNullable<RefreshableCredential['authMetadata']>;
  }
> {
  const metadata = credential.authMetadata;
  if (metadata === null || credential.refreshToken === null) {
    throw new McpRefreshRefusedError(
      metadata === null
        ? 'no refresh coordinates were recorded for it, so the grant cannot be renewed here'
        : 'the authorization server issued it no refresh token',
    );
  }

  let tokens: McpOAuthRefreshedTokens;
  try {
    tokens = await refreshAccessToken(
      {
        tokenEndpoint: metadata.tokenEndpoint,
        clientId: metadata.clientId,
        resource: metadata.resource,
        refreshToken: credential.refreshToken,
        clientSecret: clientSecretFor(server, metadata.clientId),
      },
      connectionDeps,
    );
  } catch (error: unknown) {
    throw new McpRefreshRefusedError(
      `the authorization server refused to refresh it (${describeFailure(error)})`,
    );
  }

  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? credential.refreshToken,
    expiresAt: tokens.expiresAt ?? null,
    scopes: tokens.scopes ?? credential.scopes,
    authMetadata: metadata,
  };
}

/**
 * Performs OAuth discovery/registration and persists state + PKCE verifier
 * before redirecting the browser. Leaves `server.status` unchanged so an
 * abandoned attempt cannot demote an already-connected credential.
 */
export async function beginOAuthConnect(
  prisma: Pick<PrismaService, '$transaction' | 'mcpOAuthFlow'>,
  server: McpServer,
  deps: OAuthFlowDeps,
): Promise<string> {
  if (server.backend !== 'DIRECT' || server.url === null || server.transport === null)
    throw new ConflictException('This app does not use direct OAuth discovery.');
  // Fail before sending someone through consent when storage is misconfigured.
  parseMcpCredentialKey();
  const redirectUri = oauthCallbackUrl();
  const state = createOAuthState();
  const codeVerifier = createCodeVerifier();

  const configured = configuredOAuth(server);
  const operatorClient = configured === undefined ? undefined : operatorClientOf(configured);
  if (configured !== undefined && operatorClient === undefined) {
    const message =
      `it signs in through an OAuth app you register, and ${configured.clientEnv.id} / ` +
      `${configured.clientEnv.secret} are not set. Register the ${configured.api} with ` +
      `${redirectUri} as its callback, set both variables, and restart the orchestrator.`;
    await deps.recordConnectFailure(server, message);
    throw new ConflictException(`"${server.name}" cannot be connected yet — ${message}`);
  }

  let discovery: McpOAuthDiscovery;
  let clientId: string;
  try {
    if (configured !== undefined && operatorClient !== undefined) {
      discovery = await discoverConfiguredAuthorizationServer(
        configured,
        server.url,
        deps.connectionDeps,
      );
      clientId = operatorClient.clientId;
    } else {
      discovery = await discoverAuthorizationServer(server.url, deps.connectionDeps);
      ({ clientId } = await registerOAuthClient(
        discovery,
        { redirectUri, scopes: discovery.scopes },
        deps.connectionDeps,
      ));
    }
  } catch (error: unknown) {
    const message = describeFailure(error);
    await deps.recordConnectFailure(server, message);
    throw new BadGatewayException(`"${server.name}" could not be connected: ${message}`);
  }

  const authorizeUrl = buildAuthorizeUrl(discovery, {
    clientId,
    redirectUri,
    state,
    codeChallenge: codeChallengeFor(codeVerifier),
    resource: discovery.resource,
    extra: configured?.authorizeParams,
  });

  // Serializable isolation prevents concurrent Connect clicks from leaving
  // multiple active flows for the same server across processes.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await prisma.$transaction(
        [
          prisma.mcpOAuthFlow.deleteMany({ where: { serverId: server.id } }),
          prisma.mcpOAuthFlow.deleteMany({
            where: { expiresAt: { lt: new Date() }, server: { userId: server.userId } },
          }),
          prisma.mcpOAuthFlow.create({
            data: {
              state,
              serverId: server.id,
              codeVerifier,
              clientId,
              redirectUri,
              tokenEndpoint: discovery.tokenEndpoint.href,
              resource: discovery.resource,
              scopes: [...discovery.scopes],
              expiresAt: new Date(Date.now() + OAUTH_FLOW_TTL_MS),
            },
          }),
        ],
        { isolationLevel: 'Serializable' },
      );
      break;
    } catch (error: unknown) {
      if (attempt >= 4 || !isSerializationConflict(error)) throw error;
    }
  }

  return authorizeUrl.href;
}

/**
 * Redeems the single-use OAuth callback state, exchanges the authorization code,
 * stores the resulting credential via the caller's seam, and refreshes tools.
 */
export async function completeOAuthCallback(
  prisma: Pick<PrismaService, 'mcpOAuthFlow' | 'mcpServer'>,
  query: Record<string, unknown>,
  browserUserId: string | null,
  deps: OAuthCallbackDeps,
): Promise<McpOAuthCallbackOutcome> {
  const state = asString(query['state']);
  if (state === undefined) {
    return {
      ok: false,
      code: 'invalid-request',
      detail: 'The redirect carried no state parameter.',
    };
  }

  const flow = await prisma.mcpOAuthFlow.delete({ where: { state } }).catch((error: unknown) => {
    if (isMissingRow(error)) return null;
    throw error;
  });
  if (flow === null) return { ok: false, code: 'unknown-state' };
  if (flow.expiresAt.getTime() <= Date.now()) return { ok: false, code: 'expired' };

  const server = await prisma.mcpServer.findUnique({ where: { id: flow.serverId } });
  if (server === null) return { ok: false, code: 'unknown-state' };

  // Refuse when the approving browser is signed in as a different user.
  if (browserUserId !== null && browserUserId !== server.userId) {
    return { ok: false, code: 'other-account' };
  }

  const denial = refusalText(query['error'], query['error_description']);
  if (denial !== undefined) {
    await deps.recordConnectFailure(
      server,
      `the authorization server refused the request: ${denial}`,
    );
    return { ok: false, code: 'denied', detail: denial };
  }

  const code = asString(query['code']);
  if (code === undefined) {
    return {
      ok: false,
      code: 'invalid-request',
      detail: 'The redirect carried no code.',
    };
  }

  let tokens: McpOAuthTokens;
  try {
    tokens = await exchangeAuthorizationCode(
      {
        tokenEndpoint: flow.tokenEndpoint,
        clientId: flow.clientId,
        redirectUri: flow.redirectUri,
        code,
        codeVerifier: flow.codeVerifier,
        resource: flow.resource,
        clientSecret: clientSecretFor(server, flow.clientId),
      },
      deps.connectionDeps,
    );
  } catch (error: unknown) {
    const message = describeFailure(error);
    await deps.recordConnectFailure(server, message);
    return { ok: false, code: 'exchange-failed', detail: message };
  }

  try {
    await deps.storeCredential({
      userId: server.userId,
      serverId: server.id,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      authMetadata: {
        tokenEndpoint: flow.tokenEndpoint,
        clientId: flow.clientId,
        resource: flow.resource,
      },
    });
  } catch (error: unknown) {
    // Prisma errors can include write arguments; surface only safe configuration errors.
    const message =
      error instanceof KeyringConfigError
        ? error.message
        : 'The credential could not be saved. Start Connect again from Crewaid.';
    await deps.recordConnectFailure(server, message);
    return { ok: false, code: 'storage-failed', detail: message };
  }

  try {
    const summary = await deps.refreshTools(server.userId, server.id);
    return { ok: true, serverName: summary.name, toolCount: summary.toolCount };
  } catch (error: unknown) {
    return { ok: false, code: 'tools-failed', detail: describeFailure(error) };
  }
}

/** Rejects duplicate/empty query parameters so arrays are never coerced into strings. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Formats RFC 6749 `error` and `error_description` into one bounded sentence. */
function refusalText(error: unknown, description: unknown): string | undefined {
  const code = asString(error);
  if (code === undefined) return undefined;
  const detail = asString(description);
  return bounded(detail === undefined ? code : `${code}: ${detail}`);
}
