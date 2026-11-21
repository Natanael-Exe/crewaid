import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { TurnEventsModule } from '../agent/turn-events.module.js';
import { GroupsController } from './groups.controller.js';
import { GroupsService } from './groups.service.js';

@Module({
  imports: [PrismaModule, TurnEventsModule],
  controllers: [GroupsController],
  providers: [GroupsService],
})
export class GroupsModule {}
