import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { queueRedisUrl } from '../common/queue-config.js';
import { bridgeRunEventWakeups, RunEventWakeups } from '../agent/persistence/run-event-log.js';

/**
 * This process's run-event wake-ups. With `REDIS_URL` set they are
 * bridged so a reader on this worker tails a producer on another; without it
 * the deployment is one worker and local wake-ups are complete.
 */
@Injectable()
export class RunEventWakeupsService
  extends RunEventWakeups
  implements OnModuleInit, OnModuleDestroy
{
  private redis: { readonly close: () => Promise<void> } | undefined;

  async onModuleInit(): Promise<void> {
    const url = queueRedisUrl(process.env['REDIS_URL']);
    if (url !== null) this.redis = await bridgeRunEventWakeups(this, url);
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.close();
  }
}
