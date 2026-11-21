import { Controller, Get, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import type { Principal } from '@crewaid/shared';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { ComputerSnapshotService } from './computer-snapshot.service.js';

/**
 * The caller's computer's one snapshot.
 *
 * No `:id` — a person has one computer and these address it through
 * `principal.userId`, so there is no parameter for an ownership marker to
 * resolve. Both writes answer 202: the save or restore is under way, and GET
 * says when it has finished.
 */
@Controller('computer')
export class ComputerSnapshotController {
  constructor(
    @Inject(ComputerSnapshotService) private readonly snapshots: ComputerSnapshotService,
  ) {}

  @Get('snapshot')
  status(@CurrentUser() principal: Principal) {
    return this.snapshots.status(principal.userId);
  }

  @Post('snapshot')
  @HttpCode(HttpStatus.ACCEPTED)
  save(@CurrentUser() principal: Principal) {
    return this.snapshots.save(principal.userId);
  }

  @Post('snapshot/restore')
  @HttpCode(HttpStatus.ACCEPTED)
  restore(@CurrentUser() principal: Principal) {
    return this.snapshots.restore(principal.userId);
  }
}
