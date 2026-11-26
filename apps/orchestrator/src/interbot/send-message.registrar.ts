import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { ToolRegistry } from '../agent/tool-registry.js';
import { StructuredLogger } from '../logging/structured-logger.js';
import { BOT_MESSAGE_QUEUE, type BotMessageQueue } from './bot-message.queue.js';
import { ChainBudgetService } from './chain-budget.service.js';
import { ChainNoticeService } from './chain-notice.service.js';
import { CHAIN_LIMITS, type ChainLimits } from './chain.config.js';
import { PrismaPeerDirectory } from './peer-directory.js';
import { sendMessageTool } from './send-message.tool.js';
import { TaskContext } from './task-context.js';
import { WorkflowControlService } from './workflow-control.service.js';

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
    @Inject(WorkflowControlService) private readonly workflow: WorkflowControlService,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
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
        workflow: this.workflow,
        logger: this.logger,
      }),
    );
  }
}
