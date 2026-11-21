import { API_ROUTES, ListToolsResponseSchema, type ListToolsResponse } from '@crewaid/shared';
import type { ApiClient } from './apiClient';

/**
 * `GET /tools` — the tool directory, for the composer's `/` palette.
 *
 * Read ONCE per app session by the shell and handed down as a prop: the
 * registry only changes when the orchestrator does (built-ins register at
 * boot; skills register at boot), so a fetch per palette-open would pay a
 * round trip to re-read a list that cannot have moved. A stale list after an
 * orchestrator upgrade heals on the next relaunch — the same trade every
 * other boot-time read here makes.
 */
export function listTools(client: ApiClient, signal?: AbortSignal): Promise<ListToolsResponse> {
  return client.request(API_ROUTES.tools.list, {
    schema: ListToolsResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}
