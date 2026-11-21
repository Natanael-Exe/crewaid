import { Controller, Get, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@crewaid/shared';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { SandboxReadinessService } from './sandbox-readiness.service.js';
import { SandboxService } from './sandbox.service.js';

/**
 * Sandbox lifecycle routes.
 *
 * All three are `/bots/:id/...`, and all three resolve the bot through its
 * owner inside `SandboxService` before touching a sandbox — the same shape as
 * the other bot-family routes, and the reason they carry an EXEMPT entry in
 * `test/ownership-route-coverage.test.ts` rather than an `@OwnedResource`
 * marker.
 *
 * Start and stop answer 200 rather than 202. REST calls both idempotent, and
 * the provider does not return until the sandbox is actually usable,
 * so the response describes a settled state rather than an accepted intent.
 *
 * Start goes through `SandboxReadinessService` rather than straight to the
 * lifecycle (M3-BE-11, D-039 §16). Opening the computer from its rail card is
 * one of the three things that may wake one, and §16 gives all three the same
 * path — the route is the transport, not a second implementation of it.
 */
@Controller('bots')
export class SandboxController {
  constructor(
    @Inject(SandboxService) private readonly sandboxes: SandboxService,
    @Inject(SandboxReadinessService) private readonly computers: SandboxReadinessService,
  ) {}

  @Get(':id/sandbox')
  status(@Param('id') id: string, @CurrentUser() principal: Principal) {
    return this.sandboxes.status(principal.userId, id);
  }

  @Post(':id/sandbox/start')
  @HttpCode(HttpStatus.OK)
  start(@Param('id') id: string, @CurrentUser() principal: Principal) {
    return this.computers.open(principal.userId, id);
  }

  @Post(':id/sandbox/stop')
  @HttpCode(HttpStatus.OK)
  stop(@Param('id') id: string, @CurrentUser() principal: Principal) {
    return this.sandboxes.stop(principal.userId, id);
  }
}
