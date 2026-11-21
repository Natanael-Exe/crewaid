import { z } from 'zod';

/**
 * Every enum in PRD §3, verbatim.
 *
 * These names cross the wire and land in Postgres. Do not reorder, rename, or
 * extend without a PRD revision — five other codebases read these values.
 */

export const BotStatusSchema = z.enum(['IDLE', 'THINKING', 'ACTING', 'AWAITING_APPROVAL', 'ERROR']);
export type BotStatus = z.infer<typeof BotStatusSchema>;

export const MessageAuthorSchema = z.enum(['USER', 'BOT', 'SYSTEM', 'TOOL']);
export type MessageAuthor = z.infer<typeof MessageAuthorSchema>;

/**
 * The library's run vocabulary, so a run's status crosses no
 * translation. `interrupted` waits for a person and is not terminal; a run
 * whose worker died is `failed`, with `WORKER_LOST` as its error code.
 */
export const TurnStatusSchema = z.enum([
  'running',
  'interrupted',
  'completed',
  'failed',
  'aborted',
]);
export type TurnStatus = z.infer<typeof TurnStatusSchema>;

export const SandboxStateSchema = z.enum(['STOPPED', 'STARTING', 'RUNNING', 'UNHEALTHY', 'ERROR']);
export type SandboxState = z.infer<typeof SandboxStateSchema>;

export const RecordingStateSchema = z.enum([
  'RECORDING',
  'COMPILING',
  'READY',
  'FAILED',
  'DISCARDED',
]);
export type RecordingState = z.infer<typeof RecordingStateSchema>;

/**
 * Why a recording stopped itself, rather than because someone asked it to
 * (the hard limits, M3-BE-05).
 *
 * `READY` alone cannot say this: a recording the user stopped and one the
 * 5000-event ceiling cut off settle to the same state, and the difference is
 * the whole reason the trace ends where it does. Null on every recording that
 * ended when asked.
 */
export const RecordingWarningSchema = z.enum(['EVENT_LIMIT', 'TIME_LIMIT']);
export type RecordingWarning = z.infer<typeof RecordingWarningSchema>;

/** `ATSPI` exists in v1 but stays unused — */
export const CaptureLayerSchema = z.enum(['X11', 'CDP', 'ATSPI']);
export type CaptureLayer = z.infer<typeof CaptureLayerSchema>;

export const SkillStatusSchema = z.enum(['DRAFT', 'APPROVED', 'ARCHIVED']);
export type SkillStatus = z.infer<typeof SkillStatusSchema>;

export const RunStatusSchema = z.enum(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * Who created a `Routine`. A bot may schedule its own follow-ups;
 * the operator sees, audits and deletes them beside their own.
 */
export const RoutineOriginSchema = z.enum(['OPERATOR', 'BOT']);
export type RoutineOrigin = z.infer<typeof RoutineOriginSchema>;

/** v1 supports remote transports only. `stdio` is deferred to v2. */
export const McpTransportSchema = z.enum(['HTTP', 'SSE']);
export type McpTransport = z.infer<typeof McpTransportSchema>;

export const McpAuthTypeSchema = z.enum(['NONE', 'OAUTH2', 'HEADER']);
export type McpAuthType = z.infer<typeof McpAuthTypeSchema>;

export const McpStatusSchema = z.enum([
  'DISCONNECTED',
  'CONNECTING',
  'CONNECTED',
  'NEEDS_REAUTH',
  'ERROR',
]);
export type McpStatus = z.infer<typeof McpStatusSchema>;

/**
 * Which product a build or a server is.
 *
 * `cloud` is the hosted service: the desktop's orchestrator address is fixed at
 * build time and sign-in goes through Google, GitHub or a magic link.
 * `selfhosted` is someone running the orchestrator themselves: the desktop asks
 * for the address, sign-in is email and password only so an install needs no
 * identity provider or mail service, and nothing the hosted service charges for
 * (billing, usage limits, a built-in model provider) exists on it.
 *
 * Decided once per build and once per server, never by a user at run time —
 * an edition a person could switch is a paywall with a settings toggle.
 */
export const EDITIONS = ['cloud', 'selfhosted'] as const;
export const EditionSchema = z.enum(EDITIONS);
export type Edition = z.infer<typeof EditionSchema>;
