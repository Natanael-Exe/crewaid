import { join } from 'node:path';
import { SCREEN_GATEWAY_PORT } from '@crewaid/shared';
import type { ScreenLogger } from '@crewaid/screen-stream';

import { SCREEN_KEY_FILENAME, ScreenGateway } from './gateway.js';

/**
 * The sandbox image's screen gateway process. Started by the image's
 * entrypoint as `bot`, beside the agent bridge, and bundled into one file at
 * image build time, so the computer needs no node_modules for it.
 */
const logger: ScreenLogger = {
  log: (message) => console.log(`[screen-gateway] ${message}`),
  warn: (message) => console.warn(`[screen-gateway] ${message}`),
  debug: () => undefined,
};

async function main(): Promise<void> {
  const port = Number(process.env['CREWAID_SCREEN_GATEWAY_PORT'] ?? SCREEN_GATEWAY_PORT);
  const keyFile =
    process.env['CREWAID_SCREEN_KEY_FILE'] ??
    join(process.env['XDG_RUNTIME_DIR'] ?? '/tmp', SCREEN_KEY_FILENAME);
  const gateway = new ScreenGateway({ keyFile, logger });
  await gateway.listen(port);
  logger.log(`serving screens on 127.0.0.1:${port}`);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void gateway.close().finally(() => process.exit(0));
    });
  }
}

main().catch((error: unknown) => {
  logger.warn(`could not start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
