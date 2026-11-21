-- V1-02 — accounts (Better Auth) and provider connections (D-082, D-086).
--
-- Two additions in one migration because they arrive together: a connection is
-- owned by a user, and until this migration there was only ever one user.
--
-- ⚠️ THE USER TABLE CHANGES SHAPE. `name` and `updatedAt` become NOT NULL and
-- `email` stops being nullable, because every V1 sign-in method reaches an
-- account by email. Prisma's generated form of that is three bare
-- `ADD COLUMN ... NOT NULL` statements plus a `SET NOT NULL`, which cannot
-- apply to a table that already has rows — it aborts with a constraint
-- violation naming a column, several layers from the reason.
--
-- The backfill below is deliberately NOT a data import (V1-17 still says:
-- reset the development database, carry nothing over, import no credential).
-- It exists so an existing development database FAILS NOTHING and keeps an
-- owner for the bots already in it. A synthetic local address is written for
-- any row that has none; it is unique per row, it is not deliverable, and
-- nothing signs in with it.

-- CreateEnum
CREATE TYPE "ProviderKind" AS ENUM ('OPENAI', 'ANTHROPIC', 'OPENROUTER', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ConnectionAuthKind" AS ENUM ('API_KEY');

-- CreateEnum
CREATE TYPE "ConnectionState" AS ENUM ('ACTIVE', 'NEEDS_CREDENTIAL', 'DISABLED');

-- AlterTable — added nullable/defaulted first, backfilled, then constrained.
ALTER TABLE "User" ADD COLUMN     "emailVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "image" TEXT,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3);

-- Backfill. `id` is in the synthetic address so the unique index below cannot
-- collide, and `createdAt` is reused for `updatedAt` rather than `now()` so an
-- untouched row does not claim to have just been modified.
UPDATE "User" SET "name" = COALESCE("name", 'Grog Developer') WHERE "name" IS NULL;
UPDATE "User" SET "updatedAt" = COALESCE("updatedAt", "createdAt") WHERE "updatedAt" IS NULL;
UPDATE "User" SET "email" = 'user+' || "id" || '@grog.invalid' WHERE "email" IS NULL;

ALTER TABLE "User" ALTER COLUMN "name" SET NOT NULL,
ALTER COLUMN "updatedAt" SET NOT NULL,
ALTER COLUMN "email" SET NOT NULL;

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "ProviderKind" NOT NULL,
    "name" TEXT NOT NULL,
    "endpoint" TEXT,
    "authKind" "ConnectionAuthKind" NOT NULL DEFAULT 'API_KEY',
    "state" "ConnectionState" NOT NULL DEFAULT 'NEEDS_CREDENTIAL',
    "credentialCiphertext" TEXT,
    "credentialKeyVersion" INTEGER,
    "credentialSetAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderModel" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "upstreamModelId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "contextWindow" INTEGER NOT NULL,
    "supportsTools" BOOLEAN NOT NULL DEFAULT true,
    "supportsVision" BOOLEAN NOT NULL DEFAULT false,
    "supportsReasoning" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSettings" (
    "userId" TEXT NOT NULL,
    "defaultModelId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSettings_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE INDEX "Verification_identifier_idx" ON "Verification"("identifier");

-- CreateIndex
CREATE INDEX "ProviderConnection_userId_idx" ON "ProviderConnection"("userId");

-- CreateIndex
CREATE INDEX "ProviderModel_connectionId_idx" ON "ProviderModel"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderModel_connectionId_upstreamModelId_key" ON "ProviderModel"("connectionId", "upstreamModelId");

-- CreateIndex
CREATE INDEX "UserSettings_defaultModelId_idx" ON "UserSettings"("defaultModelId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderConnection" ADD CONSTRAINT "ProviderConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderModel" ADD CONSTRAINT "ProviderModel_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ProviderConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_defaultModelId_fkey" FOREIGN KEY ("defaultModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- D-082: one connection per BUILT-IN kind, many CUSTOM ones.
--
-- A partial unique index rather than `@@unique([userId, kind])`, which Prisma
-- would render as a plain unique index and which would therefore also cap
-- CUSTOM connections at one per user — the opposite of the requirement. Prisma
-- cannot express a partial index in the schema, so this is written here and
-- the schema carries a comment pointing at it.
CREATE UNIQUE INDEX "ProviderConnection_userId_builtin_kind_key"
  ON "ProviderConnection" ("userId", "kind")
  WHERE "kind" <> 'CUSTOM';
