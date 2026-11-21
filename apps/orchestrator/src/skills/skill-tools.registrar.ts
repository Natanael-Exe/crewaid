import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { ToolRegistry } from '../agent/tool-registry.js';
import { skillTools } from '../agent/skill-tools.js';
import { skillAuthoringTools } from '../agent/skill-authoring-tools.js';
import { AgentAttachmentService } from '../agent/agent-attachment.service.js';
import { SkillRunService } from './skill-run.service.js';
import { SkillsService } from './skills.service.js';

/**
 * The skill tools put themselves in the registry.
 *
 * They register from HERE rather than from `BotsModule`'s registry factory
 * because `run_skill` needs `SkillRunService`, which lives in this module —
 * and this module already imports `BotsModule`. Registering from the other
 * side would mean `BotsModule` importing `SkillsModule` back, which is the
 * cycle `TurnEventsModule` was extracted to break. A tool group registers
 * itself from wherever its dependencies already live; the registry is the
 * shared thing, not a place every tool's dependencies have to be dragged to.
 *
 * `onModuleInit` rather than the factory: Nest initialises a module's imports
 * before the module itself, so the registry exists by the time this runs, and
 * a duplicate name still throws at boot where the stack names the caller.
 */
@Injectable()
export class SkillToolsRegistrar implements OnModuleInit {
  constructor(
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
    @Inject(SkillRunService) private readonly skills: SkillRunService,
    @Inject(AgentAttachmentService) private readonly attachments: AgentAttachmentService,
    /** `save_skill`'s write half — the row-per-version discipline lives there. */
    @Inject(SkillsService) private readonly skillsService: SkillsService,
  ) {}

  onModuleInit(): void {
    for (const entry of skillTools({ skills: this.skills, attachments: this.attachments })) {
      this.registry.register(entry);
    }
    for (const entry of skillAuthoringTools({ skills: this.skillsService })) {
      this.registry.register(entry);
    }
  }
}
