import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contract guard for the Prisma schema.
 *
 * Field names in the Prisma schema are contractual across services, migrations,
 * and shared wire schemas. A code-review promise does not survive refactors,
 * so the expectation is pinned here instead.
 *
 * If this test fails, a schema field was renamed or added — update this list
 * intentionally alongside the matching migration.
 */

const SCHEMA = readFileSync(join(import.meta.dirname, '..', 'prisma', 'schema.prisma'), 'utf8');

/** PRD §3, model → the exact set of scalar field names. Relations excluded. */
const EXPECTED_FIELDS: Record<string, readonly string[]> = {
  // D-233 / docs/TELEGRAM.md: each person's own bot, its sealed token and
  // webhook secret digest, and the expiring single-use pairing code.
  TelegramConnection: [
    'id',
    'userId',
    'telegramBotId',
    'botUsername',
    'managed',
    'tokenCiphertext',
    'webhookSecretHash',
    'webhookUrl',
    'commandsDigest',
    'telegramUserId',
    'chatId',
    'displayName',
    'selectedBotId',
    'selectedAt',
    'lastMessageSequence',
    'lastRunSequence',
    'notifiedInterruptIds',
    'createdAt',
    'updatedAt',
  ],
  TelegramLinkTicket: ['tokenHash', 'userId', 'expiresAt'],
  TelegramPendingBot: [
    'telegramBotId',
    'botUsername',
    'managed',
    'ownerTelegramUserId',
    'userId',
    'tokenCiphertext',
    'webhookSecretHash',
    'webhookUrl',
    'failedAttempts',
    'claimedAt',
    'claimTelegramUserId',
    'claimChatId',
    'claimDisplayName',
    'expiresAt',
    'createdAt',
  ],
  TelegramAttachmentDelivery: ['connectionId', 'attachmentId'],
  TelegramRetiredBot: ['telegramBotId', 'retiredAt'],
  // Deviation 7 (V1-02). The four columns after `id` are Better Auth's core
  // schema, generated from src/auth/better-auth.ts, and `email` is no longer
  // nullable: §3's User described the seeded singleton, which had no way in
  // and so needed no address. Every V1 sign-in method reaches an account BY
  // EMAIL, and a nullable one is a sign-in that cannot find its own row.
  //
  // Deviation 11 (D-156): `stripeCustomerId`, declared by `@better-auth/stripe`,
  // and the admin plugin's four columns. `role = 'admin'` is the internal plan.
  UserOnboarding: ['userId', 'welcomeSeen', 'discovery', 'createdAt', 'updatedAt'],
  TemplateInstallation: [
    'id',
    'userId',
    'idempotencyKey',
    'templateId',
    'revision',
    'configuration',
    'groupId',
    'botIds',
    'createdAt',
  ],
  User: [
    'id',
    'name',
    'email',
    'emailVerified',
    'image',
    'createdAt',
    'updatedAt',
    'stripeCustomerId',
    'role',
    'banned',
    'banReason',
    'banExpires',
  ],
  Session: [
    'id',
    'expiresAt',
    'token',
    'createdAt',
    'updatedAt',
    'ipAddress',
    'userAgent',
    'userId',
    // Deviation 11 (D-156): the admin plugin's.
    'impersonatedBy',
  ],
  Account: [
    'id',
    'accountId',
    'providerId',
    'userId',
    // ⚠️ Google's and GitHub's tokens, proving WHO IS SIGNED IN. Not a model
    // provider's key — that is ProviderConnection, and no turn reads these.
    'accessToken',
    'refreshToken',
    'idToken',
    'accessTokenExpiresAt',
    'refreshTokenExpiresAt',
    'scope',
    // Declared by Better Auth's core schema. `emailAndPassword` is disabled in
    // the config, so no row ever carries one.
    'password',
    'createdAt',
    'updatedAt',
  ],
  Verification: ['id', 'identifier', 'value', 'expiresAt', 'createdAt', 'updatedAt'],
  // Deviation 11 (D-156): `@better-auth/stripe`'s subscription, generated like
  // the four tables above. `referenceId` is the owning user's id.
  Subscription: [
    'id',
    'plan',
    'referenceId',
    'stripeCustomerId',
    'stripeSubscriptionId',
    'status',
    'periodStart',
    'periodEnd',
    'trialStart',
    'trialEnd',
    'cancelAtPeriodEnd',
    'cancelAt',
    'canceledAt',
    'endedAt',
    'seats',
    'billingInterval',
    'stripeScheduleId',
  ],
  Bot: [
    'id',
    'userId',
    'kind',
    'name',
    'role',
    'avatarColor',
    // Deviation 3, ratified 2026-09-08: the avatar is a chosen mascot or an
    // uploaded picture, and §3 gives neither a column. Both are nullable, so
    // a bot that predates them keeps the name-derived mascot.
    'avatarShape',
    'avatarUrl',
    'systemPrompt',
    'modelId',
    'status',
    'sortOrder',
    'pinned',
    'hiddenFromSidebar',
    // Deviation 2, ratified: PRD §6/M5 needs an ordered per-bot rule list and
    // §3 gives no column for it. See the schema.prisma header.
    'autoReviewRules',
    // D-144: Ask for approval, Approve for me or Full access, per bot.
    'approvalMode',
    // D-221: the voice a spoken reply is read in; null is the house voice.
    'voiceId',
    'pluginGrantRevision',
    'createdAt',
    'updatedAt',
    // D-046: the computer this bot works on. §3 had a bare `sandbox Sandbox?`
    // back-relation because a machine belonged to exactly one bot; the edge
    // moved to this side when a machine started being shared, and it sits
    // where that back-relation sat.
    'sandboxId',
    // D-131: the sidebar group this bot is in; null is Unassigned.
    'groupId',
    // Desired shared-login selection and stale-request fence.
    'activeIdentityId',
    'identityRevision',
  ],
  // D-131: a named set of bots, sharing instructions and a folder.
  BotGroup: [
    'id',
    'userId',
    'name',
    'instructions',
    'sortOrder',
    'collapsed',
    'createdAt',
    'updatedAt',
  ],
  // D-131: `lastReadAt` is what unread counts are measured from.
  Conversation: ['id', 'botId', 'createdAt', 'lastReadAt'],
  Message: [
    'id',
    'conversationId',
    'author',
    'fromBotId',
    'content',
    'parts',
    // D-009(1): required by M1's interrupted-partial acceptance criterion.
    'stopReason',
    // D-165: the thread's order, taken when a message begins.
    'sequence',
    // D-165: the run that wrote an assistant or tool row.
    'runId',
    'chainId',
    'hopCount',
    'expectReply',
    'deliveryKey',
    // D-133: the task a Start brief or a delegated message is about.
    'taskId',
    // D-136: the routine that posted it, for filing its outputs under a goal.
    'routineId',
    // D-147: a `/new` boundary; the history seed starts after the newest one.
    'startsTopic',
    'createdAt',
  ],
  // ownerId (ownership from creation) and createdAt (TTL fence / reaper input)
  // extend Attachment.
  ArtifactDeletion: ['storageKey', 'retryAt'],
  Attachment: [
    'id',
    'messageId',
    'ownerId',
    'filename',
    'mimeType',
    'sizeBytes',
    'storageKey',
    // D-221: a voice note rather than a file, and its length.
    'kind',
    'durationMs',
    'createdAt',
  ],
  AgentTurn: [
    // D-168: monotonic writer order, including identical timestamps.
    'sequence',
    'id',
    'botId',
    'triggerMessageId',
    // D-159 §3.5: the run's thread.
    'conversationId',
    'status',
    'stepIndex',
    // D-185: this run's own working time; a continuation's ceiling sums its chain.
    'workingMs',
    'steps',
    'inputTokens',
    'outputTokens',
    // D-009(3): cached tokens bill differently; §7.2's cap is a hard stop.
    'cachedInputTokens',
    'cacheCreationTokens',
    // D-178: canonical library usage on the existing run.
    'usage',
    // CC-12: the billing identity /usage's cost table prices the counters
    // with. Nullable — turns settled before the column existed (or whose
    // call never settled) have no recorded model and stay unpriceable.
    'modelId',
    'startedAt',
    'endedAt',
    'stopReason',
    // D-165: the D-006 code (or WORKER_LOST) of a failed run.
    'errorCode',
    // D-178: safe projected sentence, never raw vendor prose.
    'errorMessage',
    // M1-BE-07: nullable unique reservation for one active turn per bot.
    'activeKey',
    // D-159 §3.5: the run store's fencing fields, null when never set.
    'driverEpoch',
    // D-177: the scoped producer claim and database-clock expiry.
    'workerId',
    'leaseExpiresAt',
    'cancelRequested',
    'detachedSince',
    'sandboxKey',
    // D-160: the paused run a continuation answered.
    'resumesRunId',
    // D-159 §3.7: when the run's event log closed.
    'eventsClosedAt',
  ],
  // D-159 §3.6, D-165: a durable human-in-the-loop pause (InterruptStore).
  RunInterrupt: [
    'id',
    'runId',
    'conversationId',
    'userId',
    'status',
    'sequence',
    'requestedAt',
    'resolvedAt',
    'payload',
    'response',
    'nativeInterruptId',
    'nativePayload',
    'nativeResponse',
    'nativeStatus',
    'nativeRequestedAt',
    'nativeResolvedAt',
  ],
  // D-159 §3.7, D-165: the delivery log; `id` is the offset.
  RunEvent: ['id', 'runId', 'conversationId', 'userId', 'chunk', 'createdAt'],
  // D-197: one row per call that can change something, reserved before it runs.
  ToolDispatch: [
    'id',
    'runId',
    'conversationId',
    'userId',
    'toolCallId',
    'toolName',
    'effect',
    'argsDigest',
    'status',
    'reference',
    'dispatchedAt',
    'settledAt',
  ],
  Sandbox: [
    'id',
    // D-046: was `botId @unique`. A machine is keyed on its owner and shared
    // by the bots attached to it; `Bot.sandboxId` is the edge that says which.
    'userId',
    'sessionId',
    'containerId',
    'state',
    'workspacePending',
    'pausePending',
    'widthPx',
    'heightPx',
    'vncPort',
    'cdpPort',
    'bridgePort',
    'lastStartedAt',
    'lastError',
    // D-039 §10, declared in schema.prisma's deviation header. Idle stop needs
    // a clock that survives an orchestrator restart, and a lease needs an
    // expiry; PRD §3's Sandbox has neither.
    'lastActiveAt',
    'keepRunningUntil',
    // Deviation 11 (D-156): the computer-time meter's watermark.
    'meteredAt',
  ],
  Recording: [
    'id',
    'botId',
    'state',
    'intent',
    'cdpAvailable',
    // Deviation 4 (D-042): §6/M3 requires that a hard limit "auto-stops and
    // marks the recording READY with a warning", and §3 gives the warning
    // nowhere to live. Without it, a recording cut off at 5000 events and one
    // the user stopped are the same row.
    'warning',
    // Deviation 5 (D-044): §6/M3's acceptance criteria require a stop to
    // produce "a DRAFT skill within 60 s, or a FAILED recording with a
    // readable error", and §3 gives the error nowhere to live. FAILED on its
    // own does not distinguish a hole in the trace from a compile the model
    // refused, which leaves re-recording as the operator's only move.
    'error',
    'startedAt',
    'endedAt',
  ],
  RecordingEvent: [
    'id',
    'recordingId',
    'tsOffsetMs',
    'layer',
    'type',
    'payload',
    'screenshotKey',
    'correlatedWithId',
  ],
  Skill: [
    'id',
    'botId',
    'name',
    'description',
    'paramsSchema',
    // Deviation 10 (D-098): §3's Skill has nowhere for the compiler's
    // plain-language summary of the task, and without a column the review
    // surface could open on nothing but the source — a sentence per step is
    // what a person reviews instead. Written at compile time; carried
    // forward unchanged across edits that do not restate it.
    'steps',
    'script',
    'version',
    'status',
    'sourceRecordingId',
    'createdAt',
  ],
  SkillRun: ['id', 'skillId', 'params', 'status', 'logs', 'error', 'startedAt', 'endedAt'],
  McpServer: [
    'id',
    'userId',
    'name',
    'slug',
    'category',
    'iconUrl',
    'accessMode',
    'accessRevision',
    'backend',
    'transport',
    'url',
    'isPrivate',
    'authType',
    'status',
    'lastError',
    'createdAt',
  ],
  ComposioConnection: [
    'serverId',
    'toolkit',
    'authConfigId',
    'accountId',
    'pendingAccountId',
    'pendingExpiresAt',
    'sessionId',
    'revision',
    'removing',
    'cleanupAccounts',
    'cleanupSessions',
  ],
  McpCredential: [
    'id',
    'serverId',
    'accessToken',
    'refreshToken',
    'expiresAt',
    'scopes',
    // D-103 (M6-BE-05): a refresh grant needs the token endpoint, the client
    // id and the resource as well as the grant itself, and the flow row that
    // learned them is DELETED by the callback that consumes it — so the three
    // coordinates are written onto the credential that outlives it. Nothing
    // in the object is secret (a public PKCE client id, a URL the user's own
    // browser was sent to, the server's own URL), which is why it is the one
    // column in that table that is not ciphertext.
    'authMetadata',
    'revision',
    'updatedAt',
  ],
  McpTool: [
    'source',
    'id',
    'serverId',
    'name',
    'description',
    'inputSchema',
    'readOnly',
    'refreshedAt',
  ],
  // D-208: owned computer checkouts and exact publication attempts.
  GitRemoteWrite: [
    'id',
    'userId',
    'botId',
    'serverId',
    'toolName',
    'argsHash',
    'input',
    'accountId',
    'status',
    'reference',
    'updatedAt',
  ],
  GitCheckout: [
    'id',
    'userId',
    'botId',
    'serverId',
    'repository',
    'repositoryId',
    'defaultBranch',
    'path',
    'status',
    'activeOperationId',
    'activeUntil',
    'createdAt',
  ],
  GitPublication: [
    'id',
    'userId',
    'botId',
    'checkoutId',
    'targetRepository',
    'targetRepositoryId',
    'branch',
    'intendedHead',
    'tree',
    'previousHead',
    'confirmedHead',
    'status',
    'updatedAt',
  ],
  BotMcpServer: ['botId', 'serverId', 'enabled'],
  // D-101 (M6-BE-03): §3 has no table for a browser trip in flight, and the
  // alternative to one was process memory — which cannot survive the minutes
  // between `connect` and the redirect, let alone a restart in between. The
  // row is deliberately short-lived: it is created when the user is sent to
  // the authorization server and DELETED by the callback that consumes it.
  // `state` is unique and is the lookup key: the callback route has no
  // session, so this value is its whole authority.
  //
  // The verifier and client id live here rather than on McpServer because
  // they belong to ONE attempt, not to the server: a second Connect replaces
  // the row, and a crash between the two is a row that expires in ten minutes
  // instead of a half-written credential.
  McpOAuthFlow: [
    'id',
    'state',
    'serverId',
    'codeVerifier',
    'clientId',
    'redirectUri',
    'tokenEndpoint',
    'resource',
    'scopes',
    'createdAt',
    'expiresAt',
  ],
  // D-073, CC-29: §3 has no memory, and D-069's MEMORY.md could not express
  // either scope the product needs — it is per-MACHINE, and it lives on a
  // volume WORKSPACE §9 retention exists to reclaim. WORKSPACE §1 already
  // promised "Bot memory (Postgres rows) ... not in the container at all";
  // this makes that true. Same class of gap addition as D-005's rules column
  // and D-057's identities: nothing in §3 is renamed, two tables are added
  // beside it.
  //
  // `botId` is nullable and that IS the scope: NULL is the user-global memory
  // a new bot starts with, set is the bot's own. A `projectId` joins them the
  // first time a user can have two checkouts.
  Memory: [
    'id',
    'userId',
    'botId',
    'authorBotId',
    'kind',
    'source',
    'status',
    'text',
    'detail',
    'messageId',
    'sourceRef',
    'supersededById',
    'supersededAt',
    'expiresAt',
    'confirmations',
    'lastUsedAt',
    'useCount',
    'createdAt',
    'updatedAt',
  ],
  // Not an audit table: without it the extraction sweep re-derives a fact the
  // user erased from the transcript that established it, and the correction
  // silently undoes itself.
  MemoryTombstone: ['id', 'userId', 'botId', 'claimHash', 'createdAt'],
  // D-078, CC-38: the extraction sweep's watermark. A row per bot, and
  // deliberately not a column on Bot — this is sweep bookkeeping rather than
  // part of what a bot IS, and §3's Bot is the table five people code against.
  // `throughCreatedAt` is paired with the id because cuid sorts lexically, not
  // chronologically: the id alone cannot answer "what is newer than this".
  MemoryDistillation: [
    'botId',
    'throughMessageId',
    'throughCreatedAt',
    'lastRunAt',
    'candidatesWritten',
  ],
  // D-057, M5-BE-27: §3 has no identity and no grant, and the feature cannot
  // be expressed without both — a shared login is a NAMED Chrome profile plus
  // a record of which bots may open a seat on it. Same class of gap addition
  // as D-005's rules column and D-021's Attachment fields: nothing in §3 is
  // renamed or reinterpreted, two tables are added beside it.
  //
  // `Identity.name` IS the profile directory rather than a display name with
  // a slug beside it, which is why there is no `slug` here to match
  // `McpServer`: the bot names the identity and the operator only reads it
  // back off an approval prompt, so a second column would be two truths about
  // one directory on disk.
  Identity: ['id', 'sandboxId', 'name', 'createdAt'],
  BotIdentity: ['botId', 'identityId', 'grantedAt'],
  Routine: [
    'id',
    'botId',
    'name',
    'cron',
    'timezone',
    'endsOn',
    'prompt',
    'skillId',
    'skillParams',
    'enabled',
    'lastRunAt',
    'lastStatus',
    // D-125 (M8-BE-08): who created it — an operator or the bot itself. A
    // bot-scheduled follow-up is not trusted like the operator's own, so the
    // row has to say which it is rather than leave it to be inferred.
    'origin',
    // D-133: the goal a routine works toward.
    'goalId',
  ],

  // ── Work (D-133, PRD §3.1) ────────────────────────────────────────────────
  Project: [
    'id',
    'userId',
    'name',
    'description',
    'color',
    'status',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ],
  Goal: [
    'id',
    'userId',
    'projectId',
    'title',
    'outcome',
    'targetOn',
    'status',
    'closedAt',
    'createdAt',
    'updatedAt',
  ],
  Task: [
    'id',
    'userId',
    'projectId',
    'goalId',
    'parentId',
    'title',
    'brief',
    'status',
    'blockedReason',
    'assigneeBotId',
    'origin',
    'seriesId',
    'occursAt',
    'occursOn',
    'createdByBotId',
    'dueOn',
    'rank',
    'startedAt',
    'completedAt',
    'createdAt',
    'updatedAt',
  ],
  TaskSeries: [
    'id',
    'userId',
    'title',
    'brief',
    'assigneeBotId',
    'projectId',
    'goalId',
    'cron',
    'timezone',
    'endsOn',
    'enabled',
    'lastFiredAt',
    'origin',
    'createdAt',
    'updatedAt',
  ],
  TaskEvent: [
    'id',
    'taskId',
    'userId',
    'actor',
    'actorBotId',
    'actorLabel',
    'type',
    'payload',
    'startKey',
    'messageId',
    'createdAt',
  ],
  Deliverable: [
    'id',
    'userId',
    'kind',
    'title',
    'summary',
    'botId',
    'attachmentId',
    'messageId',
    'url',
    'sourcePath',
    'taskId',
    'goalId',
    'projectId',
    'searchText',
    'reviewState',
    'supersededById',
    'createdAt',
  ],

  // ── Deviation 8 (D-082, D-086) ──────────────────────────────────────────
  // §3 has no provider configuration at all — D-002 put it in the environment,
  // which stops being expressible the moment an install has two users, since
  // whichever key the process holds is one person's and every turn bills it.
  ProviderConnection: [
    'id',
    'userId',
    'kind',
    // Display only. D-082: the ROW is the identity, never this.
    'name',
    // CUSTOM only; the built-ins' endpoints belong to their SDKs.
    'endpoint',
    'authKind',
    'state',
    // ⚠️ D-083. AES-256-GCM output, read only by the owner-scoped credential
    // service. Never selected into a response, logged, queued, or handed to a
    // sandbox. `credentialKeyVersion` names the keyring entry that produced
    // it, which is what lets rotation proceed row by row.
    'credentialCiphertext',
    'credentialKeyVersion',
    'credentialSetAt',
    'createdAt',
    'updatedAt',
  ],
  ProviderModel: [
    'id',
    'connectionId',
    // D-082's three identities, kept apart: the row id above is what a Bot
    // stores, this is what goes on the wire to the provider, and `label` is
    // what a person reads.
    'upstreamModelId',
    'label',
    'contextWindow',
    // D-087: what the MODEL can do — NOT what an execution backend can do with
    // it. Flattened to three columns rather than a Json blob because the
    // picker filters on them.
    'supportsTools',
    'supportsVision',
    'supportsReasoning',
    'createdAt',
  ],
  // D-086: replaces the DEFAULT_MODEL_ID environment variable. The alias is
  // per-user now because the key behind it is.
  // D-234: a choice and a detection for each of language and timezone.
  UserSettings: [
    'userId',
    'defaultModelId',
    'language',
    'timezone',
    'systemLanguage',
    'systemTimezone',
    'updatedAt',
  ],
  // Deviation 11 (D-156): one row per user per billing period, keyed by the
  // period's start so a new period resets usage by being a new row.
  // D-157: one row per included-model call, itemising UsageLedger's total.
  ModelCharge: [
    'id',
    'userId',
    'periodStart',
    'upstreamModelId',
    'costMicroUsd',
    'settledAt',
    'createdAt',
  ],
  // D-223: one request's voice seconds, reserved then settled.
  VoiceCharge: ['id', 'userId', 'periodStart', 'kind', 'seconds', 'settledAt', 'createdAt'],
  // D-222: a call's minutes, settled from ElevenLabs' own count.
  VoiceCall: [
    'id',
    'userId',
    'botId',
    'conversationId',
    'periodStart',
    'reservedSeconds',
    'startedAt',
    'endedAt',
    'durationSeconds',
    'settledAt',
  ],
  UsageLedger: [
    'id',
    'userId',
    'periodStart',
    'periodEnd',
    'computeSeconds',
    'modelMicroUsd',
    // D-223: the voice allowance, by audio heard and audio made.
    'listenSeconds',
    'speakSeconds',
    'createdAt',
    'updatedAt',
  ],
  WorkflowChainState: [
    'chainId',
    'userId',
    'rootBotId',
    'groupId',
    'status',
    'expectedOwners',
    'respondedOwners',
    'closeoutPublished',
    'deadlineAt',
    'stoppedAt',
    'closedAt',
    'createdAt',
    'updatedAt',
  ],
  BoardEntry: [
    'id',
    'userId',
    'scopeKey',
    'ownerBotId',
    'ownerName',
    'content',
    'version',
    'deleted',
    'createdAt',
    'updatedAt',
  ],
  BoardRevision: [
    'id',
    'userId',
    'scopeKey',
    'entryId',
    'ownerBotId',
    'kind',
    'snapshot',
    'createdAt',
  ],
  CodingRun: [
    'id',
    'userId',
    'botId',
    'parentRunId',
    'runnerKind',
    'runnerId',
    'modelId',
    'status',
    'cwd',
    'steps',
    'workingMs',
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'cacheCreationTokens',
    'filesChanged',
    'errorCode',
    'startedAt',
    'endedAt',
  ],
};

/** PRD §3 enums, name → exact members in declaration order. */
const EXPECTED_ENUMS: Record<string, readonly string[]> = {
  BotStatus: ['IDLE', 'THINKING', 'ACTING', 'AWAITING_APPROVAL', 'ERROR'],
  MessageAuthor: ['USER', 'BOT', 'SYSTEM', 'TOOL'],
  // D-159 §3.5, D-165: the library's RunStatus.
  TurnStatus: ['running', 'interrupted', 'completed', 'failed', 'aborted'],
  // D-165: an interrupt's lifecycle.
  InterruptStatus: ['pending', 'resolved', 'cancelled'],
  DispatchStatus: ['DISPATCHED', 'COMMITTED', 'REFUSED', 'UNCERTAIN'],
  SandboxState: ['STOPPED', 'STARTING', 'RUNNING', 'UNHEALTHY', 'ERROR'],
  RecordingState: ['RECORDING', 'COMPILING', 'READY', 'FAILED', 'DISCARDED'],
  // Deviation 4 (D-042), the vocabulary of `Recording.warning`.
  RecordingWarning: ['EVENT_LIMIT', 'TIME_LIMIT'],
  CaptureLayer: ['X11', 'CDP', 'ATSPI'],
  SkillStatus: ['DRAFT', 'APPROVED', 'ARCHIVED'],
  RunStatus: ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
  // D-125 — `Routine.origin`.
  RoutineOrigin: ['OPERATOR', 'BOT'],
  McpBackend: ['DIRECT', 'COMPOSIO'],
  PluginAccessMode: ['SELECTED', 'ALL'],
  McpTransport: ['HTTP', 'SSE'],
  McpToolSource: ['REMOTE', 'CREWAID_GIT'],
  GitCheckoutStatus: ['CREATING', 'READY', 'FAILED'],
  GitPublicationStatus: ['PREPARED', 'SENDING', 'CONFIRMED', 'UNCERTAIN'],
  // D-144 — `Bot.approvalMode`.
  ApprovalMode: ['ASK', 'AUTO', 'FULL'],
  McpAuthType: ['NONE', 'OAUTH2', 'HEADER'],
  McpStatus: ['DISCONNECTED', 'CONNECTING', 'CONNECTED', 'NEEDS_REAUTH', 'ERROR'],
  // Deviation 6 (D-073). Three vocabularies the memory cannot work without.
  //
  // `MemoryKind` decides how a claim decays: TASK_STATE replaces rather than
  // accumulates, RESOURCE points at a source rather than standing in for it.
  MemoryKind: ['PREFERENCE', 'CONVENTION', 'FACT', 'DECISION', 'TASK_STATE', 'RESOURCE'],
  // ORDER IS MEANINGFUL and is asserted as written: D-074 resolves a conflict
  // by source before recency, so this is descending authority. A DISTILLED
  // guess must never silently override a TOLD statement, however many times
  // it was re-derived.
  MemorySource: ['TOLD', 'DISTILLED', 'OBSERVED', 'IMPORTED'],
  // CANDIDATE is what makes automatic extraction safe to switch on: it is
  // searchable but never injected, so a wrong inference is a search result
  // rather than a standing truth in a trim-proof prompt.
  MemoryStatus: ['CANDIDATE', 'ACTIVE', 'SUPERSEDED', 'FORGOTTEN'],
  // Deviation 8 (D-082, D-084). CUSTOM is any public HTTPS endpoint speaking
  // the OpenAI Chat Completions shape; D-085 constrains which hosts.
  //
  // D-157: CREWAID, the models a hosted plan includes — made by the server.
  //
  // D-221: ELEVENLABS, a self-hosted account's voice key. It has no models.
  ProviderKind: ['OPENAI', 'ANTHROPIC', 'OPENROUTER', 'CUSTOM', 'CREWAID', 'ELEVENLABS'],
  // D-221: `Attachment.kind`. A VOICE_NOTE on a USER message makes the reply spoken.
  AttachmentKind: ['FILE', 'VOICE_NOTE'],
  // D-223: `VoiceCharge.kind`.
  VoiceUsageKind: ['LISTEN', 'SPEAK'],
  // One member, deliberately (D-084). An enum rather than an inferred boolean
  // so a V2 subscription-backed kind arrives as a migration and a contract
  // change a client can refuse, instead of as a nullable column nobody reads.
  ConnectionAuthKind: ['API_KEY'],
  // NEEDS_CREDENTIAL is the state a connection is BORN in and the one it
  // returns to when its key is removed, which is why it is stored rather than
  // derived from `credentialCiphertext IS NULL` at every call site.
  ConnectionState: ['ACTIVE', 'NEEDS_CREDENTIAL', 'DISABLED'],
  // D-133 — Work.
  ProjectStatus: ['ACTIVE', 'ARCHIVED'],
  GoalStatus: ['ACTIVE', 'ACHIEVED', 'ABANDONED'],
  TaskStatus: ['TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'DONE', 'CANCELLED'],
  TaskOrigin: ['OPERATOR', 'BOT'],
  TaskActor: ['USER', 'BOT'],
  TaskEventType: [
    'CREATED',
    'EDITED',
    'ASSIGNED',
    'UNASSIGNED',
    'STARTED',
    'STATUS_CHANGED',
    'NOTE',
    'DELIVERABLE_LINKED',
  ],
  DeliverableKind: ['FILE', 'LINK', 'MESSAGE'],
  DeliverableReviewState: ['READY', 'REVIEWED', 'ARCHIVED'],
  WorkflowChainStatus: ['ACTIVE', 'WRAPPING_UP', 'STOPPED', 'CLOSED'],
  BoardRevisionKind: ['INIT_SNAPSHOT', 'ADD', 'UPDATE', 'DELETE', 'RESTORE', 'EXTERNAL_EDIT'],
};

/** Known model names, used to tell a relation field from a scalar one. */
const MODEL_NAMES = new Set(Object.keys(EXPECTED_FIELDS));

function blockOf(kind: 'model' | 'enum', name: string): string {
  const match = new RegExp(`^${kind}\\s+${name}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(SCHEMA);
  if (match?.[1] === undefined) {
    throw new Error(`${kind} ${name} not found in schema.prisma`);
  }
  return match[1];
}

function scalarFieldsOf(model: string): string[] {
  const fields: string[] = [];

  for (const rawLine of blockOf('model', model).split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('//') || line.startsWith('@@')) continue;

    const parsed = /^(\w+)\s+(\w+)/.exec(line);
    if (parsed === null) continue;

    const [, fieldName, fieldType] = parsed;
    if (fieldName === undefined || fieldType === undefined) continue;

    // Relation navigation properties are not wire fields.
    if (MODEL_NAMES.has(fieldType)) continue;

    fields.push(fieldName);
  }

  return fields;
}

describe('M0-03 — Prisma schema matches PRD §3 verbatim', () => {
  describe('models', () => {
    for (const [model, expected] of Object.entries(EXPECTED_FIELDS)) {
      it(`${model} has exactly the §3 fields, in order`, () => {
        expect(scalarFieldsOf(model)).toEqual([...expected]);
      });
    }

    it('declares no models beyond §3', () => {
      const declared = [...SCHEMA.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
      expect(declared.sort()).toEqual(Object.keys(EXPECTED_FIELDS).sort());
    });
  });

  describe('enums', () => {
    for (const [name, members] of Object.entries(EXPECTED_ENUMS)) {
      it(`${name} has exactly the §3 members, in order`, () => {
        const declared = blockOf('enum', name)
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '' && !l.startsWith('//'));
        expect(declared).toEqual([...members]);
      });
    }

    it('declares no enums beyond §3', () => {
      const declared = [...SCHEMA.matchAll(/^enum\s+(\w+)\s*\{/gm)].map((m) => m[1]);
      expect(declared.sort()).toEqual(Object.keys(EXPECTED_ENUMS).sort());
    });
  });

  describe('§3 invariants', () => {
    it('keeps Message.parts as an untyped Json column', () => {
      // PRD M1: "Persist AI SDK message parts verbatim. Do not invent a
      // parallel representation."
      expect(blockOf('model', 'Message')).toMatch(/parts\s+Json\?/);
    });

    it('defaults AgentTurn.steps to an empty array (R9 checkpointing)', () => {
      expect(blockOf('model', 'AgentTurn')).toMatch(/steps\s+Json\s+@default\("\[\]"\)/);
    });

    it('pins the default sandbox resolution at 1280x800 (R8)', () => {
      const sandbox = blockOf('model', 'Sandbox');
      expect(sandbox).toMatch(/widthPx\s+Int\s+@default\(1280\)/);
      expect(sandbox).toMatch(/heightPx\s+Int\s+@default\(800\)/);
    });

    it('keeps the Routine default timezone from §3', () => {
      expect(blockOf('model', 'Routine')).toMatch(/@default\("America\/Port-au-Prince"\)/);
    });

    it('cascades bot deletion into its sandbox (M2: destroy within 10s)', () => {
      expect(blockOf('model', 'Sandbox')).toMatch(/onDelete:\s*Cascade/);
    });

    it('cascades server deletion into its credential (§7.3)', () => {
      expect(blockOf('model', 'McpCredential')).toMatch(/onDelete:\s*Cascade/);
    });

    it('does NOT make Skill.sourceRecordingId unique (D-009.2)', () => {
      // M3: "editing and saving a script bumps version and keeps the previous
      // version queryable". v1 and v2 both point at the same source recording,
      // so a unique constraint makes the second edit throw. Restoring §3's
      // `@unique` here is a guaranteed M3 gate failure.
      expect(blockOf('model', 'Skill')).not.toMatch(/sourceRecordingId\s+String\?\s*@unique/);
    });

    it('gives Message a stopReason column (D-009.1)', () => {
      // M1: killing the orchestrator mid-stream must leave the partial
      // persisted with stopReason: 'interrupted'.
      expect(blockOf('model', 'Message')).toMatch(/stopReason\s+String\?/);
    });

    it('separates cached from fresh input tokens (D-009.3)', () => {
      // Cached reads bill at a fraction of fresh input, so conflating them
      // makes /usage's cost report wrong in both directions — the columns are
      // what let CC-12 price a turn by what it actually cost.
      const turn = blockOf('model', 'AgentTurn');
      expect(turn).toMatch(/cachedInputTokens\s+Int\s+@default\(0\)/);
      expect(turn).toMatch(/cacheCreationTokens\s+Int\s+@default\(0\)/);
    });

    it('keeps the turn’s billing identity nullable (CC-12)', () => {
      // History settled before the column existed has no model to price;
      // nullable is what lets /usage say "unknown" instead of guessing from
      // the bot's current configuration.
      expect(blockOf('model', 'AgentTurn')).toMatch(/modelId\s+String\?/);
    });
  });
});
