// First, before anything that builds the auth instance: a cloud boot belongs
// to ee/main.ts, and should say so rather than fail on a missing variable.
import './assert-oss-edition.js';
import 'reflect-metadata';
import { AppModule } from './app.module.js';
import { bootstrap } from './bootstrap.js';

/**
 * The AGPL orchestrator's entrypoint: the self-hosted edition.
 *
 * The cloud edition boots from `ee/main.ts` (D-238), which adds the modules
 * the core leaves out. Startup itself is shared, in `bootstrap.ts`.
 */
void bootstrap(AppModule);
