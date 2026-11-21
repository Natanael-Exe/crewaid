import { Controller, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import type { ScreenGrantResponse } from '@crewaid/shared';

import { OwnedResource } from '../ownership/owned-resource.decorator.js';
import { ScreenGrantService } from './screen-grant.service.js';

/**
 * `POST /bots/:id/screen/grant`. A POST although it changes no row: each call
 * mints a new single-use ticket, and a GET would invite a cache to hand the
 * same one out twice.
 */
@Controller('bots')
export class ScreenGrantController {
  constructor(@Inject(ScreenGrantService) private readonly grants: ScreenGrantService) {}

  @Post(':id/screen/grant')
  @HttpCode(HttpStatus.OK)
  @OwnedResource('bot', 'id')
  grant(@Param('id') botId: string): Promise<ScreenGrantResponse> {
    return this.grants.grant(botId);
  }
}
