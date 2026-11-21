import { Module } from '@nestjs/common';
import { BotsModule } from '../bots/bots.module.js';
import { LoggingModule } from '../logging/logging.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { TaskStartController } from './task-start.controller.js';
import { TaskStartService } from './task-start.service.js';
import { WorkModule } from './work.module.js';

/**
 * The Start button: the only piece of Work that can put a message in
 * front of a bot, and only because the user pressed it. Its own module so
 * `WorkModule` never depends on the turn path.
 */
@Module({
  imports: [PrismaModule, LoggingModule, BotsModule, WorkModule],
  controllers: [TaskStartController],
  providers: [TaskStartService],
  exports: [TaskStartService],
})
export class TaskStartModule {}
