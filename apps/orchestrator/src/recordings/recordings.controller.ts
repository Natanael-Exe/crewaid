import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { StartRecordingBodySchema, type Principal, type StartRecordingBody } from '@crewaid/shared';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OwnedResource } from '../ownership/owned-resource.decorator.js';
import { RecordingsService } from './recordings.service.js';

/**
 * `POST /bots/:id/recordings`.
 *
 * A separate controller from the one below because the two halves of the
 * recording contract hang off different roots, and Nest binds a controller to
 * one. Same shape as `SandboxController`: a `/bots/:id/...` route resolves the
 * bot through its owner inside the service, which is why it carries an EXEMPT
 * entry in `test/ownership-route-coverage.test.ts` rather than a marker.
 *
 * 201, not 202: the response carries the id of a row that exists, and capture
 * has already begun by the time it is written — the computer was woken and the
 * tee attached before this returns.
 */
@Controller('bots')
export class BotRecordingsController {
  constructor(@Inject(RecordingsService) private readonly recordings: RecordingsService) {}

  @Post(':id/recordings')
  @HttpCode(HttpStatus.CREATED)
  start(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(StartRecordingBodySchema)) body: StartRecordingBody,
    @CurrentUser() principal: Principal,
  ) {
    return this.recordings.start(principal.userId, id, body);
  }
}

/**
 * The direct-by-id half of REST recording routes.
 *
 * All three are fenced by `@OwnedResource('recording')`, which
 * resolves the row to an owning `userId` before the handler runs. The service
 * scopes its own lookups by `userId` as well — the guard closes the route, R7
 * closes the query, and neither is load-bearing on the other.
 *
 * Stop and discard answer 200 with the same status body `GET` returns, so a
 * client learns the settled state and its final event counts from the call
 * that caused them rather than having to poll for them.
 */
@Controller('recordings')
export class RecordingsController {
  constructor(@Inject(RecordingsService) private readonly recordings: RecordingsService) {}

  @Get(':id')
  @OwnedResource('recording')
  status(@Param('id') id: string, @CurrentUser() principal: Principal) {
    return this.recordings.status(principal.userId, id);
  }

  @Post(':id/stop')
  @OwnedResource('recording')
  @HttpCode(HttpStatus.OK)
  stop(@Param('id') id: string, @CurrentUser() principal: Principal) {
    return this.recordings.stop(principal.userId, id);
  }

  @Post(':id/discard')
  @OwnedResource('recording')
  @HttpCode(HttpStatus.OK)
  discard(@Param('id') id: string, @CurrentUser() principal: Principal) {
    return this.recordings.discard(principal.userId, id);
  }
}
