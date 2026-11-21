import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { StructuredLogger } from '../logging/structured-logger.js';
import { purgeExpiredRunEvents } from '../agent/persistence/run-event-log.js';

const SWEEP_MS = 60 * 60 * 1000;

/**
 * retention: closed logs older than the retention period are deleted at
 * boot and hourly. Bounded storage is the point; a missed sweep only delays it,
 * so a failure is logged and the next one retries.
 */
@Injectable()
export class RunEventRetentionService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  onModuleInit(): void {
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async sweep(): Promise<number> {
    try {
      return await purgeExpiredRunEvents(this.prisma);
    } catch (error) {
      this.logger.warn('run_events.retention.failed', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return 0;
    }
  }
}
