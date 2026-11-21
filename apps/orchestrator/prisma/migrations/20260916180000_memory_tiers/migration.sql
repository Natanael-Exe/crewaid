-- CreateEnum
CREATE TYPE "MemoryKind" AS ENUM ('PREFERENCE', 'CONVENTION', 'FACT', 'DECISION', 'TASK_STATE', 'RESOURCE');

-- CreateEnum
CREATE TYPE "MemorySource" AS ENUM ('TOLD', 'DISTILLED', 'OBSERVED', 'IMPORTED');

-- CreateEnum
CREATE TYPE "MemoryStatus" AS ENUM ('CANDIDATE', 'ACTIVE', 'SUPERSEDED', 'FORGOTTEN');

-- CreateTable
CREATE TABLE "Memory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT,
    "kind" "MemoryKind" NOT NULL,
    "source" "MemorySource" NOT NULL,
    "status" "MemoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "text" TEXT NOT NULL,
    "detail" TEXT,
    "messageId" TEXT,
    "sourceRef" TEXT,
    "supersededById" TEXT,
    "supersededAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "confirmations" INTEGER NOT NULL DEFAULT 1,
    "lastUsedAt" TIMESTAMP(3),
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryTombstone" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT,
    "claimHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryTombstone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Memory_userId_botId_status_idx" ON "Memory"("userId", "botId", "status");

-- CreateIndex
CREATE INDEX "Memory_userId_updatedAt_idx" ON "Memory"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "MemoryTombstone_userId_botId_claimHash_idx" ON "MemoryTombstone"("userId", "botId", "claimHash");

-- AddForeignKey
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "Memory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryTombstone" ADD CONSTRAINT "MemoryTombstone_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Full-text search over the memory ────────────────────────────────────────
--
-- Hand-written, because `schema.prisma` cannot express an expression index and
-- Prisma therefore will not generate one. Spike 002 (CC-28) measured what that
-- costs: `prisma migrate diff --exit-code`, the CI drift guard, does NOT see a
-- bare expression index, so this passes the guard rather than reading as
-- permanent drift. (A GENERATED ALWAYS AS ... STORED tsvector column, the more
-- obvious design, DOES read as drift on every run and is unreachable at any
-- phase — see spikes/002-prisma-fts-drift/README.md.)
--
-- THE QUERY MUST REPEAT THIS EXPRESSION EXACTLY. Postgres only uses an
-- expression index when the query's expression matches it, so
-- `to_tsvector('english', "text")` in MemoryService is a correctness
-- requirement and not a formatting preference. A query that spells it
-- differently returns the same rows by sequential scan and nothing fails.
--
-- The same spike result cuts the other way: a guard that cannot see this index
-- cannot protect it either. Drop it in a later migration and CI stays green
-- while search silently degrades. `memory-schema.test.ts` asserts it exists by
-- querying pg_indexes, because the drift guard will not.
CREATE INDEX "Memory_text_fts_idx" ON "Memory" USING GIN (to_tsvector('english', "text"));

-- ── Tombstone uniqueness, and why it is an expression ───────────────────────
--
-- Postgres treats NULLs as DISTINCT in a unique index, so a plain
-- UNIQUE("userId", "botId", "claimHash") enforces NOTHING for the rows where
-- botId IS NULL — the user-global tombstones, which are the common case. Two
-- tombstones for the same erased claim would insert happily, and the
-- idempotency this table exists to give the extraction sweep (CC-38) would be
-- absent precisely where it is needed most. Measured, not assumed: the plain
-- constraint was written first and memory-schema.integration.test.ts caught
-- the duplicate going in.
--
-- COALESCE turns the absent scope into a real value so uniqueness applies to
-- it. It is an EXPRESSION index, which spike 002 (CC-28) showed the drift
-- guard cannot see — so, like the FTS index above, it ships here and is
-- asserted in memory-schema.integration.test.ts rather than by CI.
CREATE UNIQUE INDEX "MemoryTombstone_scope_claim_key"
  ON "MemoryTombstone" ("userId", COALESCE("botId", ''), "claimHash");
