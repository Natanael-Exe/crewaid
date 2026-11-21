import { API_ROUTES, ScreenGrantResponseSchema, type ScreenGrantResponse } from '@crewaid/shared';
import type { ApiClient } from './apiClient';

/**
 * A grant to open one stream of a bot's desktop (`screen-stream.ts`). Asked
 * for on every connection, never cached: the ticket in it opens one stream
 * once, and the orchestrator refuses it for a computer that is not running.
 */
export function requestScreenGrant(client: ApiClient, botId: string): Promise<ScreenGrantResponse> {
  return client.request(API_ROUTES.bots.screenGrant, {
    params: { id: botId },
    schema: ScreenGrantResponseSchema,
  });
}
