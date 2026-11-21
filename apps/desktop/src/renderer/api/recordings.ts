import {
  API_ROUTES,
  RecordingStatusResponseSchema,
  StartRecordingResponseSchema,
  type RecordingStatusResponse,
  type StartRecordingBody,
  type StartRecordingResponse,
} from '@crewaid/shared';
import type { ApiClient } from './apiClient';

/**
 * REST recording routes.
 *
 * Four calls, and each answers exactly what the contract says:
 *
 * - start answers only the new recording's id — the row is written and
 * capture has begun before it returns (201), so liveness arrives over
 * WebSocket, not from this body;
 * - stop answers the settled status, so the caller learns the final state
 * and counts from the call that caused them rather than polling for them;
 * - discard throws the recording away — capture ends, no compile is queued —
 * and answers the same status body with `DISCARDED`;
 * - the read answers the same status body, and it is where D-042's
 * `warning` lives — deliberately not pushed in `recording.state`, so the
 * renderer fetches it after a terminal transition to pick its sentence.
 */
export function startRecording(
  client: ApiClient,
  botId: string,
  body: StartRecordingBody,
): Promise<StartRecordingResponse> {
  return client.request(API_ROUTES.bots.startRecording, {
    params: { id: botId },
    body,
    schema: StartRecordingResponseSchema,
  });
}

export function stopRecording(
  client: ApiClient,
  recordingId: string,
): Promise<RecordingStatusResponse> {
  return client.request(API_ROUTES.recordings.stop, {
    params: { id: recordingId },
    schema: RecordingStatusResponseSchema,
  });
}

/** `POST /recordings/:id/discard` — end capture and throw the take away. */
export function discardRecording(
  client: ApiClient,
  recordingId: string,
): Promise<RecordingStatusResponse> {
  return client.request(API_ROUTES.recordings.discard, {
    params: { id: recordingId },
    schema: RecordingStatusResponseSchema,
  });
}

export function getRecordingStatus(
  client: ApiClient,
  recordingId: string,
): Promise<RecordingStatusResponse> {
  return client.request(API_ROUTES.recordings.get, {
    params: { id: recordingId },
    schema: RecordingStatusResponseSchema,
  });
}
