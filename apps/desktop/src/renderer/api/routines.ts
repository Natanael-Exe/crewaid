import {
  API_ROUTES,
  ListRoutinesResponseSchema,
  RoutineResponseSchema,
  type CreateRoutineBody,
  type Routine,
  type UpdateRoutineBody,
} from '@crewaid/shared';
import type { ApiClient } from './apiClient';

/**
 * REST `/routines`.
 *
 * Every answer that carries a routine parses through the shared schema, the
 * write answers included: the routine a PATCH returns is what the panel
 * adopts, so rendering it unverified would make an edit the one place the
 * panel shows what it did not check.
 */

/** `GET /routines` — every routine on the caller's bots; the panel filters by bot. */
export function listRoutines(client: ApiClient): Promise<Routine[]> {
  return client.request(API_ROUTES.routines.list, { schema: ListRoutinesResponseSchema });
}

/** `POST /routines` — always an OPERATOR routine. */
export function createRoutine(client: ApiClient, body: CreateRoutineBody): Promise<Routine> {
  return client.request(API_ROUTES.routines.create, { body, schema: RoutineResponseSchema });
}

/** `PATCH /routines/:id` — any subset; enabling and disabling go through here too. */
export function updateRoutine(
  client: ApiClient,
  routineId: string,
  body: UpdateRoutineBody,
): Promise<Routine> {
  return client.request(API_ROUTES.routines.update, {
    params: { id: routineId },
    body,
    schema: RoutineResponseSchema,
  });
}

/** `DELETE /routines/:id` — 204, so there is nothing to parse. */
export function deleteRoutine(client: ApiClient, routineId: string): Promise<void> {
  return client.request(API_ROUTES.routines.remove, { params: { id: routineId } });
}

/**
 * `POST /routines/:id/run-now` — 202 with the routine as it stands; the
 * firing's outcome lands in `lastStatus` later, like a scheduled one's.
 */
export function runRoutineNow(client: ApiClient, routineId: string): Promise<Routine> {
  return client.request(API_ROUTES.routines.runNow, {
    params: { id: routineId },
    schema: RoutineResponseSchema,
  });
}
