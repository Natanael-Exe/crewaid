import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { UsageController } from './usage.controller.js';
import { UsageService } from './usage.service.js';

/**
 * The REST/§7.1 usage surface.
 *
 * Owns its own controller because usage is not a feature of any other module:
 * it reads AgentTurn rows across every bot (scoped by the caller's userId)
 * and nothing else. PrismaModule is imported explicitly so an isolated test
 * bootstrap of this module resolves PrismaService without the app root.
 *
 * Reporting only. CC-26 removed §7.2's daily caps, so nothing here refuses a
 * turn — what was spent is told, never enforced.
 */
@Module({
  imports: [PrismaModule],
  controllers: [UsageController],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {}
