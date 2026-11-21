import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { ToolRegistry } from '../agent/tool-registry.js';
import { routineTools } from './routine-tools.js';
import { RoutinesService } from './routines.service.js';

/**
 * `schedule_routine` and `cancel_routine` join the registry from the module
 * that owns routines — M5-BE-06's rule: a tool group registers itself from
 * wherever its dependencies already live.
 */
@Injectable()
export class RoutineToolsRegistrar implements OnModuleInit {
  constructor(
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
    @Inject(RoutinesService) private readonly routines: RoutinesService,
  ) {}

  onModuleInit(): void {
    for (const registered of routineTools(this.routines)) this.registry.register(registered);
  }
}
