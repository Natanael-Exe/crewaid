/**
 * `node packages/sandbox-supervisor/dist/main.js` — the one process with the
 * Docker socket. Configuration is read once, at boot, so a missing
 * secret or a bad limit fails here rather than at the first computer start.
 */

import { readSupervisorConfig } from './admission.js';
import { createDockerEngine } from './docker-engine.js';
import { createSupervisorServer } from './server.js';

const config = readSupervisorConfig(process.env);
const engine = createDockerEngine({
  publishOn: config.publishOn,
  connect: config.connect,
  network: config.network,
});
const server = createSupervisorServer({ config, engine });

server.listen(config.port, config.host, () => {
  process.stdout.write(
    `${JSON.stringify({
      time: Date.now(),
      event: 'supervisor.listening',
      host: config.host,
      port: config.port,
      image: config.image,
      network: config.network,
    })}\n`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
