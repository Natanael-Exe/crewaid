import { z } from 'zod';
import { ApprovalBindingSchema } from './tool-policy.js';
import { ScreenControlPayloadSchema, ScreenControlStatePayloadSchema } from './seat-control.js';
import {
  BotStatusSchema,
  McpStatusSchema,
  RecordingStateSchema,
  SandboxStateSchema,
} from './enums.js';
import { CuidSchema, EpochMsSchema, JsonSchema } from './primitives.js';
import { AttachmentSchema, MessageWithAttachmentsSchema } from './models.js';
import { ConnectorStatusPayloadSchema } from './connectors.js';

/**
 * The WebSocket contract.
 *
 * EVENT NAMES ARE CONTRACTUAL. `message.created` is not `messageCreated`, not
 * `message_created`. The orchestrator gateway and the Electron client both
 * discriminate on these exact strings.
 *
 * Single endpoint: `wss://<host>/ws?token=<ORCH_API_TOKEN>`.
 */

/**
 * The wire contract's version, as this build understands it.
 *
 * Bump it when a frame's SHAPE changes in a way an older reader would
 * mis-parse rather than merely not recognise, and add the step to
 * `normalizeFrame` in the same change.
 */
export const WIRE_VERSION = 2;

/**
 * The version of a frame that carries no `wireVersion` — every frame written
 * before D-071, and every frame from a client that predates it.
 *
 * Zero is a real version, not "unknown". A reader has to be able to say "this
 * is a v0 frame" rather than assume it is current: that is what lets a newer
 * desktop read an older orchestrator, and what keeps a persisted transcript
 * readable after the first shape change.
 */
export const WIRE_VERSION_UNSTAMPED = 0;

/** The WebSocket envelope, before the payload is narrowed by `type`. */
export const WsFrameSchema = z.object({
  /** uuid, for correlating request/response. */
  id: z.uuid(),
  type: z.string().min(1),
  botId: CuidSchema.optional(),
  /** epoch ms. */
  ts: EpochMsSchema,
  /**
   * D-071. Optional on READ and always stamped on WRITE: requiring it inbound
   * would refuse every frame from an existing client the moment it shipped,
   * which is the opposite of the point.
   */
  wireVersion: z.number().int().nonnegative().optional(),
  payload: z.unknown(),
});
export type WsFrame = z.infer<typeof WsFrameSchema>;

// Server → client payloads

export const MessageCreatedPayloadSchema = MessageWithAttachmentsSchema;

/**
 * Attachments claimed onto a message AFTER its `message.created` went out.
 *
 * A bot attaches during its turn, but the draft's `message.created` frame was
 * emitted before the turn ran — carrying an empty list by construction — and
 * nothing else on the wire carried attachments until the next history fetch.
 * The operator watched the bot say "I've attached the report" and saw nothing
 * until an app restart. This frame is the live half of that claim: one per
 * `attach_file`-shaped store, carrying the newly claimed rows.
 *
 * The payload is an ARRAY of rows, not one, so a batch store does not become
 * three frames; the client merges by id, so a redelivered frame is idempotent.
 */
export const MessageAttachmentsPayloadSchema = z.object({
  messageId: CuidSchema,
  attachments: z.array(AttachmentSchema),
});

/**
 * Messages removed from a bot's conversation.
 *
 * `cleared` means the whole conversation went, including pages this client
 * never loaded, so a window drops everything it holds for the bot. A clear
 * lists no ids: the flag already says "all", and a long conversation's ids
 * would make one frame as large as its history.
 */
export const MessageDeletedPayloadSchema = z.object({
  botId: CuidSchema,
  messageIds: z.array(CuidSchema),
  cleared: z.literal(true).optional(),
});

export const BotStatusPayloadSchema = z.object({
  botId: CuidSchema,
  status: BotStatusSchema,
});

/**
 * `run.started`: a conversation run exists, whatever started it.
 * The account's windows join its delivery log (`GET /bots/:id/chat?runId=`);
 * the run's events never travel on this socket.
 */
export const RunStartedPayloadSchema = z.object({
  botId: CuidSchema,
  threadId: z.string().min(1).max(128),
  runId: z.string().min(1).max(128),
});

/** How a settled run left the messages it answered. */
export const RunSettledOutcomeSchema = z.enum(['completed', 'failed', 'stopped']);
export type RunSettledOutcome = z.infer<typeof RunSettledOutcomeSchema>;

/**
 * `run.settled`: the server's last word on the messages a run answered.
 *
 * Sent once, when nothing more will happen for them: not for a run that pauses
 * on an approval, hands its work to a continuation or retries a transient
 * failure, because the run that follows is the one that answers. A run answers
 * its own trigger and every stored message it folded in, so `messageIds` can
 * name several. `reply` is the last thing the bot wrote for them, or null when
 * it wrote nothing.
 */
export const RunSettledPayloadSchema = z.object({
  botId: CuidSchema,
  threadId: z.string().min(1).max(128),
  runId: z.string().min(1).max(128),
  messageIds: z.array(z.string().min(1).max(128)).min(1).max(50),
  outcome: RunSettledOutcomeSchema,
  reply: z.string().nullable(),
});
export type RunSettledPayload = z.infer<typeof RunSettledPayloadSchema>;

/**
 * The roster moved, and every window should re-read it.
 *
 * A bot can be created, reshaped or deleted by something other than the
 * window that is watching: a bot tool acting on its operator's behalf
 * (`create_bot`), or the same person in another window. Without this frame
 * the sidebar showed the roster from whenever it last asked — a bot the
 * operator's own teammate had just created was invisible "until I reload the
 * window", which is the report this exists to answer.
 *
 * Deliberately carries no row. The client's repair is one `GET /bots`, which
 * is the same read that owns the shape (`sandbox` and all); sending the row
 * here would be a second, weaker copy of it to keep in step.
 */
export const BotsChangedPayloadSchema = z.object({
  /** The bot that changed. A deletion names the id that is gone. */
  botId: CuidSchema,
  change: z.enum(['created', 'updated', 'deleted']),
});

export const TurnStepPayloadSchema = z.object({
  botId: CuidSchema,
  turnId: CuidSchema,
  stepIndex: z.number().int().nonnegative(),
  toolName: z.string().min(1).optional(),
});

export const SandboxStatePayloadSchema = z.object({
  botId: CuidSchema,
  state: SandboxStateSchema,
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
});

export const RecordingEventPayloadSchema = z.object({
  recordingId: CuidSchema,
  layer: z.enum(['X11', 'CDP', 'ATSPI']),
  type: z.string().min(1),
  counts: z.object({
    x11: z.number().int().nonnegative(),
    cdp: z.number().int().nonnegative(),
  }),
});

export const RecordingStatePayloadSchema = z.object({
  recordingId: CuidSchema,
  state: RecordingStateSchema,
});

export const SkillCompiledPayloadSchema = z.object({
  recordingId: CuidSchema,
  skillId: CuidSchema,
  name: z.string().min(1),
});

export const ApprovalRequestedPayloadSchema = z.object({
  botId: CuidSchema,
  turnId: CuidSchema,
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  args: JsonSchema,
  binding: ApprovalBindingSchema,
});

export const ApprovalResolvedPayloadSchema = z.object({
  botId: CuidSchema,
  turnId: CuidSchema,
  toolCallId: z.string().min(1),
  approved: z.boolean(),
  reason: z.string().optional(),
});

export const McpStatusPayloadSchema = z.object({
  serverId: CuidSchema,
  status: McpStatusSchema,
  toolCount: z.number().int().nonnegative(),
  lastError: z.string().optional(),
});

/**
 * WebSocket `usage.notice` — this period's use of a plan crossed 80% or 100%.
 *
 * To the account, not a bot: the plan is the account's. Sent once per crossing,
 * at the moment the meter records it, so a window open at the time can say so;
 * one opened later reads the same numbers from `GET /billing`. `kind` is which
 * meter — computer time or the included models — and `resetsAt` is when the
 * period turns over.
 */
export const UsageNoticePayloadSchema = z.object({
  kind: z.enum(['compute', 'model']),
  level: z.union([z.literal(80), z.literal(100)]),
  resetsAt: z.iso.datetime(),
});
export type UsageNoticePayload = z.infer<typeof UsageNoticePayloadSchema>;

/**
 * WebSocket `error` frame.
 *
 * `code` stays a broad string because this frame carries transport-level errors
 * (envelope validation, unknown type) as well as model errors. Every
 * MODEL-originated error uses a `ModelErrorCode` value from `agent.ts` — that
 * is the set the transcript switches on. `detail` is for logs and is never
 * rendered: PRD the whole point is that no vendor string reaches the UI.
 */
export const ErrorPayloadSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  detail: JsonSchema.optional(),
});

/**
 * The four Work invalidations. Each names a row and nothing else: the
 * client refetches what it names, because derived counts (subtask progress,
 * goal progress, a project's open tasks) are the server's to compute, and a
 * frame carrying a copy of them would be a second, staler answer.
 *
 * They go to the operator's clients only, never to a bot.
 */
export const TaskChangedPayloadSchema = z.object({
  taskId: CuidSchema,
  deleted: z.literal(true).optional(),
});

export const ProjectChangedPayloadSchema = z.object({
  projectId: CuidSchema,
  deleted: z.literal(true).optional(),
});

export const GoalChangedPayloadSchema = z.object({
  goalId: CuidSchema,
  deleted: z.literal(true).optional(),
});

export const DeliverableChangedPayloadSchema = z.object({
  deliverableId: CuidSchema,
  deleted: z.literal(true).optional(),
});

// Client → server payloads

/**
 * Makes this socket a watcher of the bot's seat: the membership that lets it
 * send `screen.input` and ask for `screen.control`. The pixels themselves come
 * on a stream socket of their own (`screen-stream.ts`), so quality is chosen
 * there, not here.
 */
export const ScreenSubscribePayloadSchema = z.object({
  botId: CuidSchema,
});

export const ScreenUnsubscribePayloadSchema = z.object({
  botId: CuidSchema,
});

export const ApprovalRespondPayloadSchema = z
  .object({
    toolCallId: z.string().min(1),
    approved: z.boolean(),
    reason: z.string().optional(),
    editedArgs: JsonSchema.optional(),
  })
  .strict();

export const BotCancelPayloadSchema = z.object({
  botId: CuidSchema,
});

/**
 * `screen.input` (client → server) carries a raw binary RFB payload and is
 * transported as a binary WS frame, not a JSON envelope (PRD §4.3: "No
 * transcoding"). It is therefore listed here but has no Zod payload schema —
 * validating an RFB message is the M2 frame validator's job, not Zod's. Screen
 * pixels no longer travel on this socket at all; see `screen-stream.ts`.
 */
export const BINARY_WS_EVENTS = ['screen.input'] as const;

/** Server → client event registry, keyed by the exact WebSocket `type` string. */
export const ServerEventSchemas = {
  'message.created': MessageCreatedPayloadSchema,
  'message.attachments': MessageAttachmentsPayloadSchema,
  'message.deleted': MessageDeletedPayloadSchema,
  'bot.status': BotStatusPayloadSchema,
  'run.started': RunStartedPayloadSchema,
  'run.settled': RunSettledPayloadSchema,
  'bots.changed': BotsChangedPayloadSchema,
  'turn.step': TurnStepPayloadSchema,
  'screen.control.state': ScreenControlStatePayloadSchema,
  'sandbox.state': SandboxStatePayloadSchema,
  'recording.event': RecordingEventPayloadSchema,
  'recording.state': RecordingStatePayloadSchema,
  'skill.compiled': SkillCompiledPayloadSchema,
  'approval.requested': ApprovalRequestedPayloadSchema,
  'approval.resolved': ApprovalResolvedPayloadSchema,
  'mcp.status': McpStatusPayloadSchema,
  'connector.status': ConnectorStatusPayloadSchema,
  'task.changed': TaskChangedPayloadSchema,
  'project.changed': ProjectChangedPayloadSchema,
  'goal.changed': GoalChangedPayloadSchema,
  'deliverable.changed': DeliverableChangedPayloadSchema,
  'usage.notice': UsageNoticePayloadSchema,
  error: ErrorPayloadSchema,
} as const;

/** Client → server event registry, keyed by the exact WebSocket `type` string. */
export const ClientEventSchemas = {
  'screen.control': ScreenControlPayloadSchema,
  'screen.subscribe': ScreenSubscribePayloadSchema,
  'screen.unsubscribe': ScreenUnsubscribePayloadSchema,
  'approval.respond': ApprovalRespondPayloadSchema,
  'bot.cancel': BotCancelPayloadSchema,
} as const;

export type ServerEventType = keyof typeof ServerEventSchemas;
export type ClientEventType = keyof typeof ClientEventSchemas;

export const SERVER_EVENT_TYPES = Object.keys(ServerEventSchemas) as ServerEventType[];
export const CLIENT_EVENT_TYPES = Object.keys(ClientEventSchemas) as ClientEventType[];

/**
 * Discriminated union of every server → client frame.
 * The M1 gateway rejects any frame that fails this (`M1-BE-04`).
 */
export const ServerFrameSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.uuid(),
    type: z.literal('message.created'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: MessageCreatedPayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('message.attachments'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: MessageAttachmentsPayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('message.deleted'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: MessageDeletedPayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('bot.status'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: BotStatusPayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('run.started'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: RunStartedPayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('run.settled'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: RunSettledPayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('bots.changed'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: BotsChangedPayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('turn.step'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: TurnStepPayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('screen.control.state'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: ScreenControlStatePayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('sandbox.state'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: SandboxStatePayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('recording.event'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: RecordingEventPayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('recording.state'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: RecordingStatePayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('skill.compiled'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: SkillCompiledPayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('approval.requested'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: ApprovalRequestedPayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('approval.resolved'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: ApprovalResolvedPayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('mcp.status'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: McpStatusPayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('connector.status'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: ConnectorStatusPayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('usage.notice'),
    // Never set — the notice is the account's, not a bot's — but present so
    // every frame has the same envelope.
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: UsageNoticePayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('task.changed'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: TaskChangedPayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('project.changed'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: ProjectChangedPayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('goal.changed'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: GoalChangedPayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('deliverable.changed'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: DeliverableChangedPayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('error'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: ErrorPayloadSchema,
  }),
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

/** Discriminated union of every client → server frame. */
export const ClientFrameSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.uuid(),
    type: z.literal('screen.control'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: ScreenControlPayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('screen.subscribe'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: ScreenSubscribePayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('screen.unsubscribe'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: ScreenUnsubscribePayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('approval.respond'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: ApprovalRespondPayloadSchema,
  }),
  z.object({
    id: z.uuid(),
    type: z.literal('bot.cancel'),
    botId: CuidSchema.optional(),
    ts: EpochMsSchema,
    payload: BotCancelPayloadSchema,
  }),
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

// /: reading and writing the envelope's version

/**
 * Stamp the wire version onto an outgoing frame. The ONE writer.
 *
 * Exported so neither end can drift into stamping by hand — the same reason
 * `WsFrameSchema` exists rather than each side spelling the envelope out.
 * Applied on the way to the socket rather than before validation, because the
 * union schemas do not declare `wireVersion` and zod strips what they do not
 * declare: a stamp applied first would be removed by the parse that follows.
 */
export function stampWireVersion<T extends object>(frame: T): T & { wireVersion: number } {
  return { ...frame, wireVersion: WIRE_VERSION };
}

/** The version a raw frame claims; `WIRE_VERSION_UNSTAMPED` when it claims none. */
export function readWireVersion(raw: unknown): number {
  if (typeof raw !== 'object' || raw === null) return WIRE_VERSION_UNSTAMPED;
  const value = (raw as { wireVersion?: unknown }).wireVersion;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : WIRE_VERSION_UNSTAMPED;
}

/**
 * Bring an older frame up to the current contract.
 *
 * v0 → v1 is the IDENTITY, and saying so is more useful than a migration with
 * nothing to migrate: D-071 changed no frame's shape, it only started
 * recording which shape a frame is. This function is the place the first real
 * step goes, and the reason it exists before there is one is that a reader
 * with nowhere to put the step tends to grow the branch at the call site
 * instead — which is how two readers come to disagree about the same frame.
 */
function normalizeFrame(raw: unknown, from: number): unknown {
  void from;
  return raw;
}

/** Why a frame could not be read as the current contract. */
export type WireReadFailure =
  | {
      /**
       * The frame is from a NEWER build. Distinct from `malformed` on purpose:
       * one means "your build is behind", which an operator can act on, and
       * the other means "this frame is broken", which they cannot.
       */
      readonly reason: 'unsupported-version';
      readonly wireVersion: number;
      readonly supported: number;
    }
  | { readonly reason: 'malformed' };

export type WireReadResult<T> =
  | { readonly ok: true; readonly frame: T; readonly wireVersion: number }
  | ({ readonly ok: false } & WireReadFailure);

function readFrame<T>(
  raw: unknown,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
): WireReadResult<T> {
  const wireVersion = readWireVersion(raw);
  // Checked BEFORE parsing. A v2 frame carrying a member this build has never
  // heard of fails the union, and "invalid frame" is exactly the unactionable
  // answer CC-19 exists to replace.
  if (wireVersion > WIRE_VERSION) {
    return { ok: false, reason: 'unsupported-version', wireVersion, supported: WIRE_VERSION };
  }
  const parsed = parse(normalizeFrame(raw, wireVersion));
  return parsed.success
    ? { ok: true, frame: parsed.data, wireVersion }
    : { ok: false, reason: 'malformed' };
}

/** Read a server → client frame, normalising an older one on the way. */
export function readServerFrame(raw: unknown): WireReadResult<ServerFrame> {
  return readFrame(raw, (value) => ServerFrameSchema.safeParse(value));
}

/** Read a client → server frame, normalising an older one on the way. */
export function readClientEnvelope(raw: unknown): WireReadResult<WsFrame> {
  return readFrame(raw, (value) => WsFrameSchema.safeParse(value));
}
