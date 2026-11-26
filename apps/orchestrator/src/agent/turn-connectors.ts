import { Injectable } from '@nestjs/common';

import type { RegisteredTool } from './tool-registry.js';

/**
 * Neutral holder through which a turn asks for the user's opt-in local
 * connector tools (`list_local_connectors`, `local_code_task`).
 *
 * Follows the exact `TurnPlugins` pattern: owned and exported by `BotsModule`,
 * populated on init by `ConnectorsModule` so `BotsModule` never imports
 * `ConnectorsModule` back.
 */
export type TurnConnectorTools = {
  readonly tools: readonly RegisteredTool[];
  readonly hasConnectors: boolean;
};

export const NO_CONNECTOR_TOOLS: TurnConnectorTools = {
  tools: [],
  hasConnectors: false,
};

export interface TurnConnectorSource {
  toolsForTurn(userId: string, botId: string, botName: string): Promise<TurnConnectorTools>;
}

@Injectable()
export class TurnConnectors {
  private source: TurnConnectorSource | undefined;

  use(source: TurnConnectorSource): void {
    if (this.source !== undefined) {
      throw new Error('A turn connector source is already bound; there can be only one.');
    }
    this.source = source;
  }

  toolsForTurn(userId: string, botId: string, botName: string): Promise<TurnConnectorTools> {
    return (
      this.source?.toolsForTurn(userId, botId, botName) ?? Promise.resolve(NO_CONNECTOR_TOOLS)
    );
  }
}
