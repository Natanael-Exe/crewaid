import { Module } from '@nestjs/common';

import { MemoryController } from './memory.controller.js';
import { MemoryDistillService } from './memory-distill.service.js';
import { MemoryService } from './memory.service.js';
import { ModelsModule } from '../models/models.module.js';

/**
 * The memory's own module, on the `usage/` shape.
 *
 * CC-36 adds the read-only controller. REST named no memory route, which
 * §0 rule 2 forbids inventing — so it arrives with a ratified decision
 * and a declared REST amendment rather than as a quiet addition.
 */
@Module({
  // ModelsModule and not BotsModule: BotsModule imports this one, so reaching
  // for its provider would be the cycle TurnEventsModule was extracted to
  // break. ModelsModule imports only Prisma and the credential vault, so it
  // can be depended on from either side.
  imports: [ModelsModule],
  controllers: [MemoryController],
  // V1-07 / D-087 removed the AGENT_MODEL_RESOLVER token, so the distiller
  // injects the exported service itself. One dependency fewer in the way of
  // reading what it actually does.
  providers: [MemoryService, MemoryDistillService],
  exports: [MemoryService, MemoryDistillService],
})
export class MemoryModule {}
