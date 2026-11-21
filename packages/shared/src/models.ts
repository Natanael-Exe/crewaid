import { z } from 'zod';
import {
  BotStatusSchema,
  CaptureLayerSchema,
  McpAuthTypeSchema,
  McpStatusSchema,
  McpTransportSchema,
  MessageAuthorSchema,
  RecordingStateSchema,
  RecordingWarningSchema,
  RoutineOriginSchema,
  RunStatusSchema,
  SandboxStateSchema,
  SkillStatusSchema,
  TurnStatusSchema,
} from './enums.js';
import {
  CronSchema,
  CuidSchema,
  DateTimeSchema,
  HexColorSchema,
  JsonSchema,
  JsonSchemaObjectSchema,
  SlugSchema,
  SnakeCaseSchema,
  TimezoneSchema,
} from './primitives.js';
import { ApprovalModeSchema, AutoReviewRulesSchema } from './agent.js';
import { ModelRefSchema } from './providers.js';

/**
 * PRD §3 data model, one schema per Prisma model.
 *
 * FIELD NAMES ARE CONTRACTUAL. These mirror `prisma/schema.prisma` exactly.
 * If you change a name here you have broken the orchestrator, the Electron
 * client, and every test in the repo simultaneously. Change the PRD first.
 *
 * Relation fields (`bot`, `user`, `messages`, …) are intentionally omitted:
 * they are Prisma navigation properties, not wire fields. Schemas that need an
 * embedded relation compose it explicitly (see `MessageWithAttachmentsSchema`).
 */

// User
// Deviation 7: the four Better Auth columns sit beside the three, and
// `email` is no longer nullable. Every V1 sign-in method — Google, GitHub, a
// magic link — reaches an account BY EMAIL, so a nullable address describes a
// row nothing can sign into. The version described the seeded singleton,
// which had no way in and therefore needed none.

export const UserSchema = z.object({
  id: CuidSchema,
  /** Required by Better Auth's core schema; supplied by the identity provider. */
  name: z.string().min(1).max(200),
  email: z.email(),
  emailVerified: z.boolean(),
  /** Avatar URL from the identity provider, when it gave one. */
  image: z.string().nullable(),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type User = z.infer<typeof UserSchema>;

// Bot

/**
 * The mascot silhouette a bot is drawn with.
 *
 * Named rather than an index into the renderer's shape array: an index makes
 * every bot's appearance depend on that array's ORDER, so inserting a ninth
 * shape in the middle would restyle rows already in the database.
 */
export const AvatarShapeSchema = z.enum([
  'circle',
  'square',
  'polygon',
  'egg',
  'bulb',
  'cloud',
  'shield',
  'splat',
]);
export type AvatarShape = z.infer<typeof AvatarShapeSchema>;

export const BotSchema = z.object({
  kind: z.enum(['STANDARD', 'MAIN']).default('STANDARD'),
  id: CuidSchema,
  userId: CuidSchema,
  name: z.string().min(1).max(64),
  role: z.string().min(1).max(128),
  avatarColor: HexColorSchema,
  /** Null means "not chosen" — the renderer derives one from `name`. */
  avatarShape: AvatarShapeSchema.nullable(),
  /** An uploaded picture, drawn instead of the mascot when set. */
  avatarUrl: z.string().nullable(),
  systemPrompt: z.string(),
  /**
   * A `ProviderModel` row id, or the literal alias `default` — which
   * resolves per-user against `UserSettings.defaultModelId`, not against a
   * process-wide environment variable.
   *
   * NOT PARSEABLE. This was a `provider:model` registry key; anything
   * splitting it on ':' is now reading a cuid.
   */
  modelId: ModelRefSchema,
  status: BotStatusSchema,
  sortOrder: z.number().int(),
  pinned: z.boolean(),
  hiddenFromSidebar: z.boolean(),
  /** Ordered auto-review rules, first match wins; empty means always ask. */
  autoReviewRules: AutoReviewRulesSchema,
  /**
   * How this bot's actions are approved. Defaulted so a newer app
   * reading an older orchestrator sees the behaviour that orchestrator has.
   */
  approvalMode: ApprovalModeSchema.default('AUTO'),
  /** The ElevenLabs voice this bot speaks in; null is the house voice. */
  voiceId: z.string().min(1).max(64).nullable().default(null),
  /**
   * The computer this bot works on. Null means detached — a bot that
   * has never started, or one whose machine was deleted out from under it.
   * Two bots with the same value share a filesystem, a browser profile and
   * every login in it; that is the point, and it is why this is on the wire
   * rather than inferred.
   */
  sandboxId: CuidSchema.nullable(),
  /**
   * The sidebar group this bot is in, or null for Unassigned.
   *
   * Defaulted rather than required because the desktop app and the
   * orchestrator ship separately: a new app reading an orchestrator from
   * before groups existed gets a bot in no group, not a CONTRACT failure on
   * every bot list.
   */
  groupId: CuidSchema.nullable().default(null),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type Bot = z.infer<typeof BotSchema>;

// Bot groups

/** A group's name, as the sidebar header shows it. */
export const BOT_GROUP_NAME_MAX = 64;
/**
 * The group's instructions are read into every member's prompt on every turn,
 * so they are bounded the way a prompt has to be, not the way a document is.
 */
export const BOT_GROUP_INSTRUCTIONS_MAX = 8000;

/**
 * A named set of bots. It shares `instructions` with its members and a
 * folder on the machine; it gives none of them a role over the others.
 */
export const BotGroupSchema = z.object({
  id: CuidSchema,
  userId: CuidSchema,
  name: z.string().min(1).max(BOT_GROUP_NAME_MAX),
  instructions: z.string().max(BOT_GROUP_INSTRUCTIONS_MAX),
  sortOrder: z.number().int(),
  collapsed: z.boolean(),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type BotGroup = z.infer<typeof BotGroupSchema>;

// Conversation

export const ConversationSchema = z.object({
  id: CuidSchema,
  botId: CuidSchema,
  createdAt: DateTimeSchema,
});
export type Conversation = z.infer<typeof ConversationSchema>;

// Attachment

/**
 * What an attachment is for. A `VOICE_NOTE` is a recorded or spoken
 * clip: on a person's message it makes the reply spoken, on a bot's message it
 * is that spoken reply.
 */
export const AttachmentKindSchema = z.enum(['FILE', 'VOICE_NOTE']);
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;

export const AttachmentSchema = z.object({
  id: CuidSchema,
  messageId: CuidSchema,
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  storageKey: z.string().min(1),
  /** Defaulted, like the fields, so a newer app reads an older orchestrator. */
  kind: AttachmentKindSchema.default('FILE'),
  /** A voice note's length, when it is known. */
  durationMs: z.number().int().nonnegative().nullable().default(null),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

// Message

export const MessageSchema = z.object({
  id: CuidSchema,
  conversationId: CuidSchema,
  author: MessageAuthorSchema,
  /** Set when author = BOT. */
  fromBotId: CuidSchema.nullable(),
  content: z.string(),
  /** Structured message parts persisted verbatim. */
  parts: JsonSchema.nullable(),
  /** Finish reason, including the durable "interrupted" restart marker. */
  stopReason: z.string().nullable(),
  /** Inter-bot conversation chain. */
  chainId: CuidSchema.nullable(),
  hopCount: z.number().int().nonnegative(),
  /**
   * The task this message is about — a Start brief, or work another bot
   * delegated with `send_message({taskId})`. Defaulted, like the fields, so
   * a newer app reading an older orchestrator gets "no task" rather than a
   * CONTRACT failure on every transcript.
   */
  taskId: CuidSchema.nullable().default(null),
  /** The routine that posted this message, for filing its outputs. */
  routineId: CuidSchema.nullable().default(null),
  /**
   * A `/new` boundary. A turn's history starts after the newest one;
   * the transcript still shows everything before it.
   */
  startsTopic: z.boolean().default(false),
  createdAt: DateTimeSchema,
});
export type Message = z.infer<typeof MessageSchema>;

/** `message.created` carries the full Message with attachments. */
export const MessageWithAttachmentsSchema = MessageSchema.extend({
  attachments: z.array(AttachmentSchema),
});
export type MessageWithAttachments = z.infer<typeof MessageWithAttachmentsSchema>;

// AgentTurn
// One row per completed agent step, written before the next step starts.

export const AgentTurnSchema = z.object({
  id: CuidSchema,
  botId: CuidSchema,
  triggerMessageId: CuidSchema,
  status: TurnStatusSchema,
  stepIndex: z.number().int().nonnegative(),
  /** Array of completed turn step results. */
  steps: JsonSchema,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /**
   * D-009(3). Cached reads bill at a fraction of fresh input once CC-11 lands.
   * These stay separate from `inputTokens` because the daily cap is a HARD
   * stop — conflating them means false halts or blown budgets, and CC-12's
   * per-provider cost table cannot be correct without the split.
   */
  cachedInputTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  startedAt: DateTimeSchema,
  endedAt: DateTimeSchema.nullable(),
  stopReason: z.string().nullable(),
});
export type AgentTurn = z.infer<typeof AgentTurnSchema>;

// Sandbox

/** A TCP port. Nullable in the schema: unset until the container is running. */
const PortSchema = z.number().int().min(1).max(65535);

export const SandboxSchema = z.object({
  /**
   * Also the workspace key. The durable volume is
   * `crewaid-workspace-<id>`, which for a machine migrated from a single bot is
   * that bot's old id — which is why this reads like a bot id in an existing
   * install and is not one.
   */
  id: CuidSchema,
  /**
   * The owner. Was `botId`, when a machine belonged to exactly one bot;
   * a machine is now shared by the bots attached to it, and `Bot.sandboxId` is
   * the edge that says which. A client showing "this bot's computer" reads the
   * bot's side, never this one.
   */
  userId: CuidSchema,
  /** Harness session id, used for `resumeSession`. */
  sessionId: z.string().min(1).nullable(),
  containerId: z.string().min(1).nullable(),
  state: SandboxStateSchema,
  /** Fixed for the container's entire lifetime. Never renegotiated. */
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  vncPort: PortSchema.nullable(),
  cdpPort: PortSchema.nullable(),
  bridgePort: PortSchema.nullable(),
  lastStartedAt: DateTimeSchema.nullable(),
  lastError: z.string().nullable(),
  /**
   * D-039 §10, the two clocks idle stop runs on. Not in PRD §3 — ratified as a
   * deviation the way `Bot.autoReviewRules` was, and named here because
   * `GET /bots` returns the whole sandbox row: a column on the wire that the
   * contract does not name is exactly the drift this package exists to stop.
   *
   * `null` means "no evidence", not "never" — see the migration.
   */
  lastActiveAt: DateTimeSchema.nullable(),
  /** The explicit keep-running lease. Past or `null` means no lease held. */
  keepRunningUntil: DateTimeSchema.nullable(),
});
export type Sandbox = z.infer<typeof SandboxSchema>;

// Recording

export const RecordingSchema = z.object({
  id: CuidSchema,
  botId: CuidSchema,
  state: RecordingStateSchema,
  intent: z.string().nullable(),
  /** False when Chrome/CDP was unreachable; capture degraded to X11. */
  cdpAvailable: z.boolean(),
  /** Why capture ended early; null when it ended when asked. */
  warning: RecordingWarningSchema.nullable(),
  /** Why a FAILED recording failed; null in every other state. */
  error: z.string().nullable(),
  startedAt: DateTimeSchema,
  endedAt: DateTimeSchema.nullable(),
});
export type Recording = z.infer<typeof RecordingSchema>;

export const RecordingEventSchema = z.object({
  id: CuidSchema,
  recordingId: CuidSchema,
  tsOffsetMs: z.number().int().nonnegative(),
  layer: CaptureLayerSchema,
  /** "click" | "type" | "navigate" | "input" | … — open by design. */
  type: z.string().min(1),
  payload: JsonSchema,
  /** Set on X11 clicks only. */
  screenshotKey: z.string().min(1).nullable(),
  /** Set by the M4 correlator. */
  correlatedWithId: CuidSchema.nullable(),
});
export type RecordingEvent = z.infer<typeof RecordingEventSchema>;

// Skill

/**
 * One plain-language sentence of the task, in order — what the compiler wrote
 * from the trace it read, and what the review surface opens on. The caps are
 * the validator's: a summary nobody reads is noise, so the wire shape
 * refuses what the compile path refuses.
 */
export const SkillStepsSchema = z.array(z.string().min(1).max(300)).max(30);
export type SkillSteps = z.infer<typeof SkillStepsSchema>;

export const SkillSchema = z.object({
  id: CuidSchema,
  /** Null = available to all bots. */
  botId: CuidSchema.nullable(),
  name: SnakeCaseSchema,
  description: z.string(),
  /** JSON Schema for the skill's arguments. */
  paramsSchema: JsonSchemaObjectSchema,
  /**
   * The task as the compiler summarized it, in plain language — the review
   * surface's default view. Deviation 10: PRD §3 gives a compiled
   * skill's human summary nowhere to live.
   */
  steps: SkillStepsSchema,
  /** TypeScript module source. Model-generated ⇒ untrusted. */
  script: z.string(),
  version: z.number().int().positive(),
  status: SkillStatusSchema,
  sourceRecordingId: CuidSchema.nullable(),
  createdAt: DateTimeSchema,
});
export type Skill = z.infer<typeof SkillSchema>;

export const SkillRunSchema = z.object({
  id: CuidSchema,
  skillId: CuidSchema,
  params: JsonSchema,
  status: RunStatusSchema,
  logs: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: DateTimeSchema.nullable(),
  endedAt: DateTimeSchema.nullable(),
});
export type SkillRun = z.infer<typeof SkillRunSchema>;

// Mcp

export const McpServerSchema = z
  .object({
    id: CuidSchema,
    userId: CuidSchema,
    name: z.string().min(1),
    /** Used for tool namespacing as `<slug>__<toolName>`. */
    slug: SlugSchema,
    category: z.string().nullable(),
    iconUrl: z.string().nullable(),
    accessMode: z.enum(['SELECTED', 'ALL']),
    accessRevision: z.number().int().nonnegative(),
    backend: z.enum(['DIRECT', 'COMPOSIO']),
    transport: McpTransportSchema.nullable(),
    url: z.url().nullable(),
    /** User-added by URL vs directory entry. */
    isPrivate: z.boolean(),
    authType: McpAuthTypeSchema,
    status: McpStatusSchema,
    lastError: z.string().nullable(),
    createdAt: DateTimeSchema,
  })
  .refine(
    (server) =>
      server.backend === 'COMPOSIO'
        ? server.url === null &&
          server.transport === null &&
          !server.isPrivate &&
          server.authType === 'OAUTH2'
        : server.url !== null && server.transport !== null,
    { message: 'Plugin backend and transport do not match.' },
  );
export type McpServer = z.infer<typeof McpServerSchema>;

/**
 * The three coordinates a REFRESH needs, as M6-BE-05 stores them.
 *
 * A refresh token is not enough on its own: RFC 6749's refresh grant also
 * wants the endpoint that issued it, the client it belongs to, and RFC 8707's
 * resource. The connect flow is the only thing that ever learns them — its
 * `McpOAuthFlow` row is deleted as the single-use row it is — so the
 * credential carries them from then on.
 *
 * NOT SECRET, and this is the one column on `McpCredential` that is not
 * ciphertext: the client id is a PUBLIC PKCE client's (M6's registration asks
 * for `token_endpoint_auth_method: "none"`), the endpoint is a URL the user's
 * browser has already been sent to, and the resource is the server's own URL.
 * Never a bearer, never token material.
 */
export const McpAuthMetadataSchema = z.object({
  /** Where the refresh grant is POSTed. */
  tokenEndpoint: z.url(),
  /** The client the grant belongs to; public, so there is no secret beside it. */
  clientId: z.string().min(1),
  /** The resource the token is for, echoed from the original authorization. */
  resource: z.url(),
});
export type McpAuthMetadata = z.infer<typeof McpAuthMetadataSchema>;

/**
 * SECURITY. BOTH TOKEN COLUMNS are encrypted at rest with
 * CREDENTIAL_KEY before they reach Prisma; `authMetadata` is not, because it
 * holds no secret (see the schema above and D-103). This schema exists to
 * validate rows INSIDE the orchestrator only. It must never be used to shape
 * an API response and must never be passed to a sandbox. There is a deliberate
 * absence of a `McpCredentialDto` in `rest.ts` — that absence is the contract.
 */
export const McpCredentialSchema = z.object({
  id: CuidSchema,
  serverId: CuidSchema,
  accessToken: z.string(),
  refreshToken: z.string().nullable(),
  expiresAt: DateTimeSchema.nullable(),
  scopes: z.array(z.string()),
  /** Null for a row written before M6-BE-05: usable until it expires. */
  authMetadata: McpAuthMetadataSchema.nullable(),
  updatedAt: DateTimeSchema,
});
export type McpCredential = z.infer<typeof McpCredentialSchema>;

export const McpToolSchema = z.object({
  id: CuidSchema,
  serverId: CuidSchema,
  /** As reported by the server. */
  name: z.string().min(1),
  description: z.string(),
  inputSchema: JsonSchemaObjectSchema,
  /** Classified at list time — read-only classification. */
  readOnly: z.boolean(),
  refreshedAt: DateTimeSchema,
});
export type McpTool = z.infer<typeof McpToolSchema>;

export const BotMcpServerSchema = z.object({
  botId: CuidSchema,
  serverId: CuidSchema,
  enabled: z.boolean(),
});
export type BotMcpServer = z.infer<typeof BotMcpServerSchema>;

// Routine

export const RoutineSchema = z
  .object({
    id: CuidSchema,
    botId: CuidSchema,
    name: z.string().min(1),
    cron: CronSchema,
    timezone: TimezoneSchema,
    endsOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    prompt: z.string().nullable(),
    skillId: CuidSchema.nullable(),
    skillParams: JsonSchema.nullable(),
    enabled: z.boolean(),
    lastRunAt: DateTimeSchema.nullable(),
    lastStatus: RunStatusSchema.nullable(),
    origin: RoutineOriginSchema,
    /** The goal this routine works toward. Defaulted for older servers. */
    goalId: CuidSchema.nullable().default(null),
  })
  /** "exactly one of prompt or skillId". */
  .refine(
    (r) => (r.prompt === null) !== (r.skillId === null),
    'exactly one of prompt or skillId must be set',
  );
export type Routine = z.infer<typeof RoutineSchema>;
