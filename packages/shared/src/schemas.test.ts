import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as shared from './index.js';
import {
  AgentTurnSchema,
  AttachmentSchema,
  BotMcpServerSchema,
  BotSchema,
  ConversationSchema,
  McpAuthMetadataSchema,
  McpCredentialSchema,
  McpServerSchema,
  McpToolSchema,
  MessageSchema,
  MessageWithAttachmentsSchema,
  RecordingEventSchema,
  RecordingSchema,
  RoutineSchema,
  SandboxSchema,
  SkillRunSchema,
  SkillSchema,
  UserSchema,
} from './models.js';
import {
  ApprovalRespondPayloadSchema,
  ClientEventSchemas,
  ClientFrameSchema,
  ServerEventSchemas,
  ServerFrameSchema,
  WsFrameSchema,
} from './ws.js';
import {
  API_ROUTES,
  CreateBotBodySchema,
  HealthResponseSchema,
  InstallMcpServerBodySchema,
  ChatForwardedPropsSchema,
  ChatHydrationSchema,
  ChatJoinQuerySchema,
  ChatHydrateQuerySchema,
  ChatQuerySchema,
  PLUGIN_LISTING_TOKEN_BUDGET,
  SendMessageBodySchema,
  SetBotPluginsBodySchema,
  UpdateBotBodySchema,
  UpdateSkillBodySchema,
} from './rest.js';
import { PrincipalSchema } from './auth.js';
import { EditionSchema } from './enums.js';
import {
  CronSchema,
  HexColorSchema,
  JsonSchema,
  SlugSchema,
  IdentityNameSchema,
  SnakeCaseSchema,
} from './primitives.js';

/**
 * M0-08 — every Zod schema round-trips a valid fixture and rejects a malformed
 * one. Minimum one fixture pair per exported schema (PRD M0 required tests).
 *
 * The `pairs` table below is the enforcement mechanism: the coverage test at
 * the bottom asserts that every schema exported from `index.ts` appears here,
 * so adding a schema without a fixture pair fails the build.
 */

const CUID = 'clx1a2b3c4d5e6f7g8h9i0j1';
const CUID_2 = 'clx9z8y7x6w5v4u3t2s1r0q9';
it('rejects an invalid admitted clock in chat hydration', () => {
  expect(
    ChatHydrationSchema.safeParse({
      messages: [],
      activeRun: { runId: 'run', startedAt: 'now' },
      interrupts: null,
    }).success,
  ).toBe(false);
});
const CUID_3 = 'clx4m5n6o7p8q9r0s1t2u3v4';
const UUID = '3f1a5c2e-9b47-4d81-a6f2-0e5c7b8d1234';
const NOW = new Date('2026-09-01T12:00:00.000Z');

const userSettingsFixture = {
  userId: CUID_2,
  defaultModelId: CUID_3,
  language: 'fr',
  timezone: 'Europe/Paris',
  systemLanguage: 'en',
  systemTimezone: 'America/Port-au-Prince',
  updatedAt: NOW,
};

interface Pair {
  readonly schema: z.ZodType;
  /** One fixture, or several — every entry must parse. */
  readonly valid: unknown;
  /** One fixture, or several — every entry must be rejected. */
  readonly invalid: unknown;
  /** Extra valid fixtures (use when the schema itself expects arrays). */
  readonly validEach?: readonly unknown[];
  /** Extra invalid fixtures. */
  readonly invalidEach?: readonly unknown[];
}

const userFixture = {
  id: CUID,
  name: 'Ops',
  email: 'ops@example.com',
  emailVerified: true,
  image: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const botGroupFixture = {
  id: CUID_3,
  userId: CUID,
  name: 'Sales team',
  instructions: 'We sell to logistics firms.',
  sortOrder: 0,
  collapsed: false,
  createdAt: NOW,
  updatedAt: NOW,
};

const botFixture = {
  id: CUID,
  userId: CUID_2,
  name: 'Quill',
  role: 'Outbound Writer',
  avatarColor: '#8B6F47',
  avatarShape: 'circle',
  avatarUrl: null,
  systemPrompt: 'You write outbound email.',
  modelId: 'default',
  status: 'IDLE',
  sortOrder: 0,
  pinned: false,
  hiddenFromSidebar: false,
  autoReviewRules: [],
  sandboxId: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const attachmentFixture = {
  id: CUID,
  messageId: CUID_2,
  filename: 'leads.csv',
  mimeType: 'text/csv',
  sizeBytes: 2048,
  storageKey: 'artifacts/leads.csv',
};

const messageFixture = {
  id: CUID,
  conversationId: CUID_2,
  author: 'USER',
  fromBotId: null,
  content: 'Draft a follow-up.',
  parts: null,
  chainId: null,
  hopCount: 0,
  stopReason: null,
  createdAt: NOW,
};

const threadFixture = { id: CUID_2 } as const;
const previewFixture = { text: 'On it.', createdAt: NOW } as const;

const sandboxFixture = {
  id: CUID,
  userId: CUID_2,
  sessionId: 'harness-session-1',
  containerId: 'c0ffee',
  state: 'RUNNING',
  widthPx: 1280,
  heightPx: 800,
  vncPort: 5900,
  cdpPort: 9222,
  bridgePort: 7070,
  lastStartedAt: NOW,
  lastError: null,
  lastActiveAt: NOW,
  keepRunningUntil: null,
};

/** D-046: a machine that names no owner. Used as an invalid fixture. */
const { userId: _sandboxOwner, ...sandboxFixtureWithoutOwner } = sandboxFixture;

const recordingFixture = {
  id: CUID,
  botId: CUID_2,
  state: 'RECORDING',
  intent: 'Open Chrome and search',
  cdpAvailable: true,
  warning: null,
  error: null,
  startedAt: NOW,
  endedAt: null,
};

const skillFixture = {
  id: CUID,
  botId: CUID_2,
  name: 'open_example_site',
  description: 'Opens example.com and screenshots it.',
  paramsSchema: { type: 'object', properties: {} },
  steps: ['Open Chrome.', 'Go to example.com.', 'Take a screenshot.'],
  script: 'export default async function run() {}',
  version: 1,
  status: 'DRAFT',
  sourceRecordingId: null,
  createdAt: NOW,
};

const mcpServerFixture = {
  accessMode: 'SELECTED',
  accessRevision: 0,
  backend: 'DIRECT' as const,
  id: CUID,
  userId: CUID_2,
  name: 'Gmail',
  slug: 'gmail',
  category: 'Inbox And Collaboration',
  iconUrl: null,
  transport: 'HTTP',
  url: 'https://mcp.example.com/gmail',
  isPrivate: false,
  authType: 'OAUTH2',
  status: 'CONNECTED',
  lastError: null,
  createdAt: NOW,
};

const wsEnvelope = { id: UUID, ts: 1_756_732_800_000 };

/**
 * The §4.1 summary of an installed server: the row's own fields, minus
 * ownership and timestamps, plus the count of cached tools.
 */
const mcpServerSummaryFixture = {
  access: { mode: 'SELECTED', selectedBotIds: [] },
  backend: 'DIRECT' as const,
  id: mcpServerFixture.id,
  name: mcpServerFixture.name,
  slug: mcpServerFixture.slug,
  category: mcpServerFixture.category,
  iconUrl: mcpServerFixture.iconUrl,
  transport: mcpServerFixture.transport,
  url: mcpServerFixture.url,
  isPrivate: mcpServerFixture.isPrivate,
  authType: mcpServerFixture.authType,
  status: mcpServerFixture.status,
  toolCount: 12,
  lastError: mcpServerFixture.lastError,
};

// ── provider connections (D-082 … D-084) ──────────────────────────────────
// Note what is absent from every fixture below: there is no key, no
// ciphertext, and no field one could be put in. D-083 is a property of these
// types, so a fixture carrying one would not compile.

const providerConnectionFixture = {
  id: CUID,
  userId: CUID_2,
  kind: 'openai',
  name: 'Work OpenAI',
  endpoint: null,
  authKind: 'api_key',
  state: 'ACTIVE',
  hasCredential: true,
  credentialSetAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

const providerModelFixture = {
  id: CUID_3,
  connectionId: CUID,
  upstreamModelId: 'gpt-5.1',
  label: 'GPT-5.1',
  contextWindow: 400_000,
  capabilities: { tools: true, vision: true, reasoning: true },
  createdAt: NOW,
};

const modelOptionFixture = {
  id: CUID_3,
  connectionId: CUID,
  connectionName: 'Work OpenAI',
  kind: 'openai',
  upstreamModelId: 'gpt-5.1',
  label: 'GPT-5.1',
  contextWindow: 400_000,
  capabilities: { tools: true, vision: true, reasoning: true },
  available: true,
  connectionState: 'ACTIVE',
};

// ── Work (D-132 … D-140) ───────────────────────────────────────────────────

const projectFixture = {
  id: CUID,
  userId: CUID_2,
  name: 'Acme SaaS',
  description: null,
  color: '#4F46E5',
  status: 'ACTIVE',
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

const goalFixture = {
  id: CUID_3,
  userId: CUID_2,
  projectId: null,
  title: 'Lose 8 kg by March',
  outcome: null,
  targetOn: '2027-03-31',
  status: 'ACTIVE',
  closedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const taskFixture = {
  id: CUID,
  userId: CUID_2,
  projectId: null,
  goalId: CUID_3,
  parentId: null,
  title: 'Work out',
  brief: null,
  status: 'TODO',
  blockedReason: null,
  assigneeBotId: null,
  origin: 'OPERATOR',
  seriesId: CUID_3,
  occursAt: NOW,
  occursOn: '2026-09-01',
  createdByBotId: null,
  dueOn: null,
  rank: 'i',
  startedAt: null,
  completedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const taskCardFixture = {
  ...taskFixture,
  subtasks: { done: 0, total: 0 },
  deliverableCount: 0,
  series: { recent: { done: 4, total: 5 }, olderOpenCount: 1, newest: true },
};

const taskSeriesFixture = {
  id: CUID_3,
  userId: CUID_2,
  title: 'Work out',
  brief: null,
  assigneeBotId: null,
  projectId: null,
  goalId: CUID_3,
  cron: '0 7 * * 1,3,5',
  timezone: 'America/New_York',
  endsOn: null,
  enabled: true,
  lastFiredAt: null,
  origin: 'OPERATOR',
  createdAt: NOW,
  updatedAt: NOW,
};

const taskEventFixture = {
  id: CUID,
  taskId: CUID_2,
  userId: CUID_3,
  actor: 'BOT',
  actorBotId: CUID_2,
  actorLabel: 'Backend',
  type: 'STATUS_CHANGED',
  payload: { from: 'IN_PROGRESS', to: 'DONE' },
  startKey: null,
  messageId: CUID_3,
  createdAt: NOW,
};

const deliverableFixture = {
  id: CUID,
  userId: CUID_2,
  kind: 'FILE',
  title: 'PRD.md',
  summary: null,
  botId: CUID_3,
  attachmentId: CUID_2,
  messageId: null,
  url: null,
  sourcePath: '/home/bot/shared/PRD.md',
  taskId: null,
  goalId: CUID_3,
  projectId: null,
  createdAt: NOW,
};

const deliverableViewFixture = {
  ...deliverableFixture,
  attachment: attachmentFixture,
  task: null,
  goal: { id: CUID_3, title: 'Ship the MVP' },
};

const goalWithProgressFixture = {
  ...goalFixture,
  progress: { done: 12, total: 20 },
  series: [{ seriesId: CUID_3, title: 'Work out', enabled: true, rate: { done: 11, total: 12 } }],
  routineCount: 1,
};

const goalRoutineFixture = {
  id: CUID,
  botId: CUID_2,
  name: 'Weekly check-in',
  cron: '0 20 * * 0',
  timezone: 'America/New_York',
  enabled: true,
  lastRunAt: null,
  lastStatus: null,
};

const workPairs: Record<string, Pair> = {
  GitHubRepositorySchema: {
    schema: shared.GitHubRepositorySchema,
    valid: 'owner/repo',
    invalid: 'owner/..',
  },
  GitBranchSchema: { schema: shared.GitBranchSchema, valid: 'codex/fix', invalid: '../main' },
  GitObjectIdSchema: { schema: shared.GitObjectIdSchema, valid: 'a'.repeat(40), invalid: 'secret' },
  GitRelativeDirectorySchema: {
    schema: shared.GitRelativeDirectorySchema,
    valid: 'repos/example',
    invalid: '../other-bot',
  },
  GitCloneInputSchema: {
    schema: shared.GitCloneInputSchema,
    valid: { repository: 'owner/repo' },
    invalid: { repository: 'owner/repo', token: 'secret' },
  },
  GitFetchInputSchema: {
    schema: shared.GitFetchInputSchema,
    valid: { checkoutId: 'checkout' },
    invalid: { checkoutId: '' },
  },
  GitPushInputSchema: {
    schema: shared.GitPushInputSchema,
    valid: { checkoutId: 'checkout', branch: 'codex/fix' },
    invalid: { checkoutId: 'checkout', branch: 'fix', force: true },
  },
  GitCheckoutResultSchema: {
    schema: shared.GitCheckoutResultSchema,
    valid: {
      checkoutId: 'checkout',
      path: '/home/bot/agents/bot/repo',
      repository: 'owner/repo',
      branch: 'main',
      head: 'a'.repeat(40),
    },
    invalid: { checkoutId: 'checkout' },
  },
  GitPushResultSchema: {
    schema: shared.GitPushResultSchema,
    valid: {
      status: 'uncertain',
      repository: 'owner/repo',
      branch: 'codex/fix',
      head: 'a'.repeat(40),
    },
    invalid: { status: 'replayed', repository: 'owner/repo', branch: 'fix', head: 'a'.repeat(40) },
  },
  GitChangeReviewSchema: {
    schema: shared.GitChangeReviewSchema,
    valid: {
      repository: 'owner/repo',
      branch: 'fix',
      commit: 'a'.repeat(40),
      files: ['app.ts'],
      summary: '1 file changed',
    },
    invalid: {
      repository: 'owner/repo',
      branch: 'fix',
      commit: 'a'.repeat(40),
      files: [],
      summary: 'x'.repeat(16001),
    },
  },
  ProjectStatusSchema: { schema: shared.ProjectStatusSchema, valid: 'ARCHIVED', invalid: 'DONE' },
  GoalStatusSchema: { schema: shared.GoalStatusSchema, valid: 'ACHIEVED', invalid: 'DONE' },
  TaskStatusSchema: { schema: shared.TaskStatusSchema, valid: 'IN_REVIEW', invalid: 'REVIEW' },
  TaskOriginSchema: { schema: shared.TaskOriginSchema, valid: 'BOT', invalid: 'USER' },
  TaskActorSchema: { schema: shared.TaskActorSchema, valid: 'USER', invalid: 'OPERATOR' },
  TaskEventTypeSchema: { schema: shared.TaskEventTypeSchema, valid: 'NOTE', invalid: 'COMMENT' },
  DeliverableKindSchema: { schema: shared.DeliverableKindSchema, valid: 'LINK', invalid: 'URL' },
  CalendarDateSchema: {
    schema: shared.CalendarDateSchema,
    valid: '2026-10-03',
    invalid: '2026-10-03T00:00:00Z',
  },
  RankSchema: {
    schema: shared.RankSchema,
    valid: 'i',
    validEach: ['0i', 'zz1'],
    invalid: 'A',
    invalidEach: ['i0', '', 'a-b'],
  },
  ProjectSchema: {
    schema: shared.ProjectSchema,
    valid: projectFixture,
    invalid: { ...projectFixture, color: 'indigo' },
  },
  ProjectWithCountsSchema: {
    schema: shared.ProjectWithCountsSchema,
    valid: { ...projectFixture, openTaskCount: 3, goalCount: 1 },
    invalid: { ...projectFixture, openTaskCount: -1, goalCount: 1 },
  },
  GoalSchema: {
    schema: shared.GoalSchema,
    valid: goalFixture,
    invalid: { ...goalFixture, targetOn: 'March' },
  },
  TaskSchema: {
    schema: shared.TaskSchema,
    valid: taskFixture,
    invalid: { ...taskFixture, status: 'OPEN' },
  },
  DoneCountSchema: {
    schema: shared.DoneCountSchema,
    valid: { done: 3, total: 5 },
    invalid: { done: 3 },
  },
  SeriesSummarySchema: {
    schema: shared.SeriesSummarySchema,
    valid: taskCardFixture.series,
    invalid: { ...taskCardFixture.series, newest: 'yes' },
  },
  TaskCardSchema: {
    schema: shared.TaskCardSchema,
    valid: taskCardFixture,
    validEach: [
      { ...taskCardFixture, seriesId: null, occursAt: null, occursOn: null, series: null },
    ],
    invalid: { ...taskCardFixture, subtasks: '1/3' },
  },
  TaskSeriesSchema: {
    schema: shared.TaskSeriesSchema,
    valid: taskSeriesFixture,
    invalid: { ...taskSeriesFixture, timezone: 'EST' },
  },
  TaskEventSchema: {
    schema: shared.TaskEventSchema,
    valid: taskEventFixture,
    validEach: [
      {
        ...taskEventFixture,
        type: 'NOTE',
        payload: { text: '82.4 kg' },
        actor: 'USER',
        actorBotId: null,
      },
      {
        ...taskEventFixture,
        type: 'UNASSIGNED',
        payload: { botId: CUID_2, botName: 'Backend', reason: 'BOT_DELETED' },
      },
      { ...taskEventFixture, type: 'STARTED', payload: {}, startKey: UUID },
    ],
    // A payload shaped for another type is refused: the union is on `type`.
    invalid: { ...taskEventFixture, type: 'NOTE', payload: { from: 'TODO', to: 'DONE' } },
    invalidEach: [{ ...taskEventFixture, type: 'COMMENT' }],
  },
  DeliverableSchema: {
    schema: shared.DeliverableSchema,
    valid: deliverableFixture,
    invalid: { ...deliverableFixture, kind: 'DOC' },
  },
  DeliverableViewSchema: {
    schema: shared.DeliverableViewSchema,
    valid: deliverableViewFixture,
    invalid: { ...deliverableViewFixture, goal: { id: CUID_3 } },
  },
  SeriesRateSchema: {
    schema: shared.SeriesRateSchema,
    valid: goalWithProgressFixture.series[0],
    invalid: { seriesId: CUID_3, title: 'Work out', enabled: true },
  },
  GoalWithProgressSchema: {
    schema: shared.GoalWithProgressSchema,
    valid: goalWithProgressFixture,
    invalid: { ...goalWithProgressFixture, progress: 0.6 },
  },
  ListProjectsQuerySchema: {
    schema: shared.ListProjectsQuerySchema,
    valid: { status: 'ACTIVE' },
    validEach: [{}],
    invalid: { status: 'active' },
  },
  ListProjectsResponseSchema: {
    schema: shared.ListProjectsResponseSchema,
    valid: [{ ...projectFixture, openTaskCount: 0, goalCount: 0 }],
    invalid: [projectFixture],
  },
  CreateProjectBodySchema: {
    schema: shared.CreateProjectBodySchema,
    valid: { name: 'Health', color: '#16A34A' },
    invalid: { name: '   ', color: '#16A34A' },
  },
  UpdateProjectBodySchema: {
    schema: shared.UpdateProjectBodySchema,
    valid: { status: 'ARCHIVED' },
    invalid: {},
  },
  ProjectResponseSchema: {
    schema: shared.ProjectResponseSchema,
    valid: { ...projectFixture, openTaskCount: 0, goalCount: 0 },
    invalid: projectFixture,
  },
  RepeatSchema: {
    schema: shared.RepeatSchema,
    valid: { cron: '0 7 * * *', timezone: 'Europe/Paris' },
    invalid: { cron: 'every morning', timezone: 'Europe/Paris' },
  },
  ListTasksQuerySchema: {
    schema: shared.ListTasksQuerySchema,
    valid: { inbox: 'true', status: 'TODO,BLOCKED', occursFrom: '2026-09-01' },
    validEach: [{}],
    invalid: { status: 'TODO,OPEN' },
    invalidEach: [{ inbox: 'yes' }],
  },
  ListTasksResponseSchema: {
    schema: shared.ListTasksResponseSchema,
    valid: [taskCardFixture],
    invalid: [taskFixture],
  },
  CreateTaskBodySchema: {
    schema: shared.CreateTaskBodySchema,
    valid: { title: 'API auth', assigneeBotId: CUID, dueOn: '2026-10-03' },
    validEach: [{ title: 'Log my weight', repeat: { cron: '0 8 * * *', timezone: 'Etc/UTC' } }],
    invalid: { title: '' },
    invalidEach: [{ title: 'x', repeat: { cron: '0 8 * * *' } }],
  },
  UpdateTaskBodySchema: {
    schema: shared.UpdateTaskBodySchema,
    valid: { status: 'DONE' },
    validEach: [{ assigneeBotId: null, rank: 'k' }],
    invalid: {},
    invalidEach: [{ rank: 'K' }],
  },
  CreateTaskResponseSchema: {
    schema: shared.CreateTaskResponseSchema,
    valid: { task: taskCardFixture, series: taskSeriesFixture },
    validEach: [{ task: null, series: taskSeriesFixture }],
    invalid: { task: taskCardFixture },
  },
  TaskResponseSchema: {
    schema: shared.TaskResponseSchema,
    valid: taskCardFixture,
    invalid: taskFixture,
  },
  WorkUsageSchema: {
    schema: shared.WorkUsageSchema,
    valid: { turns: 3, inputTokens: 12_400, outputTokens: 1_850 },
    invalid: { turns: 1, inputTokens: -1, outputTokens: 0 },
  },
  TaskDetailResponseSchema: {
    schema: shared.TaskDetailResponseSchema,
    valid: {
      ...taskCardFixture,
      subtaskRows: [],
      events: [taskEventFixture],
      deliverables: [deliverableViewFixture],
      seriesRow: taskSeriesFixture,
      lastLinkedMessageId: null,
    },
    invalid: { ...taskCardFixture, subtaskRows: [], events: [], deliverables: [] },
  },
  AddTaskNoteBodySchema: {
    schema: shared.AddTaskNoteBodySchema,
    valid: { text: 'JWT + refresh tokens' },
    invalid: { text: '  ' },
  },
  StartTaskResponseSchema: {
    schema: shared.StartTaskResponseSchema,
    valid: { messageId: CUID },
    invalid: {},
  },
  IdempotencyKeySchema: { schema: shared.IdempotencyKeySchema, valid: UUID, invalid: 'start-1' },
  UpdateTaskSeriesBodySchema: {
    schema: shared.UpdateTaskSeriesBodySchema,
    valid: { enabled: false },
    invalid: {},
  },
  TaskSeriesDetailResponseSchema: {
    schema: shared.TaskSeriesDetailResponseSchema,
    valid: { ...taskSeriesFixture, occurrences: [taskCardFixture] },
    invalid: taskSeriesFixture,
  },
  ListGoalsQuerySchema: {
    schema: shared.ListGoalsQuerySchema,
    valid: { status: 'ACTIVE', projectId: CUID },
    invalid: { status: 'OPEN' },
  },
  ListGoalsResponseSchema: {
    schema: shared.ListGoalsResponseSchema,
    valid: [goalWithProgressFixture],
    invalid: [goalFixture],
  },
  CreateGoalBodySchema: {
    schema: shared.CreateGoalBodySchema,
    valid: { title: 'Ship the MVP', projectId: CUID },
    invalid: { title: 'Ship the MVP', targetOn: 'soon' },
  },
  UpdateGoalBodySchema: {
    schema: shared.UpdateGoalBodySchema,
    valid: { status: 'ACHIEVED' },
    invalid: {},
  },
  GoalResponseSchema: {
    schema: shared.GoalResponseSchema,
    valid: goalWithProgressFixture,
    invalid: goalFixture,
  },
  GoalRoutineSchema: {
    schema: shared.GoalRoutineSchema,
    valid: goalRoutineFixture,
    invalid: { ...goalRoutineFixture, lastStatus: 'OK' },
  },
  GoalDetailResponseSchema: {
    schema: shared.GoalDetailResponseSchema,
    valid: {
      ...goalWithProgressFixture,
      tasks: [taskCardFixture],
      routines: [goalRoutineFixture],
      deliverables: [],
    },
    invalid: goalWithProgressFixture,
  },
  ListDeliverablesQuerySchema: {
    schema: shared.ListDeliverablesQuerySchema,
    valid: { unfiled: 'true', limit: '20' },
    validEach: [{ q: 'weekly report' }],
    invalid: { limit: '500' },
    invalidEach: [{ q: '   ' }],
  },
  ListDeliverablesResponseSchema: {
    schema: shared.ListDeliverablesResponseSchema,
    valid: { items: [deliverableViewFixture], nextCursor: null },
    invalid: { items: [deliverableFixture], nextCursor: null },
  },
  CreateDeliverableBodySchema: {
    schema: shared.CreateDeliverableBodySchema,
    valid: { kind: 'LINK', url: 'https://docs.google.com/d/1', title: 'Q3 plan' },
    validEach: [{ kind: 'MESSAGE', messageId: CUID, title: 'Weekly report' }],
    // A FILE is recorded by attach_file, never posted.
    invalid: { kind: 'FILE', title: 'x' },
    invalidEach: [{ kind: 'LINK', url: 'javascript:alert(1)', title: 'x' }],
  },
  UpdateDeliverableBodySchema: {
    schema: shared.UpdateDeliverableBodySchema,
    valid: { taskId: CUID },
    validEach: [{ taskId: null, goalId: null, projectId: null }],
    invalid: {},
  },
  DeliverableResponseSchema: {
    schema: shared.DeliverableResponseSchema,
    valid: deliverableViewFixture,
    invalid: deliverableFixture,
  },
  SearchTypeSchema: { schema: shared.SearchTypeSchema, valid: 'message', invalid: 'chat' },
  SearchQuerySchema: {
    schema: shared.SearchQuerySchema,
    valid: { q: 'prd', types: 'task,deliverable' },
    invalid: { q: '   ' },
    invalidEach: [{ q: 'prd', types: 'files' }],
  },
  SearchResponseSchema: {
    schema: shared.SearchResponseSchema,
    valid: {
      tasks: [
        {
          id: CUID,
          title: 'Split the PRD into tasks',
          status: 'DONE',
          assigneeBotId: CUID_2,
          projectId: null,
          excerpt: 'Split the <<PRD>> into tasks',
        },
      ],
      goals: [],
      projects: [],
      deliverables: [],
      messages: [
        { id: CUID, botId: CUID_2, author: 'BOT', createdAt: NOW, excerpt: 'the <<PRD>> covers' },
      ],
    },
    invalid: { tasks: [] },
  },
  WorkErrorCodeSchema: {
    schema: shared.WorkErrorCodeSchema,
    valid: 'START_KEY_REUSED',
    invalid: 'CONFLICT',
  },
  TaskChangedPayloadSchema: {
    schema: shared.TaskChangedPayloadSchema,
    valid: { taskId: CUID },
    validEach: [{ taskId: CUID, deleted: true }],
    invalid: { taskId: CUID, deleted: false },
  },
  ProjectChangedPayloadSchema: {
    schema: shared.ProjectChangedPayloadSchema,
    valid: { projectId: CUID },
    invalid: { id: CUID },
  },
  GoalChangedPayloadSchema: {
    schema: shared.GoalChangedPayloadSchema,
    valid: { goalId: CUID, deleted: true },
    invalid: {},
  },
  DeliverableChangedPayloadSchema: {
    schema: shared.DeliverableChangedPayloadSchema,
    valid: { deliverableId: CUID },
    invalid: { deliverableId: '' },
  },
};

const templateBotFixture = {
  key: 'writer',
  name: 'Writer',
  role: 'Writer',
  summary: 'Turns a brief into drafts.',
  systemPrompt: 'Write clearly',
  avatarColor: '#4c6ef5',
  avatarShape: 'cloud',
  toolSlugs: [],
};
const templateFixture = {
  id: 'content',
  revision: '1',
  kind: 'crew',
  title: 'Content',
  category: 'Marketing',
  summary: 'Prepare drafts',
  outcomes: ['Drafts'],
  inputs: ['A topic'],
  examples: [{ title: 'Example', content: 'A draft' }],
  tools: [],
  bots: [templateBotFixture],
  handoff: ['Research', 'Write'],
  starterTask: 'Draft a post',
  routineSuggestion: 'Optional',
};
const onboardingFixture = {
  userId: CUID,
  welcomeSeen: false,
  discovery: 'NEW',
  createdAt: NOW,
  updatedAt: NOW,
};

const pairs: Record<string, Pair> = {
  TelegramStatusSchema: {
    schema: shared.TelegramStatusSchema,
    valid: { configured: false, canCreateBots: false, connection: null, pending: null },
    validEach: [
      {
        configured: true,
        canCreateBots: true,
        connection: {
          botUsername: 'ana_crew_bot',
          displayName: 'Ana',
          selectedBotId: CUID,
          connectedAt: NOW,
        },
        pending: { botUsername: 'ana_crew_bot', telegramName: null, expiresAt: NOW },
      },
    ],
    invalid: {
      configured: true,
      canCreateBots: true,
      connection: { botUsername: 'ana', displayName: 'Me', selectedBotId: 42, connectedAt: NOW },
      pending: null,
    },
    invalidEach: [{ configured: true, connection: null, pending: null }],
  },
  TelegramLinkResponseSchema: {
    schema: shared.TelegramLinkResponseSchema,
    valid: {
      code: 'K7M2Q9XF',
      expiresAt: NOW,
      createUrl: 'https://t.me/newbot/CrewaidBot/ana_crew_k2m4_bot?name=Ana%27s+Crew',
    },
    validEach: [{ code: 'K7M2Q9XF', expiresAt: NOW, createUrl: null }],
    invalid: { code: 'K7M2Q9XF', expiresAt: NOW, createUrl: 'https://evil.example/newbot/a/b' },
    invalidEach: [
      { code: 'K7M2-Q9XF', expiresAt: NOW, createUrl: null },
      { code: 'O0I1L000', expiresAt: NOW, createUrl: null },
      { code: 'K7M2Q9XF', expiresAt: NOW, createUrl: 'https://t.me/newbot/CrewaidBot' },
      { code: 'K7M2Q9XF', expiresAt: NOW, createUrl: 'https://t.me/newbot/a/b?start=x' },
      { code: 'K7M2Q9XF', expiresAt: NOW, createUrl: 'not a url' },
    ],
  },
  TelegramPairingCodeSchema: {
    schema: shared.TelegramPairingCodeSchema,
    valid: 'K7M2Q9XF',
    invalid: 'k7m2q9xf',
    invalidEach: ['K7M2Q9X', 'K7M2Q9XF2', 'K7M0Q9XF'],
  },
  TelegramUsernameSchema: {
    schema: shared.TelegramUsernameSchema,
    valid: 'ana_crew_bot',
    invalid: 'ana',
    invalidEach: ['_ana_bot', 'ana crew bot', 'a'.repeat(33)],
  },
  TelegramBotTokenSchema: {
    schema: shared.TelegramBotTokenSchema,
    valid: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
    invalid: '123456789',
    invalidEach: ['bot:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', '123:short'],
  },
  TelegramBotTokenRequestSchema: {
    schema: shared.TelegramBotTokenRequestSchema,
    valid: { token: ' 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw ' },
    invalid: { token: 'https://api.telegram.org/bot123/getMe' },
  },
  TelegramBotRegisteredSchema: {
    schema: shared.TelegramBotRegisteredSchema,
    valid: {
      botUsername: 'ana_crew_bot',
      code: 'K7M2Q9XF',
      expiresAt: NOW,
      openUrl: 'https://t.me/ana_crew_bot?start=K7M2Q9XF',
    },
    invalid: {
      botUsername: 'ana_crew_bot',
      code: 'K7M2Q9XF',
      expiresAt: NOW,
      openUrl: 'https://t.me/ana_crew_bot?start=K7M2Q9XF&admin=1',
    },
    invalidEach: [
      {
        botUsername: 'ana_crew_bot',
        code: 'K7M2Q9XF',
        expiresAt: NOW,
        openUrl: 'http://t.me/ana_crew_bot?start=K7M2Q9XF',
      },
    ],
  },
  TelegramConfirmResponseSchema: {
    schema: shared.TelegramConfirmResponseSchema,
    valid: { connected: true },
    invalid: { connected: false },
  },
  TelegramDisconnectResponseSchema: {
    schema: shared.TelegramDisconnectResponseSchema,
    valid: { disconnected: true },
    invalid: { disconnected: false },
  },
  TemplateSchema: {
    schema: shared.TemplateSchema,
    valid: templateFixture,
    invalid: { ...templateFixture, bots: [] },
  },
  TemplateBotSchema: {
    schema: shared.TemplateBotSchema,
    valid: templateBotFixture,
    invalid: { ...templateBotFixture, avatarShape: 'triangle' },
  },
  TemplateListSchema: {
    schema: shared.TemplateListSchema,
    valid: [templateFixture],
    invalid: [{}],
  },
  TemplateInstallBodySchema: {
    schema: shared.TemplateInstallBodySchema,
    valid: { templateId: 'content', revision: '1', idempotencyKey: 'request-123' },
    invalid: { templateId: 'content', revision: '1', idempotencyKey: 'x' },
  },
  TemplateInstallResponseSchema: {
    schema: shared.TemplateInstallResponseSchema,
    valid: {
      id: CUID,
      templateId: 'content',
      revision: '1',
      groupId: null,
      botIds: [CUID_2],
      createdAt: NOW,
    },
    invalid: { botIds: [] },
  },
  OnboardingDiscoverySchema: {
    schema: shared.OnboardingDiscoverySchema,
    valid: 'LEARNING',
    invalid: 'UNKNOWN',
  },
  OnboardingStateSchema: {
    schema: shared.OnboardingStateSchema,
    valid: onboardingFixture,
    invalid: { ...onboardingFixture, discovery: 'UNKNOWN' },
  },
  UpdateOnboardingBodySchema: {
    schema: shared.UpdateOnboardingBodySchema,
    valid: { reply: 'TOUR' },
    invalid: { reply: 'TASK', welcomeSeen: true },
  },
  WelcomeReplySchema: {
    schema: shared.WelcomeReplySchema,
    valid: 'TASK',
    invalid: 'SKIP',
  },
  OnboardingBootstrapBodySchema: {
    schema: shared.OnboardingBootstrapBodySchema,
    valid: { language: 'fr' },
    invalid: { language: 'klingon' },
  },
  OnboardingBootstrapSchema: {
    schema: shared.OnboardingBootstrapSchema,
    valid: { bot: botFixture, onboarding: onboardingFixture, isNewAccount: true },
    invalid: { isNewAccount: true },
  },
  UpdateMemoryBodySchema: {
    schema: shared.UpdateMemoryBodySchema,
    valid: { text: 'I run a small business.' },
    invalid: { text: '' },
  },

  // ── primitives ──────────────────────────────────────────────────────────
  CuidSchema: { schema: shared.CuidSchema, valid: CUID, invalid: '' },
  DateTimeSchema: { schema: shared.DateTimeSchema, valid: NOW, invalid: 'not-a-date' },
  EpochMsSchema: { schema: shared.EpochMsSchema, valid: 1_756_732_800_000, invalid: -1 },
  JsonSchema: { schema: JsonSchema, valid: { a: [1, 'b', null] }, invalid: undefined },
  JsonSchemaObjectSchema: {
    schema: shared.JsonSchemaObjectSchema,
    valid: { type: 'object' },
    invalid: 'nope',
  },
  HexColorSchema: { schema: HexColorSchema, valid: '#8B6F47', invalid: '8B6F47' },
  SnakeCaseSchema: { schema: SnakeCaseSchema, valid: 'send_follow_up', invalid: 'SendFollowUp' },
  SlugSchema: { schema: SlugSchema, valid: 'gmail', invalid: 'Gmail Inbox' },
  // A dot is the invalid case that matters: `company.google` reads as a
  // perfectly ordinary name and would be a path segment Chrome accepts,
  // which is how `..` gets one character closer to being a directory name.
  IdentityNameSchema: {
    schema: IdentityNameSchema,
    valid: 'company-google',
    invalid: 'company.google',
  },
  CronSchema: { schema: CronSchema, valid: '*/5 * * * *', invalid: '*/5 * * *' },
  TimezoneSchema: {
    schema: shared.TimezoneSchema,
    valid: 'America/Port-au-Prince',
    // The runtime's own zone list offers `UTC`, and a picker built from it
    // must never produce a zone the contract refuses.
    validEach: ['UTC', 'Etc/UTC'],
    invalid: 'EDT',
  },
  LocaleSchema: {
    schema: shared.LocaleSchema,
    valid: 'fr',
    validEach: ['en', 'zh-Hant', 'pt'],
    // A region tag is what a computer reports, never what is stored.
    invalid: 'fr-FR',
    invalidEach: ['zh', 'xx'],
  },

  // ── enums ───────────────────────────────────────────────────────────────
  BotStatusSchema: { schema: shared.BotStatusSchema, valid: 'AWAITING_APPROVAL', invalid: 'BUSY' },
  MessageAuthorSchema: { schema: shared.MessageAuthorSchema, valid: 'TOOL', invalid: 'ASSISTANT' },
  TurnStatusSchema: {
    schema: shared.TurnStatusSchema,
    valid: 'interrupted',
    invalid: 'INTERRUPTED',
  },
  SandboxStateSchema: { schema: shared.SandboxStateSchema, valid: 'UNHEALTHY', invalid: 'PAUSED' },
  RecordingStateSchema: {
    schema: shared.RecordingStateSchema,
    valid: 'COMPILING',
    invalid: 'DONE',
  },
  RecordingWarningSchema: {
    schema: shared.RecordingWarningSchema,
    valid: 'TIME_LIMIT',
    invalid: 'LOST_EVENTS',
  },
  CaptureLayerSchema: { schema: shared.CaptureLayerSchema, valid: 'ATSPI', invalid: 'DOM' },
  SkillStatusSchema: { schema: shared.SkillStatusSchema, valid: 'APPROVED', invalid: 'PUBLISHED' },
  RunStatusSchema: { schema: shared.RunStatusSchema, valid: 'SUCCEEDED', invalid: 'OK' },
  RoutineOriginSchema: { schema: shared.RoutineOriginSchema, valid: 'BOT', invalid: 'SCHEDULER' },
  McpTransportSchema: { schema: shared.McpTransportSchema, valid: 'SSE', invalid: 'stdio' },
  McpAuthTypeSchema: { schema: shared.McpAuthTypeSchema, valid: 'OAUTH2', invalid: 'BASIC' },
  McpStatusSchema: { schema: shared.McpStatusSchema, valid: 'NEEDS_REAUTH', invalid: 'PENDING' },

  // ── agent layer (M1-BE-10 / M1-BE-11 / M5 auto-review) ──────────────────
  AutoReviewDecisionSchema: {
    schema: shared.AutoReviewDecisionSchema,
    valid: 'deny',
    invalid: 'approve',
  },
  AutoReviewRuleSchema: {
    schema: shared.AutoReviewRuleSchema,
    valid: { toolPattern: 'shell', decision: 'ask' },
    invalid: { toolPattern: 'shell', decision: 'maybe' },
  },
  PluginBridgeCallSchema: {
    schema: shared.PluginBridgeCallSchema,
    valid: { tool: 'github__create_issue', arguments: { title: 'a bug' } },
    // An empty name, which is the one a model produces when it has forgotten
    // what it was calling — and the one that would make a catalogue lookup
    // miss and a "did you mean" match every tool the bot has.
    invalid: { tool: '', arguments: {} },
  },
  ApprovalModeSchema: {
    schema: shared.ApprovalModeSchema,
    valid: 'FULL',
    invalid: 'YOLO',
  },
  AutoReviewRulesSchema: {
    schema: shared.AutoReviewRulesSchema,
    valid: [{ toolPattern: 'gmail__*', argMatch: 'draft', decision: 'allow' }],
    invalid: [{ toolPattern: '', decision: 'allow' }],
  },
  ModelProviderSchema: {
    schema: shared.ModelProviderSchema,
    valid: 'anthropic',
    invalid: 'bedrock',
  },
  ModelCapabilitiesSchema: {
    schema: shared.ModelCapabilitiesSchema,
    valid: { tools: true, vision: false, reasoning: true },
    invalid: { tools: true, vision: false },
  },

  // ── provider connections (D-082 … D-084, D-086) ───────────────────────────
  ProviderKindSchema: {
    schema: shared.ProviderKindSchema,
    valid: 'custom',
    validEach: ['crewaid'],
    invalid: 'bedrock',
  },
  CreatableProviderKindSchema: {
    schema: shared.CreatableProviderKindSchema,
    valid: 'openrouter',
    invalid: 'crewaid',
  },
  ConnectionAuthKindSchema: {
    schema: shared.ConnectionAuthKindSchema,
    valid: 'api_key',
    // D-084: V1 accepts exactly one kind. A future kind arrives as a contract
    // change, which is what makes this rejection the point rather than a gap.
    invalid: 'oauth2',
  },
  ConnectionStateSchema: {
    schema: shared.ConnectionStateSchema,
    valid: 'NEEDS_CREDENTIAL',
    invalid: 'active',
  },
  ProviderEndpointSchema: {
    schema: shared.ProviderEndpointSchema,
    valid: 'https://api.example.com/v1',
    invalid: 'http://api.example.com/v1',
    invalidEach: [
      // Credentials in the URL would be a second, unencrypted credential
      // store that D-083 knows nothing about.
      'https://user:secret@api.example.com/v1',
      // A fragment is never sent to a server, so one here means the operator
      // pasted something other than an API base URL.
      'https://api.example.com/v1#section',
      'api.example.com/v1',
      'ftp://api.example.com',
      '',
    ],
  },
  UpstreamModelIdSchema: {
    schema: shared.UpstreamModelIdSchema,
    valid: 'moonshotai/kimi-k3',
    invalid: 'gpt 5',
  },
  ProviderModelSchema: {
    schema: shared.ProviderModelSchema,
    valid: providerModelFixture,
    invalid: { ...providerModelFixture, contextWindow: 0 },
  },
  ProviderConnectionSchema: {
    schema: shared.ProviderConnectionSchema,
    valid: providerConnectionFixture,
    validEach: [
      // A custom connection carries the endpoint the built-ins do not need.
      {
        ...providerConnectionFixture,
        kind: 'custom',
        endpoint: 'https://llm.internal-vendor.example/v1',
        state: 'NEEDS_CREDENTIAL',
        hasCredential: false,
        credentialSetAt: null,
      },
    ],
    invalid: { ...providerConnectionFixture, state: 'ACTIVE', authKind: 'subscription' },
  },
  ProviderConnectionWithModelsSchema: {
    schema: shared.ProviderConnectionWithModelsSchema,
    valid: { ...providerConnectionFixture, models: [providerModelFixture] },
    invalid: { ...providerConnectionFixture, models: providerModelFixture },
  },
  ModelRefSchema: {
    schema: shared.ModelRefSchema,
    valid: 'default',
    validEach: [CUID_3],
    invalid: '',
  },
  ModelOptionSchema: {
    schema: shared.ModelOptionSchema,
    valid: modelOptionFixture,
    validEach: [
      // D-086: a model whose connection lost its key is LISTED, unavailable.
      { ...modelOptionFixture, available: false, connectionState: 'NEEDS_CREDENTIAL' },
    ],
    invalid: { ...modelOptionFixture, available: 'yes' },
  },
  ListModelOptionsResponseSchema: {
    schema: shared.ListModelOptionsResponseSchema,
    valid: { models: [modelOptionFixture], defaultModelId: CUID_3 },
    validEach: [{ models: [], defaultModelId: null }],
    invalid: { models: [modelOptionFixture] },
  },
  UserSettingsSchema: {
    schema: shared.UserSettingsSchema,
    valid: userSettingsFixture,
    validEach: [
      {
        userId: CUID_2,
        defaultModelId: null,
        language: null,
        timezone: null,
        systemLanguage: null,
        systemTimezone: null,
        updatedAt: NOW,
      },
    ],
    invalid: { userId: CUID_2, updatedAt: NOW },
    invalidEach: [{ ...userSettingsFixture, language: 'french' }],
  },

  // ── provider REST (V1-05) ────────────────────────────────────────────────
  ProviderApiKeySchema: {
    schema: shared.ProviderApiKeySchema,
    valid: 'sk-0123456789abcdef',
    invalid: 'short',
    // All-whitespace would otherwise pass `min(8)` and be stored as a
    // credential that 401s forever.
    invalidEach: ['          ', ''],
  },
  CreateProviderConnectionBodySchema: {
    schema: shared.CreateProviderConnectionBodySchema,
    valid: { kind: 'openai', name: 'Work OpenAI' },
    validEach: [
      { kind: 'openai', name: 'Work OpenAI', apiKey: 'sk-0123456789abcdef' },
      { kind: 'custom', name: 'Vendor', endpoint: 'https://llm.vendor.example/v1' },
    ],
    // A built-in with an endpoint, and a custom without one: both directions
    // of the same refusal, because either would produce a connection whose
    // kind and endpoint disagree about where requests go.
    invalid: { kind: 'openai', name: 'Work', endpoint: 'https://api.openai.com/v1' },
    invalidEach: [
      { kind: 'custom', name: 'Vendor' },
      { kind: 'bedrock', name: 'Nope' },
      // D-157: the server makes the included-models connection, nobody else.
      { kind: 'crewaid', name: 'Crewaid' },
      { kind: 'custom', name: 'Vendor', endpoint: 'http://llm.vendor.example/v1' },
    ],
  },
  UpdateProviderConnectionBodySchema: {
    schema: shared.UpdateProviderConnectionBodySchema,
    valid: { name: 'Renamed' },
    validEach: [{ state: 'DISABLED' }],
    invalid: {},
    // NEEDS_CREDENTIAL is owned by the credential routes: a client that could
    // set it would be claiming a key was removed when it was not.
    invalidEach: [{ state: 'NEEDS_CREDENTIAL' }, { kind: 'anthropic' }],
  },
  SetProviderCredentialBodySchema: {
    schema: shared.SetProviderCredentialBodySchema,
    valid: { apiKey: 'sk-0123456789abcdef' },
    invalid: { apiKey: '' },
  },
  CreateProviderModelBodySchema: {
    schema: shared.CreateProviderModelBodySchema,
    valid: {
      upstreamModelId: 'gpt-5.1',
      label: 'GPT-5.1',
      contextWindow: 400_000,
      capabilities: { tools: true, vision: true, reasoning: true },
    },
    invalid: {
      upstreamModelId: 'gpt-5.1',
      label: 'GPT-5.1',
      contextWindow: 0,
      capabilities: { tools: true, vision: true, reasoning: true },
    },
  },
  UpdateProviderModelBodySchema: {
    schema: shared.UpdateProviderModelBodySchema,
    valid: { label: 'GPT-5.1 (fast)' },
    invalid: {},
  },
  ListProviderConnectionsResponseSchema: {
    schema: shared.ListProviderConnectionsResponseSchema,
    valid: { connections: [{ ...providerConnectionFixture, models: [providerModelFixture] }] },
    validEach: [{ connections: [] }],
    invalid: { connections: providerConnectionFixture },
  },
  UserSettingsResponseSchema: {
    schema: shared.UserSettingsResponseSchema,
    valid: { settings: userSettingsFixture },
    invalid: { settings: { userId: CUID_2 } },
  },
  UpdateUserSettingsBodySchema: {
    schema: shared.UpdateUserSettingsBodySchema,
    // Null clears the default; an absent field leaves it alone. One optional
    // field cannot express both, and clearing is a deliberate act.
    valid: { defaultModelId: CUID_3 },
    validEach: [
      { defaultModelId: null },
      { language: 'fr', timezone: 'Europe/Paris' },
      { language: null, timezone: null },
      { systemLanguage: 'zh-Hant', systemTimezone: 'UTC' },
    ],
    invalid: {},
    invalidEach: [
      { defaultModelId: 42 },
      { language: 'fr-FR' },
      // Shaped like a zone, but not one the runtime can schedule in.
      { timezone: 'Mars/Olympus_Mons' },
    ],
  },
  ModelErrorCodeSchema: {
    schema: shared.ModelErrorCodeSchema,
    valid: 'CONTEXT_OVERFLOW',
    invalid: 'rate_limited',
  },
  NormalizedModelErrorSchema: {
    schema: shared.NormalizedModelErrorSchema,
    valid: {
      code: 'RATE_LIMITED',
      message: 'The model provider is rate limiting this key.',
      provider: 'openai',
      retryable: true,
      retryAfterMs: 2_000,
    },
    invalid: { code: 'RATE_LIMITED', message: 'nope' },
  },
  ProviderExplanationSchema: {
    schema: shared.ProviderExplanationSchema,
    valid: {
      source: 'OpenCode',
      text: "OpenCode's free tier can only be used from within OpenCode.",
    },
    invalid: { source: 'OpenCode', text: 'x'.repeat(401) },
  },

  // ── models (§3) ─────────────────────────────────────────────────────────
  UserSchema: { schema: UserSchema, valid: userFixture, invalid: { ...userFixture, email: 'bad' } },
  BotSchema: {
    schema: BotSchema,
    valid: botFixture,
    validEach: [{ ...botFixture, approvalMode: 'ASK' }],
    invalid: { ...botFixture, avatarColor: 'brown' },
    invalidEach: [{ ...botFixture, approvalMode: 'ALWAYS' }],
  },
  ConversationSchema: {
    schema: ConversationSchema,
    valid: { id: CUID, botId: CUID_2, createdAt: NOW },
    invalid: { id: CUID, createdAt: NOW },
  },
  MessageSchema: {
    schema: MessageSchema,
    valid: messageFixture,
    invalid: { ...messageFixture, author: 'ASSISTANT' },
  },
  MessageWithAttachmentsSchema: {
    schema: MessageWithAttachmentsSchema,
    valid: { ...messageFixture, attachments: [attachmentFixture] },
    invalid: { ...messageFixture, attachments: 'none' },
  },
  AttachmentSchema: {
    schema: AttachmentSchema,
    valid: attachmentFixture,
    invalid: { ...attachmentFixture, sizeBytes: -5 },
  },
  AgentTurnSchema: {
    schema: AgentTurnSchema,
    valid: {
      id: CUID,
      botId: CUID_2,
      triggerMessageId: CUID,
      status: 'running',
      stepIndex: 3,
      steps: [],
      inputTokens: 120,
      outputTokens: 45,
      cachedInputTokens: 90,
      cacheCreationTokens: 30,
      startedAt: NOW,
      endedAt: null,
      stopReason: null,
    },
    invalid: {
      id: CUID,
      botId: CUID_2,
      triggerMessageId: CUID,
      status: 'running',
      stepIndex: -1,
      steps: [],
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      startedAt: NOW,
      endedAt: null,
      stopReason: null,
    },
  },
  SandboxSchema: {
    schema: SandboxSchema,
    valid: sandboxFixture,
    // D-046: a machine with no owner is unreachable through every R7-scoped
    // query, so the wire shape must not admit one either.
    validEach: [{ ...sandboxFixture, sessionId: null, containerId: null, state: 'STOPPED' }],
    invalid: { ...sandboxFixture, vncPort: 70000 },
    invalidEach: [{ ...sandboxFixture, userId: null }, sandboxFixtureWithoutOwner],
  },
  RecordingSchema: {
    schema: RecordingSchema,
    valid: recordingFixture,
    invalid: { ...recordingFixture, state: 'PAUSED' },
  },
  RecordingEventSchema: {
    schema: RecordingEventSchema,
    valid: {
      id: CUID,
      recordingId: CUID_2,
      tsOffsetMs: 1500,
      layer: 'X11',
      type: 'click',
      payload: { x: 10, y: 20 },
      screenshotKey: 'shots/1.png',
      correlatedWithId: null,
    },
    invalid: {
      id: CUID,
      recordingId: CUID_2,
      tsOffsetMs: 1500,
      layer: 'DOM',
      type: 'click',
      payload: {},
      screenshotKey: null,
      correlatedWithId: null,
    },
  },
  SkillSchema: {
    schema: SkillSchema,
    valid: skillFixture,
    invalid: { ...skillFixture, name: 'OpenExampleSite' },
  },
  SkillStepsSchema: {
    schema: shared.SkillStepsSchema,
    valid: ['Open Chrome.', 'Press Enter.'],
    // D-098: the caps mirror the compiler's validator, so a summary nobody
    // would read is refused on the wire too. (A whitespace-only step passes
    // here and is refused at compile time — this schema measures length, and
    // the validator is the layer that judges words.)
    invalid: [''],
    invalidEach: [Array.from({ length: 31 }, () => 'a step'), ['x'.repeat(301)]],
  },
  SkillRunSchema: {
    schema: SkillRunSchema,
    valid: {
      id: CUID,
      skillId: CUID_2,
      params: {},
      status: 'PENDING',
      logs: null,
      error: null,
      startedAt: null,
      endedAt: null,
    },
    invalid: {
      id: CUID,
      skillId: CUID_2,
      params: {},
      status: 'WAITING',
      logs: null,
      error: null,
      startedAt: null,
      endedAt: null,
    },
  },
  McpServerSchema: {
    schema: McpServerSchema,
    valid: mcpServerFixture,
    invalid: { ...mcpServerFixture, url: 'not-a-url' },
  },
  McpCredentialSchema: {
    schema: McpCredentialSchema,
    valid: {
      id: CUID,
      serverId: CUID_2,
      accessToken: 'enc:abc',
      refreshToken: null,
      expiresAt: NOW,
      scopes: ['gmail.send'],
      authMetadata: null,
      updatedAt: NOW,
    },
    invalid: {
      id: CUID,
      serverId: CUID_2,
      accessToken: 'enc:abc',
      refreshToken: null,
      expiresAt: NOW,
      scopes: 'gmail.send',
      authMetadata: null,
      updatedAt: NOW,
    },
  },
  McpAuthMetadataSchema: {
    schema: McpAuthMetadataSchema,
    valid: {
      tokenEndpoint: 'https://auth.example.test/tenant/token',
      clientId: 'client-1',
      resource: 'https://mcp.example.test/mcp',
    },
    invalid: {
      tokenEndpoint: 'not-a-url',
      clientId: 'client-1',
      resource: 'https://mcp.example.test/mcp',
    },
  },
  McpToolSchema: {
    schema: McpToolSchema,
    valid: {
      id: CUID,
      serverId: CUID_2,
      name: 'send_message',
      description: 'Sends an email.',
      inputSchema: { type: 'object' },
      readOnly: false,
      refreshedAt: NOW,
    },
    invalid: {
      id: CUID,
      serverId: CUID_2,
      name: '',
      description: 'Sends an email.',
      inputSchema: { type: 'object' },
      readOnly: false,
      refreshedAt: NOW,
    },
  },
  BotMcpServerSchema: {
    schema: BotMcpServerSchema,
    valid: { botId: CUID, serverId: CUID_2, enabled: true },
    invalid: { botId: CUID, serverId: CUID_2, enabled: 'yes' },
  },
  RoutineSchema: {
    schema: RoutineSchema,
    valid: {
      id: CUID,
      botId: CUID_2,
      name: 'Morning digest',
      cron: '0 9 * * *',
      timezone: 'America/New_York',
      endsOn: null,
      prompt: 'Summarise the inbox.',
      skillId: null,
      skillParams: null,
      enabled: true,
      lastRunAt: null,
      lastStatus: null,
      origin: 'OPERATOR',
    },
    // PRD §3: exactly one of prompt or skillId — both set must fail.
    invalid: {
      id: CUID,
      botId: CUID_2,
      name: 'Morning digest',
      cron: '0 9 * * *',
      timezone: 'America/New_York',
      endsOn: null,
      prompt: 'Summarise the inbox.',
      skillId: CUID,
      skillParams: null,
      enabled: true,
      lastRunAt: null,
      lastStatus: null,
      origin: 'OPERATOR',
    },
  },

  // ── auth (§4.4) ─────────────────────────────────────────────────────────
  PrincipalSchema: {
    schema: PrincipalSchema,
    valid: { userId: CUID, scopes: ['*'] },
    invalid: { userId: CUID, scopes: [] },
  },
  EditionSchema: {
    schema: EditionSchema,
    valid: 'selfhosted',
    invalid: 'enterprise',
  },

  // ── WebSocket (§4.2) ────────────────────────────────────────────────────
  WsFrameSchema: {
    schema: WsFrameSchema,
    valid: { ...wsEnvelope, type: 'bot.status', payload: {} },
    invalid: { ...wsEnvelope, type: 'bot.status', id: 'not-a-uuid', payload: {} },
  },
  ServerFrameSchema: {
    schema: ServerFrameSchema,
    valid: {
      ...wsEnvelope,
      type: 'bot.status',
      payload: { botId: CUID, status: 'IDLE' },
    },
    invalid: { ...wsEnvelope, type: 'message.unknown', payload: {} },
  },
  ClientFrameSchema: {
    schema: ClientFrameSchema,
    valid: { ...wsEnvelope, type: 'bot.cancel', payload: { botId: CUID } },
    invalid: { ...wsEnvelope, type: 'bot.destroy', payload: { botId: CUID } },
  },
  MessageCreatedPayloadSchema: {
    schema: shared.MessageCreatedPayloadSchema,
    valid: { ...messageFixture, attachments: [] },
    invalid: { ...messageFixture },
  },
  MessageAttachmentsPayloadSchema: {
    schema: shared.MessageAttachmentsPayloadSchema,
    // The rows a claim just bound — the same shape §4.1 carries on
    // MessageWithAttachments, which is what makes a card from either path.
    valid: { messageId: CUID, attachments: [attachmentFixture] },
    invalid: { messageId: CUID, attachments: [{ ...attachmentFixture, id: '' }] },
  },
  MessageDeletedPayloadSchema: {
    schema: shared.MessageDeletedPayloadSchema,
    // D-147: a clear names the ids it removed AND says it was a clear.
    valid: { botId: CUID, messageIds: [CUID_2] },
    invalid: { botId: CUID, messageIds: [CUID_2], cleared: false },
    validEach: [{ botId: CUID, messageIds: [], cleared: true }],
  },
  ListApprovalsResponseSchema: {
    schema: shared.ListApprovalsResponseSchema,
    valid: [
      {
        botId: CUID,
        turnId: CUID,
        toolCallId: 'tc-1',
        toolName: 'shell',
        binding: {
          toolName: 'shell',
          effect: 'unknown',
          scope: 'call',
          argsHash: 'a'.repeat(64),
          grantRevision: 'b'.repeat(64),
          resourceRevision: null,
          seat: null,
          commit: null,
        },
        args: { command: 'ls' },
      },
    ],
    // An empty toolCallId is the one that matters: it is the key
    // `approval.respond` answers with, so a blank one is an approval nobody
    // can answer.
    invalid: [{ botId: CUID, turnId: CUID, toolCallId: '', toolName: 'shell', args: {} }],
  },
  BotStatusPayloadSchema: {
    schema: shared.BotStatusPayloadSchema,
    valid: { botId: CUID, status: 'ACTING' },
    invalid: { botId: CUID, status: 'RUNNING' },
  },
  RunStartedPayloadSchema: {
    schema: shared.RunStartedPayloadSchema,
    valid: { botId: CUID, threadId: CUID, runId: 'run_1' },
    invalid: { botId: CUID, threadId: CUID, runId: '' },
  },
  RunSettledOutcomeSchema: {
    schema: shared.RunSettledOutcomeSchema,
    valid: 'stopped',
    invalid: 'interrupted',
  },
  RunSettledPayloadSchema: {
    schema: shared.RunSettledPayloadSchema,
    valid: {
      botId: CUID,
      threadId: CUID,
      runId: 'run_1',
      messageIds: ['u-1', 'u-2'],
      outcome: 'completed',
      reply: 'Done.',
    },
    // A settle that answered nothing is not one.
    invalid: {
      botId: CUID,
      threadId: CUID,
      runId: 'run_1',
      messageIds: [],
      outcome: 'completed',
      reply: null,
    },
  },
  TurnStepPayloadSchema: {
    schema: shared.TurnStepPayloadSchema,
    valid: { botId: CUID, turnId: CUID_2, stepIndex: 0, toolName: 'browser_navigate' },
    invalid: { botId: CUID, turnId: CUID_2, stepIndex: -1 },
  },
  SandboxStatePayloadSchema: {
    schema: shared.SandboxStatePayloadSchema,
    valid: { botId: CUID, state: 'RUNNING', widthPx: 1280, heightPx: 800 },
    invalid: { botId: CUID, state: 'RUNNING', widthPx: 0, heightPx: 800 },
  },
  RecordingEventPayloadSchema: {
    schema: shared.RecordingEventPayloadSchema,
    valid: { recordingId: CUID, layer: 'CDP', type: 'click', counts: { x11: 4, cdp: 2 } },
    invalid: { recordingId: CUID, layer: 'CDP', type: 'click', counts: { x11: 4 } },
  },
  RecordingStatePayloadSchema: {
    schema: shared.RecordingStatePayloadSchema,
    valid: { recordingId: CUID, state: 'READY' },
    invalid: { recordingId: CUID, state: 'DONE' },
  },
  SkillCompiledPayloadSchema: {
    schema: shared.SkillCompiledPayloadSchema,
    valid: { recordingId: CUID, skillId: CUID_2, name: 'open_site' },
    invalid: { recordingId: CUID, skillId: CUID_2, name: '' },
  },
  ApprovalRequestedPayloadSchema: {
    schema: shared.ApprovalRequestedPayloadSchema,
    valid: {
      botId: CUID,
      turnId: CUID_2,
      toolCallId: 'tc_1',
      toolName: 'shell',
      args: {},
      binding: {
        toolName: 'shell',
        effect: 'unknown',
        scope: 'call',
        argsHash: 'a'.repeat(64),
        grantRevision: 'b'.repeat(64),
        resourceRevision: null,
        seat: null,
        commit: null,
      },
    },
    invalid: { botId: CUID, turnId: CUID_2, toolCallId: '', toolName: 'shell', args: {} },
  },
  ApprovalResolvedPayloadSchema: {
    schema: shared.ApprovalResolvedPayloadSchema,
    valid: { botId: CUID, turnId: CUID_2, toolCallId: 'proposal', approved: true },
    invalid: { botId: CUID, turnId: CUID_2, toolCallId: '', approved: true },
  },
  McpStatusPayloadSchema: {
    schema: shared.McpStatusPayloadSchema,
    valid: { serverId: CUID, status: 'CONNECTED', toolCount: 12 },
    invalid: { serverId: CUID, status: 'CONNECTED', toolCount: -1 },
  },
  UsageNoticePayloadSchema: {
    schema: shared.UsageNoticePayloadSchema,
    valid: { kind: 'compute', level: 80, resetsAt: '2026-11-01T00:00:00.000Z' },
    validEach: [{ kind: 'model', level: 100, resetsAt: '2026-11-01T00:00:00.000Z' }],
    invalid: { kind: 'compute', level: 90, resetsAt: '2026-11-01T00:00:00.000Z' },
  },
  ErrorPayloadSchema: {
    schema: shared.ErrorPayloadSchema,
    valid: { code: 'E_AUTH', message: 'nope' },
    invalid: { code: '', message: 'nope' },
  },
  ScreenSubscribePayloadSchema: {
    schema: shared.ScreenSubscribePayloadSchema,
    valid: { botId: CUID },
    invalid: { botId: '' },
  },
  ScreenQualitySchema: {
    schema: shared.ScreenQualitySchema,
    valid: 0,
    validEach: [6, 9],
    invalid: 10,
    invalidEach: [-1, 2.5],
  },
  ScreenSeatBindingSchema: {
    schema: shared.ScreenSeatBindingSchema,
    valid: { seatId: 'seat-1', botId: CUID, rfbPort: 5901 },
    invalid: { seatId: 'seat-1', botId: CUID, rfbPort: 7070 },
    invalidEach: [
      { seatId: '', botId: CUID, rfbPort: 5901 },
      { seatId: 'seat-1', botId: '', rfbPort: 5901 },
    ],
  },
  ScreenStreamEndpointSchema: {
    schema: shared.ScreenStreamEndpointSchema,
    valid: { kind: 'orchestrator' },
    validEach: [{ kind: 'direct', url: 'wss://7071-abc.runtimehost.com/v1/stream?t=x' }],
    invalid: { kind: 'direct', url: 'https://7071-abc.runtimehost.com/v1/stream' },
    invalidEach: [{ kind: 'orchestrator', url: 'wss://example.com' }],
  },
  ScreenGrantResponseSchema: {
    schema: shared.ScreenGrantResponseSchema,
    valid: {
      endpoint: { kind: 'orchestrator' },
      ticket: 'eyJ2IjoxfQ.c2ln',
      expiresAt: '2026-10-14T12:00:00.000Z',
    },
    invalid: { endpoint: { kind: 'orchestrator' }, ticket: '', expiresAt: 'soon' },
  },
  ScreenTicketClaimsSchema: {
    schema: shared.ScreenTicketClaimsSchema,
    valid: {
      v: 1,
      aud: 'crewaid-screen',
      session: 'crewaid-cmv6rarhx000201pg54qta71v',
      botId: CUID,
      port: 5901,
      exp: 1_791_900_523_930,
      jti: '3f1a5c2e9b47',
    },
    invalid: {
      v: 1,
      aud: 'crewaid-chat',
      session: 's',
      botId: CUID,
      port: 5901,
      exp: 1,
      jti: '3f1a5c2e9b47',
    },
    invalidEach: [
      {
        v: 1,
        aud: 'crewaid-screen',
        session: 's',
        botId: CUID,
        port: 5901,
        exp: 1,
        jti: '3f1a5c2e9b47',
        admin: true,
      },
    ],
  },
  ScreenStreamClientMessageSchema: {
    schema: shared.ScreenStreamClientMessageSchema,
    valid: { t: 'ack', seq: 1 },
    validEach: [{ t: 'quality', quality: 3 }],
    invalid: { t: 'ack', seq: 0 },
    invalidEach: [
      { t: 'rfb', bytes: 'AAA=' },
      { t: 'quality', quality: 12 },
    ],
  },
  ScreenStreamErrorCodeSchema: {
    schema: shared.ScreenStreamErrorCodeSchema,
    valid: 'SCREEN_STREAM_LOST',
    validEach: ['SCREEN_NOT_RUNNING'],
    invalid: 'SCREEN_GONE',
  },
  ScreenStreamServerMessageSchema: {
    schema: shared.ScreenStreamServerMessageSchema,
    valid: { t: 'mark', seq: 4 },
    validEach: [{ t: 'error', code: 'SCREEN_NOT_RUNNING', message: 'The computer is stopped.' }],
    invalid: { t: 'mark' },
    invalidEach: [{ t: 'error', code: 'SCREEN_NOT_RUNNING', message: '' }],
  },
  ScreenUnsubscribePayloadSchema: {
    schema: shared.ScreenUnsubscribePayloadSchema,
    valid: { botId: CUID },
    invalid: {},
  },
  ApprovalRespondPayloadSchema: {
    schema: ApprovalRespondPayloadSchema,
    valid: { toolCallId: 'tc_1', approved: true },
    invalid: { toolCallId: 'tc_1', approved: 'yes' },
  },
  BotCancelPayloadSchema: {
    schema: shared.BotCancelPayloadSchema,
    valid: { botId: CUID },
    invalid: { botId: '' },
  },

  AvatarShapeSchema: {
    schema: shared.AvatarShapeSchema,
    valid: 'circle',
    // Names, not indices — so an index is exactly what must not parse.
    invalid: 0,
    validEach: ['square', 'polygon', 'egg', 'bulb', 'cloud', 'shield', 'splat'],
  },

  // ── REST (§4.1) ─────────────────────────────────────────────────────────
  ThreadPreviewSchema: {
    schema: shared.ThreadPreviewSchema,
    valid: previewFixture,
    // D-192: a thread whose last word was only whitespace still has one.
    validEach: [{ text: '', createdAt: NOW }],
    invalid: { text: 'hi' },
    invalidEach: [{ text: null, createdAt: NOW }],
  },
  BotThreadSchema: {
    schema: shared.BotThreadSchema,
    valid: threadFixture,
    // D-192: the preview defaults when an older orchestrator omits it.
    validEach: [{ ...threadFixture, preview: previewFixture }],
    invalid: { id: 42 },
    invalidEach: [{}, { ...threadFixture, preview: { text: 'hi' } }],
  },
  BotWithSandboxSchema: {
    schema: shared.BotWithSandboxSchema,
    valid: { ...botFixture, sandbox: sandboxFixture, thread: threadFixture },
    // D-131: a grouped bot with unread messages; both fields default when an
    // older orchestrator leaves them out, which `valid` above exercises.
    validEach: [{ ...botFixture, sandbox: null, thread: null, groupId: CUID_3, unreadCount: 2 }],
    invalidEach: [
      { ...botFixture, sandbox: null, thread: threadFixture, unreadCount: -1 },
      // D-191: the thread is stated, never left for a client to guess.
      { ...botFixture, sandbox: null },
    ],
    invalid: { ...botFixture },
  },
  ListBotsResponseSchema: {
    schema: shared.ListBotsResponseSchema,
    valid: [{ ...botFixture, sandbox: sandboxFixture, thread: threadFixture }],
    // An empty list is the first-run state, not an error.
    validEach: [[], [{ ...botFixture, sandbox: null, thread: threadFixture }]],
    // The element is a BotWithSandbox: a plain Bot has no `sandbox` key.
    invalid: [{ ...botFixture }],
    invalidEach: [{ bots: [] }],
  },
  AttachmentUploadResponseSchema: {
    schema: shared.AttachmentUploadResponseSchema,
    // An unclaimed upload carries no messageId — that is the whole point of
    // the omit, and the claimed shape must still be accepted since `.omit()`
    // strips rather than forbids.
    valid: {
      id: CUID,
      filename: 'leads.csv',
      mimeType: 'text/csv',
      sizeBytes: 2048,
      storageKey: 'artifacts/leads.csv',
    },
    validEach: [attachmentFixture],
    invalid: { id: CUID, filename: 'leads.csv', mimeType: 'text/csv', sizeBytes: 2048 },
  },
  AttachmentKindSchema: {
    schema: shared.AttachmentKindSchema,
    valid: 'VOICE_NOTE',
    validEach: ['FILE'],
    invalid: 'AUDIO',
  },
  VoiceTranscriptionResponseSchema: {
    schema: shared.VoiceTranscriptionResponseSchema,
    valid: { text: 'Remind me to send the invoice', languageCode: 'en' },
    validEach: [{ text: '', languageCode: null }],
    // The language is always answered, even when the engine had no guess.
    invalid: { text: 'Remind me to send the invoice' },
  },
  VoiceNoteResponseSchema: {
    schema: shared.VoiceNoteResponseSchema,
    valid: {
      attachment: {
        id: CUID,
        filename: 'voice-message.webm',
        mimeType: 'audio/webm',
        sizeBytes: 48_000,
        storageKey: '2026-10-14/voice-message.webm',
        kind: 'VOICE_NOTE',
        durationMs: 6200,
      },
      transcript: 'Can you check the leads sheet?',
    },
    invalid: {
      attachment: {
        id: CUID,
        filename: 'voice-message.webm',
        mimeType: 'audio/webm',
        sizeBytes: 48_000,
        storageKey: '2026-10-14/voice-message.webm',
        kind: 'RECORDING',
      },
      transcript: 'Can you check the leads sheet?',
    },
  },
  VoiceOptionSchema: {
    schema: shared.VoiceOptionSchema,
    valid: { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George' },
    validEach: [
      { id: 'CwhRBWXzGAHq8TQ4Fs17', name: 'Roger', previewUrl: 'https://example.com/roger.mp3' },
    ],
    invalid: { id: '', name: 'George' },
    invalidEach: [
      { id: 'roger', name: 'Roger', previewUrl: 'javascript:alert(1)' },
      { id: 'roger', name: 'Roger', previewUrl: 'http://example.com/roger.mp3' },
    ],
  },
  VoiceListResponseSchema: {
    schema: shared.VoiceListResponseSchema,
    valid: {
      voices: [{ id: 'CwhRBWXzGAHq8TQ4Fs17', name: 'Roger' }],
      defaultVoiceId: 'CwhRBWXzGAHq8TQ4Fs17',
    },
    validEach: [{ voices: [], defaultVoiceId: 'CwhRBWXzGAHq8TQ4Fs17' }],
    invalid: { voices: [{ id: 'JBFqnCBsd6RMkjVDRZzb' }] },
  },
  VoiceStatusResponseSchema: {
    schema: shared.VoiceStatusResponseSchema,
    valid: { configured: true },
    invalid: { configured: 'yes' },
  },
  CallOverridesSchema: {
    schema: shared.CallOverridesSchema,
    valid: {
      prompt: 'You are the voice of Quill.',
      firstMessage: "Hi, it's Quill.",
      voiceId: 'JBFqnCBsd6RMkjVDRZzb',
      maxDurationSeconds: 1800,
    },
    validEach: [
      {
        prompt: 'You are the voice of Quill.',
        firstMessage: "Bonjour, c'est Quill.",
        voiceId: 'JBFqnCBsd6RMkjVDRZzb',
        maxDurationSeconds: 1800,
        language: 'pt-br',
      },
    ],
    invalid: { prompt: 'p', firstMessage: 'f', voiceId: 'v', maxDurationSeconds: 0 },
    invalidEach: [
      {
        prompt: 'p',
        firstMessage: 'f',
        voiceId: 'v',
        maxDurationSeconds: 60,
        language: 'Portuguese',
      },
    ],
  },
  StartCallResponseSchema: {
    schema: shared.StartCallResponseSchema,
    valid: {
      callId: 'clxcall0000000000000001a',
      signedUrl:
        'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=a&conversation_signature=s',
      remainingSeconds: 1500,
      overrides: {
        prompt: 'You are the voice of Quill.',
        firstMessage: "Hi, it's Quill.",
        voiceId: 'JBFqnCBsd6RMkjVDRZzb',
        maxDurationSeconds: 1800,
      },
    },
    // A signed URL is a socket address; an https page is not one.
    invalid: {
      callId: 'clxcall0000000000000001a',
      signedUrl: 'https://example.com/call',
      remainingSeconds: 1500,
      overrides: {
        prompt: 'You are the voice of Quill.',
        firstMessage: "Hi, it's Quill.",
        voiceId: 'JBFqnCBsd6RMkjVDRZzb',
        maxDurationSeconds: 1800,
      },
    },
  },
  UpdateCallBodySchema: {
    schema: shared.UpdateCallBodySchema,
    valid: { conversationId: 'conv_9201m4x6eapwfg29sztrjmvtc7ct' },
    invalid: {},
  },
  VoiceCallSchema: {
    schema: shared.VoiceCallSchema,
    valid: {
      id: 'clxcall0000000000000001a',
      botId: 'clxbot00000000000000001a',
      conversationId: null,
      startedAt: '2026-10-14T12:00:00.000Z',
      endedAt: null,
      durationSeconds: null,
    },
    invalid: {
      id: 'clxcall0000000000000001a',
      botId: 'clxbot00000000000000001a',
      conversationId: null,
      startedAt: '2026-10-14T12:00:00.000Z',
      endedAt: null,
      durationSeconds: -1,
    },
  },
  VoiceCallResponseSchema: {
    schema: shared.VoiceCallResponseSchema,
    valid: {
      call: {
        id: 'clxcall0000000000000001a',
        botId: 'clxbot00000000000000001a',
        conversationId: 'conv_1',
        startedAt: '2026-10-14T12:00:00.000Z',
        endedAt: '2026-10-14T12:00:21.000Z',
        durationSeconds: 21,
      },
    },
    invalid: { call: null },
  },
  CallAllowanceResponseSchema: {
    schema: shared.CallAllowanceResponseSchema,
    valid: { limitSeconds: 1800, usedSeconds: 21 },
    invalid: { limitSeconds: 1800 },
  },
  ToolInfoSchema: {
    schema: shared.ToolInfoSchema,
    valid: {
      name: 'capture_screen',
      alias: 'screen',
      label: 'See the screen',
      summary: 'A picture of the whole screen, not just the page.',
      description: 'A picture of the whole screen.',
      reach: 'contained',
      origin: 'builtin',
    },
    // A reach outside the two classifications is the one that matters: the
    // composer badges it, and an unknown value would badge nothing.
    invalid: {
      name: 'capture_screen',
      alias: 'screen',
      label: 'See the screen',
      summary: 'A picture of the whole screen, not just the page.',
      description: 'A picture of the whole screen.',
      reach: 'sometimes',
      origin: 'builtin',
    },
  },
  ListToolsResponseSchema: {
    schema: shared.ListToolsResponseSchema,
    valid: [
      {
        name: 'shell',
        alias: 'run-command',
        label: 'Run a command',
        summary: 'Runs a shell command on the bot’s computer — always asks first.',
        description: 'Runs a command.',
        reach: 'sensitive',
        origin: 'builtin',
      },
    ],
    // An empty alias is the one that matters: it is what the palette would
    // insert, and `//` in a message names nothing.
    invalid: [
      {
        name: 'shell',
        alias: '',
        label: 'Run a command',
        summary: 'Runs a shell command.',
        description: 'Runs a command.',
        reach: 'sensitive',
        origin: 'builtin',
      },
    ],
  },
  BotsChangedPayloadSchema: {
    schema: shared.BotsChangedPayloadSchema,
    valid: { botId: CUID, change: 'created' },
    invalid: { botId: CUID, change: 'renamed' },
  },
  CreateBotBodySchema: {
    schema: CreateBotBodySchema,
    valid: {
      name: 'Quill',
      role: 'Outbound Writer',
      avatarColor: '#8B6F47',
      systemPrompt: 'Write.',
    },
    invalid: {
      name: 'Quill',
      role: 'Outbound Writer',
      avatarColor: 'brown',
      systemPrompt: 'Write.',
    },
  },
  UpdateBotBodySchema: {
    schema: UpdateBotBodySchema,
    valid: { pinned: true },
    // D-131: null moves a bot out of every group, so it is a value, not an absence.
    validEach: [{ groupId: CUID }, { groupId: null }],
    invalidEach: [{ groupId: '' }],
    invalid: {},
  },
  MarkBotReadBodySchema: {
    schema: shared.MarkBotReadBodySchema,
    valid: {},
    validEach: [{ unread: true }, { unread: false }],
    invalid: { unread: 'yes' },
  },
  MarkBotReadResponseSchema: {
    schema: shared.MarkBotReadResponseSchema,
    valid: { unreadCount: 0 },
    invalid: { unreadCount: -1 },
  },
  BotGroupSchema: {
    schema: shared.BotGroupSchema,
    valid: botGroupFixture,
    invalid: { ...botGroupFixture, name: '' },
  },
  ListBotGroupsResponseSchema: {
    schema: shared.ListBotGroupsResponseSchema,
    valid: [botGroupFixture],
    validEach: [[]],
    invalid: [{ ...botGroupFixture, collapsed: 'no' }],
  },
  CreateBotGroupBodySchema: {
    schema: shared.CreateBotGroupBodySchema,
    valid: { name: 'Sales team' },
    validEach: [{ name: 'Sales team', instructions: 'We sell to logistics firms.' }],
    // A name of only spaces is a header with nothing on it.
    invalid: { name: '   ' },
    invalidEach: [{ name: 'x'.repeat(65) }, { name: 'Ok', instructions: 'x'.repeat(8001) }],
  },
  UpdateBotGroupBodySchema: {
    schema: shared.UpdateBotGroupBodySchema,
    valid: { collapsed: true },
    validEach: [{ name: 'Renamed' }, { instructions: '' }, { sortOrder: 2 }],
    invalid: {},
  },
  ChatJoinQuerySchema: {
    schema: ChatJoinQuerySchema,
    valid: { runId: 'run_1', offset: '42' },
    invalid: { runId: 'run_1', offset: '-2' },
  },
  ChatHydrateQuerySchema: {
    schema: ChatHydrateQuerySchema,
    valid: { threadId: 'thread_1', limit: '50' },
    invalid: { threadId: 'thread_1', limit: '501' },
  },
  ChatHydrationSchema: {
    schema: ChatHydrationSchema,
    valid: {
      messages: [],
      activeRun: { runId: 'running', startedAt: 1791760000000 },
      interrupts: null,
      page: { truncated: false },
    },
    invalid: { messages: [], activeRun: null, interrupts: null, page: { truncated: true } },
  },
  ChatForwardedPropsSchema: {
    schema: ChatForwardedPropsSchema,
    valid: { attachmentIds: ['clz1234567890abcdefghijkl'] },
    invalid: { attachmentIds: ['clz1234567890abcdefghijkl'], tools: [] },
  },
  ChatQuerySchema: {
    schema: ChatQuerySchema,
    valid: { runId: 'run_1' },
    invalid: { runId: 'run_1', threadId: 'thread_1' },
  },
  TranscriptAttachmentSchema: {
    schema: shared.TranscriptAttachmentSchema,
    valid: {
      id: 'clz1234567890abcdefghijkl',
      filename: 'quarter.csv',
      mimeType: 'text/csv',
      sizeBytes: 2048,
    },
    invalid: { id: 'clz1234567890abcdefghijkl', filename: '', mimeType: 'text/csv', sizeBytes: 0 },
  },
  CrewaidMessageMetadataSchema: {
    schema: shared.CrewaidMessageMetadataSchema,
    valid: {
      author: 'BOT',
      fromBotId: 'clz1234567890abcdefghijkl',
      runId: 'run_1',
      sequence: 7,
      stopReason: null,
      taskId: null,
      routineId: null,
      chainId: null,
      hopCount: 0,
      startsTopic: false,
      attachments: [],
    },
    validEach: [
      {
        author: 'SYSTEM',
        fromBotId: null,
        runId: null,
        sequence: 1,
        stopReason: 'length',
        taskId: 'clz1234567890abcdefghijkl',
        routineId: 'clz1234567890abcdefghijkl',
        chainId: 'chain_1',
        hopCount: 2,
        startsTopic: true,
        attachments: [
          {
            id: 'clz1234567890abcdefghijkl',
            filename: 'notes.md',
            mimeType: 'text/markdown',
            sizeBytes: 12,
          },
        ],
      },
    ],
    invalid: { author: 'OPERATOR', fromBotId: null, sequence: 1 },
    invalidEach: [
      {
        author: 'USER',
        fromBotId: null,
        runId: null,
        sequence: 1,
        stopReason: null,
        taskId: null,
        routineId: null,
        chainId: null,
        hopCount: -1,
        startsTopic: false,
        attachments: [],
      },
    ],
  },
  SendMessageBodySchema: {
    schema: SendMessageBodySchema,
    // D-023: text alone, attachments alone, or both — never empty-nothing.
    valid: { content: 'hello' },
    invalid: { content: '' },
    validEach: [
      { content: 'see attached', attachmentIds: [CUID] },
      { attachmentIds: [CUID] },
      { content: '', attachmentIds: [CUID] },
    ],
    invalidEach: [{}, { content: '   ' }],
  },
  DeleteMessagesQuerySchema: {
    schema: shared.DeleteMessagesQuerySchema,
    // D-147: absent keeps memory; only the literal strings are accepted.
    valid: { forget: 'true' },
    invalid: { forget: 'yes' },
    validEach: [{}, { forget: 'false' }],
  },
  DeleteMessagesResponseSchema: {
    schema: shared.DeleteMessagesResponseSchema,
    valid: { deletedCount: 3, forgottenCount: 1 },
    invalid: { deletedCount: -1, forgottenCount: 0 },
  },
  ListTurnsQuerySchema: {
    schema: shared.ListTurnsQuerySchema,
    valid: { limit: 20 },
    invalid: { limit: 0 },
  },
  TurnSummarySchema: {
    schema: shared.TurnSummarySchema,
    valid: {
      id: CUID,
      botId: CUID_2,
      triggerMessageId: CUID,
      status: 'completed',
      stepIndex: 2,
      steps: [],
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      cacheCreationTokens: 1,
      startedAt: NOW,
      endedAt: NOW,
      stopReason: 'stop',
      stepCount: 2,
    },
    invalid: {
      id: CUID,
      botId: CUID_2,
      triggerMessageId: CUID,
      status: 'completed',
      stepIndex: 2,
      steps: [],
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      cacheCreationTokens: 1,
      startedAt: NOW,
      endedAt: NOW,
      stopReason: 'stop',
    },
  },
  SandboxStatusResponseSchema: {
    schema: shared.SandboxStatusResponseSchema,
    valid: { botId: CUID, state: 'RUNNING', widthPx: 1280, heightPx: 800, lastError: null },
    invalid: { botId: CUID, state: 'BOOTING', widthPx: 1280, heightPx: 800, lastError: null },
  },
  ComputerSnapshotSchema: {
    schema: shared.ComputerSnapshotSchema,
    valid: { takenAt: '2026-11-19T10:00:00.000Z', sizeBytes: 4_096, expiresAt: null },
    invalid: { takenAt: 'yesterday', sizeBytes: 4_096, expiresAt: null },
  },
  ComputerSnapshotActivitySchema: {
    schema: shared.ComputerSnapshotActivitySchema,
    valid: 'SAVING',
    invalid: 'DELETING',
  },
  ComputerSnapshotFailureSchema: {
    schema: shared.ComputerSnapshotFailureSchema,
    valid: 'SAVE_FAILED',
    invalid: 'runtime: capture failed',
  },
  ComputerSnapshotStatusResponseSchema: {
    schema: shared.ComputerSnapshotStatusResponseSchema,
    valid: {
      supported: true,
      snapshot: { takenAt: '2026-11-19T10:00:00.000Z', sizeBytes: null, expiresAt: null },
      activity: 'RESTORING',
      lastError: null,
    },
    invalid: { supported: true, snapshot: null, activity: 'PAUSED', lastError: null },
  },
  StartRecordingBodySchema: {
    schema: shared.StartRecordingBodySchema,
    valid: { intent: 'search the web' },
    invalid: { intent: 42 },
  },
  StartRecordingResponseSchema: {
    schema: shared.StartRecordingResponseSchema,
    valid: { recordingId: CUID },
    invalid: { recordingId: '' },
  },
  RecordingStatusResponseSchema: {
    schema: shared.RecordingStatusResponseSchema,
    valid: {
      id: CUID,
      state: 'FAILED',
      intent: null,
      cdpAvailable: false,
      warning: 'EVENT_LIMIT',
      error: 'the model returned a skill name that is not snake_case',
      counts: { x11: 10, cdp: 0, atspi: 0 },
      skillId: null,
    },
    invalid: {
      id: CUID,
      state: 'READY',
      intent: null,
      cdpAvailable: false,
      warning: 'EVENT_LIMIT',
      error: null,
      counts: { x11: 10, cdp: 0 },
      skillId: null,
    },
  },
  ListSkillsQuerySchema: {
    schema: shared.ListSkillsQuerySchema,
    valid: { botId: CUID },
    invalid: { botId: '' },
  },
  UpdateSkillBodySchema: {
    schema: UpdateSkillBodySchema,
    valid: { description: 'better' },
    invalid: {},
  },
  RunSkillBodySchema: {
    schema: shared.RunSkillBodySchema,
    valid: { params: { q: 'hi' } },
    invalid: { params: undefined },
  },
  RunSkillResponseSchema: {
    schema: shared.RunSkillResponseSchema,
    valid: { runId: CUID },
    invalid: {},
  },
  SkillWithSourceSchema: {
    schema: shared.SkillWithSourceSchema,
    valid: skillFixture,
    invalid: { ...skillFixture, version: 0 },
  },
  SkillSummarySchema: {
    schema: shared.SkillSummarySchema,
    // M3-BE-09: the list omits the source — everything a reviewer branches on
    // is here, and `script` belongs to the detail route.
    valid: {
      id: CUID,
      botId: CUID_2,
      name: 'open_example_site',
      description: 'Opens example.com and screenshots it.',
      paramsSchema: { type: 'object', properties: {} },
      steps: ['Open Chrome.', 'Go to example.com.'],
      version: 2,
      status: 'DRAFT',
      sourceRecordingId: null,
      createdAt: NOW,
    },
    invalid: {
      id: CUID,
      botId: CUID_2,
      name: 'open_example_site',
      description: 'Opens example.com and screenshots it.',
      paramsSchema: { type: 'object', properties: {} },
      steps: ['Open Chrome.', 'Go to example.com.'],
      version: 2,
      status: 'PUBLISHED',
      sourceRecordingId: null,
      createdAt: NOW,
    },
  },
  ListSkillsResponseSchema: {
    schema: shared.ListSkillsResponseSchema,
    valid: [
      {
        id: CUID,
        botId: CUID_2,
        name: 'open_example_site',
        description: 'Opens example.com and screenshots it.',
        paramsSchema: { type: 'object', properties: {} },
        steps: [],
        version: 2,
        status: 'APPROVED',
        sourceRecordingId: null,
        createdAt: NOW,
      },
    ],
    invalid: 'not-an-array',
  },
  ReviseSkillBodySchema: {
    schema: shared.ReviseSkillBodySchema,
    valid: { instruction: 'Use Firefox instead of Chrome.' },
    invalid: { instruction: '   ' },
  },
  McpDirectoryEntrySchema: {
    schema: shared.McpDirectoryEntrySchema,
    valid: { name: 'Gmail', slug: 'gmail', category: null, iconUrl: null, authType: 'OAUTH2' },
    // D-204: a Composio entry names its backend; a curated entry omits it.
    validEach: [
      {
        name: 'Gmail',
        slug: 'gmail',
        category: null,
        iconUrl: null,
        authType: 'OAUTH2',
        backend: 'COMPOSIO',
      },
    ],
    invalid: { name: 'Gmail', slug: 'Gmail', category: null, iconUrl: null, authType: 'OAUTH2' },
  },
  ListMcpDirectoryResponseSchema: {
    schema: shared.ListMcpDirectoryResponseSchema,
    valid: [{ name: 'Gmail', slug: 'gmail', category: 'Inbox', iconUrl: null, authType: 'OAUTH2' }],
    // An empty catalog is a valid answer, not a malformed one.
    validEach: [[]],
    // A slug the namespace rule would never accept (`SlugSchema`, §6/M6).
    invalid: [{ name: 'Gmail', slug: 'Gmail', category: null, iconUrl: null, authType: 'OAUTH2' }],
  },
  PluginAccessSchema: {
    schema: shared.PluginAccessSchema,
    valid: { mode: 'SELECTED', selectedBotIds: [CUID] },
    validEach: [{ mode: 'ALL', excludedBotIds: [CUID_2] }],
    invalid: { mode: 'ALL', selectedBotIds: [] },
  },
  McpServerSummarySchema: {
    schema: shared.McpServerSummarySchema,
    valid: mcpServerSummaryFixture,
    validEach: [{ ...mcpServerSummaryFixture, backend: 'COMPOSIO', url: null, transport: null }],
    invalid: { ...mcpServerSummaryFixture, transport: 'STDIO' },
  },
  ListMcpServersResponseSchema: {
    schema: shared.ListMcpServersResponseSchema,
    valid: [mcpServerSummaryFixture],
    validEach: [[]],
    invalid: [{ ...mcpServerSummaryFixture, status: 'PENDING' }],
  },
  InstallMcpServerBodySchema: {
    schema: InstallMcpServerBodySchema,
    // The private arm WITH its bearer, because that arm is the one D-114
    // changed and `{slug}` alone would never exercise it.
    valid: {
      name: 'Custom',
      url: 'https://mcp.example.com/mcp',
      transport: 'HTTP',
      bearerToken: 'sk-live-abc',
    },
    invalid: { name: 'Custom', url: 'not-a-url', transport: 'HTTP' },
  },
  SetMcpCredentialBodySchema: {
    schema: shared.SetMcpCredentialBodySchema,
    valid: { bearerToken: 'sk-live-abc' },
    // Empty rather than absent: a route whose whole purpose is to carry one
    // secret must not accept a blank one and report success.
    invalid: { bearerToken: '' },
  },
  ConnectMcpServerResponseSchema: {
    schema: shared.ConnectMcpServerResponseSchema,
    valid: { authorizeUrl: 'https://auth.example.com/authorize?x=1' },
    // Both arms: a server that needs no credential is connected on the spot
    // and answers `{connected:true}`, which the client narrows on rather than
    // guessing from a status code (M6-BE-03).
    validEach: [{ connected: true }],
    invalid: { authorizeUrl: 'nope' },
  },
  BotPluginSchema: {
    schema: shared.BotPluginSchema,
    valid: { serverId: CUID, slug: 'gmail', name: 'Gmail', enabled: true, toolCount: 5 },
    invalid: { serverId: CUID, slug: 'gmail', name: 'Gmail', enabled: true, toolCount: -1 },
  },
  ListBotPluginsResponseSchema: {
    schema: shared.ListBotPluginsResponseSchema,
    valid: [{ serverId: CUID, slug: 'gmail', name: 'Gmail', enabled: true, toolCount: 5 }],
    // A bot with nothing enabled still gets every installed server back, so
    // the empty array is the case where the user has installed none at all.
    validEach: [[]],
    // A negative tool count, like `BotPluginSchema`'s own invalid fixture:
    // `CuidSchema` is deliberately permissive about id shape, so a malformed
    // id would not have made this reject and the case would assert nothing.
    invalid: [{ serverId: CUID, slug: 'gmail', name: 'Gmail', enabled: true, toolCount: -1 }],
  },
  SetBotPluginsBodySchema: {
    schema: SetBotPluginsBodySchema,
    valid: { serverIds: [CUID, CUID_2] },
    invalid: { serverIds: 'all' },
  },
  CreateRoutineBodySchema: {
    schema: shared.CreateRoutineBodySchema,
    valid: { botId: CUID, name: 'Digest', cron: '0 9 * * *', prompt: 'Summarise.' },
    // exactly one of prompt or skillId
    invalid: { botId: CUID, name: 'Digest', cron: '0 9 * * *' },
  },
  UpdateRoutineBodySchema: {
    schema: shared.UpdateRoutineBodySchema,
    valid: { enabled: false },
    invalid: {},
  },
  ListRoutinesResponseSchema: {
    schema: shared.ListRoutinesResponseSchema,
    valid: [
      {
        id: CUID,
        botId: CUID_2,
        name: 'Digest',
        cron: '0 9 * * *',
        timezone: 'America/New_York',
        endsOn: null,
        prompt: 'Summarise.',
        skillId: null,
        skillParams: null,
        enabled: true,
        lastRunAt: null,
        lastStatus: null,
        origin: 'OPERATOR',
      },
    ],
    // An empty list is a bot with no routines yet, not an error.
    validEach: [[]],
    // Wrapped in an object is not the §4.1 shape.
    invalid: { routines: [] },
  },
  RoutineResponseSchema: {
    schema: shared.RoutineResponseSchema,
    valid: {
      id: CUID,
      botId: CUID_2,
      name: 'Digest',
      cron: '0 9 * * *',
      timezone: 'America/New_York',
      endsOn: null,
      prompt: null,
      skillId: CUID,
      skillParams: null,
      enabled: true,
      lastRunAt: null,
      lastStatus: null,
      origin: 'OPERATOR',
    },
    invalid: {
      id: CUID,
      botId: CUID_2,
      name: 'Digest',
      cron: '0 9 * * *',
      timezone: 'America/New_York',
      endsOn: null,
      prompt: null,
      skillId: null,
      skillParams: null,
      enabled: true,
      lastRunAt: null,
      lastStatus: null,
      origin: 'OPERATOR',
    },
  },
  // ── Memory (CC-36, D-080) ────────────────────────────────────────────────
  MemoryQuerySchema: {
    schema: shared.MemoryQuerySchema,
    valid: { botId: CUID, includeInactive: 'true' },
    validEach: [
      // Both optional: no bot means everything this user's bots can see, and
      // the default hides superseded and forgotten rows.
      {},
      { botId: CUID },
      { includeInactive: 'false' },
    ],
    // A boolean-looking string and nothing else. `includeInactive: true` (a
    // real boolean) cannot arrive through a query string, and accepting it
    // here would make the schema disagree with the only transport it has.
    invalid: { includeInactive: 'yes' },
  },
  MemoryKindSchema: {
    schema: shared.MemoryKindSchema,
    valid: 'CONVENTION',
    validEach: ['PREFERENCE', 'CONVENTION', 'FACT', 'DECISION', 'TASK_STATE', 'RESOURCE'],
    invalid: 'OBSERVED', // a SOURCE, never a kind
  },
  MemorySourceSchema: {
    schema: shared.MemorySourceSchema,
    valid: 'TOLD',
    validEach: ['TOLD', 'DISTILLED', 'OBSERVED', 'IMPORTED'],
    invalid: 'GUESSED',
  },
  MemoryStatusSchema: {
    schema: shared.MemoryStatusSchema,
    valid: 'ACTIVE',
    validEach: ['CANDIDATE', 'ACTIVE', 'SUPERSEDED', 'FORGOTTEN'],
    invalid: 'DELETED', // nothing is deleted; it is FORGOTTEN and tombstoned
  },
  MemoryRowSchema: {
    schema: shared.MemoryRowSchema,
    valid: {
      id: CUID,
      botId: CUID,
      kind: 'CONVENTION',
      source: 'TOLD',
      status: 'ACTIVE',
      text: 'Deploys run from the repo root.',
      detail: null,
      sourceRef: null,
      messageId: CUID,
      supersededById: null,
      confirmations: 1,
      useCount: 0,
      lastUsedAt: null,
      createdAt: '2026-09-16T12:00:00.000Z',
      updatedAt: '2026-09-16T12:00:00.000Z',
    },
    validEach: [
      // The user-global row: botId null is the scope, not missing data.
      {
        id: CUID,
        botId: null,
        kind: 'PREFERENCE',
        source: 'TOLD',
        status: 'ACTIVE',
        text: 'Short replies.',
        detail: null,
        sourceRef: null,
        messageId: null,
        supersededById: null,
        confirmations: 3,
        useCount: 2,
        lastUsedAt: '2026-09-16T11:00:00.000Z',
        createdAt: '2026-09-01T12:00:00.000Z',
        updatedAt: '2026-09-16T11:00:00.000Z',
      },
      // A claim read off a page, with its origin, and an unconfirmed guess:
      // the two rows an operator most needs to tell apart from a fact.
      {
        id: CUID,
        botId: null,
        kind: 'CONVENTION',
        source: 'OBSERVED',
        status: 'ACTIVE',
        text: 'The handbook says two approvers.',
        detail: null,
        sourceRef: 'https://example.invalid/handbook',
        messageId: null,
        supersededById: null,
        confirmations: 1,
        useCount: 0,
        lastUsedAt: null,
        createdAt: '2026-09-16T12:00:00.000Z',
        updatedAt: '2026-09-16T12:00:00.000Z',
      },
      {
        id: CUID,
        botId: CUID,
        kind: 'FACT',
        source: 'DISTILLED',
        status: 'SUPERSEDED',
        text: 'Staging was staging.example.com.',
        detail: 'Replaced after the move.',
        sourceRef: null,
        messageId: null,
        supersededById: CUID,
        confirmations: 2,
        useCount: 5,
        lastUsedAt: '2026-09-10T09:00:00.000Z',
        createdAt: '2026-08-01T12:00:00.000Z',
        updatedAt: '2026-09-10T09:00:00.000Z',
      },
    ],
    invalid: {
      id: CUID,
      botId: CUID,
      kind: 'CONVENTION',
      source: 'TOLD',
      status: 'ACTIVE',
      text: 'Deploys run from the repo root.',
      detail: null,
      sourceRef: null,
      messageId: CUID,
      supersededById: null,
      // Zero confirmations would mean a fact nobody ever established: every
      // row is written with 1 and only ever climbs.
      confirmations: 0,
      useCount: 0,
      lastUsedAt: null,
      createdAt: '2026-09-16T12:00:00.000Z',
      updatedAt: '2026-09-16T12:00:00.000Z',
    },
  },
  MemoryResponseSchema: {
    schema: shared.MemoryResponseSchema,
    valid: { rows: [] },
    invalid: { rows: [{ id: CUID }] },
  },
  UsageQuerySchema: {
    schema: shared.UsageQuerySchema,
    valid: { from: '2026-09-01', to: '2026-09-30' },
    invalid: { from: '01-09-2026', to: '2026-09-30' },
  },
  UsageRowSchema: {
    schema: shared.UsageRowSchema,
    valid: {
      botId: CUID,
      day: '2026-09-01',
      inputTokens: 10,
      outputTokens: 5,
      estimatedCostUsd: 0.000046,
    },
    validEach: [
      // CC-12: a measured nothing is a real 0, an unpriceable day is null.
      { botId: CUID, day: '2026-09-02', inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      { botId: CUID, day: '2026-09-03', inputTokens: 10, outputTokens: 5, estimatedCostUsd: null },
    ],
    invalid: {
      botId: CUID,
      day: 'yesterday',
      inputTokens: 10,
      outputTokens: 5,
      estimatedCostUsd: null,
    },
    invalidEach: [
      { botId: CUID, day: '2026-09-01', inputTokens: 10, outputTokens: 5, estimatedCostUsd: -1 },
    ],
  },
  UsageResponseSchema: {
    schema: shared.UsageResponseSchema,
    valid: { rows: [] },
    invalid: { rows: null },
  },
  BillingPlanSchema: {
    schema: shared.BillingPlanSchema,
    valid: 'trial',
    validEach: ['none', 'starter', 'pro', 'internal'],
    invalid: 'enterprise',
  },
  PurchasablePlanSchema: {
    schema: shared.PurchasablePlanSchema,
    valid: 'starter',
    validEach: ['pro'],
    // The trial is bought through Starter, never asked for by name.
    invalid: 'trial',
    // Nor is an admin's plan something anyone can buy.
    invalidEach: ['none', 'internal'],
  },
  SubscriptionStatusSchema: {
    schema: shared.SubscriptionStatusSchema,
    valid: 'trialing',
    validEach: ['active', 'past_due', 'canceled'],
    invalid: 'cancelled',
  },
  BillingResponseSchema: {
    schema: shared.BillingResponseSchema,
    valid: {
      plan: 'trial',
      status: 'trialing',
      period: { start: '2026-10-01T10:00:00.000Z', end: '2026-10-08T10:00:00.000Z' },
      cancelAtPeriodEnd: false,
      trialEligible: false,
      compute: { usedSeconds: 3600, limitSeconds: 36000 },
      model: { usedUsd: 0.12, allowanceUsd: 1 },
      voice: {
        listen: { usedSeconds: 240, limitSeconds: 1800 },
        speak: { usedSeconds: 30, limitSeconds: 300 },
      },
    },
    validEach: [
      // Never subscribed, and Pro's unlimited hours.
      {
        plan: 'none',
        status: null,
        period: null,
        cancelAtPeriodEnd: false,
        trialEligible: true,
        compute: { usedSeconds: 0, limitSeconds: 0 },
        model: { usedUsd: 0, allowanceUsd: 0 },
        voice: {
          listen: { usedSeconds: 0, limitSeconds: 0 },
          speak: { usedSeconds: 0, limitSeconds: 0 },
        },
      },
      {
        plan: 'pro',
        status: 'active',
        period: { start: '2026-10-01T10:00:00.000Z', end: '2026-11-01T10:00:00.000Z' },
        cancelAtPeriodEnd: true,
        trialEligible: false,
        compute: { usedSeconds: 900000, limitSeconds: null },
        model: { usedUsd: 3.5, allowanceUsd: 10 },
        voice: {
          listen: { usedSeconds: 3600, limitSeconds: 72000 },
          speak: { usedSeconds: 600, limitSeconds: 7200 },
        },
      },
      // An admin: no subscription, no limits.
      {
        plan: 'internal',
        status: null,
        period: null,
        cancelAtPeriodEnd: false,
        trialEligible: true,
        compute: { usedSeconds: 0, limitSeconds: null },
        model: { usedUsd: 0, allowanceUsd: null },
        voice: {
          listen: { usedSeconds: 0, limitSeconds: null },
          speak: { usedSeconds: 0, limitSeconds: null },
        },
      },
    ],
    invalid: {
      plan: 'starter',
      status: 'active',
      period: null,
      cancelAtPeriodEnd: false,
      trialEligible: false,
      compute: { usedSeconds: -1, limitSeconds: 360000 },
      model: { usedUsd: 0, allowanceUsd: 5 },
      voice: {
        listen: { usedSeconds: 0, limitSeconds: 18000 },
        speak: { usedSeconds: 0, limitSeconds: 1800 },
      },
    },
  },
  BillingCheckoutBodySchema: {
    schema: shared.BillingCheckoutBodySchema,
    valid: { plan: 'pro' },
    invalid: { plan: 'trial' },
  },
  BillingRedirectResponseSchema: {
    schema: shared.BillingRedirectResponseSchema,
    valid: { url: 'https://checkout.stripe.com/c/pay/cs_test_123' },
    invalid: { url: 'not a url' },
  },
  HealthResponseSchema: {
    schema: HealthResponseSchema,
    valid: {
      status: 'ok',
      version: '0.0.3',
      edition: 'selfhosted',
      db: true,
      redis: true,
      docker: true,
      sandboxes: [],
    },
    invalid: {
      status: 'ok',
      version: '0.0.3',
      edition: 'enterprise',
      db: true,
      redis: true,
      docker: true,
      sandboxes: [],
    },
  },
  ApiErrorSchema: {
    schema: shared.ApiErrorSchema,
    valid: { statusCode: 404, code: 'E_NOT_FOUND', message: 'missing' },
    invalid: { statusCode: 99, code: 'E_NOT_FOUND', message: 'missing' },
  },
  // ── seat control (D-163) ────────────────────────────────────────────────
  SeatControlModeSchema: {
    schema: shared.SeatControlModeSchema,
    valid: 'draining',
    invalid: 'observer',
  },
  SeatControlHolderSchema: {
    schema: shared.SeatControlHolderSchema,
    valid: 'other',
    invalid: 'sess_123',
  },
  SeatControlActionSchema: {
    schema: shared.SeatControlActionSchema,
    valid: 'renew',
    invalid: 'steal',
  },
  // A renew or release without the epoch it was granted under is the case
  // that matters: it is how a superseded holder would extend its successor.
  ScreenControlPayloadSchema: {
    schema: shared.ScreenControlPayloadSchema,
    valid: { botId: CUID, action: 'take' },
    validEach: [
      { botId: CUID, action: 'renew', epoch: 3 },
      { botId: CUID, action: 'release', epoch: 0 },
    ],
    invalid: { botId: CUID, action: 'release' },
    invalidEach: [
      { botId: CUID, action: 'renew' },
      { botId: CUID, action: 'renew', epoch: -1 },
      { botId: CUID, action: 'steal', epoch: 3 },
      { action: 'take' },
    ],
  },
  // Each mode carries the deadline that bounds it, and the bot's control has
  // no holder to name.
  ScreenControlStatePayloadSchema: {
    schema: shared.ScreenControlStatePayloadSchema,
    valid: { botId: CUID, mode: 'agent', epoch: 4, holder: null, observationRequired: true },
    validEach: [
      {
        botId: CUID,
        mode: 'draining',
        epoch: 3,
        holder: 'self',
        drainDeadline: 1_756_732_805_000,
        observationRequired: false,
      },
      {
        botId: CUID,
        mode: 'human',
        epoch: 4,
        holder: 'other',
        leaseExpiresAt: 1_756_732_830_000,
        observationRequired: false,
      },
    ],
    invalid: {
      botId: CUID,
      mode: 'human',
      epoch: 4,
      holder: 'self',
      observationRequired: false,
    },
    invalidEach: [
      { botId: CUID, mode: 'agent', epoch: 4, holder: 'self', observationRequired: false },
      {
        botId: CUID,
        mode: 'draining',
        epoch: 3,
        holder: null,
        drainDeadline: 1_756_732_805_000,
        observationRequired: false,
      },
      {
        botId: CUID,
        mode: 'human',
        epoch: 4,
        holder: 'sess_123',
        leaseExpiresAt: 1_756_732_830_000,
        observationRequired: false,
      },
    ],
  },
  SeatControlRefusalCodeSchema: {
    schema: shared.SeatControlRefusalCodeSchema,
    valid: 'STALE_REFERENCE',
    invalid: 'FORBIDDEN',
  },
  // ── external-effect policy (D-164) ──────────────────────────────────────
  ToolEffectSchema: { schema: shared.ToolEffectSchema, valid: 'unknown', invalid: 'acts' },
  ApprovalScopeSchema: {
    schema: shared.ApprovalScopeSchema,
    valid: 'identity-turn',
    invalid: 'turn',
  },
  // The invalid cases are the ones that would widen an approval: a commit
  // with nothing pinned, and an identity window over a private seat or over
  // a call that is not a seat action.
  ToolApprovalRequestSchema: {
    schema: shared.ToolApprovalRequestSchema,
    valid: {
      proposalId: 'proposal-1',
      toolCallId: 'model-call-1',
      botId: 'bot-1',
      runId: 'run-1',
      definitionName: 'use_plugin_tool',
      toolName: 'mail__send',
      args: { to: 'ops@example.test' },
      binding: {
        toolName: 'mail__send',
        effect: 'unknown',
        scope: 'call',
        argsHash: 'a'.repeat(64),
        grantRevision: 'b'.repeat(64),
        resourceRevision: null,
        seat: null,
        commit: null,
      },
    },
    invalid: { proposalId: 'proposal-1', toolCallId: 'model-call-1' },
    invalidEach: [{ proposalId: 'proposal-1', approved: true }],
  },
  ToolApprovalAnswerSchema: {
    schema: shared.ToolApprovalAnswerSchema,
    valid: { approved: true, editedArgs: { to: 'ops@example.test' } },
    validEach: [{ approved: false, reason: 'Declined' }],
    invalid: { approved: 'yes' },
    invalidEach: [
      { approved: true, grantValid: true },
      { approved: true, binding: {} },
    ],
  },
  ApprovalBindingSchema: {
    schema: shared.ApprovalBindingSchema,
    valid: {
      toolName: 'shell',
      effect: 'unknown',
      scope: 'call',
      argsHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      grantRevision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      resourceRevision: null,
      seat: null,
      commit: null,
    },
    validEach: [
      {
        toolName: 'browser_click',
        effect: 'unknown',
        scope: 'identity-turn',
        argsHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        grantRevision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        resourceRevision: null,
        seat: { identity: 'company-google', browserGeneration: 2 },
        commit: null,
      },
      {
        toolName: 'gmail__send_email',
        effect: 'commit',
        scope: 'call',
        argsHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        grantRevision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        resourceRevision: null,
        seat: null,
        commit: {
          account: 'ops@example.test',
          destinations: ['ana@example.test'],
          contentRevision: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        },
      },
    ],
    invalid: {
      toolName: 'gmail__send_email',
      effect: 'commit',
      scope: 'call',
      argsHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      grantRevision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      resourceRevision: null,
      seat: null,
      commit: null,
    },
    invalidEach: [
      {
        toolName: 'browser_click',
        effect: 'draft',
        scope: 'identity-turn',
        argsHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        grantRevision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        resourceRevision: null,
        seat: { identity: null, browserGeneration: 2 },
        commit: null,
      },
      {
        toolName: 'shell',
        effect: 'unknown',
        scope: 'identity-turn',
        argsHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        grantRevision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        resourceRevision: null,
        seat: null,
        commit: null,
      },
      {
        toolName: 'shell',
        effect: 'unknown',
        scope: 'call',
        argsHash: 'ABC',
        grantRevision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        resourceRevision: null,
        seat: null,
        commit: null,
      },
    ],
  },
  ToolPolicyRefusalCodeSchema: {
    schema: shared.ToolPolicyRefusalCodeSchema,
    valid: 'APPROVAL_STALE',
    invalid: 'DENIED',
  },
  ...workPairs,
};

describe('M0-08 — every exported schema round-trips and rejects', () => {
  for (const [name, pair] of Object.entries(pairs)) {
    describe(name, () => {
      it('accepts a valid fixture', () => {
        for (const fixture of [pair.valid, ...(pair.validEach ?? [])]) {
          const result = pair.schema.safeParse(fixture);
          if (!result.success) {
            throw new Error(`${name} rejected its valid fixture: ${result.error.message}`);
          }
          expect(result.success).toBe(true);
        }
      });

      it('rejects a malformed fixture', () => {
        for (const fixture of [pair.invalid, ...(pair.invalidEach ?? [])]) {
          expect(pair.schema.safeParse(fixture).success).toBe(false);
        }
      });
    });
  }
});

describe('fixture coverage', () => {
  /**
   * The guard that keeps this file honest: a schema exported from `index.ts`
   * with no fixture pair fails here rather than shipping unverified.
   */
  it('covers every schema exported from index.ts', () => {
    const exported = Object.entries(shared)
      .filter(([name, value]) => name.endsWith('Schema') && value instanceof z.ZodType)
      .map(([name]) => name);

    const uncovered = exported.filter((name) => !(name in pairs));
    expect(uncovered, `schemas exported without a fixture pair: ${uncovered.join(', ')}`).toEqual(
      [],
    );
  });
});

describe('contract invariants', () => {
  it('preserves interrupted Message.stopReason through the wire schema', () => {
    const parsed = MessageSchema.parse({
      ...messageFixture,
      author: 'BOT',
      stopReason: 'interrupted',
    });
    expect(parsed.stopReason).toBe('interrupted');
  });

  it('exposes the exact §4.2 server event names', () => {
    expect(Object.keys(ServerEventSchemas).sort()).toEqual(
      [
        'approval.requested',
        'approval.resolved',
        'bot.status',
        'bots.changed',
        'deliverable.changed',
        'error',
        'goal.changed',
        'mcp.status',
        'message.attachments',
        'message.created',
        'message.deleted',
        'project.changed',
        'recording.event',
        'recording.state',
        'run.settled',
        'run.started',
        'screen.control.state',
        'sandbox.state',
        'skill.compiled',
        'task.changed',
        'turn.step',
        'usage.notice',
      ].sort(),
    );
  });

  it('exposes the exact §4.2 client event names', () => {
    expect(Object.keys(ClientEventSchemas).sort()).toEqual(
      [
        'approval.respond',
        'bot.cancel',
        'screen.control',
        'screen.subscribe',
        'screen.unsubscribe',
      ].sort(),
    );
  });

  it('pins §7.4’s per-bot budget at 4 000 estimated tokens of plugin listing', () => {
    // D-113 replaced the 40-definition cap with the number §6/M6 was actually
    // about: what a bot's plugins cost the request. Two definitions plus this
    // listing, whatever the catalogue holds — and the listing degrades rather
    // than refusing, so there is no size at which a plugin is turned away.
    expect(PLUGIN_LISTING_TOKEN_BUDGET).toBe(4_000);
  });

  it('defaults auto-review to ask when no rule matches (§6/M5)', () => {
    expect(shared.DEFAULT_AUTO_REVIEW_DECISION).toBe('ask');
  });

  it('keeps the model alias literal that Bot.modelId defaults to', () => {
    // The Prisma column default is the string "default"; if this constant
    // drifts, every existing Bot row silently stops resolving.
    //
    // V1-06 moved it from `DEFAULT_MODEL_ALIAS` to `MODEL_REF_DEFAULT` — ONE
    // constant, because two names for one literal is drift waiting to happen.
    expect(shared.MODEL_REF_DEFAULT).toBe('default');
    expect(shared.ModelRefSchema.safeParse('default').success).toBe(true);
  });

  it('keeps the separator the telemetry price table is keyed on', () => {
    // No longer a catalog id — D-082 retired `provider:model` as a model
    // identity. It survives as the key format of the cost table, which is
    // per-VENDOR and unaffected by which connection served the call.
    expect(shared.MODEL_ID_SEPARATOR).toBe(':');
  });

  it('normalizes every provider error onto exactly the ratified vocabulary', () => {
    // Three providers, three error shapes, one vocabulary. Adding a code here
    // without telling Nathan breaks his transcript switch.
    expect([...shared.ModelErrorCodeSchema.options].sort()).toEqual(
      [
        'ALLOWANCE_EXHAUSTED',
        'AUTH_FAILED',
        'CONTENT_REFUSED',
        'CONTEXT_OVERFLOW',
        'INVALID_REQUEST',
        'PROVIDER_UNAVAILABLE',
        'QUOTA_EXCEEDED',
        'RATE_LIMITED',
        'TIMEOUT',
        'UNKNOWN',
      ].sort(),
    );
  });

  it('never marks CONTEXT_OVERFLOW retryable', () => {
    // Retrying an oversized prompt unchanged just fails again — it needs
    // prepareStep to trim first.
    expect(shared.RETRYABLE_MODEL_ERROR_CODES).not.toContain('CONTEXT_OVERFLOW');
    for (const code of shared.RETRYABLE_MODEL_ERROR_CODES) {
      expect(shared.ModelErrorCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  it('no longer treats a provider-prefixed string as a model identity', () => {
    // The old rule was "`Bot.modelId` must carry a provider prefix, because an
    // unprefixed id would silently pick whichever provider registered first".
    // D-082 removed the registry that made that true: a `provider:model` key
    // stopped being unique once a user could hold two custom connections, so
    // the identity is a row id and the upstream name is a separate field.
    expect(shared.ModelRefSchema.safeParse('openai:gpt-5').success).toBe(true);
    expect(shared.UpstreamModelIdSchema.safeParse('gpt-5').success).toBe(true);
    // Still rejected, for the reason that outlived the registry: an id has to
    // be a non-empty string somebody could have stored.
    expect(shared.ModelRefSchema.safeParse('').success).toBe(false);
  });

  it('prefixes every REST route with a §4.1 method', () => {
    const flatten = (node: unknown): string[] =>
      typeof node === 'string'
        ? [node]
        : Object.values(node as Record<string, unknown>).flatMap(flatten);

    for (const route of flatten(API_ROUTES)) {
      expect(route).toMatch(/^(GET|POST|PATCH|PUT|DELETE) \//);
    }
  });

  it('accepts exactly one connection auth kind in V1 (D-084)', () => {
    // An enum with one member is the point: a V2 kind then arrives as a
    // versioned contract change a client can refuse, rather than as a
    // nullable column nobody branches on.
    expect([...shared.ConnectionAuthKindSchema.options]).toEqual(['api_key']);
  });

  it('allows one connection per built-in kind and many custom ones (D-082)', () => {
    for (const kind of shared.BUILT_IN_PROVIDER_KINDS) {
      expect(shared.ProviderKindSchema.safeParse(kind).success).toBe(true);
    }
    expect([...shared.BUILT_IN_PROVIDER_KINDS]).not.toContain('custom');
    expect(shared.ProviderKindSchema.safeParse('custom').success).toBe(true);
  });

  it('gives a provider connection no field a key could travel in (D-083)', () => {
    // The stronger half of the rule below: that one checks schema NAMES, this
    // one checks the fields a connection actually declares. A key is
    // write-only, so the absence has to be structural — a handler that wanted
    // to leak one would have to add a field here first, and this fails when it
    // does.
    //
    // Asserted against the DECLARATION, not against a parsed fixture. A parsed
    // fixture only carries fields the fixture itself set, so an OPTIONAL
    // `apiKey` added to the schema would be absent from the parse and the
    // assertion would pass over it — measured, not assumed: the fixture-based
    // form of this test stayed green with `apiKey: z.string().optional()` on
    // the schema. The declaration lists a field whether or not it is set.
    const allowed = new Set(['hasCredential', 'credentialSetAt']);
    const declared = Object.keys(shared.ProviderConnectionSchema.shape);
    expect(declared).toContain('hasCredential');
    for (const field of declared) {
      if (allowed.has(field)) continue;
      expect(field.toLowerCase()).not.toMatch(/key|secret|token|credential|password/);
    }
    // And the two allowed ones say only whether and when — never what.
    const parsed = shared.ProviderConnectionSchema.parse(providerConnectionFixture);
    expect(typeof parsed.hasCredential).toBe('boolean');
    expect(Object.keys(parsed).sort()).toEqual([...declared].sort());
  });

  it('never exposes credential material in a REST response schema', () => {
    // PRD §7.3: no API response anywhere contains token material.
    const responseSchemaNames = Object.keys(shared).filter(
      (n) => n.includes('Response') || n.includes('Summary') || n.includes('Plugin'),
    );
    for (const name of responseSchemaNames) {
      expect(name.toLowerCase()).not.toContain('credential');
      expect(name.toLowerCase()).not.toContain('token');
    }
  });
});
