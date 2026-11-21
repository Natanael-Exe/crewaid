import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { CredentialService } from './credential.service.js';

/**
 * The credential vault.
 *
 * Exports one service and no controller. There is no REST surface here on
 * purpose: a credential is written through the connection routes and
 * read only by the model-resolution path, so a route that exposed the
 * vault directly would be a route whose only purpose is to hand out keys.
 */
@Module({
  imports: [PrismaModule],
  providers: [CredentialService],
  exports: [CredentialService],
})
export class CredentialsModule {}
