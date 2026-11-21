import { z } from 'zod';
import {
  EditionSchema,
  McpTransportSchema,
  MessageAuthorSchema,
  RecordingWarningSchema,
  SandboxStateSchema,
} from './enums.js';
import {
  CuidSchema,
  HexColorSchema,
  JsonSchema,
  JsonSchemaObjectSchema,
  SlugSchema,
  TimezoneSchema,
} from './primitives.js';
import { isKnownTimezone, LocaleSchema } from './locale.js';
import {
  AgentTurnSchema,
  AttachmentSchema,
  AvatarShapeSchema,
  BOT_GROUP_INSTRUCTIONS_MAX,
  BOT_GROUP_NAME_MAX,
  BotGroupSchema,
  BotSchema,
  RoutineSchema,
  SandboxSchema,
  SkillSchema,
} from './models.js';
import { ApprovalModeSchema, AutoReviewRulesSchema, ModelCapabilitiesSchema } from './agent.js';
import {
  CreatableProviderKindSchema,
  ModelRefSchema,
  ProviderConnectionWithModelsSchema,
  ProviderEndpointSchema,
  UpstreamModelIdSchema,
  UserSettingsSchema,
} from './providers.js';
import { ApprovalRequestedPayloadSchema } from './ws.js';

/**
 * REST request/response bodies. All under `/api/v1`, all JSON.
 *
 * PATHS AND BODY SHAPES ARE CONTRACTUAL. The path registry at the bottom of
 * this file is the single source of truth the Electron client builds URLs from,
 * so a typo here is a typo everywhere — which is the point.
 */

export const API_PREFIX = '/api/v1' as const;

/**
 * Where an authorization server sends the user's browser back to.
 *
 * Named here rather than written twice, because the two readers must agree on
 * ONE string: the route the orchestrator serves, and the `redirect_uri` it
 * registers with a third party. A drift between them is not a 404 — it is a
 * provider-side refusal ("redirect_uri mismatch") that this codebase never
 * sees, and the compose example already warns about exactly that class of
 * mistake for the sign-in callbacks.
 *
 * This path is AUTHENTICATED LIKE EVERY OTHER ROUTE except that one
 * exemption in `AuthGuard` names it: the browser arriving here carries no
 * session, so the `state` in the query is the entire authority. See.
 */
export const MCP_OAUTH_CALLBACK_PATH = '/mcp/oauth/callback' as const;

/**
 * ratified per-file ceiling, in bytes.
 *
 * It is a contract fence, not a server detail: the upload route answers 413
 * above it, and a client that buffers a download has to know the largest
 * response it has agreed to hold in memory. Both sides read it from here so
 * the number cannot drift on one of them.
 */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

// Bots

/**
 * the sidebar's second line, computed where the messages are.
 *
 * It used to be read off the transcript the renderer was holding, which only
 * worked for a bot whose conversation had been opened at least once — every
 * other row fell back to the bot's role. The server answers for every bot in
 * one query, so the sidebar is right on the first paint and stays right for
 * bots nobody has opened.
 *
 * `text` is the message's `content`, which is what the bot SAID: since a
 * reply's parts also carry the model's thinking, and a preview taken from
 * those would put the reasoning that opened a turn under the bot's name.
 */
export const ThreadPreviewSchema = z.object({
  text: z.string(),
  createdAt: z.coerce.date(),
});
export type ThreadPreview = z.infer<typeof ThreadPreviewSchema>;

/**
 * the bot's thread — the `threadId` every `/bots/:id/chat` route
 * requires ( §3.1). Knowing the id grants nothing: the routes still
 * derive ownership from the bot.
 */
export const BotThreadSchema = z.object({
  id: CuidSchema,
  /**
   * The newest thing said in this thread, or null when nothing has been.
   * Defaulted for the same reason `unreadCount` is: an orchestrator from
   * before this field answers without it, and that reads as "nothing yet".
   */
  preview: ThreadPreviewSchema.nullable().default(null),
});
export type BotThread = z.infer<typeof BotThreadSchema>;

/** `GET /bots` — list bots with sandbox state. */
export const BotWithSandboxSchema = BotSchema.extend({
  sandbox: SandboxSchema.nullable(),
  /** null only for a bot whose conversation a hand-migrated database lost. */
  thread: BotThreadSchema.nullable(),
  /**
   * how many of this bot's own messages the user has not read yet.
   * Defaulted for the same reason as `groupId`: an orchestrator from before
   * unread tracking answers without it, and that means nothing is unread.
   */
  unreadCount: z.number().int().nonnegative().default(0),
});
export type BotWithSandbox = z.infer<typeof BotWithSandboxSchema>;

/**
 * The `GET /bots` body is a bare array, not an envelope — `BotsService.list`
 * returns its `findMany` straight through. Named here so the client has one
 * contractual shape to parse against instead of composing `z.array` itself.
 */
export const ListBotsResponseSchema = z.array(BotWithSandboxSchema);
export type ListBotsResponse = z.infer<typeof ListBotsResponseSchema>;

/** `POST /bots` */
export const CreateBotBodySchema = z.object({
  name: z.string().min(1).max(64),
  role: z.string().min(1).max(128),
  avatarColor: HexColorSchema,
  avatarShape: AvatarShapeSchema.optional(),
  systemPrompt: z.string(),
  modelId: ModelRefSchema.optional(),
  autoReviewRules: AutoReviewRulesSchema.optional(),
  approvalMode: ApprovalModeSchema.optional(),
});
export type CreateBotBody = z.infer<typeof CreateBotBodySchema>;

/** `PATCH /bots/:id` — update profile fields. */
export const UpdateBotBodySchema = z
  .object({
    name: z.string().min(1).max(64),
    role: z.string().min(1).max(128),
    avatarColor: HexColorSchema,
    avatarShape: AvatarShapeSchema,
    systemPrompt: z.string(),
    modelId: ModelRefSchema,
    sortOrder: z.number().int(),
    pinned: z.boolean(),
    hiddenFromSidebar: z.boolean(),
    autoReviewRules: AutoReviewRulesSchema,
    /** Ask for approval, Approve for me, or Full access. */
    approvalMode: ApprovalModeSchema,
    /** move the bot into a group, or out of every group with null. */
    groupId: CuidSchema.nullable(),
    /** the voice this bot speaks in, or null for the house voice. */
    voiceId: z.string().min(1).max(64).nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'at least one field must be provided');
export type UpdateBotBody = z.infer<typeof UpdateBotBodySchema>;

/**
 * `POST /bots/:id/read` —. Without a body (or `unread: false`) every
 * message is read; `unread: true` puts the newest bot message back to unread,
 * which is what "Mark as unread" means in every chat app.
 */
export const MarkBotReadBodySchema = z.object({
  unread: z.boolean().optional(),
});
export type MarkBotReadBody = z.infer<typeof MarkBotReadBodySchema>;

/** The count after the change, so the client never has to guess it. */
export const MarkBotReadResponseSchema = z.object({
  unreadCount: z.number().int().nonnegative(),
});
export type MarkBotReadResponse = z.infer<typeof MarkBotReadResponseSchema>;

// Bot groups

/** `GET /groups` — the user's groups, in sidebar order. */
export const ListBotGroupsResponseSchema = z.array(BotGroupSchema);
export type ListBotGroupsResponse = z.infer<typeof ListBotGroupsResponseSchema>;

/** `POST /groups` */
export const CreateBotGroupBodySchema = z.object({
  name: z.string().trim().min(1).max(BOT_GROUP_NAME_MAX),
  instructions: z.string().max(BOT_GROUP_INSTRUCTIONS_MAX).optional(),
});
export type CreateBotGroupBody = z.infer<typeof CreateBotGroupBodySchema>;

/** `PATCH /groups/:id` */
export const UpdateBotGroupBodySchema = z
  .object({
    name: z.string().trim().min(1).max(BOT_GROUP_NAME_MAX),
    instructions: z.string().max(BOT_GROUP_INSTRUCTIONS_MAX),
    sortOrder: z.number().int(),
    collapsed: z.boolean(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'at least one field must be provided');
export type UpdateBotGroupBody = z.infer<typeof UpdateBotGroupBodySchema>;

// Tools

/**
 * One tool the orchestrator offers, as the composer's `/` palette shows it.
 *
 * Three vocabularies live here on purpose. `name` is the wire contract the
 * model calls and the orchestrator matches; `alias`/`label`/`summary` are what
 * a PERSON reads — "Read the page" rather than `browser_read`, in the shape a
 * slash-command palette uses. `description` stays the model-facing text, for
 * surfaces that need to explain the tool in the model's own words.
 *
 * `reach` is the approval behavior in the operator's vocabulary: a
 * `sensitive` tool asks before it runs, a `contained` one does not. That is
 * the one thing an operator choosing to mention a tool needs to know that the
 * tool's own description does not reliably say.
 */
export const ToolInfoSchema = z.object({
  name: z.string().min(1),
  /** The user-facing slash token, without the slash. */
  alias: z.string().min(1),
  /** The two-or-three-word name a row shows. */
  label: z.string().min(1),
  /** One sentence for a person: what it does, no jargon. */
  summary: z.string(),
  description: z.string(),
  reach: z.enum(['contained', 'sensitive']),
  origin: z.enum(['builtin', 'mcp', 'skill']),
});
export type ToolInfo = z.infer<typeof ToolInfoSchema>;

/** `GET /tools` — every registered tool, in registration order. */
export const ListToolsResponseSchema = z.array(ToolInfoSchema);
export type ListToolsResponse = z.infer<typeof ListToolsResponseSchema>;

// Messages

/**
 * `GET /bots/:id/chat?runId=&offset=` — join one run's delivery log (
 * §3.2, ): replay strictly after `offset`, then tail. `-1` (or `0`) is the
 * start; the stock client may send the offset as `Last-Event-ID` instead.
 */
export const ChatJoinQuerySchema = z
  .object({
    runId: z.string().min(1).max(128),
    offset: z
      .string()
      .regex(/^(-1|0|[1-9]\d{0,18})$/)
      .optional(),
  })
  .strict();
export type ChatJoinQuery = z.infer<typeof ChatJoinQuerySchema>;

/**
 * `GET /bots/:id/chat?threadId=[&limit&before]` — hydrate ( §3.2): the
 * stored transcript window, the active run, pending interrupts and a page
 * cursor, in the client library's `ChatHydrationResult` shape.
 */
export const ChatHydrateQuerySchema = z
  .object({
    threadId: z.string().min(1).max(128),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    before: z.string().min(1).max(256).optional(),
  })
  .strict();
export type ChatHydrateQuery = z.infer<typeof ChatHydrateQuerySchema>;

/** Application hydration envelope. The SDK owns the embedded AG-UI protocol shapes. */
export const ChatHydrationSchema = z.object({
  messages: z.array(JsonSchema),
  activeRun: z
    .object({ runId: z.string().min(1), startedAt: z.number().int().nonnegative().optional() })
    .nullable(),
  interrupts: z.object({ runId: z.string().min(1), pending: z.array(JsonSchema) }).nullable(),
  page: z
    .discriminatedUnion('truncated', [
      z.object({ truncated: z.literal(false) }),
      z.object({ truncated: z.literal(true), cursor: z.string().min(1) }),
    ])
    .optional(),
});
export type ChatHydration = z.infer<typeof ChatHydrationSchema>;

/**
 * `POST /bots/:id/chat` — the only `forwardedProps` this server accepts
 * ( §3.3 rule 5, ).
 *
 * The body itself is an AG-UI `RunAgentInput`, parsed by the library rather
 * than by a schema here, so the shape this server takes is the shape the stock
 * client sends. What the client may smuggle through `forwardedProps` is a
 * Crewaid question, and the answer is one key: the uploads this turn claims.
 * `.strict` is the point — an unknown key is refused rather than ignored, so
 * a client cannot reach a field a later version might honour.
 */
export const ChatForwardedPropsSchema = z
  .object({ attachmentIds: z.array(CuidSchema).optional() })
  .strict();
export type ChatForwardedProps = z.infer<typeof ChatForwardedPropsSchema>;

/** The one `GET /bots/:id/chat` route: a run id joins, a thread id hydrates. */
export const ChatQuerySchema = z.union([ChatJoinQuerySchema, ChatHydrateQuerySchema]);
export type ChatQuery = z.infer<typeof ChatQuerySchema>;

/**
 * An attachment as a transcript card renders it: no `messageId` (the card is
 * already on that message) and no `storageKey` ( — bytes are fetched
 * through the download route, never addressed by key).
 */
export const TranscriptAttachmentSchema = AttachmentSchema.omit({
  messageId: true,
  storageKey: true,
});
export type TranscriptAttachment = z.infer<typeof TranscriptAttachmentSchema>;

/**
 * `metadata.crewaid` on a hydrated message ( §3.4, ).
 *
 * What a client is told about a message beyond the model's view of it. Every
 * field is a column, projected on read; nothing here is ever written from a
 * client's metadata. This is the renderer's only source for a message's
 * author, so it is a wire shape and lives here rather than in either app.
 */
export const CrewaidMessageMetadataSchema = z.object({
  author: MessageAuthorSchema,
  /** Set when author = BOT: this thread's own bot, or the teammate who sent it. */
  fromBotId: CuidSchema.nullable(),
  runId: z.string().min(1).max(128).nullable(),
  sequence: z.number().int(),
  /** Why a reply ended, when it did not end normally. Never a vendor's text. */
  stopReason: z.string().nullable(),
  taskId: CuidSchema.nullable(),
  routineId: CuidSchema.nullable(),
  chainId: z.string().min(1).max(128).nullable(),
  hopCount: z.number().int().nonnegative(),
  startsTopic: z.boolean(),
  attachments: z.array(TranscriptAttachmentSchema),
});
export type CrewaidMessageMetadata = z.infer<typeof CrewaidMessageMetadataSchema>;

/**
 * `POST /bots/:id/messages`.
 *
 * content is optional when attachments carry the message — an
 * attachment-only send is valid (`content` absent or empty), text+attachments
 * send together, and the empty-nothing case (no text AND no attachments) is a
 * validation error.
 */
export const SendMessageBodySchema = z
  .object({
    /** Optional when attachmentIds is present. */
    content: z.string().max(100_000).optional(),
    attachmentIds: z.array(CuidSchema).optional(),
  })
  .refine(
    (b) =>
      (b.content !== undefined && b.content.trim().length > 0) ||
      (b.attachmentIds?.length ?? 0) > 0,
    'a message needs text or at least one attachment',
  );
export type SendMessageBody = z.infer<typeof SendMessageBodySchema>;

/**
 * `DELETE /bots/:id/messages` (clear the chat) and
 * `DELETE /bots/:id/messages/:messageId`.
 *
 * `forget` is the question the confirmation asks. Absent or `false` keeps
 * every memory the messages established, which is what a transcript deletion
 * always did (`Memory.messageId` is SetNull). `true` forgets those memories
 * and tombstones them, so the sweep cannot learn them again from elsewhere.
 */
export const DeleteMessagesQuerySchema = z.object({
  forget: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
});
export type DeleteMessagesQuery = z.infer<typeof DeleteMessagesQuerySchema>;

/** What a deletion removed, so the confirmation can say so. */
export const DeleteMessagesResponseSchema = z.object({
  deletedCount: z.number().int().nonnegative(),
  forgottenCount: z.number().int().nonnegative(),
});
export type DeleteMessagesResponse = z.infer<typeof DeleteMessagesResponseSchema>;

/**
 * `POST /attachments` — the attachment row before it is claimed, so
 * `messageId` is absent rather than null. Derived from `AttachmentSchema` so a
 * §3 column change cannot leave the upload response silently unvalidated.
 */
export const AttachmentUploadResponseSchema = AttachmentSchema.omit({ messageId: true });
export type AttachmentUploadResponse = z.infer<typeof AttachmentUploadResponseSchema>;

// Voice

/**
 * `POST /voice/transcriptions` — dictation. The clip is transcribed and
 * dropped: nothing is stored, and the words land in the person's draft.
 */
export const VoiceTranscriptionResponseSchema = z.object({
  text: z.string(),
  /** ISO 639 code the speech was recognised as, when the engine says. */
  languageCode: z.string().min(1).max(16).nullable(),
});
export type VoiceTranscriptionResponse = z.infer<typeof VoiceTranscriptionResponseSchema>;

/**
 * `POST /voice/notes` — a voice message, stored unclaimed like any upload
 * and transcribed. The transcript is what the message says; the clip
 * is what makes the bot answer aloud.
 */
export const VoiceNoteResponseSchema = z.object({
  attachment: AttachmentUploadResponseSchema,
  transcript: z.string(),
});
export type VoiceNoteResponse = z.infer<typeof VoiceNoteResponseSchema>;

/** One voice a bot can speak in. */
export const VoiceOptionSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  /** A public provider sample, fetched only when Preview is pressed. */
  previewUrl: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .optional(),
});
export type VoiceOption = z.infer<typeof VoiceOptionSchema>;

/** `GET /voice/voices`. */
export const VoiceListResponseSchema = z.object({
  voices: z.array(VoiceOptionSchema),
  defaultVoiceId: z.string().min(1).max(64),
});
export type VoiceListResponse = z.infer<typeof VoiceListResponseSchema>;

/**
 * `GET /voice/status`. `configured` says whether this account can speak and
 * listen at all: the hosted key on a plan, or an ElevenLabs key of its own.
 */
export const VoiceStatusResponseSchema = z.object({ configured: z.boolean() });
export type VoiceStatusResponse = z.infer<typeof VoiceStatusResponseSchema>;

// Calls (, cloud edition only)

/**
 * What one call's voice is told, applied by the client when it connects.
 * The server decides every value: the bot's name and voice, and how much of
 * the period's minutes this call may use.
 *
 * `language` is the voice agent's own language code (`pt-br`, `zh`, `no`), not
 * a Crewaid locale, and is absent when the call stays in English.
 */
export const CallOverridesSchema = z.object({
  prompt: z.string().min(1).max(4000),
  firstMessage: z.string().min(1).max(200),
  voiceId: z.string().min(1).max(64),
  maxDurationSeconds: z.number().int().positive(),
  language: z
    .string()
    .regex(/^[a-z]{2}(?:-[a-z]{2})?$/)
    .optional(),
});
export type CallOverrides = z.infer<typeof CallOverridesSchema>;

/**
 * `POST /bots/:id/calls`. The signed URL starts one conversation with the
 * shared voice agent and expires unused; `remainingSeconds` is null on a plan
 * with no limit.
 */
export const StartCallResponseSchema = z.object({
  callId: CuidSchema,
  signedUrl: z.url({ protocol: /^wss$/ }),
  remainingSeconds: z.number().int().nonnegative().nullable(),
  overrides: CallOverridesSchema,
});
export type StartCallResponse = z.infer<typeof StartCallResponseSchema>;

/**
 * `PATCH /calls/:callId`. `conversationId` is ElevenLabs' id once the call
 * connects; `ended` hangs it up and settles its minutes from ElevenLabs.
 */
export const UpdateCallBodySchema = z
  .object({
    conversationId: z.string().min(1).max(128).optional(),
    ended: z.literal(true).optional(),
  })
  .refine((body) => body.conversationId !== undefined || body.ended !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateCallBody = z.infer<typeof UpdateCallBodySchema>;

/** A call as the client sees it. `durationSeconds` is null until it is settled. */
export const VoiceCallSchema = z.object({
  id: CuidSchema,
  botId: CuidSchema,
  conversationId: z.string().min(1).max(128).nullable(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  durationSeconds: z.number().int().nonnegative().nullable(),
});
export type VoiceCall = z.infer<typeof VoiceCallSchema>;

export const VoiceCallResponseSchema = z.object({ call: VoiceCallSchema });
export type VoiceCallResponse = z.infer<typeof VoiceCallResponseSchema>;

/** `GET /calls/allowance`: this period's call minutes, in seconds. `null` limit: none. */
export const CallAllowanceResponseSchema = z.object({
  limitSeconds: z.number().int().nonnegative().nullable(),
  usedSeconds: z.number().int().nonnegative(),
});
export type CallAllowanceResponse = z.infer<typeof CallAllowanceResponseSchema>;

/**
 * `GET /bots/:id/approvals` — what this bot is waiting on right now.
 *
 * The rows are WebSocket `approval.requested` payload verbatim, not a REST shape
 * of their own. A prompt that arrived live and one recovered on mount are then
 * the same value, so the client has one path into state instead of two that
 * can disagree — and the only difference between them is how they arrived.
 *
 * It is a read of what the orchestrator is CURRENTLY blocked on, not a log:
 * an approval that has been answered is gone, which is what makes a client's
 * mount-time fetch authoritative rather than a source of stale prompts.
 */
export const ListApprovalsResponseSchema = z.array(ApprovalRequestedPayloadSchema);
export type ListApprovalsResponse = z.infer<typeof ListApprovalsResponseSchema>;

/** `GET /bots/:id/turns?limit=` */
export const ListTurnsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListTurnsQuery = z.infer<typeof ListTurnsQuerySchema>;

export const TurnSummarySchema = AgentTurnSchema.extend({
  stepCount: z.number().int().nonnegative(),
});
export type TurnSummary = z.infer<typeof TurnSummarySchema>;

// Sandbox

/** `GET /bots/:id/sandbox` — state + resolution. */
export const SandboxStatusResponseSchema = z.object({
  botId: CuidSchema,
  state: SandboxStateSchema,
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  lastError: z.string().nullable(),
});
export type SandboxStatusResponse = z.infer<typeof SandboxStatusResponseSchema>;

// Computer snapshot

/** The one saved copy of the caller's computer. */
export const ComputerSnapshotSchema = z.object({
  takenAt: z.iso.datetime(),
  /** What the provider stores for it; null until it has measured. */
  sizeBytes: z.number().int().nonnegative().nullable(),
  /** Null while it is kept for as long as the provider allows. */
  expiresAt: z.iso.datetime().nullable(),
});
export type ComputerSnapshot = z.infer<typeof ComputerSnapshotSchema>;

export const ComputerSnapshotActivitySchema = z.enum(['SAVING', 'RESTORING']);
export type ComputerSnapshotActivity = z.infer<typeof ComputerSnapshotActivitySchema>;

/** The last save or restore that failed, until the next one starts. */
export const ComputerSnapshotFailureSchema = z.enum(['SAVE_FAILED', 'RESTORE_FAILED']);
export type ComputerSnapshotFailure = z.infer<typeof ComputerSnapshotFailureSchema>;

/**
 * `GET /computer/snapshot`, and the 202 body of both POSTs. `supported` is
 * false when this server's computers cannot be snapshotted at all.
 */
export const ComputerSnapshotStatusResponseSchema = z.object({
  supported: z.boolean(),
  snapshot: ComputerSnapshotSchema.nullable(),
  activity: ComputerSnapshotActivitySchema.nullable(),
  lastError: ComputerSnapshotFailureSchema.nullable(),
});
export type ComputerSnapshotStatusResponse = z.infer<typeof ComputerSnapshotStatusResponseSchema>;

/**
 * 409 `code`s. Busy: a bot on the computer is working, or a save or
 * restore is already running. Unavailable: there is nothing to save or restore
 * (no computer, no snapshot, or a server whose computers cannot be saved).
 */
export const COMPUTER_BUSY_CODE = 'COMPUTER_BUSY';
export const SNAPSHOT_UNAVAILABLE_CODE = 'SNAPSHOT_UNAVAILABLE';

// Recordings

/** `POST /bots/:id/recordings` */
export const StartRecordingBodySchema = z.object({
  intent: z.string().optional(),
});
export type StartRecordingBody = z.infer<typeof StartRecordingBodySchema>;

export const StartRecordingResponseSchema = z.object({
  recordingId: CuidSchema,
});
export type StartRecordingResponse = z.infer<typeof StartRecordingResponseSchema>;

/** `GET /recordings/:id` — state, event counts by layer, generated skill id. */
export const RecordingStatusResponseSchema = z.object({
  id: CuidSchema,
  state: z.enum(['RECORDING', 'COMPILING', 'READY', 'FAILED', 'DISCARDED']),
  intent: z.string().nullable(),
  cdpAvailable: z.boolean(),
  /**
   * Set only when a hard limit stopped the recording.
   *
   * Read here rather than pushed: WebSocket `recording.state` carries
   * `{recordingId, state}` and is the contract five other people code
   * against. A recording stopping itself is a terminal transition the client
   * already re-reads after, so it costs one round trip on an event that
   * happens at most once per recording.
   */
  warning: RecordingWarningSchema.nullable(),
  /**
   * Why a FAILED recording failed — a hole in the trace, or a compile the
   * model refused. Null in every other state.
   *
   * Read here for the same reason `warning` is: WebSocket `recording.state`
   * carries `{recordingId, state}`, and a failure is a terminal transition
   * the client re-reads after. FAILED without this is a dead end — the
   * operator's only recourse is to re-record something that may fail the
   * same way.
   */
  error: z.string().nullable(),
  counts: z.object({
    x11: z.number().int().nonnegative(),
    cdp: z.number().int().nonnegative(),
    atspi: z.number().int().nonnegative(),
  }),
  skillId: CuidSchema.nullable(),
});
export type RecordingStatusResponse = z.infer<typeof RecordingStatusResponseSchema>;

// Skills

/** `GET /skills?botId=` */
export const ListSkillsQuerySchema = z.object({
  botId: CuidSchema.optional(),
});
export type ListSkillsQuery = z.infer<typeof ListSkillsQuerySchema>;

/**
 * A skill as the review list shows it: everything but the source.
 *
 * REST documents `GET /skills/:id` as "includes script source", and that
 * phrase is the contrast this encodes — the list carries what a reviewer
 * branches on (name, version, status, description) and the source arrives
 * when one version is opened. A page of scripts would otherwise ride on every
 * list render.
 */
export const SkillSummarySchema = SkillSchema.omit({ script: true });
export type SkillSummary = z.infer<typeof SkillSummarySchema>;

/**
 * `GET /skills?botId=` — a bare array, like `GET /bots`, carrying the latest
 * version of each skill name for the bot (; older versions stay
 * fetchable by their own id).
 */
export const ListSkillsResponseSchema = z.array(SkillSummarySchema);
export type ListSkillsResponse = z.infer<typeof ListSkillsResponseSchema>;

/** `PATCH /skills/:id` — edit script, description, paramsSchema; bumps version. */
export const UpdateSkillBodySchema = z
  .object({
    script: z.string().min(1),
    description: z.string(),
    paramsSchema: JsonSchemaObjectSchema,
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'at least one field must be provided');
export type UpdateSkillBody = z.infer<typeof UpdateSkillBodySchema>;

/**
 * `POST /skills/:id/revise` — what to change, in plain language.
 *
 * The compiler answers with a new version of the skill, so the person editing
 * never reads or writes the script. Like a PATCH, the answer is the NEW
 * version row — model-generated bytes, therefore DRAFT.
 */
export const REVISE_SKILL_INSTRUCTION_MAX_LENGTH = 2000;
export const ReviseSkillBodySchema = z.object({
  instruction: z.string().trim().min(1).max(REVISE_SKILL_INSTRUCTION_MAX_LENGTH),
});
export type ReviseSkillBody = z.infer<typeof ReviseSkillBodySchema>;

/**
 * `POST /skills/:id/run` — the script's arguments.
 *
 * An object, not any JSON: every skill's `paramsSchema` is `type: "object"`,
 * and the bridge's `POST /skill/run` accepts nothing else —
 * `params` "must be a JSON object" is its validation boundary. A looser wire
 * shape here would only manufacture 400s one hop away, after a `SkillRun` row
 * already exists. No-argument skills send `{}`.
 */
export const RunSkillBodySchema = z.object({
  params: JsonSchemaObjectSchema,
});
export type RunSkillBody = z.infer<typeof RunSkillBodySchema>;

export const RunSkillResponseSchema = z.object({
  runId: CuidSchema,
});
export type RunSkillResponse = z.infer<typeof RunSkillResponseSchema>;

export const SkillWithSourceSchema = SkillSchema;

// Mcp

/**
 * `GET /mcp/directory` — the installable catalog: curated direct-MCP entries
 * plus, the deployment's live Composio toolkits. `backend` is
 * present only on Composio entries; a curated entry's backend is DIRECT by
 * definition and the field is omitted from it.
 */
export const McpDirectoryEntrySchema = z.object({
  name: z.string().min(1),
  slug: SlugSchema,
  category: z.string().nullable(),
  iconUrl: z.string().nullable(),
  authType: z.enum(['NONE', 'OAUTH2', 'HEADER']),
  backend: z.enum(['DIRECT', 'COMPOSIO']).optional(),
});
export type McpDirectoryEntry = z.infer<typeof McpDirectoryEntrySchema>;

/**
 * The `GET /mcp/directory` body is a bare array, like `GET /bots` — the route
 * returns its catalog straight through. Named here so the client parses one
 * contractual shape instead of composing `z.array` against a schema it picked
 * out of this file itself.
 */
export const ListMcpDirectoryResponseSchema = z.array(McpDirectoryEntrySchema);
export type ListMcpDirectoryResponse = z.infer<typeof ListMcpDirectoryResponseSchema>;

/**
 * `GET /mcp/servers` — installed servers with status and tool counts.
 *
 * this response contains NO token material, ever. There is
 * deliberately no credential field here and no `McpCredentialDto` in this file.
 */
/** ALL includes future bots; its IDs are exclusions. */
export const PluginAccessSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('SELECTED'), selectedBotIds: z.array(CuidSchema) }).strict(),
  z.object({ mode: z.literal('ALL'), excludedBotIds: z.array(CuidSchema) }).strict(),
]);
export type PluginAccess = z.infer<typeof PluginAccessSchema>;

export const McpServerSummarySchema = z
  .object({
    id: CuidSchema,
    name: z.string().min(1),
    slug: SlugSchema,
    category: z.string().nullable(),
    iconUrl: z.string().nullable(),
    access: PluginAccessSchema,
    backend: z.enum(['DIRECT', 'COMPOSIO']),
    transport: McpTransportSchema.nullable(),
    url: z.url().nullable(),
    isPrivate: z.boolean(),
    authType: z.enum(['NONE', 'OAUTH2', 'HEADER']),
    status: z.enum(['DISCONNECTED', 'CONNECTING', 'CONNECTED', 'NEEDS_REAUTH', 'ERROR']),
    toolCount: z.number().int().nonnegative(),
    lastError: z.string().nullable(),
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
export type McpServerSummary = z.infer<typeof McpServerSummarySchema>;

/**
 * The `GET /mcp/servers` body, a bare array for the same reason.
 *
 * The array is of summaries; there is no credential field and no
 * `McpCredentialDto` for one to live on. `` asserts no token
 * material in the serialized response, not just in the type.
 */
export const ListMcpServersResponseSchema = z.array(McpServerSummarySchema);
export type ListMcpServersResponse = z.infer<typeof ListMcpServersResponseSchema>;

/**
 * `POST /mcp/servers` — install from directory `{slug}` or private
 * `{name,url,transport}`, optionally with the bearer a private server needs.
 *
 * Why the secret rides on the install
 *
 * A private server used to be installed with `authType: 'NONE'`, because the
 * body carried no credential and nothing else could supply one — so a server
 * behind an API key installed, failed its first listing with the server's own
 * 401, and could never be fixed. One form in front of an operator asks for the
 * URL and the token together, and one round trip is what that form should be:
 * a row created now and authorized in a second call is a row that exists in a
 * state the operator never asked for if the second call never comes.
 *
 * NOTE WHICH DIRECTION THIS TRAVELS. §7.3 forbids token material in a
 * RESPONSE; a request body is how a secret gets in at all, and it is the same
 * direction `ConnectProviderBody` already carries an API key. What the server
 * does with it is not this schema's business, but it is fixed: encrypted
 * before Prisma, written only by `mcp-credentials.ts`, and echoed by nothing.
 */
export const InstallMcpServerBodySchema = z.union([
  z.object({ slug: SlugSchema }),
  z.object({
    name: z.string().min(1),
    url: z.url(),
    transport: McpTransportSchema,
    /** Sent as `Authorization: Bearer …`. Absent means the server needs none. */
    bearerToken: z.string().min(1).optional(),
  }),
]);
export type InstallMcpServerBody = z.infer<typeof InstallMcpServerBodySchema>;

/**
 * `PUT /mcp/servers/:id/credential` — replace a header server's bearer.
 *
 * Its own route rather than a field on an update, because a token that can
 * only be set at install is a server that has to be uninstalled and rebuilt
 * when the token rotates — losing its per-bot enablement with it. This is also
 * the only way out of `NEEDS_REAUTH` for a header server: there is no refresh
 * token to spend, so the operator pasting a new one IS the ladder.
 */
export const SetMcpCredentialBodySchema = z.object({
  bearerToken: z.string().min(1),
});
export type SetMcpCredentialBody = z.infer<typeof SetMcpCredentialBodySchema>;

/** `POST /mcp/servers/:id/connect` → `{authorizeUrl}` for OAuth, or connects directly. */
export const ConnectMcpServerResponseSchema = z.union([
  z.object({ authorizeUrl: z.url() }),
  z.object({ connected: z.literal(true) }),
]);
export type ConnectMcpServerResponse = z.infer<typeof ConnectMcpServerResponseSchema>;

/** `GET /bots/:id/plugins` */
export const BotPluginSchema = z.object({
  serverId: CuidSchema,
  slug: SlugSchema,
  name: z.string().min(1),
  enabled: z.boolean(),
  toolCount: z.number().int().nonnegative(),
});
export type BotPlugin = z.infer<typeof BotPluginSchema>;

/**
 * The `GET /bots/:id/plugins` body, a bare array like the two MCP listings.
 *
 * Named here rather than composed as `z.array(BotPluginSchema)` at the call
 * site, for the reason `ListMcpDirectoryResponseSchema` gives: a client that
 * builds its own array schema is building a contract the server never agreed
 * to, and `packages/shared` is where a wire shape is decided.
 *
 * Every server the caller installed, with THIS bot's enablement on each —
 * not only the enabled ones. `enabled` would be a constant otherwise, and a
 * field that is always true is a field nobody needs.
 */
export const ListBotPluginsResponseSchema = z.array(BotPluginSchema);
export type ListBotPluginsResponse = z.infer<typeof ListBotPluginsResponseSchema>;

/** `PUT /bots/:id/plugins` — replaces the set. */
export const SetBotPluginsBodySchema = z.object({
  serverIds: z.array(CuidSchema),
});
export type SetBotPluginsBody = z.infer<typeof SetBotPluginsBodySchema>;

/**
 * Per-bot tool budget, restated in token terms.
 *
 * Why there is no longer a count here
 *
 * The row this replaces read "Resolved tool definitions per bot ≤ 40, hard
 * cap", and MCP plugins own reasoning for it is about cost: "ninety tool
 * definitions in every single request … degrades tool selection accuracy and
 * burns input tokens on every step of every turn." Forty DEFINITIONS was a
 * proxy for that cost and a bad one — it refused a thirty-tool server this
 * build has every reason to accept, and it charged nothing for a tool with a
 * two-kilobyte schema.
 *
 * A bot's plugin tools now reach the model through `find_plugin_tools` and
 * `use_plugin_tool` (, shape), so what a bot's plugins cost is
 * two definitions plus this listing, whatever the catalogue holds. The number
 * below is the listing's budget in ESTIMATED tokens — see
 * `mcp-indirect-tools.ts` for the estimate and the forms the listing degrades
 * through. It is a budget rather than a fence: nothing is refused and no tool
 * becomes unreachable when it is reached, because reachability is the search's
 * and not the listing's.
 *
 * It lives here, as its predecessor did, so the number the orchestrator
 * enforces and the number a test asserts are one number.
 */
export const PLUGIN_LISTING_TOKEN_BUDGET = 4000 as const;

// Provider connections

/**
 * THE KEY TRAVELS IN ONE DIRECTION ONLY.
 *
 * `apiKey` appears on REQUEST bodies below and on no response anywhere. There
 * is deliberately no "reveal" route and no response schema with a field it
 * could occupy — the absence is the contract, the same way
 * `McpCredentialSchema` has no REST counterpart.
 */

/** A provider API key as it arrives. Never echoed back, never logged. */
export const ProviderApiKeySchema = z
  .string()
  .min(8)
  .max(512)
  // Trimmed by the handler, but a key that is ALL whitespace is a mistake
  // worth naming rather than storing as a valid credential that 401s forever.
  .refine((value) => value.trim().length >= 8, 'must not be blank');

/** `POST /providers/connections` */
export const CreateProviderConnectionBodySchema = z
  .object({
    // never `crewaid` — the server makes that one.
    kind: CreatableProviderKindSchema,
    name: z.string().min(1).max(64),
    /** Required for `custom`, refused for the built-ins. */
    endpoint: ProviderEndpointSchema.optional(),
    /** Optional: a connection may be created now and given a key later. */
    apiKey: ProviderApiKeySchema.optional(),
  })
  .refine(
    (body) => (body.kind === 'custom') === (body.endpoint !== undefined),
    'endpoint is required for a custom connection and not accepted for a built-in one',
  );
export type CreateProviderConnectionBody = z.infer<typeof CreateProviderConnectionBodySchema>;

/**
 * `PATCH /providers/connections/:id`
 *
 * `kind` is absent deliberately: changing it would repoint every model on the
 * connection at a different provider while their upstream ids stayed the same,
 * which is a new connection wearing an old id. Delete and recreate.
 */
export const UpdateProviderConnectionBodySchema = z
  .object({
    name: z.string().min(1).max(64),
    endpoint: ProviderEndpointSchema,
    /**
     * Only ACTIVE and DISABLED are settable. NEEDS_CREDENTIAL is owned by the
     * credential routes — a client that could set it would be claiming a key
     * was removed when it was not.
     */
    state: z.enum(['ACTIVE', 'DISABLED']),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'at least one field must be provided');
export type UpdateProviderConnectionBody = z.infer<typeof UpdateProviderConnectionBodySchema>;

/** `PUT /providers/connections/:id/credential` — write-only. */
export const SetProviderCredentialBodySchema = z.object({
  apiKey: ProviderApiKeySchema,
});
export type SetProviderCredentialBody = z.infer<typeof SetProviderCredentialBodySchema>;

/** `POST /providers/connections/:id/models` */
export const CreateProviderModelBodySchema = z.object({
  upstreamModelId: UpstreamModelIdSchema,
  label: z.string().min(1).max(128),
  contextWindow: z.number().int().positive().max(100_000_000),
  capabilities: ModelCapabilitiesSchema,
});
export type CreateProviderModelBody = z.infer<typeof CreateProviderModelBodySchema>;

/**
 * `PATCH /providers/models/:modelId`
 *
 * `upstreamModelId` is editable because a provider genuinely does rename a
 * model, and the row id is what bots point at — so correcting it must not
 * force every bot to be repointed.
 */
export const UpdateProviderModelBodySchema = z
  .object({
    upstreamModelId: UpstreamModelIdSchema,
    label: z.string().min(1).max(128),
    contextWindow: z.number().int().positive().max(100_000_000),
    capabilities: ModelCapabilitiesSchema,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'at least one field must be provided');
export type UpdateProviderModelBody = z.infer<typeof UpdateProviderModelBodySchema>;

/** `GET /providers/connections` — connections with their models. */
export const ListProviderConnectionsResponseSchema = z.object({
  connections: z.array(ProviderConnectionWithModelsSchema),
});
export type ListProviderConnectionsResponse = z.infer<typeof ListProviderConnectionsResponseSchema>;

// Per-user settings

/** `GET /settings` */
export const UserSettingsResponseSchema = z.object({
  settings: UserSettingsSchema,
});
export type UserSettingsResponse = z.infer<typeof UserSettingsResponseSchema>;

/**
 * `PATCH /settings`
 *
 * `defaultModelId` is nullable rather than optional-to-clear: `null` means
 * "the user has no default", and an absent field means "leave it alone". A
 * single optional field cannot express both, and the difference matters —
 * clearing a default is a deliberate act that unsets every bot on the alias.
 *
 * The language and timezone fields follow the same rule: null is
 * "Follow System"/"Auto-detect", absent leaves the field alone. A zone must be
 * one the runtime knows, so nothing the server cannot schedule in is stored.
 */
const KnownTimezoneSchema = TimezoneSchema.refine(isKnownTimezone, 'unknown timezone');

export const UpdateUserSettingsBodySchema = z
  .object({
    defaultModelId: CuidSchema.nullable(),
    language: LocaleSchema.nullable(),
    timezone: KnownTimezoneSchema.nullable(),
    systemLanguage: LocaleSchema.nullable(),
    systemTimezone: KnownTimezoneSchema.nullable(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'at least one field must be provided');
export type UpdateUserSettingsBody = z.infer<typeof UpdateUserSettingsBodySchema>;

// Routines

export const CreateRoutineBodySchema = z
  .object({
    botId: CuidSchema,
    name: z.string().min(1),
    cron: z.string().min(1),
    timezone: z.string().min(1).optional(),
    endsOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    prompt: z.string().nullish(),
    skillId: CuidSchema.nullish(),
    skillParams: JsonSchema.nullish(),
    enabled: z.boolean().optional(),
    /** the goal it works toward. */
    goalId: CuidSchema.nullish(),
  })
  .refine(
    (r) => Boolean(r.prompt) !== Boolean(r.skillId),
    'exactly one of prompt or skillId must be set',
  );
export type CreateRoutineBody = z.infer<typeof CreateRoutineBodySchema>;

export const UpdateRoutineBodySchema = z
  .object({
    name: z.string().min(1),
    cron: z.string().min(1),
    timezone: z.string().min(1),
    endsOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    prompt: z.string().nullable(),
    skillId: CuidSchema.nullable(),
    skillParams: JsonSchema.nullable(),
    enabled: z.boolean(),
    goalId: CuidSchema.nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'at least one field must be provided');
export type UpdateRoutineBody = z.infer<typeof UpdateRoutineBodySchema>;

export const RoutineResponseSchema = RoutineSchema;

/**
 * `GET /routines` — every routine the caller's bots hold, operator- and
 * bot-created alike, so a schedule nobody can see cannot accumulate. A bare
 * array, as `ListBotsResponseSchema` is; the right rail filters by bot.
 */
export const ListRoutinesResponseSchema = z.array(RoutineSchema);
export type ListRoutinesResponse = z.infer<typeof ListRoutinesResponseSchema>;

// Usage

/**
 * `GET /usage?from=&to=` — token spend per bot per day.
 *
 * `from`/`to` are inclusive UTC calendar dates: the window is
 * `[fromT00:00:00Z, (to+1)T00:00:00Z)`, and a turn lands in the bucket of its
 * UTC start day — one definition of "day" for the whole surface, rather than
 * a local one that disagrees with the stored timestamps at midnight.
 */
export const UsageQuerySchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
});
export type UsageQuery = z.infer<typeof UsageQuerySchema>;

/**
 * One row per (bot, day) that had at least one turn in the window. A day a
 * bot spent nothing on is absent — absence means zero, never a fabricated
 * row. Days are UTC (see UsageQuerySchema).
 */
export const UsageRowSchema = z.object({
  botId: CuidSchema,
  /** YYYY-MM-DD, the UTC start day of the turns summed into this row. */
  day: z.iso.date(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /**
   * the day's estimated spend in USD, priced per turn from the
   * billing identity that turn recorded (provider:model) and rounded to
   * micro-dollars (6 dp) — the resolution the per-1M-token rates need.
   * `null` means the spend could not be priced — a turn with measured
   * tokens whose model is unknown or was never recorded — a real unknown,
   * never a fabricated 0; a day whose turns measured no tokens is 0.
   */
  estimatedCostUsd: z.number().finite().nonnegative().nullable(),
});
export type UsageRow = z.infer<typeof UsageRowSchema>;

export const UsageResponseSchema = z.object({
  rows: z.array(UsageRowSchema),
});
export type UsageResponse = z.infer<typeof UsageResponseSchema>;

// Billing (, cloud edition only)

/**
 * What each plan includes, in one place for the server that enforces it, the
 * desktop that shows it and the site that sells it.
 *
 * Prices are what Stripe charges and are only displayed from here: the amount
 * a customer pays is the Stripe price the server is configured with, so a
 * change of price is a change in both. Limits are per billing period and do not
 * roll over. `null` hours means no limit, and that plan's computer is never
 * stopped for being idle.
 *
 * `trial` is Starter's first seven days, bought for $1 once per account.
 * `internal` is an admin account's (`User.role = 'admin'`, set in the
 * database): no charge and no limits, for operating and testing the service.
 * It keeps idle stop, so a test computer left open does not run all month.
 * A `null` allowance means no limit on the built-in models either.
 * `callMinutes` are live calls with a bot; `null` means no limit.
 * `listenMinutes` (dictation and voice messages, by audio heard) and
 * `speakMinutes` (spoken replies, by audio made) are voice allowance,
 * kept apart from the model allowance so talking never stops a bot working.
 */
export const BILLING_PLANS = {
  trial: {
    label: 'Trial',
    monthlyUsd: 1,
    computeHours: 10,
    modelAllowanceUsd: 1,
    listenMinutes: 30,
    speakMinutes: 5,
    callMinutes: 0,
    idleStop: true,
  },
  starter: {
    label: 'Starter',
    monthlyUsd: 20,
    computeHours: 100,
    modelAllowanceUsd: 5,
    listenMinutes: 300,
    speakMinutes: 30,
    callMinutes: 0,
    idleStop: true,
  },
  pro: {
    label: 'Pro',
    monthlyUsd: 100,
    computeHours: null,
    modelAllowanceUsd: 10,
    listenMinutes: 1200,
    speakMinutes: 120,
    callMinutes: 30,
    idleStop: false,
  },
  internal: {
    label: 'Internal',
    monthlyUsd: 0,
    computeHours: null,
    modelAllowanceUsd: null,
    listenMinutes: null,
    speakMinutes: null,
    callMinutes: null,
    idleStop: true,
  },
} as const;

/** The trial's length; Stripe's `trial_period_days` on the Starter subscription. */
export const BILLING_TRIAL_DAYS = 7;

/** `none` is an account with no plan in force: its computer does not start. */
export const BillingPlanSchema = z.enum(['none', 'trial', 'starter', 'pro', 'internal']);
export type BillingPlan = z.infer<typeof BillingPlanSchema>;

/** The plans a checkout can ask for. The trial is Starter's, not a plan of its own. */
export const PurchasablePlanSchema = z.enum(['starter', 'pro']);
export type PurchasablePlan = z.infer<typeof PurchasablePlanSchema>;

/** Stripe's subscription statuses, verbatim. */
export const SubscriptionStatusSchema = z.enum([
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;

/**
 * `GET /billing` — the caller's plan and what they have used of it this period.
 *
 * `status` and `period` are null for an account that has never subscribed.
 * `trialEligible` says whether a Starter checkout would start the $1 trial:
 * one trial per account, ever.
 */
export const BillingResponseSchema = z.object({
  plan: BillingPlanSchema,
  status: SubscriptionStatusSchema.nullable(),
  period: z.object({ start: z.iso.datetime(), end: z.iso.datetime() }).nullable(),
  cancelAtPeriodEnd: z.boolean(),
  trialEligible: z.boolean(),
  compute: z.object({
    usedSeconds: z.number().int().nonnegative(),
    /** `null`: no limit. */
    limitSeconds: z.number().int().nonnegative().nullable(),
  }),
  model: z.object({
    usedUsd: z.number().finite().nonnegative(),
    /** `null`: no limit. */
    allowanceUsd: z.number().finite().nonnegative().nullable(),
  }),
  /** voice on Crewaid's key, in seconds of audio. `null` limit: none. */
  voice: z.object({
    listen: z.object({
      usedSeconds: z.number().int().nonnegative(),
      limitSeconds: z.number().int().nonnegative().nullable(),
    }),
    speak: z.object({
      usedSeconds: z.number().int().nonnegative(),
      limitSeconds: z.number().int().nonnegative().nullable(),
    }),
  }),
});
export type BillingResponse = z.infer<typeof BillingResponseSchema>;

/** `POST /billing/checkout`. */
export const BillingCheckoutBodySchema = z.object({ plan: PurchasablePlanSchema });
export type BillingCheckoutBody = z.infer<typeof BillingCheckoutBodySchema>;

/**
 * A Stripe page for the browser: Checkout, or the Billing Portal. The desktop
 * opens it outside the app and refreshes `GET /billing` when it is back.
 */
export const BillingRedirectResponseSchema = z.object({ url: z.url() });
export type BillingRedirectResponse = z.infer<typeof BillingRedirectResponseSchema>;

// Memory

/**
 * `GET /memory?botId=&includeInactive=` — what this user's bots know.
 *
 * Read-only. Before an operator could open `/home/bot/shared/MEMORY.md`
 * in the seat and read it; moving the memory into Postgres took that away, and
 * a memory nobody can inspect is a black box exactly when a bot is
 * confidently wrong and you need to look.
 *
 * `botId` absent means everything this user's bots can see. Present means the
 * global memory PLUS that bot's own — the same scope the bot itself is shown,
 * because "what does this bot know" is the question an operator is actually
 * asking.
 */
export const MemoryQuerySchema = z.object({
  botId: CuidSchema.optional(),
  /**
   * Superseded and forgotten rows are hidden by default: the usual question
   * is "what does it believe now". They remain fetchable because the second
   * question is always "since when, and what did it replace".
   */
  includeInactive: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
});
export type MemoryQuery = z.infer<typeof MemoryQuerySchema>;

export const MemoryKindSchema = z.enum([
  'PREFERENCE',
  'CONVENTION',
  'FACT',
  'DECISION',
  'TASK_STATE',
  'RESOURCE',
]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const MemorySourceSchema = z.enum(['TOLD', 'DISTILLED', 'OBSERVED', 'IMPORTED']);
export type MemorySource = z.infer<typeof MemorySourceSchema>;

export const MemoryStatusSchema = z.enum(['CANDIDATE', 'ACTIVE', 'SUPERSEDED', 'FORGOTTEN']);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

/**
 * One remembered claim, with enough provenance to answer WHY it is there.
 *
 * `source` and `status` are on the wire deliberately. "The bot thinks X" and
 * "a model guessed X and nobody confirmed it" look identical without them,
 * and telling them apart is the whole reason to look.
 */
export const MemoryRowSchema = z.object({
  id: CuidSchema,
  /** `null` is the user-global memory every bot is shown. */
  botId: CuidSchema.nullable(),
  kind: MemoryKindSchema,
  source: MemorySourceSchema,
  status: MemoryStatusSchema,
  text: z.string(),
  /** A DECISION's rationale, or an OBSERVED claim's origin. */
  detail: z.string().nullable(),
  /** Where an OBSERVED claim was read, when it was not a message. */
  sourceRef: z.string().nullable(),
  /** The message that established it, when there was one. */
  messageId: CuidSchema.nullable(),
  /** What replaced it, for a SUPERSEDED row. */
  supersededById: CuidSchema.nullable(),
  confirmations: z.number().int().positive(),
  useCount: z.number().int().nonnegative(),
  lastUsedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type MemoryRow = z.infer<typeof MemoryRowSchema>;

export const MemoryResponseSchema = z.object({
  rows: z.array(MemoryRowSchema),
});
export type MemoryResponse = z.infer<typeof MemoryResponseSchema>;

// Health

/** `GET /health` — the only route that bypasses AuthGuard. */
export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  /**
   * the release this server runs (`dev` for a local build), so a
   * self-hosted desktop can tell its server is older than it is. Not a
   * secret: the images are public and the version is in their tag.
   */
  version: z.string().min(1),
  /** which product this server is. */
  edition: EditionSchema,
  db: z.boolean(),
  redis: z.boolean(),
  docker: z.boolean(),
  sandboxes: z.array(
    z.object({
      botId: CuidSchema,
      state: SandboxStateSchema,
      healthy: z.boolean(),
    }),
  ),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// Errors

export const ApiErrorSchema = z.object({
  statusCode: z.number().int().min(100).max(599),
  code: z.string().min(1),
  message: z.string(),
  detail: JsonSchema.optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/**
 * The `code` a start refused for host capacity carries ( §7).
 *
 * `ApiError.code` is deliberately an open string, so almost nothing should be
 * switched on — a client that classified every failure by it would degrade to
 * "unknown" the moment a handler invented a new one. This one is different in
 * the only way that matters: §7 ratifies the exact string, and §16.1
 * requires the screen UI to show a full host SEPARATELY from a broken sandbox,
 * with a retry. 503 alone cannot carry that distinction — the workspace
 * readiness path answers 503 too, and telling an operator the host is full
 * when their bot's storage is unreachable sends them to stop a sandbox that
 * would not have helped.
 *
 * It lives here rather than as a literal on each side because it is a wire
 * value two workspaces agree on, which is what this package is for.
 */
export const SANDBOX_CAPACITY_CODE = 'SANDBOX_CAPACITY';

/**
 * The `code`s a start refused by the account's plan carries, with
 * status 402. Two, because they want different buttons: an account with no
 * plan chooses one, and one that used its hours waits for the period to turn
 * over or upgrades. The body's `detail` carries `usedSeconds`, `limitSeconds`
 * and `resetsAt` for the second.
 */
export const PLAN_REQUIRED_CODE = 'PLAN_REQUIRED';
export const COMPUTE_ALLOWANCE_EXHAUSTED_CODE = 'COMPUTE_ALLOWANCE_EXHAUSTED';
/**
 * a 402 for speech on Crewaid's key once the period's model allowance
 * is spent. Dictation and spoken replies draw on that allowance too.
 */
export const MODEL_ALLOWANCE_EXHAUSTED_CODE = 'MODEL_ALLOWANCE_EXHAUSTED';
/**
 * a 402 for dictation, a voice message or a spoken reply once the
 * period's voice minutes of that kind are spent.
 */
export const VOICE_ALLOWANCE_EXHAUSTED_CODE = 'VOICE_ALLOWANCE_EXHAUSTED';
/** a 402 for a call on a plan with no call minutes. */
export const CALL_PLAN_REQUIRED_CODE = 'CALL_PLAN_REQUIRED';
/** a 402 for a call once the period's minutes are spent. */
export const CALL_ALLOWANCE_USED_CODE = 'CALL_ALLOWANCE_USED';

/**
 * A 503 whose cause is the SERVER's configuration, not the caller's request.
 *
 * The provider credential vault encrypts every key with a keyring the
 * orchestrator reads from its environment. That read is deliberately lazy —
 * an orchestrator with no keyring still serves chat, sandboxes and the
 * settings pages an operator would use to fix it, so failing at boot would
 * take all of that down to report one variable.
 *
 * The cost of being lazy is that the failure surfaces at a request instead,
 * and without this code it surfaced as a bare 500: the operator saw "Something
 * went wrong. Try again." on the one screen where trying again can never work,
 * while the server had a precise sentence about which variable was missing and
 * no way to say it. This is that way.
 *
 * Nothing about the key material travels with it — the message names the
 * variable and its expected SHAPE, never a value.
 */
export const SERVER_MISCONFIGURED_CODE = 'SERVER_MISCONFIGURED';

/**
 * The complete REST path registry. Static segments only; `:id` marks a param.
 * The Electron client builds every URL from this, so drift is impossible.
 */
export const API_ROUTES = {
  telegram: {
    status: 'GET /channels/telegram',
    link: 'POST /channels/telegram/link',
    registerBot: 'POST /channels/telegram/bot',
    confirm: 'POST /channels/telegram/confirm',
    disconnect: 'DELETE /channels/telegram',
  },
  onboarding: {
    bootstrap: 'POST /onboarding/bootstrap',
    get: 'GET /onboarding',
    update: 'PATCH /onboarding',
  },
  templates: {
    list: 'GET /templates',
    get: 'GET /templates/:id',
    install: 'POST /template-installations',
  },
  bots: {
    list: 'GET /bots',
    create: 'POST /bots',
    update: 'PATCH /bots/:id',
    remove: 'DELETE /bots/:id',
    duplicate: 'POST /bots/:id/duplicate',
    chat: 'GET /bots/:id/chat',
    clearMessages: 'DELETE /bots/:id/messages',
    deleteMessage: 'DELETE /bots/:id/messages/:messageId',
    startTopic: 'POST /bots/:id/topics',
    turns: 'GET /bots/:id/turns',
    approvals: 'GET /bots/:id/approvals',
    sandboxStart: 'POST /bots/:id/sandbox/start',
    sandboxStop: 'POST /bots/:id/sandbox/stop',
    sandbox: 'GET /bots/:id/sandbox',
    screenGrant: 'POST /bots/:id/screen/grant',
    releaseIdentity: 'DELETE /bots/:id/identity',
    startRecording: 'POST /bots/:id/recordings',
    plugins: 'GET /bots/:id/plugins',
    setPlugins: 'PUT /bots/:id/plugins',
    markRead: 'POST /bots/:id/read',
  },
  /** the caller's computer, addressed without an id (one per user). */
  computer: {
    snapshot: 'GET /computer/snapshot',
    snapshotSave: 'POST /computer/snapshot',
    snapshotRestore: 'POST /computer/snapshot/restore',
  },
  groups: {
    list: 'GET /groups',
    create: 'POST /groups',
    update: 'PATCH /groups/:id',
    remove: 'DELETE /groups/:id',
  },
  recordings: {
    stop: 'POST /recordings/:id/stop',
    discard: 'POST /recordings/:id/discard',
    get: 'GET /recordings/:id',
  },
  skills: {
    list: 'GET /skills',
    get: 'GET /skills/:id',
    update: 'PATCH /skills/:id',
    remove: 'DELETE /skills/:id',
    revise: 'POST /skills/:id/revise',
    approve: 'POST /skills/:id/approve',
    run: 'POST /skills/:id/run',
    getRun: 'GET /skills/:id/runs/:runId',
  },
  tools: {
    list: 'GET /tools',
  },
  mcp: {
    directory: 'GET /mcp/directory',
    servers: 'GET /mcp/servers',
    install: 'POST /mcp/servers',
    uninstall: 'DELETE /mcp/servers/:id',
    connect: 'POST /mcp/servers/:id/connect',
    refreshTools: 'POST /mcp/servers/:id/refresh-tools',
    setCredential: 'PUT /mcp/servers/:id/credential',
    setAccess: 'PUT /mcp/servers/:id/access',
    oauthCallback: `GET ${MCP_OAUTH_CALLBACK_PATH}`,
  },
  projects: {
    list: 'GET /projects',
    create: 'POST /projects',
    update: 'PATCH /projects/:id',
    remove: 'DELETE /projects/:id',
  },
  tasks: {
    list: 'GET /tasks',
    create: 'POST /tasks',
    get: 'GET /tasks/:id',
    update: 'PATCH /tasks/:id',
    remove: 'DELETE /tasks/:id',
    start: 'POST /tasks/:id/start',
    addNote: 'POST /tasks/:id/notes',
  },
  taskSeries: {
    get: 'GET /task-series/:id',
    update: 'PATCH /task-series/:id',
    remove: 'DELETE /task-series/:id',
  },
  goals: {
    list: 'GET /goals',
    create: 'POST /goals',
    get: 'GET /goals/:id',
    update: 'PATCH /goals/:id',
    remove: 'DELETE /goals/:id',
  },
  deliverables: {
    list: 'GET /deliverables',
    create: 'POST /deliverables',
    update: 'PATCH /deliverables/:id',
    remove: 'DELETE /deliverables/:id',
  },
  search: 'GET /search',
  routines: {
    list: 'GET /routines',
    create: 'POST /routines',
    update: 'PATCH /routines/:id',
    remove: 'DELETE /routines/:id',
    runNow: 'POST /routines/:id/run-now',
  },
  /**
   * V1-05 / D-082. Connections are addressed by ROW ID, never by kind or
   * name: `/providers/connections/openai` would be a URL that stops being
   * unique the moment a user has two custom connections, and a name-keyed one
   * would repoint on a rename.
   *
   * Models hang off `/providers/models/:modelId` rather than
   * `/providers/connections/:id/models/:modelId` because a model id is already
   * globally unique and the nested form invites a handler that trusts the
   * connection half of the path without checking that the model belongs to it.
   */
  providers: {
    list: 'GET /providers/connections',
    create: 'POST /providers/connections',
    update: 'PATCH /providers/connections/:id',
    remove: 'DELETE /providers/connections/:id',
    // PUT, not POST: setting a key is idempotent and replaces whatever is
    // there. There is no GET — D-083, the key never comes back.
    setCredential: 'PUT /providers/connections/:id/credential',
    clearCredential: 'DELETE /providers/connections/:id/credential',
    createModel: 'POST /providers/connections/:id/models',
    updateModel: 'PATCH /providers/models/:modelId',
    removeModel: 'DELETE /providers/models/:modelId',
  },
  /** Where the per-user `default` alias is chosen. */
  settings: {
    get: 'GET /settings',
    update: 'PATCH /settings',
  },
  usage: 'GET /usage',
  /**
   * The hosted service's plans. Registered only on a cloud server with
   * Stripe configured; anywhere else these answer 404.
   */
  billing: {
    get: 'GET /billing',
    checkout: 'POST /billing/checkout',
    portal: 'POST /billing/portal',
  },
  memoryUpdate: 'PATCH /memory/:id',
  memoryRemove: 'DELETE /memory/:id',
  memory: 'GET /memory',
  models: 'GET /models',
  attachmentUpload: 'POST /attachments', // multipart/form-data
  attachmentRemove: 'DELETE /attachments/:id', // unclaimed only
  attachmentDownload: 'GET /attachments/:id/download',
  voice: {
    transcribe: 'POST /voice/transcriptions', // dictation, multipart, nothing stored
    note: 'POST /voice/notes', // voice message, multipart, stored unclaimed
    voices: 'GET /voice/voices',
    status: 'GET /voice/status',
  },
  calls: {
    start: 'POST /bots/:id/calls', // cloud edition only
    update: 'PATCH /calls/:callId',
    allowance: 'GET /calls/allowance',
  },
  health: 'GET /health',
} as const;
