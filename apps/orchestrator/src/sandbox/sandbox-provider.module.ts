import { SeatControlModule } from '../screen/seat-control.service.js';
import { Logger, Module } from '@nestjs/common';
import {
  CloudflareSandboxProvider,
  cloudflareControlSecretConfigured,
} from '@crewaid/sandbox-cloudflare';
import { DockerSandboxProvider } from '@crewaid/sandbox-docker';
import {
  DigitalOceanSandboxProvider,
  digitalOceanTokenConfigured,
} from '@crewaid/sandbox-digitalocean';
import { InstaboxSandboxProvider, instaboxApiKeyConfigured } from '@crewaid/sandbox-instabox';
import { RuntimeSandboxProvider, runtimeApiKeyConfigured } from '@crewaid/sandbox-runtime';
import { SANDBOX_PROVIDER, type SandboxProvider } from './sandbox.provider.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { SandboxWorkspaceService } from './sandbox-workspace.service.js';
import { SeatService } from './seat.service.js';
import { IdentityController } from './identity.controller.js';
import { IdentityHandoffService } from './identity-handoff.service.js';
import { IdentityService } from './identity.service.js';
import { LoggingModule } from '../logging/logging.module.js';
import { readSandboxProvider } from './sandbox.config.js';

/**
 * The one place a deployment's provider is chosen. All satisfy
 * `SandboxProvider` structurally, so nothing past this line knows which host
 * a computer is on.
 */
function createSandboxProvider(): SandboxProvider {
  const config = readSandboxProvider(process.env, {
    digitalOceanToken: digitalOceanTokenConfigured(),
    cloudflareControlSecret: cloudflareControlSecretConfigured(),
    runtimeApiKey: runtimeApiKeyConfigured(),
    instaboxApiKey: instaboxApiKeyConfigured(),
  });
  if (config.kind === 'docker') return new DockerSandboxProvider();
  if (config.kind === 'cloudflare') {
    return new CloudflareSandboxProvider({ controlUrl: config.controlUrl });
  }
  if (config.kind === 'runtime') {
    const logger = new Logger(RuntimeSandboxProvider.name);
    return new RuntimeSandboxProvider({
      image: config.image,
      vcpu: config.vcpu,
      memoryMiB: config.memoryMiB,
      diskMiB: config.diskMiB,
      log: (message) => logger.warn(message),
    });
  }
  if (config.kind === 'instabox') {
    const logger = new Logger(InstaboxSandboxProvider.name);
    return new InstaboxSandboxProvider({
      image: config.image,
      template: config.template,
      ...(config.vcpus !== undefined ? { vcpus: config.vcpus } : {}),
      ...(config.memoryMiB !== undefined ? { memoryMiB: config.memoryMiB } : {}),
      ...(config.apiUrl !== undefined ? { apiUrl: config.apiUrl } : {}),
      log: (message) => logger.warn(message),
    });
  }
  return new DigitalOceanSandboxProvider({
    template: config.template,
    size: config.size,
    baseAdapter: config.baseAdapter,
  });
}

/**
 * Shared transport, without importing bot orchestration back into bot CRUD.
 *
 * `SeatService` sits here rather than in `SandboxModule` because it is the
 * same kind of thing as the provider token: a thin way to ask a machine
 * something, with no lifecycle of its own. Bot CRUD needs it to close a
 * departing tenant's window, and reaching it through the lifecycle
 * module would import bot orchestration back into bot CRUD — the cycle this
 * module exists to avoid.
 */
@Module({
  imports: [PrismaModule, LoggingModule, SeatControlModule],
  controllers: [IdentityController],
  providers: [
    IdentityHandoffService,
    SandboxWorkspaceService,
    SeatService,
    IdentityService,
    {
      provide: SANDBOX_PROVIDER,
      useFactory: createSandboxProvider,
    },
  ],
  exports: [SANDBOX_PROVIDER, SandboxWorkspaceService, SeatService, IdentityService],
})
export class SandboxProviderModule {}
