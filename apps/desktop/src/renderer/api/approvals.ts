import {
  API_ROUTES,
  ListApprovalsResponseSchema,
  type ListApprovalsResponse,
} from '@crewaid/shared';
import type { ApiClient } from './apiClient';

/**
 * REST `GET /bots/:id/approvals` — what this bot is waiting on.
 *
 * `approval.requested` is emitted once, when the turn suspends, so a window
 * opened after that never saw it. The pending set is renderer memory: it
 * survives a reconnect, correctly, but not a relaunch — and until this route
 * existed the only way to clear a prompt the client had forgotten was
 * `bot.cancel`, which throws the whole turn away.
 *
 * The rows are WebSocket `approval.requested` payloads verbatim, so a recovered
 * prompt is the same value as a live one and takes the same path into state.
 */
export function listApprovals(client: ApiClient, botId: string): Promise<ListApprovalsResponse> {
  return client.request(API_ROUTES.bots.approvals, {
    params: { id: botId },
    schema: ListApprovalsResponseSchema,
  });
}
