-- D-156: the computer-time meter's watermark on each computer.

-- AlterTable
ALTER TABLE "Sandbox" ADD COLUMN     "meteredAt" TIMESTAMP(3);

