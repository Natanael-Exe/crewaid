import { registerAuthExtension } from '../../auth/auth-extensions.js';
import { processBillingConfig } from '../billing/billing.config.js';
import { cloudAuthPlugins } from './cloud-auth-plugins.js';

/**
 * Adds the cloud edition's Better Auth plugins to the core's registry (D-238).
 *
 * Imported for its side effect, and FIRST, by `ee/main.ts` and
 * `CloudAppModule`: the core's `auth` instance is built when
 * `auth/better-auth.ts` is first imported, and the registry refuses a plugin
 * that arrives after that.
 *
 * A self-hosted instance built in the same process (tests build both) gets
 * nothing, and the billing config is read when the instance is built rather
 * than here, so it follows the environment at that moment.
 */
registerAuthExtension(({ edition }) =>
  edition === 'cloud' ? cloudAuthPlugins(processBillingConfig(edition)) : [],
);
