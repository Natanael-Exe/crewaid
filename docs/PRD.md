# PRD — Crewaid

**Owner:** Natanael Exe / Evoxatech
**Status:** Implementation plan — revision 4 (lifecycle and commercial roadmap)
**Date:** 2026-09-05
**Product name:** `Crewaid`

> **Revision 2 changes.** Hermes removed as a dependency. AI SDK 7 adopted for the model layer, the agent loop, tool approval, and the sandbox provider interface. BullMQ confirmed over Workflow DevKit, with a step-checkpointing requirement added to compensate. HeroUI added to the stack. Auth boundary defined but real auth deferred.
>
> **Revision 3 changes.** HeroUI v3 promoted from supporting-cast-only to the UI foundation, including the chat surface; the revision-2 instruction to hand-build the transcript is reversed. MCP plugins promoted from deferred to **M6**, ahead of bot-to-bot messaging and routines; former M6 and M7 renumbered to M7 and M8. Without connectors a bot can only drive web UIs through Chrome, which is not enough to do real work. See §2.5 for the reasoning behind each decision.

---

> **Revision 4:** D-031–D-034 define durable workspaces, capacity and idle lifecycle, honest interruption semantics, complete review gates, and a separate conditional M9 paid-launch milestone. M0–M8 remain the personal MVP.

## 0. How to use this document

This PRD is written to be handed to a coding agent. It is organized as **nine sequential milestones (M0–M8)**. Each milestone has a **Scope**, an **Interface contract**, **Acceptance criteria** (binary, checkable), and **Required tests**.

**Rules for the implementing agent:**

1. Do not start milestone `N+1` until every acceptance criterion and every required test in milestone `N` passes in CI.
2. Do not invent endpoints, event names, table names, or config keys. If something is genuinely underspecified, stop and ask rather than guessing.
3. Do not hand-roll anything §2.5 says the AI SDK already provides. If you find yourself writing a tool-calling loop, a provider adapter, or a stream-chunk mapper, stop — it exists upstream.
4. Every milestone ends with a green `pnpm test` and a working `docker compose up`.
5. Commit per milestone with the message prefix `feat(mN): …`.

---

## 1. Product summary

### 1.1 What this is

A self-hosted desktop application for running a team of AI agents ("bots"). Each bot owns a private Linux computer. The user chats with bots in a messaging-style UI, watches their screens live, takes control of a bot's computer directly, and teaches new skills by demonstrating a task **on the bot's own machine**.

### 1.2 Why

Existing products with this shape are closed and subscription-priced. Channel-based alternatives (Telegram bots, Slack apps) require per-channel setup, don't give a bot its own environment, and offer no way to watch or take over the work.

### 1.3 Primary user

A single technical operator running 3–8 bots for outbound sales, research, and pipeline work. Multi-tenant is out of scope for v1, but §2.2 R7 keeps the door open.

### 1.4 Goals

- **G1** — Each bot has a Linux desktop with a browser, file manager, and terminal.
  *(Amended by **D-046**: "isolated" as originally written meant a container per bot. A computer is
  now shared by the bots attached to it, defaulting to one per user, and isolation is per computer.
  A user who wants two boundaries creates two computers. `docs/WORKSPACE.md` §19–§22.)*
- **G2** — The user sees any bot's screen live and can take control with mouse and keyboard.
  *(Unchanged by D-046, and deliberately so: a shared container does not require a shared display.
  Each bot keeps a seat with its own stream — `docs/WORKSPACE.md` §20.)*
- **G3** — The user teaches a task by performing it on the bot's computer; the demonstration becomes a reusable, parameterized skill.
- **G4** — Bots exchange messages with each other under the orchestrator's control.
- **G5** — Bots run recurring work on a schedule without the user's laptop being awake.
- **G6** — Everything runs on infrastructure the user already owns (Hetzner VPS, Docker, Traefik) plus a metered inference provider.

### 1.5 Non-goals for v1

- Multi-user accounts, teams, org permissions, billing.
- Mobile clients.
- Windows or macOS bot environments. Bot computers are Linux only.
- Training, fine-tuning, or self-hosting model weights.
- A marketplace for sharing skills between installations.
- Voice input. *(Superseded by D-221: dictation, voice messages and spoken replies.)*

---

## 2. Architecture

### 2.1 Layer split

```
┌───────────────────────────────────────────────────────────┐
│  Electron client                    (user's Mac/PC)       │
│  Chat UI · screen viewer · input capture · downloads      │
│  React 19 · HeroUI · Tailwind v4 · noVNC                  │
└───────────────────────────┬───────────────────────────────┘
                            │  HTTPS + WSS (single origin)
┌───────────────────────────▼───────────────────────────────┐
│  Orchestrator — NestJS                       (Hetzner VPS)│
│  Bots · conversations · ToolLoopAgent · sandbox lifecycle │
│  RFB proxy + recording tee · skill compiler · routines    │
│  Postgres · Redis · BullMQ · AI SDK 7 · MCP registry      │
└──────────┬──────────────────────────────┬─────────────────┘
           │ HarnessV1SandboxProvider     │ AI SDK provider
           │ (Docker impl, local socket)  │ + MCP clients (HTTPS)
┌──────────▼──────────────────┐  ┌────────▼──────────────────┐
│ Bot sandboxes — Docker      │  │ Inference + MCP servers   │
│ Xvfb · XFCE · Chrome (CDP)  │  │ @ai-sdk/openai-compatible │
│ Thunar · xterm · x11vnc     │  │ Gmail · Calendar · Notion │
│ at-spi2 · xdotool · bridge  │  └───────────────────────────┘
└─────────────────────────────┘
```

### 2.2 Hard architectural rules

- **R1 — Electron contains zero orchestration logic.** No agent loop, no model calls, no Docker access, no database. It speaks HTTP and WebSocket only, even in local development.
- **R2 — Sandbox access goes through `HarnessV1SandboxProvider` from `@ai-sdk/harness`.** The v1 implementation is `DockerSandboxProvider`. No code outside that class may import `dockerode`.
- **R3 — Model access goes through the AI SDK's provider abstraction.** Never call a provider HTTP API directly. Switching endpoints is a config change.
- **R4 — Tools receive `session.restricted()`, never the full network session.** A tool must not be able to call `destroy()`, `setNetworkPolicy()`, or `setPorts()`.
- **R5 — The bot container never receives the Docker socket, arbitrary host filesystem mounts, or orchestrator credentials. D-031 permits only provider-managed workspace storage** (owned by the computer rather than by one bot since D-046; the mechanism — a named volume, never a host path — is unchanged).
- **R6 — Input events flowing to a sandbox pass through the orchestrator.** This is what makes recording possible without a screen-recording pipeline. The client never connects to a sandbox's VNC port directly.
- **R7 — Every request resolves to a `Principal` before reaching a handler.** In v1 the guard returns a hardcoded singleton principal, but handlers read `principal.userId` rather than assuming a single user. See §4.4.
- **R8 — Every sandbox has a fixed framebuffer resolution for its entire lifetime.** Never renegotiate. The client scales the image; the server does not resize the display.
- **R9 — Agent turns checkpoint after every step.** See §6/M5. This is the mitigation for choosing BullMQ over durable execution.
- **R10 — MCP clients run in the orchestrator, never in a sandbox.** Plugin credentials must never enter a bot container. MCP tools join the same registry as built-in tools and pass through the same approval rules.

### 2.3 Stack

| Layer | Choice | Notes |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | |
| Orchestrator | NestJS 11, TypeScript strict | |
| Model + agent layer | AI SDK 7 (`ai`, `@ai-sdk/openai-compatible`, `@ai-sdk/harness`) | |
| ORM | Prisma | migrations checked into repo |
| Database | PostgreSQL 16 | |
| Queue / cache | Redis 7 + BullMQ | routines, inter-bot delivery, skill compilation |
| Sandbox control | dockerode, wrapped in `DockerSandboxProvider` | |
| Desktop client | Electron 32 + React 19 + Vite | |
| UI components | HeroUI v3 (pin 3.2.x) + Tailwind CSS v4 + React Aria | Pro license for the Chat template and Sidebar |
| VNC client | `@novnc/novnc` RFB module in the renderer | |
| Browser automation | Playwright (replay) + raw CDP (capture) | |
| Auth | static bearer token behind an `AuthGuard` | better-auth deferred, see §2.5 |
| Tests | Vitest, Testcontainers, Playwright | |
| Deploy | Docker Compose behind Dokploy/Traefik | |

### 2.4 Repository layout

```
agent-desktop/
├─ apps/
│  ├─ orchestrator/          NestJS service
│  └─ desktop/               Electron + React client
├─ packages/
│  ├─ shared/                Zod schemas + TS types shared by both apps
│  ├─ sandbox-docker/        DockerSandboxProvider (HarnessV1SandboxProvider impl)
│  └─ skill-runtime/         Skill script executor, shipped into the sandbox
├─ infra/
│  ├─ sandbox-image/         Dockerfile + entrypoint + agent-bridge
│  └─ compose/               docker-compose.yml, .env.example
└─ docs/
   └─ PRD.md                 this file
```

### 2.5 Decisions and rejected alternatives

Recorded so the implementing agent does not relitigate them.

**AI SDK 7 — adopted.** It provides the unified provider abstraction, `ToolLoopAgent` with `stopWhen` stop conditions, first-class tool execution approval, `prepareStep` for per-step context and model control, typed runtime context, and a two-tier sandbox abstraction. Everything in that list was hand-specified in revision 1 of this PRD and has been deleted.

**Sandbox layer — use the harness abstraction, not a bespoke interface.** Revision 1 assumed AI SDK sandboxes were ephemeral code-exec environments and specified a custom `SandboxProvider`. That was wrong. The abstraction has two tiers: `Experimental_SandboxSession` (files and processes only, silent on lifecycle) and `HarnessV1NetworkSandboxSession`, which adds `id`, `ports`, `getPortUrl()`, `stop()`, `destroy()`, `setNetworkPolicy()`, `setPorts()`, and `restricted()`. The provider exposes `createSession()` and `resumeSession()`, and the documented use cases explicitly include persistent and resumable sandbox resources. The reference implementation in the AI SDK repo is itself a `DockerSandboxProvider`. This fits a long-lived VNC desktop directly.

Caveats the agent must respect:
- These types carry `Experimental_` and `harness-sandbox-v1` markers. Pin the AI SDK version and treat the interface as churn-prone. Everything downstream of `DockerSandboxProvider` should depend on our own thin re-export, so an upstream rename is a one-file fix.
- **Do not use `HarnessAgent`.** It exists to run packaged coding harnesses (Claude Code, Codex) inside a sandbox. We want `ToolLoopAgent` with our own tools. Use the sandbox provider layer only.
- The abstraction has no screenshot capture and no accessibility-event stream. Those stay in `agent-bridge` (§5.2).
- RFB proxying, the input tee, and fixed framebuffer resolution are entirely ours. The provider only gets us the port.

**Workflow DevKit — rejected for v1, revisit at v2.** It is genuinely self-hostable: workflows run on pluggable World adapters, and `WORKFLOW_TARGET_WORLD=@workflow/world-postgres` covers self-hosting. The real case for it is that a 10-minute agent turn across 25 tool calls dies on deploy, and BullMQ restarts the job from zero where durable execution would replay and resume. Its `waitForEvent` also maps neatly onto approval gating.

It is still rejected for v1 because it means two execution models in one codebase plus a `"use workflow"` build transform to reconcile with NestJS, and because self-hosted deployment gives up the Vercel dashboard observability that is most of its polish. The compensating requirement is R9: checkpoint every completed agent step so a restart preserves the record and marks unfinished turns INTERRUPTED. Automatic turn resumption is not required in v1 (D-032). Revisit only if interrupted turns prove painful in real use.

**Hermes and self-hosted weights — dropped.** The project needs a strong tool-calling model, not a specific one. Self-hosting open weights pays off only for zero marginal cost at volume or hard data isolation, neither of which applies. A separate vision-grounding model is also no longer a core dependency: once M4 lands, most actions are CDP selector-based and vision is a fallback for rare non-browser steps.

**HeroUI v3 — adopted as the UI foundation, including the chat surface.** v3 is a ground-up rewrite on React 19, Tailwind v4, and React Aria Components, stable and Apache 2.0. Revision 2 scoped it to "supporting cast only" and told the agent to hand-build the transcript and sidebar. That was written against a v2 mental model and is now reversed: v3 plus the Pro Chat template already covers the conversation shell, prompt input with attachment and model-picker affordances, attachment chips, and a source-disclosure pattern, and the Pro Sidebar covers the bot list. Start from those and adapt. Hand-building them would be slower and worse.

The Pro tier is a paid license (47 components, four templates: Dashboard, Mail, Chat, Finances). The core library is free; the Chat template and Sidebar are not. Confirm the license is in place before M1 rather than discovering it mid-milestone.

Two things HeroUI does not give you, and the agent should not go looking:
- **The VNC canvas.** That is an RFB client bound to a `<canvas>` with input-event forwarding. No component library addresses it. It sits inside a HeroUI layout, but the surface itself is ours (§4.3).
- **Message part renderers.** The template handles text bubbles, attachments, and sources. It knows nothing about AI SDK tool-call parts, tool results, approval prompts, inter-bot attribution, or interrupted-turn markers. Those are custom renderers plugged into the template's message slot — not a reason to abandon the template.

**Use the HeroUI MCP server.** HeroUI ships an MCP server carrying version-matched component docs for AI coding assistants, and Pro adds agent skills with usage patterns and design principles. The implementing agent should connect it rather than recalling component APIs from training data, which for a library this new will be wrong.

**MCP plugins — promoted to v1 (M6), not deferred.** Revision 2 listed this under v2. That was wrong. A bot whose only tools are browser, shell, and filesystem can reach a service exactly one way: by driving its web UI through Chrome. That is slower, more brittle, and far more token-expensive than a structured API call, and it makes the whole product feel like a demo. Outbound sales work needs mail, calendar, and CRM as first-class tools. AI SDK 7 ships full MCP support, so the client itself is cheap.

Three constraints the agent must respect:
- **Orchestrator-side only (R10).** Credentials never enter a sandbox.
- **Remote HTTP and SSE transports only in v1.** `stdio` servers mean running arbitrary third-party processes; if one becomes necessary later it runs in its own container, never in the orchestrator process.
- **The real cost is OAuth, not MCP.** Initiating a flow from Electron, handling the redirect, encrypting tokens at rest, refreshing before expiry, and surfacing a clear reconnect state when refresh fails is the bulk of M6. Size the milestone on that, not on the client.

**better-auth — deferred, boundary installed now.** v1 has one operator; a static bearer token in the OS keychain is adequate and is about twenty lines. better-auth is session- and cookie-oriented, which is an awkward fit for an Electron client that wants bearer tokens anyway, and it would add tables and an adapter for zero present benefit. The cost of deferring is real but bounded, and R7 pays it down: every handler already reads `principal.userId`, so adopting better-auth later is one guard implementation swap rather than a sweep across every endpoint. When the time comes, evaluate its API-key plugin (rotation and revocation for the desktop client) against plain sessions; check current docs, since the library moves quickly.

---

## 3. Data model

Prisma schema. Field names are contractual.

```prisma
model User {
  id        String   @id @default(cuid())
  email     String?  @unique
  createdAt DateTime @default(now())
  bots      Bot[]
}
// v1 seeds exactly one User row. Do not remove this table; R7 depends on it.

model Bot {
  id            String   @id @default(cuid())
  userId        String
  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  name          String                       // "Quill"
  role          String                       // "Outbound Writer"
  avatarColor   String                       // hex, e.g. "#8B6F47"
  systemPrompt  String   @db.Text
  modelId       String   @default("default") // key into the AI SDK provider registry
  status        BotStatus @default(IDLE)
  sortOrder     Int      @default(0)
  pinned        Boolean  @default(false)
  hiddenFromSidebar Boolean @default(false)
  approvalMode  ApprovalMode @default(AUTO) // D-144: ASK | AUTO | FULL
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  sandboxId     String?                      // D-046: the computer this bot works on
  sandbox       Sandbox? @relation(fields: [sandboxId], references: [id], onDelete: SetNull)
  groupId       String?                      // D-131: its sidebar group; null is Unassigned
  group         BotGroup? @relation(fields: [groupId], references: [id], onDelete: SetNull)
  conversation  Conversation?
  skills        Skill[]
  routines      Routine[]
  recordings    Recording[]
  turns         AgentTurn[]
  mcpServers    BotMcpServer[]
}

enum BotStatus { IDLE THINKING ACTING AWAITING_APPROVAL ERROR }

// D-131: a named set of bots. Shares `instructions` (read into every member's
// prompt) and a folder, /home/bot/groups/<id>. Never a role or a chain of command.
model BotGroup {
  id           String   @id @default(cuid())
  userId       String
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  name         String
  instructions String   @default("") @db.Text
  sortOrder    Int      @default(0)
  collapsed    Boolean  @default(false)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  bots         Bot[]
}

model Conversation {
  id         String    @id @default(cuid())
  botId      String    @unique
  bot        Bot       @relation(fields: [botId], references: [id], onDelete: Cascade)
  createdAt  DateTime  @default(now())
  lastReadAt DateTime? // D-131: BOT messages after this are unread
  messages   Message[]
}

model Message {
  id             String   @id @default(cuid())
  conversationId String
  conversation   Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  author         MessageAuthor
  fromBotId      String?                     // set when author = BOT
  content        String   @db.Text
  parts          Json?                       // AI SDK message parts, verbatim
  chainId        String?                     // inter-bot conversation chain
  hopCount       Int      @default(0)
  taskId         String?                     // D-133: the task this message is about (Start brief, delegated work)
  routineId      String?                     // D-136: the routine that posted it; filing rule 3
  startsTopic    Boolean  @default(false)    // D-147: a `/new` boundary; history is seeded from the newest one
  createdAt      DateTime @default(now())

  attachments    Attachment[]
  @@index([conversationId, createdAt])
}

enum MessageAuthor { USER BOT SYSTEM TOOL }

model Attachment {
  id         String  @id @default(cuid())
  messageId  String
  message    Message @relation(fields: [messageId], references: [id], onDelete: Cascade)
  filename   String
  mimeType   String
  sizeBytes  Int
  storageKey String                          // key in the artifact store: R2, or ARTIFACT_DIR (D-220)
}

// R9: one row per completed agent step, written before the next step starts.
model AgentTurn {
  id            String   @id @default(cuid())
  botId         String
  bot           Bot      @relation(fields: [botId], references: [id], onDelete: Cascade)
  triggerMessageId String
  status        TurnStatus @default(RUNNING)
  stepIndex     Int      @default(0)
  steps         Json     @default("[]")      // array of completed AI SDK step results
  inputTokens   Int      @default(0)
  outputTokens  Int      @default(0)
  startedAt     DateTime @default(now())
  endedAt       DateTime?
  stopReason    String?
  @@index([botId, startedAt])
}

enum TurnStatus { RUNNING AWAITING_APPROVAL SUCCEEDED FAILED CANCELLED INTERRUPTED }

// D-046: the computer. Shared by the bots attached to it, one per user by
// default. `id` is also the workspace key — `crewaid-workspace-<id>` — which a
// migrated machine inherits from the bot that used to own it, so no operator's
// volume is renamed.
model Sandbox {
  id           String  @id @default(cuid())
  userId       String                        // was botId @unique before D-046
  user         User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  sessionId    String?                       // harness session id, used for resumeSession
  containerId  String?
  state        SandboxState @default(STOPPED)
  widthPx      Int     @default(1280)
  heightPx     Int     @default(800)
  vncPort      Int?
  cdpPort      Int?
  bridgePort   Int?
  lastStartedAt DateTime?
  lastError    String? @db.Text
}

enum SandboxState { STOPPED STARTING RUNNING UNHEALTHY ERROR }

model Recording {
  id          String   @id @default(cuid())
  botId       String
  bot         Bot      @relation(fields: [botId], references: [id], onDelete: Cascade)
  state       RecordingState @default(RECORDING)
  intent      String?  @db.Text
  cdpAvailable Boolean @default(true)
  startedAt   DateTime @default(now())
  endedAt     DateTime?
  events      RecordingEvent[]
  skill       Skill?
}

enum RecordingState { RECORDING COMPILING READY FAILED DISCARDED }

model RecordingEvent {
  id          String   @id @default(cuid())
  recordingId String
  recording   Recording @relation(fields: [recordingId], references: [id], onDelete: Cascade)
  tsOffsetMs  Int
  layer       CaptureLayer
  type        String                         // "click" | "type" | "navigate" | "input" | ...
  payload     Json
  screenshotKey String?                      // set on X11 clicks only
  correlatedWithId String?                   // set by the M4 correlator
  @@index([recordingId, tsOffsetMs])
}

enum CaptureLayer { X11 CDP ATSPI }

model Skill {
  id            String  @id @default(cuid())
  botId         String?                      // null = available to all bots
  bot           Bot?    @relation(fields: [botId], references: [id], onDelete: SetNull)
  name          String                       // snake_case
  description   String  @db.Text
  paramsSchema  Json                         // JSON Schema for the skill's arguments
  script        String  @db.Text             // TypeScript module source
  version       Int     @default(1)
  status        SkillStatus @default(DRAFT)
  sourceRecordingId String? @unique
  sourceRecording   Recording? @relation(fields: [sourceRecordingId], references: [id])
  createdAt     DateTime @default(now())
  runs          SkillRun[]
  @@unique([botId, name, version])
}

enum SkillStatus { DRAFT APPROVED ARCHIVED }

model SkillRun {
  id        String   @id @default(cuid())
  skillId   String
  skill     Skill    @relation(fields: [skillId], references: [id], onDelete: Cascade)
  params    Json
  status    RunStatus @default(PENDING)
  logs      String?  @db.Text
  error     String?  @db.Text
  startedAt DateTime?
  endedAt   DateTime?
}

enum RunStatus { PENDING RUNNING SUCCEEDED FAILED CANCELLED }

model McpServer {
  id          String   @id @default(cuid())
  userId      String
  name        String                          // "Gmail"
  slug        String                          // "gmail" — used for tool namespacing
  category    String?                         // "Inbox And Collaboration"
  iconUrl     String?
  transport   McpTransport @default(HTTP)
  url         String
  isPrivate   Boolean  @default(false)        // user-added by URL vs directory entry
  authType    McpAuthType @default(OAUTH2)
  status      McpStatus @default(DISCONNECTED)
  lastError   String?  @db.Text
  createdAt   DateTime @default(now())

  credential  McpCredential?
  tools       McpTool[]
  bots        BotMcpServer[]
  @@unique([userId, slug])
}

enum McpTransport { HTTP SSE }
enum McpAuthType { NONE OAUTH2 HEADER }
enum McpStatus { DISCONNECTED CONNECTING CONNECTED NEEDS_REAUTH ERROR }

// Both token columns are encrypted at rest with CREDENTIAL_KEY before they
// reach Prisma. Never log, never return over the API, never pass to a sandbox.
model McpCredential {
  id           String    @id @default(cuid())
  serverId     String    @unique
  server       McpServer @relation(fields: [serverId], references: [id], onDelete: Cascade)
  accessToken  String    @db.Text
  refreshToken String?   @db.Text
  expiresAt    DateTime?
  scopes       String[]
  updatedAt    DateTime  @updatedAt
}

model McpTool {
  id          String   @id @default(cuid())
  serverId    String
  server      McpServer @relation(fields: [serverId], references: [id], onDelete: Cascade)
  name        String                          // as reported by the server
  description String   @db.Text
  inputSchema Json
  readOnly    Boolean  @default(false)        // classified at list time, see M6
  refreshedAt DateTime @default(now())
  @@unique([serverId, name])
}

model BotMcpServer {
  botId    String
  bot      Bot       @relation(fields: [botId], references: [id], onDelete: Cascade)
  serverId String
  server   McpServer @relation(fields: [serverId], references: [id], onDelete: Cascade)
  enabled  Boolean   @default(true)
  @@id([botId, serverId])
}

model Routine {
  id         String   @id @default(cuid())
  botId      String
  bot        Bot      @relation(fields: [botId], references: [id], onDelete: Cascade)
  name       String
  cron       String                          // 5-field cron
  timezone   String   @default("America/Port-au-Prince")
  prompt     String?  @db.Text               // exactly one of prompt or skillId
  skillId    String?
  skillParams Json?
  enabled    Boolean  @default(true)
  lastRunAt  DateTime?
  lastStatus RunStatus?
  goalId     String?                         // D-133: the goal it works toward (SetNull)
}
```

### 3.1 Work (M10, D-133)

Projects, goals, tasks, recurring series, the activity log and deliverables, as ratified from
`docs/PRD-WORK.md` §4. Every model carries `userId` for R7. Inverse relations on `User`, `Bot`,
`Message`, `Attachment` and `Routine` are omitted here as they are above.

```prisma
model Project {
  id          String        @id @default(cuid())
  userId      String
  user        User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  name        String
  description String?       @db.Text
  color       String        // hex, same vocabulary as Bot.avatarColor
  status      ProjectStatus @default(ACTIVE)
  sortOrder   Int           @default(0)
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt
  goals       Goal[]
  tasks       Task[]
  series      TaskSeries[]
  @@index([userId, status])
}

enum ProjectStatus { ACTIVE ARCHIVED }

model Goal {
  id          String     @id @default(cuid())
  userId      String
  user        User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  projectId   String?
  project     Project?   @relation(fields: [projectId], references: [id], onDelete: Restrict)
  title       String
  outcome     String?    @db.Text
  targetOn    String?    @db.VarChar(10)   // calendar date, same shape as Routine.endsOn
  status      GoalStatus @default(ACTIVE)
  closedAt    DateTime?
  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt
  tasks       Task[]
  series      TaskSeries[]
  routines    Routine[]
  @@index([userId, status])
}

enum GoalStatus { ACTIVE ACHIEVED ABANDONED }

model Task {
  id             String     @id @default(cuid())
  userId         String
  user           User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  projectId      String?    // null = Inbox
  project        Project?   @relation(fields: [projectId], references: [id], onDelete: Restrict)
  goalId         String?
  goal           Goal?      @relation(fields: [goalId], references: [id], onDelete: SetNull)
  parentId       String?    // one level: a parent's parentId is always null (service-enforced)
  parent         Task?      @relation("Subtasks", fields: [parentId], references: [id], onDelete: Cascade)
  subtasks       Task[]     @relation("Subtasks")
  title          String
  brief          String?    @db.Text
  status         TaskStatus @default(TODO)
  blockedReason  String?    @db.Text
  assigneeBotId  String?
  assigneeBot    Bot?       @relation("TaskAssignee", fields: [assigneeBotId], references: [id], onDelete: SetNull)
  origin         TaskOrigin @default(OPERATOR)   // who created it; mirrors Routine.origin (D-125)
  seriesId       String?    // set on an occurrence; SetNull if the series is deleted
  series         TaskSeries? @relation(fields: [seriesId], references: [id], onDelete: SetNull)
  occursAt       DateTime?  // scheduled instant: retry identity, including hourly/minute repeats
  occursOn       String?    @db.VarChar(10) // local date for display and date-range queries
  createdByBotId String?
  dueOn          String?    @db.VarChar(10)
  rank           String     // lexicographic order within a column; a drag is one row write
  startedAt      DateTime?
  completedAt    DateTime?
  createdAt      DateTime   @default(now())
  updatedAt      DateTime   @updatedAt
  events         TaskEvent[]
  deliverables   Deliverable[]
  messages       Message[]
  @@index([userId, status])
  @@index([assigneeBotId, status])
  @@index([parentId])
  @@index([goalId])
  @@unique([seriesId, occursAt])   // one occurrence per scheduled firing, however often retried
  @@index([userId, goalId, occursOn])
}

enum TaskStatus { TODO IN_PROGRESS BLOCKED IN_REVIEW DONE CANCELLED }

/// §3.6 — a task that comes back. Each firing creates one Task with seriesId set.
model TaskSeries {
  id            String   @id @default(cuid())
  userId        String
  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  title         String
  brief         String?  @db.Text
  assigneeBotId String?  // SetNull
  assigneeBot   Bot?     @relation("SeriesAssignee", fields: [assigneeBotId], references: [id], onDelete: SetNull)
  projectId     String?
  project       Project? @relation(fields: [projectId], references: [id], onDelete: Restrict)
  goalId        String?  // SetNull
  goal          Goal?    @relation(fields: [goalId], references: [id], onDelete: SetNull)
  cron          String   // same CronSchema/TimezoneSchema as Routine
  timezone      String
  endsOn        String?  @db.VarChar(10)
  enabled       Boolean  @default(true)
  lastFiredAt   DateTime?
  origin        TaskOrigin @default(OPERATOR)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  occurrences   Task[]
  @@index([userId, enabled])
  @@index([goalId])
}
enum TaskOrigin { OPERATOR BOT }

/// "Who did what, when." Append-only.
model TaskEvent {
  id          String        @id @default(cuid())
  taskId      String
  task        Task          @relation(fields: [taskId], references: [id], onDelete: Cascade)
  userId      String
  user        User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  actor       TaskActor
  actorBotId  String?       // SetNull: history outlives the bot
  actorLabel  String        // name at the time, so a deleted bot still reads "Backend"
  type        TaskEventType
  payload     Json          // e.g. {from, to} for STATUS_CHANGED; validated by a shared schema
  startKey    String?       // STARTED only; identifies retries even after status changes
  messageId   String?       // BOT reply for a tool edit, Start brief for STARTED; null for board edits
  message     Message?      @relation(fields: [messageId], references: [id], onDelete: SetNull)
  createdAt   DateTime      @default(now())
  @@index([taskId, createdAt])
  @@unique([userId, startKey])
}

enum TaskActor { USER BOT }
enum TaskEventType { CREATED EDITED ASSIGNED UNASSIGNED STARTED STATUS_CHANGED NOTE DELIVERABLE_LINKED }

model Deliverable {
  id           String          @id @default(cuid())
  userId       String
  user         User            @relation(fields: [userId], references: [id], onDelete: Cascade)
  kind         DeliverableKind
  title        String
  summary      String?         @db.Text
  botId        String?         // producer. Cascade: a deleted bot takes its deliverables (§9.4)
  bot          Bot?            @relation(fields: [botId], references: [id], onDelete: Cascade)
  attachmentId String?         @unique   // Cascade: the record goes with its file
  attachment   Attachment?     @relation(fields: [attachmentId], references: [id], onDelete: Cascade)
  messageId    String?         // Cascade, for the same reason
  message      Message?        @relation(fields: [messageId], references: [id], onDelete: Cascade)
  url          String?
  sourcePath   String?         // where in the workspace the file was attached from
  taskId       String?
  task         Task?           @relation(fields: [taskId], references: [id], onDelete: SetNull)
  goalId       String?
  goal         Goal?           @relation(fields: [goalId], references: [id], onDelete: SetNull)
  projectId    String?         // denormalised from task/goal (§3.5)
  project      Project?        @relation(fields: [projectId], references: [id], onDelete: SetNull)
  searchText   String?         @db.Text   // P1: bounded extract of a text-like file
  createdAt    DateTime        @default(now())
  @@index([userId, createdAt])
  @@index([taskId])
  @@index([goalId])
  @@index([projectId])
}

enum DeliverableKind { FILE LINK MESSAGE }
```

---

## 4. Interface contracts

### 4.1 REST (all under `/api/v1`, all responses JSON)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/bots` | list bots with sandbox state and `unreadCount` (D-131) |
| `POST` | `/bots` | create bot `{name, role, avatarColor, systemPrompt, modelId?}` |
| `PATCH` | `/bots/:id` | update profile fields, rules and `approvalMode` (D-144) |
| `DELETE` | `/bots/:id` | delete bot, cascade sandbox teardown |
| `POST` | `/bots/:id/duplicate` | clone profile and skills, not history |
| `POST` | `/bots/:id/read` | D-131: mark read, or `{unread: true}` for the newest bot message → `{unreadCount}` |
| `GET` | `/groups` | D-131: the user's bot groups, sidebar order |
| `POST` | `/groups` | `{name, instructions?}` |
| `PATCH` | `/groups/:id` | `{name?, instructions?, sortOrder?, collapsed?}` |
| `DELETE` | `/groups/:id` | members move to Unassigned; no bot is deleted |
| `GET` | `/bots/:id/messages?before=&around=&limit=` | paginated history, newest first; `around` centres on a message (D-134) |
| `POST` | `/bots/:id/messages` | send user message `{content, attachmentIds?}` |
| `DELETE` | `/bots/:id/messages?forget=` | clear the chat; `forget=true` also forgets what was learned from it (D-147) |
| `DELETE` | `/bots/:id/messages/:messageId?forget=` | delete one message, same `forget` (D-147) |
| `POST` | `/bots/:id/topics` | `/new`: start a new topic, no model call (D-147) |
| `GET` | `/bots/:id/turns?limit=` | recent agent turns with step counts and token usage |
| `POST` | `/bots/:id/sandbox/start` | idempotent; resumes by `sessionId` when present |
| `POST` | `/bots/:id/sandbox/stop` | idempotent |
| `GET` | `/bots/:id/sandbox` | state + resolution |
| `POST` | `/bots/:id/recordings` | start recording `{intent?}` → `{recordingId}` |
| `POST` | `/recordings/:id/stop` | stop and enqueue compilation |
| `POST` | `/recordings/:id/discard` | |
| `GET` | `/recordings/:id` | state, event counts by layer, generated skill id |
| `GET` | `/skills?botId=` | |
| `GET` | `/skills/:id` | includes script source |
| `PATCH` | `/skills/:id` | edit script, description, paramsSchema — bumps version |
| `POST` | `/skills/:id/approve` | DRAFT → APPROVED |
| `POST` | `/skills/:id/run` | `{params}` → `{runId}` |
| `GET` | `/skills/:id/runs/:runId` | |
| `GET` | `/mcp/directory` | curated catalog: name, slug, category, icon, auth type |
| `GET` | `/mcp/servers` | installed servers with status and tool counts |
| `POST` | `/mcp/servers` | install from directory `{slug}` or private `{name, url, transport}` |
| `DELETE` | `/mcp/servers/:id` | uninstall, revoke credential, detach from all bots |
| `POST` | `/mcp/servers/:id/connect` | → `{authorizeUrl}` for OAuth, or connects directly |
| `POST` | `/mcp/servers/:id/refresh-tools` | re-list tools, update `McpTool` cache |
| `GET` | `/mcp/oauth/callback` | redirect target; exchanges code, stores credential |
| `GET` | `/bots/:id/plugins` | enabled servers for this bot, with resolved tool count |
| `PUT` | `/bots/:id/plugins` | `{serverIds: string[]}` — replaces the set; no size limit (D-113) |
| `GET`/`POST`/`PATCH`/`DELETE` | `/routines` | CRUD; bodies accept `goalId` (D-134) |
| `POST` | `/routines/:id/run-now` | |
| `GET` | `/projects?status=` | D-134: list, with open-task and goal counts |
| `POST` | `/projects` | `{name, description?, color}` |
| `PATCH` | `/projects/:id` | edit; `{status: 'ARCHIVED'}` archives |
| `DELETE` | `/projects/:id` | `409 PROJECT_NOT_EMPTY` unless it holds nothing |
| `GET` | `/tasks?projectId=&inbox=&goalId=&assigneeBotId=&status=&parentId=&seriesId=&occursFrom=&occursThrough=&doneSince=` | D-134: top-level only unless `parentId` is given; `doneSince` bounds the Done column |
| `POST` | `/tasks` | `{title, brief?, projectId?, goalId?, parentId?, assigneeBotId?, dueOn?, repeat?}`; never starts a turn |
| `GET` | `/tasks/:id` | with subtasks, newest 100 events, deliverables, `usage` (D-141) |
| `PATCH` | `/tasks/:id` | fields, status, assignee, `rank` |
| `DELETE` | `/tasks/:id` | cascades subtasks and events; deliverables are unfiled |
| `POST` | `/tasks/:id/start` | D-135: `Idempotency-Key` required → `202 {messageId}` |
| `POST` | `/tasks/:id/notes` | `{text}` → a `NOTE` event |
| `GET` | `/task-series/:id` | D-137: the series with its recent occurrences |
| `PATCH` | `/task-series/:id` | edits future occurrences; `enabled: false` stops it |
| `DELETE` | `/task-series/:id` | stops it; occurrences stay |
| `GET` | `/goals?status=&projectId=` | with derived progress and done rates |
| `POST` | `/goals` | `{title, outcome?, targetOn?, projectId?}` |
| `GET` | `/goals/:id` | tasks, series, routines, deliverables, progress, `usage` (D-141) |
| `PATCH` | `/goals/:id` | fields, status |
| `DELETE` | `/goals/:id` | unlinks tasks, series and routines |
| `GET` | `/deliverables?projectId=&goalId=&taskId=&botId=&kind=&unfiled=&q=&before=&limit=` | D-136: newest first, `{items, nextCursor}`; `q` per D-142 |
| `POST` | `/deliverables` | P1: `{kind: 'LINK', url, title}` or `{kind: 'MESSAGE', messageId, title}` |
| `PATCH` | `/deliverables/:id` | title, summary, re-file |
| `DELETE` | `/deliverables/:id` | removes the record; the attachment stays |
| `GET` | `/search?q=&types=&botId=&projectId=&limit=` | D-139: grouped hits with excerpts |
| `GET` | `/usage?from=&to=` | token spend per bot per day |
| `GET` | `/memory?botId=&includeInactive=` | what a user's bots know, read-only (added by D-080) |
| `GET` | `/attachments/:id/download` | streams file |
| `GET` | `/health` | `{status, db, redis, docker, sandboxes}` |

### 4.2 WebSocket

Single endpoint: `wss://<host>/ws?token=<ORCH_API_TOKEN>`.

```ts
type WsFrame = {
  id: string;          // uuid, for correlating request/response
  type: string;
  botId?: string;
  ts: number;          // epoch ms
  payload: unknown;
};
```

**Server → client:**

| `type` | Payload |
|---|---|
| `message.created` | full `Message` with attachments |
| `message.delta` | `{messageId, chunk}` — text streaming |
| `message.part` | `{messageId, part}` — AI SDK message part (tool call, tool result, reasoning) |
| `message.completed` | `{messageId, stopReason}` |
| `message.deleted` | `{botId, messageIds, cleared?: true}` — D-147; `cleared` drops the whole history |
| `bot.status` | `{botId, status: BotStatus}` |
| `turn.step` | `{botId, turnId, stepIndex, toolName?}` |
| `sandbox.state` | `{botId, state, widthPx, heightPx}` |
| `screen.frame` | binary RFB payload (see 4.3) |
| `recording.event` | `{recordingId, layer, type, counts: {x11, cdp}}` |
| `recording.state` | `{recordingId, state}` |
| `skill.compiled` | `{recordingId, skillId, name}` |
| `approval.requested` | `{botId, turnId, toolCallId, toolName, args}` |
| `mcp.status` | `{serverId, status: McpStatus, toolCount, lastError?}` |
| `task.changed` | `{taskId, deleted?: true}` — D-134 invalidation, client only |
| `project.changed` | `{projectId, deleted?: true}` |
| `goal.changed` | `{goalId, deleted?: true}` |
| `deliverable.changed` | `{deliverableId, deleted?: true}` |
| `error` | `{code, message, detail?}` |

**Client → server:**

| `type` | Payload |
|---|---|
| `screen.subscribe` | `{botId, quality: 0..9}` |
| `screen.unsubscribe` | `{botId}` |
| `screen.input` | binary RFB client message (see 4.3) |
| `approval.respond` | `{toolCallId, approved: boolean, reason?}` |
| `bot.cancel` | `{botId}` — abort the current agent turn |

### 4.3 Screen transport

The orchestrator holds one RFB connection per running sandbox to `x11vnc`, reached via `session.getPortUrl({ port: 5900 })`. It multiplexes:

- **Outbound:** raw RFB server messages forwarded to every subscribed client as binary WS frames. No transcoding. `tight` encoding at the client-requested quality.
- **Inbound:** `screen.input` frames validated as well-formed `PointerEvent` (type 5) or `KeyEvent` (type 4), then forwarded.

**The tee:** if the bot has an active `Recording`, every validated inbound event is *also* written to the recording pipeline (§6/M3) before being forwarded. This is the entire recorder. Do not build a video capture path.

With no subscribers, do not read the framebuffer faster than a 1 fps keepalive.

### 4.4 Auth boundary (R7)

```ts
interface Principal {
  userId: string;
  scopes: string[];      // v1: ['*']
}

// v1 implementation: validate the static bearer token, then return the singleton.
// Handlers MUST scope queries by principal.userId. Never query Bot without it.
```

Every REST route except `/health` and every WS connection passes through `AuthGuard`. No handler may read `req.headers.authorization` directly.

---

## 5. The sandbox image

`infra/sandbox-image/Dockerfile`. A specification — package names may be adjusted to make the build succeed, but every capability must survive.

```dockerfile
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:1 \
    SCREEN_WIDTH=1280 \
    SCREEN_HEIGHT=800 \
    SCREEN_DEPTH=24

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc xfce4-session xfwm4 xfdesktop4 thunar xfce4-terminal \
      plank at-spi2-core dbus-x11 xdotool wmctrl scrot \
      fonts-dejavu-core ca-certificates curl gnupg python3 python3-pyatspi \
    && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
       | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] \
       http://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash bot
WORKDIR /home/bot
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY agent-bridge/ /opt/agent-bridge/
RUN chmod +x /usr/local/bin/entrypoint.sh

USER bot
EXPOSE 5900 9222 7070
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

`entrypoint.sh` starts and supervises, in order:

1. `dbus-daemon --session` (required for AT-SPI).
2. `Xvfb :1 -screen 0 ${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH} -nolisten tcp` — **no `-resize`, no RANDR resolution changes** (R8).
3. `xfce4-session` with the panel disabled and `plank` as the dock.
4. `google-chrome --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 --no-first-run --no-default-browser-check --disable-dev-shm-usage --user-data-dir=/home/bot/.chrome`.
5. `x11vnc -display :1 -forever -shared -nopw -rfbport 5900 -noxdamage`.
6. `agent-bridge` on port 7070.

If any supervised process exits, the entrypoint exits non-zero so Docker marks the container unhealthy.

### 5.1 Container runtime constraints

Applied by `DockerSandboxProvider` at `createSession()`:

```
memory:        2g          (hard limit)
memory_swap:   2g          (disable swap)
cpus:          1.0
pids_limit:    512
security_opt:  no-new-privileges
cap_drop:      ALL
network:       agent-net   (user-defined bridge; see §7.3)
tmpfs:         /dev/shm:size=512m
restart:       no
```

D-031 permits narrowly scoped provider-managed workspace and browser-profile storage; arbitrary host mounts remain forbidden. Files can also be retrieved through `readFile()`. Stop/start and supported image replacement must preserve the saved workspace. Live processes need not survive stopping. Specify paths, ownership, retention, and migration before implementing storage.

### 5.2 `agent-bridge` (reduced scope)

Most of what revision 1 put here is now covered by `Experimental_SandboxSession` (`readFile`, `writeFile`, `run`, `spawn`). The bridge keeps only what the harness abstraction does not provide:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | X display up, Chrome CDP reachable, AT-SPI bus up |
| `GET` | `/screenshot` | PNG of the current display |
| `GET` | `/atspi/events` | SSE stream of AT-SPI accessibility events (unused in v1, see §9) |
| `POST` | `/skill/run` | run a compiled skill module with params |
| `GET` | `/seats` | list the machine's seats (D-046); `?botId=` answers that bot's own seat, `404 NO_SUCH_SEAT` when it has none |
| `POST` | `/seats` | create a seat, with optional `botId`, `url`, `width`, `height`, `left`, `top` |
| `POST` | `/seats/<seatId>/close` | close a seat, its window and its RFB stream |

Reachable only from the orchestrator on the internal network.

---

## 6. Milestones

### M0 — Repo skeleton and CI

**Scope**

pnpm workspace, Turborepo pipeline, TypeScript strict everywhere, ESLint + Prettier, Vitest in both apps, `packages/shared` exporting Zod schemas for every type in §3 and §4, Docker Compose with Postgres + Redis, Prisma schema from §3 with an initial migration seeding one `User`, GitHub Actions running lint + typecheck + test.

**Acceptance criteria**

- `pnpm install && pnpm build && pnpm test && pnpm lint` all exit 0 from a clean clone.
- `docker compose up -d` brings up Postgres and Redis; `pnpm prisma migrate deploy` succeeds.
- `packages/shared` has zero runtime dependencies other than `zod`.
- TypeScript `strict: true`, `noUncheckedIndexedAccess: true`; no `any` in committed code.
- AI SDK version is pinned exactly (no `^`), per the churn caveat in §2.5.

**Required tests**

- `shared/schemas.test.ts` — every Zod schema round-trips a valid fixture and rejects a malformed one. Minimum one fixture pair per exported schema.

---

### M1 — Orchestrator core and chat over WebSocket

**Scope**

Bot CRUD, conversation and message persistence, the WS gateway with the §4.2 envelope, the `AuthGuard` and `Principal` from §4.4, and streaming replies via AI SDK `streamText`. No sandbox, no tools yet — a bot is a system prompt plus a conversation.

Electron shell: HeroUI v3 + Tailwind v4 configured, bot sidebar, chat pane, composer, streaming render, connection status, reconnect with exponential backoff (1s → 30s cap).

Start the chat surface from the HeroUI Pro Chat template and the Pro Sidebar rather than building from primitives. Adapt the sidebar's data model — this app's rows are bots with a role badge, avatar color, status, and a ⌘-shortcut, not chat threads. Connect the HeroUI MCP server before writing components (§2.5).

**Implementation notes**

- Use `streamText` from `ai` with a provider from `@ai-sdk/openai-compatible` registered in a provider registry keyed by `Bot.modelId`.
- Persist AI SDK message parts verbatim into `Message.parts`. Do not invent a parallel representation.
- Do not write a chunk-mapping adapter. If you find yourself parsing SSE, you are in the wrong layer.

**Acceptance criteria**

- Sending a message from Electron persists it, streams the reply token by token, and persists the completed reply with its parts.
- Killing the orchestrator mid-stream and restarting leaves the partial persisted with `stopReason: 'interrupted'`; the UI shows it as interrupted.
- Closing and reopening Electron restores the last 50 messages per conversation.
- `bot.cancel` aborts an in-flight generation within 500 ms and keeps the partial text.
- Two Electron windows against the same orchestrator both receive `message.delta` for the same turn.
- Message rendering goes through a part-renderer registry keyed by AI SDK part type, with a fallback renderer for unknown types. Adding a part type in M5 or M6 must not require touching the transcript component.
- Every REST handler scopes its Prisma query by `principal.userId`. Enforced by a lint rule or an architecture test — not by review.

**Required tests**

- Unit: WS envelope validation rejects frames with unknown `type`, missing `id`, or a payload failing its Zod schema.
- Unit: `AuthGuard` rejects a missing token, a wrong token, and a malformed header; accepts the configured token and attaches a `Principal`.
- Architecture test: no Prisma `bot.findMany` or `bot.findFirst` call site lacks a `userId` in its where clause.
- Integration (Testcontainers Postgres + Redis, model stubbed with the AI SDK's mock provider): send a message via REST, assert the `message.created` → `message.delta`* → `message.completed` sequence on a connected WS client, and assert final DB state.
- Integration: reconnect — drop the socket mid-stream, reconnect, assert the completed message is fetchable via REST.
- E2E (Playwright + Electron): type a message, see streamed text, restart the app, see the message still there.

---

### M2 — Sandbox lifecycle and live screen with input

The milestone that makes the product feel real. Do not rush it.

**Scope**

`DockerSandboxProvider` implementing `HarnessV1SandboxProvider` from `@ai-sdk/harness`, in `packages/sandbox-docker`. Build the §5 image. Create and resume sessions per bot. Health polling. The RFB proxy from §4.3 including inbound input forwarding. Electron: a screen thumbnail in the right rail and a full-screen view with a collapse control.

**Implementation notes**

- `createSession({ sessionId, identity })` — persist the returned session id to `Sandbox.sessionId`.
- On orchestrator start, reconcile stored sessions with provider state. Reattach or restart existing sessions. Do not silently replace missing sessions with empty desktops; use the explicit workspace recovery path (D-031).
- Port access is via `getPortEndpoint({ port })`, forwarding its optional headers, for 5900, 9222, and 7070. Do not read mapped ports out of dockerode directly elsewhere.
- Re-export the harness types through `packages/sandbox-docker/src/types.ts` so upstream renames touch one file (§2.5).

**Acceptance criteria**

- `POST /bots/:id/sandbox/start` returns within 20 s with `state: RUNNING` and a healthy bridge.
- Calling start twice concurrently produces exactly one container (verify with `docker ps`).
- Restarting the orchestrator with a running sandbox resumes the same session — same container, same `sessionId`, no restart of the desktop.
- The Electron screen panel shows the XFCE desktop with Chrome, Thunar, and a terminal in the dock.
- Clicking and typing in full-screen moves the cursor and types inside the container. Verified end to end: click the terminal icon, type `touch /home/bot/proof.txt`, press Enter, then `session.readFile` finds it.
- Framebuffer dimensions at connect equal `Sandbox.widthPx` × `heightPx` and never change for the container's lifetime.
- With the panel closed, orchestrator CPU attributable to that sandbox's RFB connection stays under 2% over 60 s idle.
- Deleting a bot calls `destroy()` and removes the container within 10 s.
- No process inside the container can reach the Docker socket or the orchestrator's Postgres. Explicit negative test.
- D-031 acceptance: saved workspace/profile survives stop/start and supported image replacement; host admission prevents oversubscription; idle stop respects execution/recording/takeover leases; reconciliation covers partial creation and teardown without deleting saved workspaces.
- Record representative CPU, peak RAM, disk growth, startup and restart measurements before ratifying capacity.
- Expired unclaimed uploads are physically reaped and cumulative artifact growth is bounded.
- Egress controls must be installed and verified before a sandbox is made available; an unsupported optional provider method must never silently bypass enforcement.

**Required tests**

- Integration (real Docker, not mocked): create → health → run → screenshot → stop → resume → destroy.
- Integration: concurrent start race — 5 simultaneous start calls, assert one container.
- Integration: resume across orchestrator restart — assert the same container id and an unchanged desktop.
- Integration: crash recovery — `docker kill` the container, assert `UNHEALTHY` within one poll interval, assert a subsequent start succeeds.
- Integration: input round-trip — inject a synthetic `PointerEvent` and `KeyEvent` through the WS path, assert the effect via `readFile` (the `proof.txt` test, automated).
- Security test: from inside the container, `curl` to the Postgres port and to `/var/run/docker.sock` both fail.
- Unit: RFB frame validator accepts valid type-4 and type-5 messages and rejects everything else, including truncated and oversized frames.

---

### M3 — Recording: capture and raw-trace skill

**Scope**

The recording tee. Start/stop from the full-screen view. Persist `RecordingEvent` rows at the X11 layer with a screenshot crop on each click. Compile a recording into a working coordinate-level skill. Skill review UI with source, edit, and approve.

Skills may be brittle at this milestone. M4 fixes robustness.

**Capture rules**

- Every validated inbound `screen.input` frame during an active recording produces a `RecordingEvent` with `layer: X11`.
- Coalesce pointer moves: at most one per 100 ms, and always emit the move immediately preceding a button press.
- On every button-down, capture a screenshot via the bridge and store a 200×200 px crop centered on the click point.
- Coalesce consecutive `keydown` events with no intervening pointer event into a single `type` event. Modifier combinations (`Ctrl+C`) stay discrete.
- Hard limits: 20 minutes, 5000 events. Exceeding either auto-stops and marks the recording `READY` with a warning.

**Skill compilation**

A BullMQ job `skill.compile` runs on stop, using `generateObject` from the AI SDK with this output schema:

```ts
{
  name: string;              // snake_case
  description: string;
  paramsSchema: JSONSchema;  // object type; every param needs a description
  script: string;            // TS module, default-exports async run(ctx, params)
}
```

The model receives: the user's stated intent, the ordered event trace (compact JSON, screenshots referenced by index), the sandbox resolution, and up to 8 screenshot crops from the most ambiguous clicks.

The generated script targets:

```ts
interface SkillContext {
  click(x: number, y: number): Promise<void>;
  doubleClick(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  key(combo: string): Promise<void>;          // "ctrl+c", "Return"
  screenshot(): Promise<Buffer>;
  waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void>;
  log(msg: string): void;
}
```

**Timing rule (mandatory):** the compiler prompt must forbid `sleep(n)`. Every wait becomes a `waitFor` with an explicit predicate. A gap in the trace is evidence that a wait is needed, not evidence of its duration.

**Acceptance criteria**

- "Teach a task" starts a recording; the UI shows a live event counter and a recording indicator.
- Stopping produces a `DRAFT` skill within 60 s, or a `FAILED` recording with a readable error.
- Golden path: record "open Chrome, go to example.com, screenshot the page", then run the generated skill on a freshly restarted sandbox and reach the same final page.
- Generated scripts contain no `sleep(` or `setTimeout(`. Enforced by a validator that retries once with a corrective message before failing.
- Editing and saving a script bumps `version` and keeps the previous version queryable.
- A `DRAFT` skill cannot be run. Only `APPROVED`.

**Required tests**

- Unit: pointer-move coalescer — a synthetic 500-event burst over 3 s yields ≤ 31 move events, and the move preceding each click is retained.
- Unit: keystroke coalescer — `h,e,l,l,o` becomes one `type("hello")`; `h,e,Ctrl+a,x` becomes `type("he")`, `key("ctrl+a")`, `type("x")`.
- Unit: output validator rejects a script containing `sleep(`, a missing `paramsSchema`, or a non-snake_case name.
- Integration: recording tee — start, push 20 synthetic input frames, stop, assert exactly the expected rows with correct `tsOffsetMs` ordering.
- Integration with a stubbed model: fixture trace in, fixture skill out, persisted, `skill.compiled` emitted on WS.
- E2E (real sandbox, real model, `@slow`): the golden path, run twice to check determinism.

---

### M4 — CDP capture layer

**Scope**

Attach to Chrome's CDP endpoint for the duration of a recording. Record browser interactions with DOM identity alongside X11 events. Teach the compiler to prefer CDP steps and emit Playwright calls for them.

**Capture rules**

- Inject a capture script via `Page.addScriptToEvaluateOnNewDocument` listening for `click`, `input`, `change`, and `submit` in the capture phase, reporting over a CDP binding.
- Selector priority: `data-testid` → `id` → `aria-label` + role → unique CSS path → text match. Record all candidates, not only the winner.
- Also record `Page.frameNavigated` and `Network.loadingFinished` so the compiler can emit real wait conditions.
- Correlate layers by timestamp: an X11 click within 150 ms of a CDP click at the same coordinates is the same action. Write `correlatedWithId` on both rows. The compiler must not emit both.

**Acceptance criteria**

- A browser-task recording produces rows at both layers, correctly correlated.
- The compiler emits `page.click('<selector>')` rather than `ctx.click(x, y)` for every correlated interaction.
- A skill generated from a browser task still succeeds after layout shift, verified with a fixture page at two viewport widths.
- Waits are `page.waitForSelector` or `page.waitForLoadState`, never coordinate-blind delays.
- If Chrome or CDP is unreachable, recording degrades silently to X11-only and sets `Recording.cdpAvailable = false`.

**Required tests**

- Unit: selector generator — for a fixture DOM, asserts priority order and uniqueness of the chosen selector.
- Unit: correlator — synthetic pairs at 0, 100, 200, 500 ms; asserts ≤150 ms pairs merge and others do not.
- Integration: record against a locally served fixture page, assert the compiled script has no coordinate clicks.
- Integration: layout-shift robustness — run the skill against the fixture at 1280 px and at 900 px, both succeed.
- Integration: CDP-down degradation — kill Chrome, record, assert X11-only trace and the flag.

---

### M5 — Agent loop and tools

**Scope**

The bot acts autonomously, using `ToolLoopAgent` from the AI SDK. Tool registry. Auto-review rules deciding whether an action runs automatically or waits for user approval, wired into the SDK's tool approval mechanism. Approval prompts inline in chat. Step checkpointing per R9.

**Implementation notes**

- Configure `ToolLoopAgent` with `stopWhen: stepCountIs(25)`. Do not write a loop.
- Use `prepareStep` to trim context and to swap models per step if `Bot.modelId` implies it.
- Pass `session.restricted()` to tool execution, never the network session (R4).
- **R9 checkpointing:** in `onStepFinish`, append the completed step to `AgentTurn.steps` and increment `stepIndex` before the next step begins. On orchestrator start, any `AgentTurn` left `RUNNING` is marked `INTERRUPTED` and a system message is posted. Resuming a turn is not required in v1; not losing the record of it is.

**Built-in tools**

| Tool | Notes |
|---|---|
| `browser_navigate(url)` | |
| `browser_read()` | accessibility-tree text of the current page, not raw HTML |
| `browser_click(selector)` | |
| `browser_type(selector, text)` | |
| `screenshot()` | returns an image part to the model |
| `shell(command)` | via `session.run()`; **always requires approval by default** |
| `fs_read(path)` / `fs_write(path, content)` | via the restricted session; scoped to `/home/bot` |
| `run_skill(name, params)` | only `APPROVED` skills belonging to that bot or global |
| `send_message(toBot, content)` | stubbed here, implemented in M7 |
| `attach_file(path, note)` | surfaces a download card in chat |

**Loop safety limits (defaults, all configurable)**

- 25 tool calls per user turn (`stopWhen`).
- 150,000 accumulated input tokens per turn.
- 10-minute wall-clock timeout per turn.
- On any limit: stop, post a system message naming the limit, set status `IDLE`.

**Auto-review rules** are an ordered per-bot list, each `{ toolPattern: string; argMatch?: string; decision: 'allow' | 'ask' | 'deny' }`, first match wins, default `ask`.

**Acceptance criteria**

- A bot given "go to example.com and tell me the heading" completes it using `browser_navigate` + `browser_read` with no human input.
- A bot attempting `shell` under default rules emits `approval.requested` and blocks. Denying returns a tool result the model can react to, not an exception.
- Hitting the tool-call limit posts a clear system message and does not leave the bot stuck in `ACTING`.
- `bot.cancel` mid-tool-call aborts within 2 s with consistent state.
- Tool results over 100 KB are truncated with an explicit marker before reaching the model.
- Killing the orchestrator mid-turn leaves `AgentTurn` with every completed step persisted and status `INTERRUPTED` after restart. No turn is silently lost.
- A tool implementation cannot reach `destroy()` or `setNetworkPolicy()`. Enforced by types and by an explicit test.

**Required tests**

- Unit: each tool's argument schema validation, including rejection of `fs_read('/etc/shadow')` and any path escaping `/home/bot`.
- Unit: auto-review rule matcher — ordered fixtures for allow, ask, deny, and default fallthrough.
- Unit: `restricted()` boundary — assert the object handed to tools has no `destroy`, `setNetworkPolicy`, or `setPorts`.
- Integration: full loop with the AI SDK mock provider and a real sandbox for the navigate-and-read task.
- Integration: approval flow — assert block, resume on approve, graceful tool result on deny.
- Integration: cancel mid-tool-call leaves no orphaned Playwright context or zombie process in the container.
- Integration (R9): kill the orchestrator after step 3 of 6; on restart assert 3 steps persisted and the turn marked `INTERRUPTED`.

---

### M6 — MCP plugins

Without this, a bot's only route to any external service is driving its web UI through Chrome. This milestone is what makes the tool list cover real work.

**Scope**

A curated plugin directory, private server installation by URL, OAuth connection flow, per-bot plugin enablement, and MCP tools merged into the M5 tool registry. Electron: the plugin modal — search, category filters, install, connect, and an installed-count summary.

**Sizing warning.** The MCP client is provided by the AI SDK and is a small part of this milestone. The work is the credential lifecycle: launching an authorize URL from Electron, catching the redirect, exchanging the code, encrypting tokens, refreshing before expiry, and showing a `NEEDS_REAUTH` state that the user can act on. Plan the milestone around that.

**Where things run**

- MCP clients live in the orchestrator (R10). Credentials never enter a sandbox.
- Transports: `HTTP` and `SSE` only. `stdio` is out of scope — see §2.5.
- The OAuth redirect target is an orchestrator route, not an Electron deep link. Electron opens the authorize URL in the system browser and polls `GET /mcp/servers/:id` for status.

**Tool namespacing**

Every MCP tool is exposed to the model as `<serverSlug>__<toolName>` — for example `gmail__send_message`. Collisions across servers are impossible by construction. The registry rejects a server whose slug collides with a built-in tool prefix.

**Tool budget (mandatory)**

Six plugins at fifteen tools each is ninety tool definitions in every single request. That degrades tool selection accuracy and burns input tokens on every step of every turn.

- Plugins are enabled **per bot**, never globally. A bot's tool set is its built-ins plus only the servers enabled for it.
- A bot's plugin tools reach the model through a two-definition bridge, so the prompt footprint is bounded whatever the catalogue holds. The bound is `PLUGIN_LISTING_TOKEN_BUDGET` over the advertisement, which degrades in form as the catalogue grows (D-113): nothing is refused for size, and nothing is truncated out of reach — a query searches the whole catalogue, and a name the listing omitted still runs.
- `prepareStep` may narrow further within a turn.

**Read-only classification**

`McpTool.readOnly` is set at list time from the server's `readOnlyHint` annotation when present, falling back to a name pattern (`get_*`, `list_*`, `search_*`, `read_*`, `fetch_*`). Anything unmatched is treated as writing.

**Approval defaults**

Every MCP tool defaults to `ask`. Tools classified `readOnly` default to `allow`. The user may add per-bot rules either way using the existing M5 auto-review matcher — MCP tools need no separate mechanism.

**Failure isolation**

One broken plugin must never fail a turn.

- List-tools timeout 10 s; tool-call timeout 30 s.
- A server failing its health check is dropped from the bot's tool set for that turn, and a single system note names it.
- Three consecutive failures move the server to `ERROR` and emit `mcp.status`; it stays out of tool sets until reconnected.
- A `401` from a tool call moves the server to `NEEDS_REAUTH` and triggers one refresh attempt before giving up.

**Acceptance criteria**

- The plugin modal lists directory entries by category, shows installed state, and installs an entry in one action.
- A private server can be added by URL and behaves identically to a directory entry thereafter.
- Connecting an OAuth server opens the system browser, and on completion the server reaches `CONNECTED` with a populated `McpTool` cache, with no manual refresh in Electron.
- Enabling a plugin for a bot makes its tools available on the very next turn without an orchestrator restart.
- An MCP tool call appears in the transcript as a tool part **under the plugin tool's own name**, and respects the bot's approval rules.
- A write-classified MCP tool blocks for approval under default rules; a read-only one does not.
- `PUT /bots/:id/plugins` accepts a set of any size: a bot with three hundred plugin tools is configured exactly as easily as one with three, and every one of them is reachable on the next turn (D-113).
- With one plugin's server returning 500 for every request, a turn using two other plugins still completes.
- An expired access token is refreshed transparently mid-turn. A failed refresh surfaces `NEEDS_REAUTH` in the UI rather than a raw error in the transcript.
- No API response anywhere in the app contains access or refresh token material.

**Required tests**

- Unit: tool namespacing — asserts the `slug__name` format, rejects a slug colliding with a built-in prefix, and round-trips a namespaced call back to the right server and tool.
- Unit: read-only classifier — fixtures covering annotation-present, annotation-absent-name-matches, and annotation-absent-name-unmatched.
- Unit: tool-surface budget — a catalogue far larger than the old cap is accepted in full, the advertised listing stays inside `PLUGIN_LISTING_TOKEN_BUDGET` and degrades in form, a search answer stays inside the same budget while still answering in full for a single oversized match, and a tool the listing omitted is still found by a query and still runnable.
- Unit: credential encryption — a token round-trips through encrypt/decrypt, and the ciphertext does not contain the plaintext.
- Integration (mock MCP server over HTTP): install → connect → list tools → enable for bot → call a tool → assert the result reaches the model.
- Integration: OAuth flow against a stub authorization server, including code exchange and credential persistence.
- Integration: token refresh — seed a credential expiring in 5 s, run a turn, assert transparent refresh and an updated `expiresAt`.
- Integration: failed refresh sets `NEEDS_REAUTH` and emits `mcp.status`.
- Integration: failure isolation — three servers enabled, one returning 500, assert the turn completes and exactly one system note names the failing server.
- Integration: approval — assert a write tool blocks and a read-only tool does not, under default rules.
- Security test: `GET /mcp/servers`, `GET /bots/:id/plugins`, and the WS `mcp.status` frame contain no token material. Assert against the serialized response body, not the DTO type.
- Security test: assert no MCP credential is reachable from inside a sandbox container.

---

### M7 — Bot-to-bot messaging

**Scope**

`send_message(toBot, content)` becomes real. Delivery goes through a BullMQ queue, never a direct call. The receiving bot's turn triggers as if a user had messaged it, with `author: BOT` and the originating `fromBotId`.

**Loop protection (implement before enabling the tool)**

- Every exchange carries a `chainId` and a `hopCount`.
- `hopCount` increments per delivery; at `MAX_HOPS` (default 10) delivery is dropped and a system message posted to both bots.
- Each `chainId` carries a token budget (default 200,000 across all participants). Exhaustion terminates the chain with a system message.
- A bot may not send more than 3 messages to the same bot within one chain.
- Inter-bot messages render with a distinct treatment showing the originating bot's name and color.

**Acceptance criteria**

- Bot A asks Bot B a question and receives an answer appearing in both conversations.
- Two bots told to converse indefinitely terminate at the hop limit within 60 s with the explanatory system message.
- A chain exhausting its token budget terminates and reports actual tokens spent.
- Deleting a bot mid-chain terminates the chain cleanly rather than dead-lettering forever.

**Required tests**

- Unit: hop counter and budget accounting arithmetic.
- Integration: A→B→A round trip with a stubbed model; assert rows in both conversations with correct `chainId` and `hopCount`.
- Integration: infinite-loop scenario with a stub that always replies with `send_message`; assert termination at exactly `MAX_HOPS` and no further jobs enqueued.
- Integration: budget exhaustion with an inflated-usage stub.
- Integration: delete a participating bot mid-chain; assert no stuck jobs after 30 s.

---

### M8 — Routines

**Scope**

Recurring scheduled work per bot. BullMQ repeatable jobs from cron with per-routine timezones. Routine panel in the right rail: create, edit, enable/disable, run-now, last-run status.

**Acceptance criteria**

- A routine with `*/5 * * * *` fires at correct wall-clock times in its timezone, including across a DST boundary. Test with `America/New_York` — the default timezone has no DST and will not exercise this.
- Routines survive an orchestrator restart without duplicating or skipping.
- A routine whose bot's sandbox is stopped starts (or resumes) the sandbox first, then runs.
- Overlapping runs are prevented: if the previous run is still active, the new one is skipped and logged, not queued.
- Disabling removes the repeatable job from Redis, verified by inspecting the queue.

**Required tests**

- Unit: cron + timezone expansion, including spring-forward and fall-back fixtures.
- Integration: create a routine, advance fake timers, assert exactly N executions.
- Integration: restart the orchestrator between two firings, assert no duplicate and no gap.
- Integration: overlap suppression with a deliberately slow run.
- Integration: disable removes the repeatable job key from Redis.

### M10 — Work

Projects, tasks, goals, deliverables and search, worked before M9. `docs/PRD-WORK.md` is the
milestone's PRD; D-132 … D-140 ratify its decisions and contracts, and §3.1 and §4 above carry them.

---

## 7. Cross-cutting requirements

### 7.1 Observability

- Structured JSON logs (pino) with `botId`, `conversationId`, `chainId`, `turnId`, and `runId` in context.
- `GET /health` reports Postgres, Redis, Docker daemon, and per-sandbox health.
- Enable AI SDK telemetry. Every model call records provider, model, input tokens, output tokens, latency, and cost estimate.
- Daily token-spend rollup per bot, served by `GET /usage`.

### 7.2 Cost controls

- `MAX_DAILY_TOKENS` global cap. On breach all bots refuse new turns and post a system message. Hard stop, not a warning.
- Per-bot daily cap, defaulting to the global cap divided by the number of bots.
- CC-04, CC-05, and CC-12 are M5 release prerequisites. Enforce budgets before admitting work and during execution, account for concurrent turns, and disclose bounded in-flight overshoot. Track sandbox runtime separately from model tokens (D-031/D-033).

### 7.3 Security

- Bot containers sit on a dedicated bridge with no route to Postgres or Redis.
- Default egress: allow outbound 80/443, deny everything else, deny RFC1918 destinations. Prefer `session.setNetworkPolicy()` where the provider implementation supports it; otherwise iptables rules on the bridge, documented in `infra/compose/README.md`.
- Secrets (`ORCH_API_TOKEN`, model API key, DB URL, `CREDENTIAL_KEY`) come from environment only. No secret is ever passed into a sandbox container.
- MCP credentials are encrypted at rest with `CREDENTIAL_KEY` (AES-256-GCM) before they reach Prisma. They are never logged, never returned by any API route, and never reach a sandbox (R10). A test asserts that `GET /mcp/servers` responses contain no token material.
- The Electron client stores its token with `safeStorage`, never plaintext on disk.
- Skill scripts are model-generated and therefore untrusted. They execute **inside the sandbox**, never in the orchestrator process. No `eval`, `vm.runInNewContext`, or dynamic `import()` of skill source anywhere in `apps/orchestrator`. Enforced by a lint rule.
- Tools receive only `session.restricted()` (R4).

### 7.4 Performance budgets

| Metric | Budget |
|---|---|
| Sandbox cold start to `RUNNING` | ≤ 20 s |
| Sandbox resume to `RUNNING` | ≤ 5 s |
| First streamed token after user message | ≤ 2.5 s p95 |
| Screen input round-trip (click → visible change) | ≤ 250 ms p95 on LAN |
| Screen stream at 1280×800, active use | ≤ 1.5 Mbps |
| MCP list-tools call | ≤ 10 s timeout |
| MCP tool call | ≤ 30 s timeout |
| Plugin listing advertised per bot | ≤ 4000 estimated tokens, degrading in form (D-113) |
| Plugin search answer per call | ≤ 4000 estimated tokens, except a single match that alone exceeds it (D-113) |
| Orchestrator RSS with 6 idle sandboxes | ≤ 1 GB |
| Per-sandbox host memory | ≤ 2 GB hard limit |

### 7.5 Host sizing

Six concurrent bots at these budgets need roughly 16 GB RAM and 8 vCPU with headroom. **Verify the target Hetzner instance before starting M2.** A 4 GB VPS will not run three desktops, and discovering that at M2 wastes the milestone.

---

## 8. Definition of done for v1

- All M0–M8 acceptance criteria pass.
- Test suite green in CI, with `@slow` E2E tests running nightly rather than per-commit.
- `docker compose up` on a clean VPS produces a working orchestrator; the Electron client connects with only a host and token.
- README documents prerequisites, environment variables, first-run bot creation, and building the sandbox image.
- At least three skills recorded and approved through the real flow, each re-run successfully on a fresh sandbox.
- At least two MCP plugins connected via OAuth and used successfully by a bot in a real task.
- An incident runbook covering: sandbox won't start, model provider outage, runaway token spend, stuck chain, interrupted turn, expired plugin credential.

---

## 9. Deferred work and conditional paid launch

M9 is a separate paid-launch gate after the personal MVP, not part of v1 completion. See [COMMERCIAL-ROADMAP.md](COMMERCIAL-ROADMAP.md) and D-033. Customer isolation, provisioning, credentials, metering, recovery, and operations are additional work beyond replacing a provider or auth guard.


Listed so the agent does not build them speculatively, and so the v1 data model accommodates them.

- **AT-SPI capture layer** for native-app teaching. The `ATSPI` enum value and the bridge SSE endpoint exist but stay unused in v1.
- **better-auth**, replacing the static token. R7 and the `User` table are the groundwork. Evaluate its API-key plugin for the desktop client against plain sessions; check current docs at adoption time.
- **Workflow DevKit** for durable agent turns, if R9 checkpointing proves insufficient. Self-host with `WORKFLOW_TARGET_WORLD=@workflow/world-postgres`.
- **Remote sandbox providers** (Vercel Sandbox, E2B, Fly Machines). The harness abstraction already accommodates them; a second provider handles runtime access, while persistence, provisioning, tenant isolation, metering, and recovery require the separate M9 work.
- **Skill sharing and templates** between installations.
- **Multi-user auth** and per-user bot ownership.
- **Voice input.** *(Done in D-221.)*
- **MCP `stdio` transport**, running third-party server processes in an isolated container rather than the orchestrator.
- **Per-bot credential scoping** — in v1 a connected server's credential is shared by every bot enabled for it.
