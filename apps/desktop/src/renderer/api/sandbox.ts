import {
  API_ROUTES,
  SandboxStatusResponseSchema,
  type SandboxStatusResponse,
} from '@crewaid/shared';
import type { ApiClient } from './apiClient';

/**
 * REST sandbox lifecycle, as the renderer needs it.
 *
 * One function, and the omission is the design. D-041 replaced the manual
 * Start/Stop pair with a computer that wakes when someone asks for it: the
 * orchestrator's ensure-ready path is what this route reaches, and
 * §8's idle policy is what puts the computer back down. So there is no
 * `stopSandbox` here — not because stopping is unimplemented, but because a
 * Stop button would hand the operator a lifecycle chore the product exists to
 * take away, and would let one click strip a desktop out from under an agent
 * turn or a recording that is still using it.
 *
 * The route is idempotent and the orchestrator does not answer until
 * the sandbox is actually usable, so the response describes a settled
 * state rather than an accepted intent — which is what lets the caller treat
 * a resolved promise as "the computer is ready".
 */
export function startSandbox(client: ApiClient, botId: string): Promise<SandboxStatusResponse> {
  return client.request(API_ROUTES.bots.sandboxStart, {
    params: { id: botId },
    schema: SandboxStatusResponseSchema,
  });
}

/** Revoke the selected grant and return this bot to its private browser. */
export function releaseIdentity(client: ApiClient, botId: string): Promise<void> {
  return client.request(API_ROUTES.bots.releaseIdentity, { params: { id: botId } });
}
