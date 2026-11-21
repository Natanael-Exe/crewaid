import { Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import {
  UpdateUserSettingsBodySchema,
  type Principal,
  type UpdateUserSettingsBody,
  type UserSettingsResponse,
} from '@crewaid/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ProviderConnectionsService } from './provider-connections.service.js';

/**
 * `GET /settings`, `PATCH /settings`.
 *
 * Where the per-user `default` alias is chosen — the replacement for the
 * `DEFAULT_MODEL_ID` environment variable.
 *
 * No `@OwnedResource` marker and no exemption entry needed: neither route
 * carries an id in its path. The ownership IS the where clause, because the
 * row is keyed on the principal's own `userId` and there is no id a caller
 * could substitute. `memory.controller.ts` sets the same precedent.
 */
@Controller('settings')
export class SettingsController {
  constructor(
    @Inject(ProviderConnectionsService) private readonly providers: ProviderConnectionsService,
  ) {}

  @Get()
  async get(@CurrentUser() principal: Principal): Promise<UserSettingsResponse> {
    return { settings: await this.providers.settings(principal.userId) };
  }

  @Patch()
  async update(
    @Body(new ZodValidationPipe(UpdateUserSettingsBodySchema)) body: UpdateUserSettingsBody,
    @CurrentUser() principal: Principal,
  ): Promise<UserSettingsResponse> {
    return { settings: await this.providers.updateSettings(principal.userId, body) };
  }
}
