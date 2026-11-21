import { SeatControlModule } from '../../screen/seat-control.service.js';
import { SkillExecutionPolicy } from './skill-policy.js';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { SandboxModule } from '../../sandbox/sandbox.module.js';
import { SandboxProviderModule } from '../../sandbox/sandbox-provider.module.js';
import { TurnEventsModule } from '../turn-events.module.js';
import { ToolApprovalHub } from './approval-hub.js';
import { ToolPolicyStateService } from './state.service.js';

@Module({
  imports: [
    SeatControlModule,
    PrismaModule,
    SandboxModule,
    SandboxProviderModule,
    TurnEventsModule,
  ],
  providers: [ToolApprovalHub, ToolPolicyStateService, SkillExecutionPolicy],
  exports: [ToolApprovalHub, ToolPolicyStateService, SkillExecutionPolicy],
})
export class ToolPolicyModule {}
