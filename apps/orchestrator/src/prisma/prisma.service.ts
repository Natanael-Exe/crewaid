import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { messageKeyring } from '../credentials/message-cipher.js';
import { messageSealing } from './message-sealing.js';
import { prismaClientOptions } from './prisma-client.factory.js';

/**
 * The single Prisma client instance for the orchestrator.
 *
 * Global module: inject `PrismaService`, never construct a client elsewhere.
 * Every query that touches a user-owned model MUST scope by `principal.userId`
 * (PRD R7 / D-010 allowlist) — this service is where that discipline lives or
 * dies, so keep call sites in services, not controllers.
 *
 * The adapter wiring moved to `prisma-client.factory.ts` when Better Auth
 * arrived needing its own client outside the Nest context. Two copies
 * of that wiring would fail the same way a missing migration does, in the one
 * place nobody would look.
 *
 * Message text is sealed here: what `new PrismaService` hands back
 * is this client with `messageSealing` over it, so every service, and every
 * transaction it opens, writes ciphertext and reads what was said. The
 * extension only intercepts queries, so the client's shape is unchanged; it is
 * a different object from `this`, though, which is why nothing may test a
 * client with `instanceof PrismaService`.
 */
/** Said once a process: a test run constructs this service hundreds of times. */
let warnedUnsealed = false;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super(prismaClientOptions());
    // Asked for once here so a production server with no keyring refuses to
    // boot, rather than refusing each message as it arrives.
    if (messageKeyring() === null && !warnedUnsealed) {
      warnedUnsealed = true;
      this.logger.warn(
        'CREWAID_CREDENTIAL_KEYRING is not set: messages are stored unencrypted (refused in production)',
      );
    }
    // A query-only extension adds no member and changes no signature.
    return this.$extends(messageSealing()) as unknown as this;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
