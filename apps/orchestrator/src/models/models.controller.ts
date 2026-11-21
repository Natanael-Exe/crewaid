import { Controller, Get, Inject } from '@nestjs/common';
import {
  ListModelOptionsResponseSchema,
  type ListModelOptionsResponse,
  type Principal,
} from '@crewaid/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ModelResolutionService } from './model-resolution.service.js';

/**
 * `GET /models` (D-086, replacing D-003's static catalog).
 *
 * The picker's source of truth, now derived from the CALLER's connections
 * rather than from a list compiled into the process. Still not a live fan-out
 * to three providers' model endpoints on every render — the D-003 property
 * that mattered survives; what changed is whose models these are.
 *
 * No `@OwnedResource` marker and no exemption: there is no id in the path.
 * The ownership is the where clause, keyed on the principal's own `userId`.
 */
@Controller('models')
export class ModelsController {
  constructor(@Inject(ModelResolutionService) private readonly models: ModelResolutionService) {}

  @Get()
  async list(@CurrentUser() principal: Principal): Promise<ListModelOptionsResponse> {
    // Parsed through the shared schema at the boundary: if the projection ever
    // violates the contract this fails loudly here, in tests, rather than
    // shipping a drifted shape to the picker.
    return ListModelOptionsResponseSchema.parse(await this.models.options(principal.userId));
  }
}
