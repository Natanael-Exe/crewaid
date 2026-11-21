import { API_PREFIX, API_ROUTES, WIRE_VERSION } from '@crewaid/shared';

import { resolveRoute } from '../api/apiClient';
import type { TokenCredentials } from '../connection/wsClient';
import { t } from '../i18n/i18n';

/**
 * Where a bot's chat routes are, and what authorizes a request to them.
 *
 * The chat routes stream, so they cannot go through `ApiClient.request`, which
 * reads a whole JSON body, or `download`, which reads a whole Blob. The
 * properties D-025 actually asks for are kept: the path comes from
 * `API_ROUTES` through the same `resolveRoute` every REST call uses, the
 * credentials come from the same CC-07 bag, and every request is a `fetch`
 * carrying an `Authorization` header. `buildWsUrl` in `connection/wsClient.ts`
 * is the precedent — the WebSocket resolves its own URL from the same bag
 * for the same reason.
 *
 * Resolved once per mounted thread rather than per request: the stock SSE
 * adapter reads its URL synchronously, and a credential change already
 * reloads the window's connections.
 */
export type ChatEndpoint = {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
};

export class ChatEndpointError extends Error {}

export function chatEndpoint(credentials: TokenCredentials, botId: string): ChatEndpoint {
  const baseUrl = credentials.orchestratorBaseUrl?.trim() ?? '';
  const token = credentials.orchestratorToken?.trim() ?? '';
  if (baseUrl === '' || token === '')
    throw new ChatEndpointError(t('chat.chatEndpoint.credentialsNotConfigured'));

  const { path } = resolveRoute(API_ROUTES.bots.chat, { id: botId });
  let url: URL;
  try {
    // Resolved relatively, for the reverse-proxy subpath reason `ApiClient`
    // documents: a base of `https://host/crewaid` must keep its prefix.
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    url = new URL(`${API_PREFIX}${path}`.replace(/^\/+/, ''), base);
  } catch {
    throw new ChatEndpointError(t('chat.chatEndpoint.urlNotValid'));
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new ChatEndpointError(t('chat.chatEndpoint.urlMustUseHttp'));

  return {
    url: url.toString(),
    headers: {
      Authorization: `Bearer ${token}`,
      // Both sides state the contract they speak, so a client built
      // against another one fails plainly instead of half-parsing a stream.
      'x-crewaid-wire-version': String(WIRE_VERSION),
    },
  };
}
