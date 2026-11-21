import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { OwnershipService } from './ownership.service.js';
import { ResourceOwnershipGuard } from './resource-ownership.guard.js';

/** Shared ownership boundary; global so future route modules cannot omit it. */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [OwnershipService, ResourceOwnershipGuard],
  exports: [OwnershipService, ResourceOwnershipGuard],
})
export class OwnershipModule {}
