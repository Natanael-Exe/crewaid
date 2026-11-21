-- CreateEnum
CREATE TYPE "RoutineOrigin" AS ENUM ('OPERATOR', 'BOT');

-- AlterTable
ALTER TABLE "Routine" ADD COLUMN     "origin" "RoutineOrigin" NOT NULL DEFAULT 'OPERATOR';
