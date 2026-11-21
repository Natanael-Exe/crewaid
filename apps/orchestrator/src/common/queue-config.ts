/**
 * What every BullMQ queue in this orchestrator needs to know before it opens
 * a connection.
 *
 * Extracted from `skills/skill-compile.queue.ts` when M7 added the second
 * queue (`bot.message`) and M8's routines made it certain there would be a
 * third. The functions are unchanged; what changed is that they are no longer
 * reachable only by importing the skills feature from somewhere that has
 * nothing to do with skills.
 *
 * Pure and environment-free: every one of them takes the raw value. The one
 * reader of `process.env` is each queue's own `describe*Config`, so a test can
 * exercise the parsing without touching the real environment.
 */

/** What `BullModule.forRoot` is given, and what a worker connects with. */
export function redisConnection(redisUrl: string): { url: string; maxRetriesPerRequest: null } {
  // `maxRetriesPerRequest: null` is required by BullMQ for a blocking
  // connection: with ioredis's default, a reconnect aborts the blocking
  // command a worker sits on and the worker stops consuming without saying so.
  return { url: redisUrl, maxRetriesPerRequest: null };
}

/**
 * Whether this deployment has a queue at all.
 *
 * No default parameter, deliberately: `queueRedisUrl(undefined)` would then
 * fall back to reading the environment, so "this caller has no URL" and "this
 * caller did not say" would take different paths through the same call.
 */
export function queueRedisUrl(raw: string | undefined): string | null {
  return raw === undefined || raw.trim() === '' ? null : raw;
}

/**
 * Whether this process CONSUMES a given queue, rather than only enqueuing.
 *
 * A config key rather than a hardcoded rule, for the reason
 * `SANDBOX_RECONCILE_ON_BOOT` is one: a `@Processor` starts a worker in EVERY
 * Nest context that has it, and the integration suites boot the application
 * many times against one shared Redis. Without a way off, every suite would
 * consume every other suite's jobs and run real work for them.
 *
 * The key is a parameter so the error names the variable the operator
 * actually set. A shared reader whose message named one queue's key would
 * send the reader of the other queue's failure to the wrong line of `.env`.
 */
export function readWorkerEnabled(key: string, raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return true;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${key} must be 'true' or 'false', got ${JSON.stringify(raw)}`);
}
