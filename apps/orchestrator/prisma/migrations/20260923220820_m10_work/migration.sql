-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('ACTIVE', 'ACHIEVED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskOrigin" AS ENUM ('OPERATOR', 'BOT');

-- CreateEnum
CREATE TYPE "TaskActor" AS ENUM ('USER', 'BOT');

-- CreateEnum
CREATE TYPE "TaskEventType" AS ENUM ('CREATED', 'EDITED', 'ASSIGNED', 'UNASSIGNED', 'STARTED', 'STATUS_CHANGED', 'NOTE', 'DELIVERABLE_LINKED');

-- CreateEnum
CREATE TYPE "DeliverableKind" AS ENUM ('FILE', 'LINK', 'MESSAGE');

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "routineId" TEXT,
ADD COLUMN     "taskId" TEXT;

-- AlterTable
ALTER TABLE "Routine" ADD COLUMN     "goalId" TEXT;

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Goal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT NOT NULL,
    "outcome" TEXT,
    "targetOn" VARCHAR(10),
    "status" "GoalStatus" NOT NULL DEFAULT 'ACTIVE',
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "goalId" TEXT,
    "parentId" TEXT,
    "title" TEXT NOT NULL,
    "brief" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'TODO',
    "blockedReason" TEXT,
    "assigneeBotId" TEXT,
    "origin" "TaskOrigin" NOT NULL DEFAULT 'OPERATOR',
    "seriesId" TEXT,
    "occursAt" TIMESTAMP(3),
    "occursOn" VARCHAR(10),
    "createdByBotId" TEXT,
    "dueOn" VARCHAR(10),
    "rank" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskSeries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "brief" TEXT,
    "assigneeBotId" TEXT,
    "projectId" TEXT,
    "goalId" TEXT,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "endsOn" VARCHAR(10),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastFiredAt" TIMESTAMP(3),
    "origin" "TaskOrigin" NOT NULL DEFAULT 'OPERATOR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskSeries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskEvent" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actor" "TaskActor" NOT NULL,
    "actorBotId" TEXT,
    "actorLabel" TEXT NOT NULL,
    "type" "TaskEventType" NOT NULL,
    "payload" JSONB NOT NULL,
    "startKey" TEXT,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deliverable" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "DeliverableKind" NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "botId" TEXT,
    "attachmentId" TEXT,
    "messageId" TEXT,
    "url" TEXT,
    "sourcePath" TEXT,
    "taskId" TEXT,
    "goalId" TEXT,
    "projectId" TEXT,
    "searchText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deliverable_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Project_userId_status_idx" ON "Project"("userId", "status");

-- CreateIndex
CREATE INDEX "Goal_userId_status_idx" ON "Goal"("userId", "status");

-- CreateIndex
CREATE INDEX "Task_userId_status_idx" ON "Task"("userId", "status");

-- CreateIndex
CREATE INDEX "Task_assigneeBotId_status_idx" ON "Task"("assigneeBotId", "status");

-- CreateIndex
CREATE INDEX "Task_parentId_idx" ON "Task"("parentId");

-- CreateIndex
CREATE INDEX "Task_goalId_idx" ON "Task"("goalId");

-- CreateIndex
CREATE INDEX "Task_projectId_idx" ON "Task"("projectId");

-- CreateIndex
CREATE INDEX "Task_userId_goalId_occursOn_idx" ON "Task"("userId", "goalId", "occursOn");

-- CreateIndex
CREATE UNIQUE INDEX "Task_seriesId_occursAt_key" ON "Task"("seriesId", "occursAt");

-- CreateIndex
CREATE INDEX "TaskSeries_userId_enabled_idx" ON "TaskSeries"("userId", "enabled");

-- CreateIndex
CREATE INDEX "TaskSeries_goalId_idx" ON "TaskSeries"("goalId");

-- CreateIndex
CREATE INDEX "TaskEvent_taskId_createdAt_idx" ON "TaskEvent"("taskId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TaskEvent_userId_startKey_key" ON "TaskEvent"("userId", "startKey");

-- CreateIndex
CREATE UNIQUE INDEX "Deliverable_attachmentId_key" ON "Deliverable"("attachmentId");

-- CreateIndex
CREATE INDEX "Deliverable_userId_createdAt_idx" ON "Deliverable"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Deliverable_taskId_idx" ON "Deliverable"("taskId");

-- CreateIndex
CREATE INDEX "Deliverable_goalId_idx" ON "Deliverable"("goalId");

-- CreateIndex
CREATE INDEX "Deliverable_projectId_idx" ON "Deliverable"("projectId");

-- CreateIndex
CREATE INDEX "Deliverable_botId_idx" ON "Deliverable"("botId");

-- CreateIndex
CREATE INDEX "Deliverable_messageId_idx" ON "Deliverable"("messageId");

-- CreateIndex
CREATE INDEX "Message_taskId_idx" ON "Message"("taskId");

-- CreateIndex
CREATE INDEX "Routine_goalId_idx" ON "Routine"("goalId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "Routine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Routine" ADD CONSTRAINT "Routine_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeBotId_fkey" FOREIGN KEY ("assigneeBotId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "TaskSeries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdByBotId_fkey" FOREIGN KEY ("createdByBotId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskSeries" ADD CONSTRAINT "TaskSeries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskSeries" ADD CONSTRAINT "TaskSeries_assigneeBotId_fkey" FOREIGN KEY ("assigneeBotId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskSeries" ADD CONSTRAINT "TaskSeries_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskSeries" ADD CONSTRAINT "TaskSeries_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskEvent" ADD CONSTRAINT "TaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskEvent" ADD CONSTRAINT "TaskEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskEvent" ADD CONSTRAINT "TaskEvent_actorBotId_fkey" FOREIGN KEY ("actorBotId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskEvent" ADD CONSTRAINT "TaskEvent_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deliverable" ADD CONSTRAINT "Deliverable_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deliverable" ADD CONSTRAINT "Deliverable_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deliverable" ADD CONSTRAINT "Deliverable_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deliverable" ADD CONSTRAINT "Deliverable_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deliverable" ADD CONSTRAINT "Deliverable_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deliverable" ADD CONSTRAINT "Deliverable_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deliverable" ADD CONSTRAINT "Deliverable_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Full-text search over Work records (D-139) ─────────────────────────────
--
-- Hand-written, like Message_content_fts_idx and Memory_text_fts_idx: an
-- expression index is not something schema.prisma can say, and the drift
-- guard does not see one (spike 002). THE SEARCH QUERIES MUST REPEAT THESE
-- EXPRESSIONS EXACTLY — a different spelling returns the same rows by
-- sequential scan and nothing fails — so work-schema.integration.test.ts
-- asserts each index from pg_indexes, and the search service's tests assert
-- that the plan uses them.
CREATE INDEX "Task_search_fts_idx"
  ON "Task" USING GIN (to_tsvector('english', "title" || ' ' || coalesce("brief", '')));

CREATE INDEX "Goal_search_fts_idx"
  ON "Goal" USING GIN (to_tsvector('english', "title" || ' ' || coalesce("outcome", '')));

CREATE INDEX "Deliverable_search_fts_idx"
  ON "Deliverable" USING GIN (
    to_tsvector('english',
      "title" || ' ' || coalesce("summary", '') || ' ' || coalesce("searchText", '')));
