import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { CredentialsModule } from '../credentials/credentials.module.js';
import { ModelsController } from './models.controller.js';
import { ModelResolutionService } from './model-resolution.service.js';

/**
 * Owner-scoped model resolution and `GET /models`.
 *
 * Exported because the agent loop and the skill compiler both resolve through
 * it. Neither builds a provider itself: `provider-factory.ts` is the only
 * place that touches a provider SDK constructor, which is what keeps R3 a
 * one-file property.
 */
@Module({
  imports: [PrismaModule, CredentialsModule],
  controllers: [ModelsController],
  providers: [ModelResolutionService],
  exports: [ModelResolutionService],
})
export class ModelsModule {}
