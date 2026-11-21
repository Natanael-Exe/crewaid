import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/** Global so every feature module injects the same client instance. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
