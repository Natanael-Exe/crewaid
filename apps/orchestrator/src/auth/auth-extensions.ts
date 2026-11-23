import type { BetterAuthPlugin } from 'better-auth';
import type { Edition } from '@crewaid/shared';

/**
 * Better Auth plugins contributed from outside the core (D-238).
 *
 * The cloud edition's operator accounts and its Stripe webhook are Better Auth
 * plugins, and they live under `ee/`, which the core may not import. So the
 * core holds this registry and `ee/` fills it.
 *
 * Why a registry read at construction, not a Nest provider
 *
 * `auth` is built when `better-auth.ts` is first imported, before Nest exists,
 * and seven core modules import that instance. A plugin therefore has to be
 * registered before that first import, which is why the cloud entrypoint and
 * `CloudAppModule` import their registration first.
 *
 * Why reading seals it
 *
 * A registration that arrives after `auth` was built would be ignored: the
 * process would boot without, say, the Stripe webhook and fail only when
 * Stripe calls. Sealing on the first read turns that ordering mistake into an
 * error at startup.
 */
export type AuthExtension = (context: { readonly edition: Edition }) => BetterAuthPlugin[];

const extensions: AuthExtension[] = [];
let sealed = false;

export function registerAuthExtension(extension: AuthExtension): void {
  if (sealed) {
    throw new Error(
      'registerAuthExtension: the Better Auth instance was already built, so this plugin would ' +
        'be ignored. Import the registration before anything that imports auth/better-auth.',
    );
  }
  extensions.push(extension);
}

/** The plugins every registered extension contributes for `edition`. Seals the registry. */
export function extensionPlugins(context: { readonly edition: Edition }): BetterAuthPlugin[] {
  sealed = true;
  return extensions.flatMap((extension) => extension(context));
}
