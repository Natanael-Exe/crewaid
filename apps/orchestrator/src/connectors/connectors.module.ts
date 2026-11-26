import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';

import { CodingRunStoreService } from '../agent/coding/coding-run-store.service.js';
import {
  NO_CONNECTOR_TOOLS,
  TurnConnectors,
  type TurnConnectorSource,
  type TurnConnectorTools,
} from '../agent/turn-connectors.js';
import { TurnEventsModule } from '../agent/turn-events.module.js';
import { BotsModule } from '../bots/bots.module.js';
import { LoggingModule } from '../logging/logging.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ConnectorWsHost } from './connector-ws.host.js';
import { ConnectorsController } from './connectors.controller.js';
import { ConnectorsService } from './connectors.service.js';
import { localConnectorTools } from './local-coding-tools.js';
import { LocalConnectorCodingRunner } from './local-connector-runner.service.js';

@Injectable()
class ConnectorsTurnRegistrar implements OnModuleInit, TurnConnectorSource {
  constructor(
    @Inject(TurnConnectors) private readonly holder: TurnConnectors,
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(LocalConnectorCodingRunner) private readonly runner: LocalConnectorCodingRunner,
    @Inject(CodingRunStoreService) private readonly runs: CodingRunStoreService,
  ) {}

  onModuleInit(): void {
    this.holder.use(this);
  }

  async toolsForTurn(userId: string, botId: string, botName: string): Promise<TurnConnectorTools> {
    const hasConnectors = await this.connectors.hasActiveConnectors(userId);
    if (!hasConnectors) return NO_CONNECTOR_TOOLS;
    return {
      hasConnectors: true,
      tools: localConnectorTools({
        userId,
        botId,
        botName,
        connectors: this.connectors,
        runner: this.runner,
        runs: this.runs,
      }),
    };
  }
}

/**
 * Opt-in local coding connectors (`crewaid-connect`, D-241 Step 5).
 *
 * Imports `BotsModule` (never the reverse) and registers its per-turn tool
 * provider into `TurnConnectors` on init, mirroring `McpModule` / `TurnPlugins`.
 */
@Module({
  imports: [PrismaModule, TurnEventsModule, LoggingModule, BotsModule],
  controllers: [ConnectorsController],
  providers: [
    ConnectorsService,
    ConnectorWsHost,
    LocalConnectorCodingRunner,
    ConnectorsTurnRegistrar,
  ],
  exports: [ConnectorsService, ConnectorWsHost, LocalConnectorCodingRunner],
})
export class ConnectorsModule {}
