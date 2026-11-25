import { ToolPolicyModule } from '../agent/policy/policy.module.js';
import { Module } from '@nestjs/common';
import { SeatControlModule } from '../screen/seat-control.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { BotsController } from './bots.controller.js';
import { BotsService } from './bots.service.js';
import { MessagesController } from '../messages/messages.controller.js';
import { ApprovalsController } from '../agent/approvals.controller.js';
import { TurnsController } from '../agent/turns.controller.js';
import { TurnHistoryService } from '../agent/turn-history.service.js';
import { MessagesService } from '../messages/messages.service.js';
import { TurnControlService } from '../agent/turn-control.service.js';
import { TurnEventsModule } from '../agent/turn-events.module.js';
import { SandboxModule } from '../sandbox/sandbox.module.js';
import { ToolRegistry } from '../agent/tool-registry.js';
import { TurnPlugins } from '../agent/turn-plugins.js';
import { TanStackTurns } from '../agent/tanstack-turns.js';
import {
  AgentBrowserService,
  PLAYWRIGHT_CONNECT,
  connectPlaywright,
} from '../agent/agent-browser.service.js';
import { AgentAttachmentService } from '../agent/agent-attachment.service.js';
import { ToolsController } from '../agent/tools.controller.js';
import { previewTools } from '../agent/preview-tools.js';
import { visualTools } from '../agent/visual-tools.js';
import { browserTools } from '../agent/browser-tools.js';
import { boardTools } from '../agent/board-tools.js';
import { memoryTools } from '../agent/memory-tools.js';
import { identityTools } from '../agent/identity-tools.js';
import { computerTools } from '../agent/computer-tools.js';
import { machineTools } from '../agent/machine-tools.js';
import { botTools } from '../agent/bot-tools.js';
import { AttachmentsModule } from '../attachments/attachments.module.js';
import { AgentSessionService } from '../agent/agent-session.service.js';
import { ModelsModule } from '../models/models.module.js';
import { LoggingModule } from '../logging/logging.module.js';
import { SandboxProviderModule } from '../sandbox/sandbox-provider.module.js';
import { UsageModule } from '../usage/usage.module.js';
import { MemoryModule } from '../memory/memory.module.js';
import { MemoryService } from '../memory/memory.service.js';
import { AI_TELEMETRY, AiTelemetryService } from '../telemetry/ai-telemetry.js';

/**
 * Bot + message domain and the chat turn coordinator.
 *
 * One module because MessagesService depends on bot ownership resolution;
 * splitting them would trade a real dependency for two exports.
 */
@Module({
  imports: [
    ToolPolicyModule,
    SeatControlModule,
    PrismaModule,
    LoggingModule,
    SandboxProviderModule,
    UsageModule,
    MemoryModule,
    TurnEventsModule,
    SandboxModule,
    // The machine-level built-ins auto-attach their evidence (a screen
    // recording claims the reply like attach_file does), so the registration
    // needs `AgentAttachmentService`. Explicit even though the module is
    // @Global — depending on another module's loading order is not a
    // dependency (SkillsModule reached the same conclusion first).
    AttachmentsModule,
    // The chat producer assembles from this module and resolves its model
    // through ModelsModule, so the import stays with the services it serves.
    ModelsModule,
  ],
  controllers: [
    BotsController,
    MessagesController,
    ApprovalsController,
    TurnsController,
    ToolsController,
  ],
  providers: [
    BotsService,
    MessagesService,
    TurnControlService,
    TurnHistoryService,
    // The one place a tool's definition and its out-of-band behavior
    // descriptor are read from. The browser built-ins are registered
    // here because they need nothing this module does not already have.
    // The skill tools register from SkillsModule instead, and that is
    // the shape the registry was built for rather than a workaround:
    // SkillsModule already imports this one, so it can reach the registry,
    // while this module importing SkillsModule back would be the cycle
    // TurnEventsModule was extracted to break. A tool group registers itself
    // from wherever its dependencies already live.
    // Registration happens at construction rather than in a module hook so a
    // duplicate name fails at boot, where the stack names the colliding
    // caller, rather than at the first turn that offers the tool.
    // The first tool group with a dependency, hence the first `inject` here.
    // MemoryService arrives at REGISTRATION rather than through ToolContext:
    // the context carries what varies per turn (which bot, which reply), and
    // a service does not vary. Threading it through the context would widen a
    // type every tool sees for the benefit of three.
    {
      provide: ToolRegistry,
      useFactory: (
        memories: MemoryService,
        browsers: AgentBrowserService,
        attachments: AgentAttachmentService,
        bots: BotsService,
      ): ToolRegistry => {
        const registry = new ToolRegistry();
        for (const entry of previewTools()) registry.register(entry);
        for (const entry of visualTools()) registry.register(entry);
        for (const entry of browserTools()) registry.register(entry);
        for (const entry of computerTools({ machines: browsers })) registry.register(entry);
        for (const entry of machineTools({ machines: browsers, attachments }))
          registry.register(entry);
        for (const entry of botTools({ bots })) registry.register(entry);
        for (const entry of identityTools()) registry.register(entry);
        for (const entry of boardTools()) registry.register(entry);
        for (const entry of memoryTools(memories)) registry.register(entry);
        return registry;
      },
      inject: [MemoryService, AgentBrowserService, AgentAttachmentService, BotsService],
    },
    // The holder a turn asks for a bot's plugin tools. Empty until
    // `McpModule` registers itself into it, the same way the tool groups
    // register into `ToolRegistry` from wherever their dependencies live.
    TurnPlugins,
    // The holder `ChatSendService` registers itself into, so background
    // triggers reach the producer without importing the module that imports
    // this one.
    TanStackTurns,
    AgentBrowserService,
    { provide: PLAYWRIGHT_CONNECT, useValue: connectPlaywright },
    AgentSessionService,
    AiTelemetryService,
    { provide: AI_TELEMETRY, useExisting: AiTelemetryService },
  ],
  exports: [
    BotsService,
    MessagesService,
    TurnEventsModule,
    TurnControlService,
    ToolRegistry,
    TurnPlugins,
    TanStackTurns,
    // The TanStack send route assembles a turn from the same services
    // this module already owns, rather than constructing its own browser or
    // session service — two of either would be two views of one machine.
    AgentBrowserService,
    AgentSessionService,
    // The TanStack backend records its model calls into the same sink.
    AI_TELEMETRY,
  ],
})
export class BotsModule {}
