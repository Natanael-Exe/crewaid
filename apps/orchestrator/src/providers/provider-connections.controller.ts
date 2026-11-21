import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  CreateProviderConnectionBodySchema,
  CreateProviderModelBodySchema,
  SetProviderCredentialBodySchema,
  UpdateProviderConnectionBodySchema,
  UpdateProviderModelBodySchema,
  type CreateProviderConnectionBody,
  type CreateProviderModelBody,
  type ListProviderConnectionsResponse,
  type Principal,
  type ProviderConnection,
  type ProviderModel,
  type SetProviderCredentialBody,
  type UpdateProviderConnectionBody,
  type UpdateProviderModelBody,
} from '@crewaid/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { OwnedResource } from '../ownership/owned-resource.decorator.js';
import { ProviderConnectionsService } from './provider-connections.service.js';

/**
 * Provider connections (V1-05, REST addition under D-082).
 *
 * Every direct-by-id route carries `@OwnedResource`, so the guard resolves the
 * row to an owner before any handler logic runs. The service scopes
 * every query anyway — the two are belt and braces, and
 * `ownership-route-coverage.test.ts` fails the build if the marker is missing.
 *
 * ⚠️ THERE IS NO ROUTE THAT RETURNS A CREDENTIAL, and there must never be.
 * `PUT.../credential` writes one and answers 204; `DELETE` removes it. The
 * absence of a GET is the contract.
 */
@Controller('providers')
export class ProviderConnectionsController {
  constructor(
    @Inject(ProviderConnectionsService) private readonly providers: ProviderConnectionsService,
  ) {}

  @Get('connections')
  async list(@CurrentUser() principal: Principal): Promise<ListProviderConnectionsResponse> {
    return { connections: await this.providers.list(principal.userId) };
  }

  @Post('connections')
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(CreateProviderConnectionBodySchema))
    body: CreateProviderConnectionBody,
    @CurrentUser() principal: Principal,
  ): Promise<ProviderConnection> {
    return this.providers.create(principal.userId, body);
  }

  @Patch('connections/:id')
  @OwnedResource('providerConnection')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateProviderConnectionBodySchema))
    body: UpdateProviderConnectionBody,
    @CurrentUser() principal: Principal,
  ): Promise<ProviderConnection> {
    return this.providers.update(principal.userId, id, body);
  }

  @Delete('connections/:id')
  @OwnedResource('providerConnection')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() principal: Principal): Promise<void> {
    await this.providers.remove(principal.userId, id);
  }

  /**
   * Write a key. 204, with no body — there is nothing safe to return, and an
   * echo of the connection would invite a client to diff it against what was
   * sent and conclude the key round-trips.
   */
  @Put('connections/:id/credential')
  @OwnedResource('providerConnection')
  @HttpCode(HttpStatus.NO_CONTENT)
  async setCredential(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SetProviderCredentialBodySchema)) body: SetProviderCredentialBody,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    await this.providers.setCredential(principal.userId, id, body.apiKey);
  }

  @Delete('connections/:id/credential')
  @OwnedResource('providerConnection')
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearCredential(
    @Param('id') id: string,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    await this.providers.clearCredential(principal.userId, id);
  }

  @Post('connections/:id/models')
  @OwnedResource('providerConnection')
  @HttpCode(HttpStatus.CREATED)
  createModel(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CreateProviderModelBodySchema)) body: CreateProviderModelBody,
    @CurrentUser() principal: Principal,
  ): Promise<ProviderModel> {
    return this.providers.createModel(principal.userId, id, body);
  }

  @Patch('models/:modelId')
  @OwnedResource('providerModel', 'modelId')
  updateModel(
    @Param('modelId') modelId: string,
    @Body(new ZodValidationPipe(UpdateProviderModelBodySchema)) body: UpdateProviderModelBody,
    @CurrentUser() principal: Principal,
  ): Promise<ProviderModel> {
    return this.providers.updateModel(principal.userId, modelId, body);
  }

  @Delete('models/:modelId')
  @OwnedResource('providerModel', 'modelId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeModel(
    @Param('modelId') modelId: string,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    await this.providers.removeModel(principal.userId, modelId);
  }
}
