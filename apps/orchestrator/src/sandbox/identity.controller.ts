import { Controller, Delete, HttpCode, HttpStatus, Inject, Param } from '@nestjs/common';
import type { Principal } from '@crewaid/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { IdentityHandoffService } from './identity-handoff.service.js';

@Controller('bots')
export class IdentityController {
  constructor(@Inject(IdentityHandoffService) private readonly handoff: IdentityHandoffService) {}

  @Delete(':id/identity')
  @HttpCode(HttpStatus.NO_CONTENT)
  release(@Param('id') botId: string, @CurrentUser() principal: Principal): Promise<void> {
    return this.handoff.release(principal.userId, botId);
  }
}
