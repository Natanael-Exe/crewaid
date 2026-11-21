import { Inject, Injectable, Module } from '@nestjs/common';
import { BotsModule } from '../bots/bots.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { TurnEventsModule } from '../agent/turn-events.module.js';
import { ToolRegistry } from '../agent/tool-registry.js';
import {
  OnboardingController,
  TemplatesController,
  TemplateInstallationsController,
} from './experience.controller.js';
import { OnboardingService } from './onboarding.service.js';
import { TemplateService } from './template.service.js';
import { templateTools } from './template-tools.js';
@Injectable()
class TemplateToolRegistrar {
  constructor(
    @Inject(ToolRegistry) tools: ToolRegistry,
    @Inject(TemplateService) templates: TemplateService,
  ) {
    for (const entry of templateTools(templates)) tools.register(entry);
  }
}
@Module({
  imports: [PrismaModule, BotsModule, TurnEventsModule],
  controllers: [OnboardingController, TemplatesController, TemplateInstallationsController],
  providers: [OnboardingService, TemplateService, TemplateToolRegistrar],
  exports: [OnboardingService, TemplateService],
})
export class ExperienceModule {}
