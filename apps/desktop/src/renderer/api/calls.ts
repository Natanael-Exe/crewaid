import {
  API_ROUTES,
  CallAllowanceResponseSchema,
  StartCallResponseSchema,
  VoiceCallResponseSchema,
  type CallAllowanceResponse,
  type StartCallResponse,
  type UpdateCallBody,
  type VoiceCallResponse,
} from '@crewaid/shared';
import type { ApiClient } from './apiClient';

/** POST /bots/:id/calls — a signed URL and what the call's voice is told. */
export function startCall(client: ApiClient, botId: string): Promise<StartCallResponse> {
  return client.request(API_ROUTES.calls.start, {
    params: { id: botId },
    schema: StartCallResponseSchema,
  });
}

/** PATCH /calls/:callId — the conversation once connected, or the hang-up. */
export function updateCall(
  client: ApiClient,
  callId: string,
  body: UpdateCallBody,
): Promise<VoiceCallResponse> {
  return client.request(API_ROUTES.calls.update, {
    params: { callId },
    body,
    schema: VoiceCallResponseSchema,
  });
}

/** GET /calls/allowance — a 404 means this server has no calls at all. */
export function callAllowance(client: ApiClient): Promise<CallAllowanceResponse> {
  return client.request(API_ROUTES.calls.allowance, { schema: CallAllowanceResponseSchema });
}
