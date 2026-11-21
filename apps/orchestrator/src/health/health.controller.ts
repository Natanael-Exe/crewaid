import type { IncomingMessage } from 'node:http';
import { Controller, Get, Inject, Req } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import type { HealthResponse } from '@crewaid/shared';

import { auth } from '../auth/better-auth.js';
import { HealthService } from './health.service.js';

/**
 * GET /health — liveness and readiness in one response.
 *
 * Liveness semantics are deliberately preserved. The route is unauthenticated
 * (the AuthGuard exempts it), and it answers **HTTP 200 whenever the process
 * can answer at all** — a downstream dependency being down is reported in the
 * body, never as a failed probe. A supervisor that read a database outage as
 * "the process is dead" would restart the wrong thing and hide the real
 * failure. The M1 ruling ("liveness only") ruled the SHAPE, not this rule;
 * CC-02 completes the shape with the readiness fields.
 *
 * The body is REST `{ status, db, redis, docker, sandboxes }`, ratified in
 * `packages/shared` as `HealthResponseSchema`. The probes live in
 * HealthService — the controller is the door, not the logic — and every
 * probe the read awaits, the per-sandbox snapshot included, is raced against
 * a bound, so a hung dependency cannot hold the response open.
 *
 * `sandboxes` is the CALLER'S: an exempt route still reads a session when one
 * is sent, and lists only that user's bots. Anonymous, the list is empty — a
 * probe needs the process and its dependencies, not which bots every account
 * has and whether each is running, and an unauthenticated request must not
 * be able to make this process probe every computer it knows.
 */
@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get()
  async check(@Req() request: IncomingMessage): Promise<HealthResponse> {
    return this.health.read(await callerOf(request));
  }
}

/** The signed-in user behind an exempt request, or null — never a failure. */
async function callerOf(request: IncomingMessage): Promise<string | null> {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    return session?.user.id ?? null;
  } catch {
    return null;
  }
}
