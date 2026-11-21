import { z } from 'zod';

/**
 * Primitive building blocks shared by every schema in this package.
 *
 * PRD §3 field names are CONTRACTUAL. Nothing in this file may rename, alias,
 * or "improve" a field name that appears in the Prisma schema or in §4.
 */

/** Prisma `@default(cuid())`. Kept permissive: we validate shape, not issuer. */
export const CuidSchema = z.string().min(1).max(64);

/**
 * A DateTime column. Accepts a `Date` (Prisma output) or an ISO-8601 string
 * (JSON transport) and normalises to `Date`, so the same schema validates a row
 * read from Prisma and the same row after a JSON round-trip.
 */
export const DateTimeSchema = z.coerce.date();

/** Epoch milliseconds, as carried by `WsFrame.ts`. */
export const EpochMsSchema = z.number().int().nonnegative();

/** A Prisma `Json` column. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export const JsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonSchema),
    z.record(z.string(), JsonSchema),
  ]),
);

/** A JSON Schema document, e.g. `Skill.paramsSchema` and `McpTool.inputSchema`. */
export const JsonSchemaObjectSchema = z.record(z.string(), JsonSchema);

/** `Bot.avatarColor` — hex, e.g. "#8B6F47". */
export const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #RRGGBB hex colour');

/** `Skill.name` is snake_case (PRD §3, enforced by the M3 output validator). */
export const SnakeCaseSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, 'must be snake_case');

/** `McpServer.slug` — used for tool namespacing as `<slug>__<toolName>` (§M6). */
export const SlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/, 'must be a lowercase slug');

/** `Routine.cron` — 5-field cron. */
export const CronSchema = z
  .string()
  .trim()
  .refine((v) => v.split(/\s+/).length === 5, 'must be a 5-field cron expression');

/**
 * IANA timezone identifier, e.g. "America/Port-au-Prince". `UTC` is the one
 * zone without a region, and the runtime's own list offers it, so a picker
 * built from that list never produces a zone this refuses.
 */
export const TimezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((zone) => zone === 'UTC' || zone.includes('/'), 'must be an IANA timezone');

/**
 * `Identity.name` — the Chrome profile directory a shared identity IS
 * (M5-BE-27 / D-057).
 *
 * Deliberately narrower than `SlugSchema`, which it otherwise resembles: this
 * string is interpolated into `--profile-directory=` and used as a path
 * segment inside the machine's one `--user-data-dir`, so the charset is the
 * one the agent-bridge will accept and nothing more. A name that reaches the
 * bridge and is refused there fails as a seat that would not open, several
 * layers from the model that chose it.
 *
 * Case is not folded. Chrome's profile directories are case-sensitive on
 * Linux, so lowercasing here would make two names collide on one directory —
 * the opposite of what an identity is for.
 */
export const IdentityNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'must be letters, digits, underscore or hyphen');
