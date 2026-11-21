import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SANDBOX_PROVIDER, type SandboxProvider } from './sandbox.provider.js';
import { readWorkspaceRetentionMs } from './sandbox.config.js';

/** The only automatic workspace deletion path. Runtime reconciliation preserves storage. */
@Injectable()
export class SandboxRetentionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SandboxRetentionService.name);
  private readonly retentionMs: number;
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SANDBOX_PROVIDER) private readonly provider: SandboxProvider,
  ) {
    this.retentionMs = readWorkspaceRetentionMs(process.env['SANDBOX_WORKSPACE_RETENTION_DAYS']);
  }

  onApplicationBootstrap(): void {
    // Fixed cadence, no extra configuration key. Delayed first pass lets runtime
    // reconciliation finish first; downtime can only lengthen the grace period.
    this.timer = setInterval(() => void this.sweep(), 60_000).unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(now = Date.now()): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const { botId } of await this.provider.listWorkspaces()) {
        try {
          await this.prisma.$transaction(
            async (tx) => {
              // Sandbox inserts take the same transaction lock in PostgreSQL, including restores.
              // Slow provider calls therefore fence only this computer's identity.
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(5390040, hashtext(${botId}))`;
              const computer = await tx.sandbox.findUnique({
                where: { id: botId },
                select: { id: true },
              });
              const result = await this.provider.retainWorkspace({
                botId,
                orphaned: computer === null,
                now,
                retentionMs: this.retentionMs,
              });
              if (result === 'deleted')
                this.logger.log(`Reclaimed expired workspace for deleted computer ${botId}`);
            },
            { timeout: 10_000 },
          );
        } catch (error: unknown) {
          this.logger.error(`Workspace retention failed for ${botId}: ${String(error)}`);
        }
      }
    } catch (error: unknown) {
      this.logger.error(`Workspace inventory failed: ${String(error)}`);
    } finally {
      this.sweeping = false;
    }
  }
}
