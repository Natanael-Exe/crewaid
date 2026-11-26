import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import {
  CreateConnectorBodySchema,
  type CreateConnectorBody,
  type CreateConnectorResponse,
  type ListConnectorsResponse,
  type Principal,
  type RotateConnectorResponse,
} from '@crewaid/shared';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OwnedResource } from '../ownership/owned-resource.decorator.js';
import { ConnectorsService } from './connectors.service.js';

/**
 * Owner-scoped REST endpoints for paired local coding connectors (`/api/v1/connectors`).
 *
 * Raw connector bearer secrets (`crw_conn_…`) are returned once on `POST` and
 * `POST /:id/rotate` and never retrievable afterwards.
 */
@Controller('connectors')
export class ConnectorsController {
  constructor(@Inject(ConnectorsService) private readonly connectors: ConnectorsService) {}

  @Get()
  list(@CurrentUser() principal: Principal): Promise<ListConnectorsResponse> {
    return this.connectors.list(principal.userId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(CreateConnectorBodySchema)) body: CreateConnectorBody,
    @CurrentUser() principal: Principal,
  ): Promise<CreateConnectorResponse> {
    return this.connectors.create(principal.userId, body);
  }

  @Post(':id/rotate')
  @HttpCode(HttpStatus.OK)
  @OwnedResource('localConnector', 'id')
  rotate(
    @Param('id') id: string,
    @CurrentUser() principal: Principal,
  ): Promise<RotateConnectorResponse> {
    return this.connectors.rotateSecret(principal.userId, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @OwnedResource('localConnector', 'id')
  async remove(@Param('id') id: string, @CurrentUser() principal: Principal): Promise<void> {
    await this.connectors.remove(principal.userId, id);
  }
}
