import {
  API_ROUTES,
  ListModelOptionsResponseSchema,
  type ListModelOptionsResponse,
} from '@crewaid/shared';
import type { ApiClient } from './apiClient';

/**
 * `GET /models` — the picker's source of truth (D-086, replacing D-003).
 *
 * The list is now derived from the SIGNED-IN USER's provider connections
 * rather than from a catalog compiled into the orchestrator. It is still not a
 * live fan-out to three providers' model endpoints, so this remains a cheap
 * call and the client still does no caching of its own.
 *
 * `defaultModelId` comes back alongside the list so the picker can mark the
 * `default` alias without a second round trip — and so "default" is never
 * rendered as a model id nobody recognises.
 */
export async function fetchModelCatalog(client: ApiClient): Promise<ListModelOptionsResponse> {
  return client.request(API_ROUTES.models, { schema: ListModelOptionsResponseSchema });
}
