import { EDITIONS, EditionSchema, type Edition } from '@crewaid/shared';

/**
 * `CREWAID_EDITION`, read at boot.
 *
 * Required, with no default. The edition decides how people sign in and, once
 * they exist, whether billing and the built-in model provider do — so a
 * missing value must not quietly pick one. A hosted server that booted as
 * `selfhosted` would open password sign-up to the internet; a self-hosted one
 * that booted as `cloud` would offer sign-in methods nobody configured.
 *
 * Billing, usage metering and any built-in model provider are registered only
 * when this answers `cloud`, so a `selfhosted` server exposes none of their
 * routes. That is the rule every later feature in that family follows.
 */
export function readEdition(env: Readonly<Record<string, string | undefined>>): Edition {
  const raw = (env['CREWAID_EDITION'] ?? '').trim();
  const parsed = EditionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `CREWAID_EDITION must be ${EDITIONS.map((e) => `"${e}"`).join(' or ')}, got ` +
        `${JSON.stringify(raw)} (see infra/compose/.env.example)`,
    );
  }
  return parsed.data;
}
