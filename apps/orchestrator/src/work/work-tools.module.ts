import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';

import { ToolRegistry } from '../agent/tool-registry.js';
import { BotsModule } from '../bots/bots.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { workTools } from './work-tools.js';
import { WorkToolsService } from './work-tools.service.js';
import { WorkModule } from './work.module.js';

/**
 * The task tools join the registry from here — M5-BE-06's rule, a tool group
 * registers from wherever its dependencies live — so `WorkModule` itself
 * never depends on the agent loop.
 */
@Injectable()
export class WorkToolsRegistrar implements OnModuleInit {
  constructor(
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
    @Inject(WorkToolsService) private readonly service: WorkToolsService,
  ) {}

  onModuleInit(): void {
    for (const registered of workTools(this.service)) this.registry.register(registered);
  }
}

@Module({
  imports: [PrismaModule, BotsModule, WorkModule],
  providers: [WorkToolsService, WorkToolsRegistrar],
  exports: [WorkToolsService],
})
export class WorkToolsModule {}
