// First: the core's auth instance is built when auth/better-auth is first
// imported, and the cloud plugins must be registered by then.
import './auth/register-cloud-auth.js';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { bootstrap } from '../bootstrap.js';
import { CloudAppModule } from './cloud-app.module.js';

/**
 * The cloud edition's entrypoint, `node dist/ee/main.js` (D-238).
 *
 * The same startup as the self-hosted edition, around `CloudAppModule`.
 * Licensed under the Crewaid Enterprise License (`ee/LICENSE.md`), not the AGPL.
 */
new Logger('Bootstrap').log(
  'Crewaid Enterprise modules enabled (licensed under apps/orchestrator/src/ee/LICENSE.md)',
);
void bootstrap(CloudAppModule);
