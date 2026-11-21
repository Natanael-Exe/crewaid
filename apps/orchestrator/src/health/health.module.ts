import { Module } from '@nestjs/common';

import { SandboxModule } from '../sandbox/sandbox.module.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

/**
 * The REST/§4.4 health surface.
 *
 * SandboxModule supplies both the provider token and SandboxHealthService —
 * the same instances the lifecycle runs on, not a second Docker client that
 * could disagree with them about which container a session id names.
 * PrismaService is global (PrismaModule).
 */
@Module({
  imports: [SandboxModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
