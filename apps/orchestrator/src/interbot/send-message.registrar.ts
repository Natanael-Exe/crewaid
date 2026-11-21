import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { ToolRegistry } from '../agent/tool-registry.js';
import { BOT_MESSAGE_QUEUE, type BotMessageQueue } from './bot-message.queue.js';
import { ChainBudgetService } from './chain-budget.service.js';
import { ChainNoticeService } from './chain-notice.service.js';
import { CHAIN_LIMITS, type ChainLimits } from './chain.config.js';
import { PrismaPeerDirectory } from './peer-directory.js';
import { sendMessageTool } from './send-message.tool.js';
import { TaskContext } from './task-context.js';

/**
 * `send_message` puts itself in the registry, from the module
 * that owns delivery.
 *
 * The same shape as `SkillToolsRegistrar` and for the same reason: a tool
 * registers from wherever its dependencies already live, rather than
 * dragging them into `BotsModule`'s factory. `onModuleInit` rather than the
 * factory, because Nest initialises a module's imports first — so the
 * registry exists by the time this runs, and a duplicate name still throws at
 * boot with this class named in the stack.
 *
 * The M5 stub registered the same NAME from `SkillsModule`. Registering it
 * here instead is not a second registration: the stub is gone, and if it were
 * not, `ToolRegistry.register` would refuse the duplicate at boot rather than
 * let two definitions of one tool exist.
 */
@Injectable()
export class SendMessageRegistrar implements OnModuleInit {
  constructor(
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
    @Inject(BOT_MESSAGE_QUEUE) private readonly queue: BotMessageQueue,
    @Inject(PrismaPeerDirectory) private readonly directory: PrismaPeerDirectory,
    @Inject(ChainNoticeService) private readonly notice: ChainNoticeService,
    @Inject(ChainBudgetService) private readonly budget: ChainBudgetService,
    @Inject(CHAIN_LIMITS) private readonly limits: ChainLimits,
    @Inject(TaskContext) private readonly tasks: TaskContext,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      sendMessageTool({
        queue: this.queue,
        directory: this.directory,
        notice: this.notice,
        budget: this.budget,
        limits: this.limits,
        tasks: this.tasks,
      }),
    );
  }
}
