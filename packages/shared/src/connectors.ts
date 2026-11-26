import { z } from 'zod';
import { CuidSchema, DateTimeSchema } from './primitives.js';

/**
 * D-241 Step 5 — Opt-in standalone local connector contracts.
 *
 * Shared across the orchestrator, the desktop Settings/approval UI, and the
 * standalone `crewaid-connect` CLI. Browser-safe: zero Node built-in imports.
 */

export const CONNECTOR_WS_PATH = '/ws/connectors' as const;
export const CONNECTOR_PROTOCOL_VERSION = 1 as const;
export const MIN_CONNECTOR_PROTOCOL_VERSION = 1 as const;
export const CONNECTOR_TOKEN_PREFIX = 'crw_conn_' as const;

export const LocalConnectorStatusSchema = z.enum(['ONLINE', 'OFFLINE', 'REVOKED']);
export type LocalConnectorStatus = z.infer<typeof LocalConnectorStatusSchema>;

export const LocalConnectorReportModeSchema = z.enum(['summary', 'full']);
export type LocalConnectorReportMode = z.infer<typeof LocalConnectorReportModeSchema>;

export const LocalConnectorHarnessIdSchema = z.enum([
  'claude-code',
  'codex',
  'opencode',
  'antigravity',
  'custom',
]);
export type LocalConnectorHarnessId = z.infer<typeof LocalConnectorHarnessIdSchema>;

export const LocalConnectorSchema = z.object({
  id: CuidSchema,
  name: z.string().min(1).max(80),
  status: LocalConnectorStatusSchema,
  busy: z.boolean(),
  tokenPrefix: z.string().min(4).max(24),
  reportMode: LocalConnectorReportModeSchema,
  workspaceName: z.string().min(1).max(200).nullable(),
  hostName: z.string().min(1).max(120).nullable(),
  harnesses: z.array(LocalConnectorHarnessIdSchema).max(16),
  defaultHarness: LocalConnectorHarnessIdSchema.nullable(),
  lastSeenAt: DateTimeSchema.nullable(),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type LocalConnectorView = z.infer<typeof LocalConnectorSchema>;

export const CreateConnectorBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
});
export type CreateConnectorBody = z.infer<typeof CreateConnectorBodySchema>;

export const CreateConnectorResponseSchema = z.object({
  connector: LocalConnectorSchema,
  /** One-time connector bearer secret (`crw_conn_…`), shown once on create. */
  secret: z.string().min(20).max(200),
});
export type CreateConnectorResponse = z.infer<typeof CreateConnectorResponseSchema>;

export const RotateConnectorResponseSchema = z.object({
  connector: LocalConnectorSchema,
  /** One-time replacement connector bearer secret (`crw_conn_…`), shown once. */
  secret: z.string().min(20).max(200),
});
export type RotateConnectorResponse = z.infer<typeof RotateConnectorResponseSchema>;

export const ListConnectorsResponseSchema = z.object({
  connectors: z.array(LocalConnectorSchema),
});
export type ListConnectorsResponse = z.infer<typeof ListConnectorsResponseSchema>;

/** Desktop `/ws` invalidation payload (`connector.status`). */
export const ConnectorStatusPayloadSchema = z.object({
  connectorId: CuidSchema,
  status: LocalConnectorStatusSchema,
  busy: z.boolean(),
  workspaceName: z.string().min(1).max(200).nullable().optional(),
  harnesses: z.array(LocalConnectorHarnessIdSchema).max(16).optional(),
  reportMode: LocalConnectorReportModeSchema.optional(),
});
export type ConnectorStatusPayload = z.infer<typeof ConnectorStatusPayloadSchema>;

// ── Outbound Connector WebSocket Protocol (`/ws/connectors`) ──────────────

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const ConnectorHelloFrameSchema = z.object({
  type: z.literal('connector.hello'),
  protocolVersion: z.number().int().positive(),
  cliVersion: z.string().min(1).max(64),
  workspaceName: z.string().min(1).max(200),
  hostName: z.string().min(1).max(120),
  harnesses: z.array(LocalConnectorHarnessIdSchema).max(16),
  defaultHarness: LocalConnectorHarnessIdSchema.nullable(),
  reportMode: LocalConnectorReportModeSchema,
  /** Set when reconnecting mid-task within the 60s disconnect grace window. */
  activeSessionId: z.string().min(1).max(128).optional(),
});
export type ConnectorHelloFrame = z.infer<typeof ConnectorHelloFrameSchema>;

export const ConnectorTaskProgressFrameSchema = z.object({
  type: z.literal('task.progress'),
  sessionId: z.string().min(1).max(128),
  kind: z.enum(['started', 'step', 'waiting_local_permission', 'resumed', 'finished']),
  acpSessionId: z.string().min(1).max(128).optional(),
  harness: z.string().min(1).max(64).optional(),
  agentName: z.string().min(1).max(120).optional(),
  step: z.number().int().nonnegative().optional(),
  toolKind: z.string().min(1).max(64).optional(),
  toolName: z.string().min(1).max(64).optional(),
  title: z.string().max(200).optional(),
  target: z.string().max(200).optional(),
  file: z.string().max(512).optional(),
  toolCallId: z.string().max(128).optional(),
  permissionOutcome: z.enum(['selected', 'cancelled']).optional(),
  filesChangedCount: z.number().int().nonnegative().optional(),
  status: z.enum(['completed', 'incomplete', 'cancelled', 'failed', 'interrupted']).optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type ConnectorTaskProgressFrame = z.infer<typeof ConnectorTaskProgressFrameSchema>;

export const ConnectorCommandRecordSchema = z.object({
  command: z.string().min(1).max(200),
  status: z.enum(['completed', 'failed', 'unknown']),
});

export const ConnectorTaskResultFrameSchema = z.object({
  type: z.literal('task.result'),
  sessionId: z.string().min(1).max(128),
  status: z.enum(['completed', 'incomplete', 'cancelled', 'failed', 'interrupted']),
  acpSessionId: z.string().min(1).max(128).nullable(),
  agentName: z.string().min(1).max(120).optional(),
  reportMode: LocalConnectorReportModeSchema,
  summary: z.string().max(20_000),
  filesChanged: z.array(z.string().min(1).max(512)).max(500),
  commandsRun: z.array(ConnectorCommandRecordSchema).max(200),
  steps: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  gitBranch: z.string().min(1).max(256).optional(),
  headSha: z.string().min(7).max(64).optional(),
  transcriptExcerpt: z.string().max(20_000).optional(),
  diffExcerpt: z.string().max(10_000).optional(),
  error: z
    .object({
      code: z.string().min(1).max(64),
      message: z.string().max(2_000),
    })
    .optional(),
});
export type ConnectorTaskResultFrame = z.infer<typeof ConnectorTaskResultFrameSchema>;

/** Every frame the standalone CLI may send to `/ws/connectors`. */
export const ConnectorClientFrameSchema = z.discriminatedUnion('type', [
  ConnectorHelloFrameSchema,
  ConnectorTaskProgressFrameSchema,
  ConnectorTaskResultFrameSchema,
]);
export type ConnectorClientFrame = z.infer<typeof ConnectorClientFrameSchema>;

export const ConnectorWelcomeFrameSchema = z.object({
  type: z.literal('connector.welcome'),
  connectorId: CuidSchema,
  name: z.string().min(1).max(80),
  heartbeatMs: z.number().int().positive(),
  /** True when the server still holds the `activeSessionId` sent in `connector.hello`. */
  resumeAccepted: z.boolean().optional(),
});
export type ConnectorWelcomeFrame = z.infer<typeof ConnectorWelcomeFrameSchema>;

export const ConnectorErrorFrameSchema = z.object({
  type: z.literal('connector.error'),
  code: z.enum(['CLI_OUTDATED', 'UNAUTHORIZED', 'INVALID_FRAME', 'CONNECTOR_BUSY']),
  message: z.string().max(500),
});
export type ConnectorErrorFrame = z.infer<typeof ConnectorErrorFrameSchema>;

export const ConnectorTaskDispatchFrameSchema = z.object({
  type: z.literal('task.dispatch'),
  sessionId: z.string().min(1).max(128),
  payloadHash: Sha256Hex,
  botId: CuidSchema,
  botName: z.string().min(1).max(80),
  relativeCwd: z.string().min(1).max(512),
  harness: LocalConnectorHarnessIdSchema,
  prompt: z.string().min(1).max(16_000),
  verifyCommand: z.string().min(1).max(512).optional(),
  maxDurationMs: z.number().int().positive(),
});
export type ConnectorTaskDispatchFrame = z.infer<typeof ConnectorTaskDispatchFrameSchema>;

export const ConnectorTaskCancelFrameSchema = z.object({
  type: z.literal('task.cancel'),
  sessionId: z.string().min(1).max(128),
  reason: z.string().max(200).optional(),
});
export type ConnectorTaskCancelFrame = z.infer<typeof ConnectorTaskCancelFrameSchema>;

/**
 * Every frame the orchestrator may send to `/ws/connectors`.
 *
 * Deliberately carries NO permission-answer frame: ACP `session/request_permission`
 * prompts are answered strictly locally on the user's machine.
 */
export const ConnectorServerFrameSchema = z.discriminatedUnion('type', [
  ConnectorWelcomeFrameSchema,
  ConnectorErrorFrameSchema,
  ConnectorTaskDispatchFrameSchema,
  ConnectorTaskCancelFrameSchema,
]);
export type ConnectorServerFrame = z.infer<typeof ConnectorServerFrameSchema>;
