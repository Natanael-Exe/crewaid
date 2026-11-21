#!/usr/bin/env node
import 'reflect-metadata';
import path from 'node:path';
import { Test } from '@nestjs/testing';
import { AppModule } from '../dist/app.module.js';
import { SINGLETON_USER_ID } from '../dist/auth/singleton-user.js';
import { BotsService } from '../dist/bots/bots.service.js';
import { CredentialService } from '../dist/credentials/credential.service.js';
import { ModelResolutionService } from '../dist/models/model-resolution.service.js';
import { StructuredLogger } from '../dist/logging/structured-logger.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';
import { toTranscriptRow } from '../dist/agent/persistence/transcript.js';
import { SandboxReconciliationService } from '../dist/sandbox/sandbox-reconciliation.service.js';
import { SandboxRetentionService } from '../dist/sandbox/sandbox-retention.service.js';
import { SANDBOX_PROVIDER } from '../dist/sandbox/sandbox.provider.js';
import { CrewaidWsAdapter } from '../dist/ws/crewaid-ws.adapter.js';
import {
  createDeterministicTextAdapter,
  E2E_APPROVAL_FACT,
  E2E_APPROVAL_REPLY,
  E2E_REPLY,
} from './e2e-deterministic-provider.mjs';

/**
 * The session token the desktop will present, on both transports.
 *
 * Named for what it is since V1-09. It was `ORCH_API_TOKEN` while that
 * variable meant something — a static secret the REST guard and the §4.2
 * handshake both compared — and keeping the name after both moved to sessions
 * would point the next reader at a variable that no longer exists.
 */
const token = process.env.CREWAID_E2E_SESSION_TOKEN;
if (!token) throw new Error('CREWAID_E2E_SESSION_TOKEN is required for the M1-QA-05 server');

const schemaName = process.env.CREWAID_E2E_DATABASE_SCHEMA;
const databaseUrl = process.env.DATABASE_URL;
if (
  !schemaName ||
  !schemaName.startsWith('crewaid_e2e_') ||
  !databaseUrl ||
  new URL(databaseUrl).searchParams.get('schema') !== schemaName
) {
  throw new Error('M1-QA-05 refuses to run without its isolated temporary database schema');
}

/**
 * Opt-in, for the approval spec: the bot answers by calling `remember` and is
 * set to "Ask for approval", so the operator is asked by the real policy. One
 * switch for both halves, because a call the mode allows never prompts and a
 * mode with no call never asks — either half alone is a spec that waits for a
 * prompt nothing will produce.
 */
const approvalTool = process.env.CREWAID_E2E_APPROVAL_TOOL === '1';

/**
 * Creation provisions a workspace before it commits (D-039 §14.1), so an
 * absent image fails the create outright rather than degrading to a bot with
 * no storage. This suite types, streams and restarts; it owns no desktop, and
 * building the sandbox image to seed one bot would tie every UI run to a
 * multi-minute image build. So answer as a daemon holding exactly the
 * workspaces this schema provisioned, and keep the create path itself intact.
 *
 * Runtime members stay absent-shaped rather than simulated: nothing here
 * starts a container, and a future spec that needs a real one must fail on the
 * missing member instead of reading a fake as a running desktop.
 */
class E2eWorkspaceProvider {
  specificationVersion = 'harness-sandbox-v1';
  providerId = 'crewaid-e2e-workspace';
  #workspaces = new Set();

  provisionWorkspace = ({ botId }) => {
    this.#workspaces.add(botId);
    return Promise.resolve();
  };

  inspectWorkspace = ({ botId }) =>
    Promise.resolve(
      this.#workspaces.has(botId)
        ? { exists: true, ok: true, volumeName: `crewaid-workspace-${botId}` }
        : { exists: false },
    );

  // Never started, so never any runtime history to report.
  inspectWorkspaceHistory = () => Promise.resolve({ referenced: false, runtimeCreatedAt: null });
  listWorkspaces = () => Promise.resolve([...this.#workspaces].map((botId) => ({ botId })));
  retainWorkspace = () => Promise.resolve('retained');

  // Deletion asks what is running before it drops the row; nothing ever is.
  listManagedSessions = () => Promise.resolve([]);
  attachSession = () => Promise.resolve(null);
  removeManagedSession = () => Promise.resolve();
}

const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  // This schema knows only its own test bot, while Docker may host unrelated
  // real desktops. Never interpret "absent from this schema" as an orphan on
  // the shared daemon. Screen tests still exercise explicit sandbox lifecycle.
  .overrideProvider(SandboxReconciliationService)
  .useValue({ onApplicationBootstrap() {} })
  .overrideProvider(SandboxRetentionService)
  .useValue({ onApplicationBootstrap() {} })
  .overrideProvider(SANDBOX_PROVIDER)
  .useValue(new E2eWorkspaceProvider())
  // The run engine resolves its text adapter through
  // `ModelResolutionService.resolveText` (D-199: it is the only engine). Without a stub there, every reply in
  // this harness fails with "no model is configured", which reaches Playwright
  // as a transcript that holds the operator's message and never answers it.
  //
  // Only `resolveText` is replaced, on the module's REAL service: `options()`
  // still answers `GET /models` from this schema's own (empty) catalog, so the
  // composer's model picker says what it says in production for a user with no
  // connection rather than crashing the route.
  .overrideProvider(ModelResolutionService)
  .useFactory({
    inject: [PrismaService, CredentialService],
    factory: (prisma, credentials) => {
      const service = new ModelResolutionService(prisma, credentials);
      service.resolveText = () =>
        Promise.resolve({
          adapter: createDeterministicTextAdapter({ approvalTool }),
          // Decides how the reported usage is read (`models/tanstack/usage.ts`);
          // the scripted figures are OpenAI-shaped.
          kind: 'custom',
          modelId: 'pm_e2e_model',
          connectionId: 'conn_e2e',
          connectionName: 'E2E',
          upstreamModelId: 'm1-qa-05-deterministic',
          label: 'Deterministic E2E model',
          contextWindow: 200_000,
          capabilities: { tools: true, vision: true, reasoning: false },
        });
      return service;
    },
  })
  .compile();

const app = moduleRef.createNestApplication();
const logger = app.get(StructuredLogger);
app.useLogger(logger);
app.setGlobalPrefix('api/v1', { exclude: ['health'] });
app.useWebSocketAdapter(new CrewaidWsAdapter(app, logger));

await app.init();

const prisma = app.get(PrismaService);
// V1-02 made `name` non-null and `email` non-null + unique. This harness
// runs against a database of its own, so the address only has to be unique
// and unreachable, not real.
await prisma.user.create({
  data: {
    id: SINGLETON_USER_ID,
    name: 'QA-05 User',
    email: `${SINGLETON_USER_ID}@e2e.invalid`,
  },
});

/**
 * V1-08: HTTP authenticates a Better Auth SESSION, so the desktop's bearer has
 * to be one. The session token is set to `ORCH_API_TOKEN` deliberately — the
 * one value this harness already hands the client — so the REST requests and
 * the §4.2 handshake keep working from a single credential while the socket
 * still compares that variable (V1-09 moves it).
 *
 * The row is written directly for the same reason the test fixture does it:
 * every real way in leaves the process, and an end-to-end UI run must not
 * depend on an identity provider or a mail service being reachable.
 */
await prisma.session.create({
  data: {
    id: 'ses_m1_qa_05_e2e',
    token,
    userId: SINGLETON_USER_ID,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  },
});
const bot = await app.get(BotsService).create(SINGLETON_USER_ID, {
  name: 'QA-05 Bot',
  role: 'Deterministic E2E provider',
  avatarColor: '#2563EB',
  systemPrompt: 'Reply through the deterministic M1-QA-05 provider.',
});
await app.get(BotsService).update(SINGLETON_USER_ID, bot.id, {
  pinned: true,
  sortOrder: -2_147_483_648,
  ...(approvalTool && { approvalMode: 'ASK' }),
});

// Keep the production startup boundary in the E2E. The temporary schema is
// empty, so recovery can never rewrite a developer's in-flight turns.
// M10: the Work spec previews a deliverable, and a FILE deliverable is only
// ever made by a bot's attach_file inside a turn with a real computer. So it
// is seeded here, opt-in, exactly as that path leaves it: the bytes under
// ARTIFACT_DIR, an attachment claimed by a reply in the bot's conversation,
// and the deliverable pointing at it. Other specs see an empty conversation.
//
// D-192: the reply goes in through `toTranscriptRow`, which is what writes
// `parts`. A row with `content` alone is the AI SDK shape, and the operator
// hydrate of a TANSTACK thread refuses to read one: `loadForOperator` throws
// on an unreadable row rather than skipping it (so a save of the shorter list
// cannot look like the thread losing a message), which answers
// `GET /bots/:id/chat?threadId=` with a 500. The window then shows an empty
// conversation and "Something went wrong" — for every message in the thread,
// not just the seeded one.
if (process.env.CREWAID_E2E_SEED_WORK === '1') {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const artifactDir = process.env.ARTIFACT_DIR;
  if (!artifactDir) throw new Error('ARTIFACT_DIR is required to seed a deliverable');
  const storageKey = `e2e-work/${schemaName}/PRD.md`;
  const bytes = Buffer.from('# Acme PRD\n\nAuth, **billing** and onboarding.\n');
  await mkdir(path.dirname(path.join(artifactDir, storageKey)), { recursive: true });
  await writeFile(path.join(artifactDir, storageKey), bytes);
  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { botId: bot.id } });
  const row = toTranscriptRow(
    { id: 'cnm10workreply00000000001', role: 'assistant', content: 'Here is the PRD.' },
    { threadBotId: bot.id, runId: null },
  );
  if (!row.ok) throw new Error(`the seeded reply is not a transcript row: ${row.violation.kind}`);
  const reply = await prisma.message.create({
    data: { conversationId: conversation.id, ...row.value },
  });
  const attachment = await prisma.attachment.create({
    data: {
      ownerId: SINGLETON_USER_ID,
      messageId: reply.id,
      filename: 'PRD.md',
      mimeType: 'text/markdown',
      sizeBytes: bytes.length,
      storageKey,
    },
  });
  await prisma.deliverable.create({
    data: {
      userId: SINGLETON_USER_ID,
      kind: 'FILE',
      title: 'PRD.md',
      botId: bot.id,
      attachmentId: attachment.id,
      sourcePath: '/home/bot/shared/PRD.md',
    },
  });
}

await app.listen(0, '127.0.0.1');

const address = app.getHttpServer().address();
if (address === null || typeof address === 'string') {
  throw new Error('M1-QA-05 server did not bind a TCP port');
}

console.log(
  `M1_QA_05_READY ${JSON.stringify({
    baseUrl: `http://127.0.0.1:${address.port}`,
    botId: bot.id,
    reply: E2E_REPLY,
    databaseSchema: schemaName,
    ...(approvalTool && { approvalFact: E2E_APPROVAL_FACT, approvalReply: E2E_APPROVAL_REPLY }),
  })}`,
);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  process.exit(0);
}

process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
