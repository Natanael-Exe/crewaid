import {
  API_ROUTES,
  ComputerSnapshotStatusResponseSchema,
  type ComputerSnapshotStatusResponse,
} from '@crewaid/shared';
import type { ApiClient } from './apiClient';

/**
 * The snapshot routes: the caller's computer, addressed without an id.
 * Both writes answer 202 with the status; the pane reads GET again until
 * `activity` clears.
 */

export function getComputerSnapshot(
  client: ApiClient,
  signal?: AbortSignal,
): Promise<ComputerSnapshotStatusResponse> {
  return client.request(API_ROUTES.computer.snapshot, {
    ...(signal === undefined ? {} : { signal }),
    schema: ComputerSnapshotStatusResponseSchema,
  });
}

export function saveComputerSnapshot(client: ApiClient): Promise<ComputerSnapshotStatusResponse> {
  return client.request(API_ROUTES.computer.snapshotSave, {
    schema: ComputerSnapshotStatusResponseSchema,
  });
}

export function restoreComputerSnapshot(
  client: ApiClient,
): Promise<ComputerSnapshotStatusResponse> {
  return client.request(API_ROUTES.computer.snapshotRestore, {
    schema: ComputerSnapshotStatusResponseSchema,
  });
}
