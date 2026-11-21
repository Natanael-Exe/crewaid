-- CreateTable
CREATE TABLE "MemoryDistillation" (
    "botId" TEXT NOT NULL,
    "throughMessageId" TEXT,
    "throughCreatedAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "candidatesWritten" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MemoryDistillation_pkey" PRIMARY KEY ("botId")
);

-- AddForeignKey
ALTER TABLE "MemoryDistillation" ADD CONSTRAINT "MemoryDistillation_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

