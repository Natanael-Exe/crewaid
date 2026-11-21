-- CreateEnum
CREATE TYPE "BotStatus" AS ENUM ('IDLE', 'THINKING', 'ACTING', 'AWAITING_APPROVAL', 'ERROR');

-- CreateEnum
CREATE TYPE "MessageAuthor" AS ENUM ('USER', 'BOT', 'SYSTEM', 'TOOL');

-- CreateEnum
CREATE TYPE "TurnStatus" AS ENUM ('RUNNING', 'AWAITING_APPROVAL', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED');

-- CreateEnum
CREATE TYPE "SandboxState" AS ENUM ('STOPPED', 'STARTING', 'RUNNING', 'UNHEALTHY', 'ERROR');

-- CreateEnum
CREATE TYPE "RecordingState" AS ENUM ('RECORDING', 'COMPILING', 'READY', 'FAILED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "CaptureLayer" AS ENUM ('X11', 'CDP', 'ATSPI');

-- CreateEnum
CREATE TYPE "SkillStatus" AS ENUM ('DRAFT', 'APPROVED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "McpTransport" AS ENUM ('HTTP', 'SSE');

-- CreateEnum
CREATE TYPE "McpAuthType" AS ENUM ('NONE', 'OAUTH2', 'HEADER');

-- CreateEnum
CREATE TYPE "McpStatus" AS ENUM ('DISCONNECTED', 'CONNECTING', 'CONNECTED', 'NEEDS_REAUTH', 'ERROR');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "avatarColor" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "modelId" TEXT NOT NULL DEFAULT 'default',
    "status" "BotStatus" NOT NULL DEFAULT 'IDLE',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "hiddenFromSidebar" BOOLEAN NOT NULL DEFAULT false,
    "autoReviewRules" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "author" "MessageAuthor" NOT NULL,
    "fromBotId" TEXT,
    "content" TEXT NOT NULL,
    "parts" JSONB,
    "chainId" TEXT,
    "hopCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTurn" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "triggerMessageId" TEXT NOT NULL,
    "status" "TurnStatus" NOT NULL DEFAULT 'RUNNING',
    "stepIndex" INTEGER NOT NULL DEFAULT 0,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "stopReason" TEXT,

    CONSTRAINT "AgentTurn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sandbox" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "sessionId" TEXT,
    "containerId" TEXT,
    "state" "SandboxState" NOT NULL DEFAULT 'STOPPED',
    "widthPx" INTEGER NOT NULL DEFAULT 1280,
    "heightPx" INTEGER NOT NULL DEFAULT 800,
    "vncPort" INTEGER,
    "cdpPort" INTEGER,
    "bridgePort" INTEGER,
    "lastStartedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "Sandbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recording" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "state" "RecordingState" NOT NULL DEFAULT 'RECORDING',
    "intent" TEXT,
    "cdpAvailable" BOOLEAN NOT NULL DEFAULT true,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "Recording_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordingEvent" (
    "id" TEXT NOT NULL,
    "recordingId" TEXT NOT NULL,
    "tsOffsetMs" INTEGER NOT NULL,
    "layer" "CaptureLayer" NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "screenshotKey" TEXT,
    "correlatedWithId" TEXT,

    CONSTRAINT "RecordingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "botId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "paramsSchema" JSONB NOT NULL,
    "script" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "SkillStatus" NOT NULL DEFAULT 'DRAFT',
    "sourceRecordingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillRun" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "logs" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "SkillRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpServer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "category" TEXT,
    "iconUrl" TEXT,
    "transport" "McpTransport" NOT NULL DEFAULT 'HTTP',
    "url" TEXT NOT NULL,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "authType" "McpAuthType" NOT NULL DEFAULT 'OAUTH2',
    "status" "McpStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpServer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpCredential" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "scopes" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpTool" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "inputSchema" JSONB NOT NULL,
    "readOnly" BOOLEAN NOT NULL DEFAULT false,
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpTool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotMcpServer" (
    "botId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "BotMcpServer_pkey" PRIMARY KEY ("botId","serverId")
);

-- CreateTable
CREATE TABLE "Routine" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Port-au-Prince',
    "prompt" TEXT,
    "skillId" TEXT,
    "skillParams" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" "RunStatus",

    CONSTRAINT "Routine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_botId_key" ON "Conversation"("botId");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentTurn_botId_startedAt_idx" ON "AgentTurn"("botId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Sandbox_botId_key" ON "Sandbox"("botId");

-- CreateIndex
CREATE INDEX "RecordingEvent_recordingId_tsOffsetMs_idx" ON "RecordingEvent"("recordingId", "tsOffsetMs");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_sourceRecordingId_key" ON "Skill"("sourceRecordingId");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_botId_name_version_key" ON "Skill"("botId", "name", "version");

-- CreateIndex
CREATE UNIQUE INDEX "McpServer_userId_slug_key" ON "McpServer"("userId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "McpCredential_serverId_key" ON "McpCredential"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "McpTool_serverId_name_key" ON "McpTool"("serverId", "name");

-- AddForeignKey
ALTER TABLE "Bot" ADD CONSTRAINT "Bot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTurn" ADD CONSTRAINT "AgentTurn_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sandbox" ADD CONSTRAINT "Sandbox_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recording" ADD CONSTRAINT "Recording_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordingEvent" ADD CONSTRAINT "RecordingEvent_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "Recording"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_sourceRecordingId_fkey" FOREIGN KEY ("sourceRecordingId") REFERENCES "Recording"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillRun" ADD CONSTRAINT "SkillRun_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpServer" ADD CONSTRAINT "McpServer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpCredential" ADD CONSTRAINT "McpCredential_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpTool" ADD CONSTRAINT "McpTool_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotMcpServer" ADD CONSTRAINT "BotMcpServer_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotMcpServer" ADD CONSTRAINT "BotMcpServer_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Routine" ADD CONSTRAINT "Routine_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
