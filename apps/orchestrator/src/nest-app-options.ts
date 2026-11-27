import type { NestApplicationOptions } from '@nestjs/common';

/**
 * Shared NestJS application options for both editions.
 *
 * - `rawBody`: keeps the exact request bytes beside the parsed body. Stripe
 *   signs the bytes it sends, and the Better Auth middleware hands them on so a
 *   webhook verifies.
 * - `routeConflictPolicy`: fails boot on duplicate routes and only warns on
 *   shadows, because under the default `'declaration'` strategy Nest reports a
 *   correctly ordered literal-before-parameter pair as a shadow too.
 *
 * Kept apart from `bootstrap.ts`, which loads Better Auth and so needs
 * `DATABASE_URL` at import, so a test can boot with these options without one.
 */
export const NEST_APP_OPTIONS: NestApplicationOptions = {
  rawBody: true,
  routeConflictPolicy: { duplicate: 'error', shadow: 'warn' },
};
