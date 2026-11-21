import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { CredentialsModule } from '../credentials/credentials.module.js';
import { ProviderConnectionsController } from './provider-connections.controller.js';
import { ProviderConnectionsService } from './provider-connections.service.js';
import { SettingsController } from './settings.controller.js';

/**
 * Provider connections and per-user settings.
 *
 * The service is exported because the model resolution reads connections
 * through it rather than querying the tables itself: one place that knows how
 * a row becomes a wire type is also one place to audit for R7.
 */
@Module({
  imports: [PrismaModule, CredentialsModule],
  controllers: [ProviderConnectionsController, SettingsController],
  providers: [ProviderConnectionsService],
  exports: [ProviderConnectionsService],
})
export class ProvidersModule {}
