import {
  API_ROUTES,
  PluginAccessSchema,
  type PluginAccess,
  ConnectMcpServerResponseSchema,
  ListMcpDirectoryResponseSchema,
  ListBotPluginsResponseSchema,
  ListMcpServersResponseSchema,
  McpServerSummarySchema,
  type ConnectMcpServerResponse,
  type InstallMcpServerBody,
  type ListMcpDirectoryResponse,
  type ListBotPluginsResponse,
  type ListMcpServersResponse,
  type McpServerSummary,
} from '@crewaid/shared';
import type { ApiClient } from './apiClient';

/**
 * REST MCP surface, and the per-bot half of it.
 *
 * NOTHING HERE RETURNS A CREDENTIAL, AND NOTHING HERE CAN. `connect`
 * answers either an authorize URL — which carries a `state` and a PKCE
 * challenge, both worthless without the verifier that stays in the database
 * — or `{connected: true}`. `McpServerSummarySchema` has no field
 * token material could travel in, which is the contract §7.3 asks for and
 * `M6-QA-11` asserts against the serialized body rather than the type.
 *
 * Why status is polled off the list route
 *
 * MCP plugins says Electron "polls `GET /mcp/servers/:id` for status". REST route
 * table has no such route — it has `GET /mcp/servers`, the list — and §0 rule 2
 * forbids inventing one. So the poll reads the list and finds the row, which
 * costs one extra array scan on a request a person is already waiting through,
 * and keeps this client honest about the endpoints that exist.
 */

export function listDirectory(client: ApiClient): Promise<ListMcpDirectoryResponse> {
  return client.request(API_ROUTES.mcp.directory, { schema: ListMcpDirectoryResponseSchema });
}

export function listServers(client: ApiClient): Promise<ListMcpServersResponse> {
  return client.request(API_ROUTES.mcp.servers, { schema: ListMcpServersResponseSchema });
}

/** Install a curated entry by slug, or a private server by URL. */
export function installServer(
  client: ApiClient,
  body: InstallMcpServerBody,
): Promise<McpServerSummary> {
  return client.request(API_ROUTES.mcp.install, { body, schema: McpServerSummarySchema });
}

/**
 * Replace a header server's bearer token.
 *
 * Write-only, like `setProviderCredential`: the answer is the server summary,
 * which has no credential field for a token to come back in. It does
 * not dial — `connectServer` is what says whether the new value works, so a
 * rotation that fails to list and a host that is briefly down stay two
 * different answers.
 */
export function setServerCredential(
  client: ApiClient,
  id: string,
  bearerToken: string,
): Promise<McpServerSummary> {
  return client.request(API_ROUTES.mcp.setCredential, {
    params: { id },
    body: { bearerToken },
    schema: McpServerSummarySchema,
  });
}

/** 204. Takes the credential, the tool cache and every bot link with it. */
export function uninstallServer(client: ApiClient, id: string): Promise<void> {
  return client.request(API_ROUTES.mcp.uninstall, { params: { id } });
}

/**
 * Start a connection.
 *
 * Two shapes come back and which one is not a preference — it is what the
 * server's `authType` allows — so the caller narrows on the response rather
 * than guessing from a status code.
 */
export function connectServer(client: ApiClient, id: string): Promise<ConnectMcpServerResponse> {
  return client.request(API_ROUTES.mcp.connect, {
    params: { id },
    schema: ConnectMcpServerResponseSchema,
  });
}

/** Re-list a connected server's tools. Also the way an ERROR row is cleared. */
export function refreshServerTools(client: ApiClient, id: string): Promise<McpServerSummary> {
  return client.request(API_ROUTES.mcp.refreshTools, {
    params: { id },
    schema: McpServerSummarySchema,
  });
}

/** Every installed server, with THIS bot's enablement on each. */
export function listBotPlugins(client: ApiClient, botId: string): Promise<ListBotPluginsResponse> {
  return client.request(API_ROUTES.bots.plugins, {
    params: { id: botId },
    schema: ListBotPluginsResponseSchema,
  });
}

/**
 * Replace the set, and read back what the bot now has.
 *
 * The whole list rather than a diff, because that is what REST body says and
 * because it is the shape a screen of checkboxes produces: the operator
 * submits the state they want, not a change nobody computed.
 */
export function setBotPlugins(
  client: ApiClient,
  botId: string,
  serverIds: readonly string[],
): Promise<ListBotPluginsResponse> {
  return client.request(API_ROUTES.bots.setPlugins, {
    params: { id: botId },
    body: { serverIds: [...serverIds] },
    schema: ListBotPluginsResponseSchema,
  });
}

/** Installation-wide access, including future bots in ALL mode. */
export function setPluginAccess(
  client: ApiClient,
  id: string,
  access: PluginAccess,
): Promise<PluginAccess> {
  return client.request(API_ROUTES.mcp.setAccess, {
    params: { id },
    body: access,
    schema: PluginAccessSchema,
  });
}
