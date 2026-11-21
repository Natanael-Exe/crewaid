-- CreateEnum
CREATE TYPE "AttachmentKind" AS ENUM ('FILE', 'VOICE_NOTE');

-- AlterEnum
ALTER TYPE "ProviderKind" ADD VALUE 'ELEVENLABS';

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "kind" "AttachmentKind" NOT NULL DEFAULT 'FILE';

-- AlterTable
ALTER TABLE "Bot" ADD COLUMN     "voiceId" TEXT;
