import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SANDBOX_PROVIDER, type SandboxProvider } from './sandbox.provider.js';
import { attachToComputer } from './attached-computer.js';

/** Backfill and on-demand repair share the deletion lock order: Bot, then Sandbox. */
@Injectable()
export class SandboxWorkspaceService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SandboxWorkspaceService.name);
  private timer: NodeJS.Timeout | undefined;
  private sweeping = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SANDBOX_PROVIDER) private readonly provider: SandboxProvider,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env['SANDBOX_RECONCILE_ON_BOOT'] === 'false') return;
    // Migration may span many bots or an unavailable daemon; keep the API usable.
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), 60_000).unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const bots = await this.prisma.bot.findMany({ select: { id: true, userId: true } });
      for (const bot of bots) {
        try {
          await this.ensure(bot.userId, bot.id);
        } catch (error: unknown) {
          this.logger.warn(`Workspace provisioning for ${bot.id} will retry: ${messageOf(error)}`);
        }
      }
    } catch (error: unknown) {
      this.logger.error(`Workspace migration failed: ${messageOf(error)}`);
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Make sure this bot has a machine with usable storage.
   *
   * Two jobs since D-046, and the order matters: attach the bot to its user's
   * computer — creating that computer and its volume the first time — and then
   * diagnose that computer's workspace. A bot that joins an existing machine
   * therefore provisions nothing, which is the cost saving the decision was
   * about.
   */
  async ensure(userId: string, botId: string): Promise<void> {
    const problem = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${userId} FOR NO KEY UPDATE`;
        await tx.$executeRaw`SELECT 1 FROM "Bot" WHERE id = ${botId} AND "userId" = ${userId} FOR UPDATE`;
        const bot = await tx.bot.findFirst({ where: { id: botId, userId } });
        if (bot === null) throw new NotFoundException('Bot not found');
        // Attach first, so a bot that has never had a machine gets its
        // user's one (creating it if this is the first bot) before anything
        // below asks about that machine's workspace.
        const computerId =
          bot.sandboxId ?? (await attachToComputer(tx, userId, botId, this.provider));
        await tx.$executeRaw`SELECT 1 FROM "Sandbox" WHERE id = ${computerId} FOR UPDATE`;
        const row = await tx.sandbox.findUnique({ where: { id: computerId } });
        // A lifecycle holder already owns Docker I/O. Never inspect/mount around it.
        if (row?.workspacePending || row?.pausePending) return null;
        if (row?.state === 'RUNNING') return null;
        if (row?.state === 'STARTING') return null;
        // The provider's `botId` parameter is the workspace key, and under
        // D-046 that key is the COMPUTER's id. `attachToComputer` already
        // created the row and its volume when there was none, so a missing
        // workspace here is a machine whose storage went away underneath it,
        // which is the recoverable diagnosis below rather than a reason to
        // silently make a new empty one.
        const workspace = await this.provider.inspectWorkspace({ botId: computerId });

        let reason: string | null = null;
        if (!workspace.exists)
          reason = 'Workspace missing; storage will not be recreated automatically';
        else if (!workspace.ok) reason = workspace.reason;
        else if (
          row === null ||
          (row.state === 'STOPPED' &&
            row.sessionId === null &&
            row.containerId === null &&
            row.lastStartedAt === null)
        ) {
          try {
            const history = await this.provider.inspectWorkspaceHistory({ botId: computerId });
            if (row === null || history.referenced || history.runtimeCreatedAt !== null)
              reason =
                'Saved workspace has runtime history or unknown provenance; explicit recovery required';
          } catch (error: unknown) {
            reason = `Workspace history could not be verified: ${messageOf(error)}`;
          }
        }
        if (reason === null) return null;
        // Persist the recoverable diagnosis, but never erase session/history evidence.
        await tx.sandbox.update({
          where: { id: computerId },
          data: { state: 'UNHEALTHY', lastError: reason },
        });
        return reason;
      },
      { timeout: 30_000 },
    );
    if (problem !== null) throw new ServiceUnavailableException(problem);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
