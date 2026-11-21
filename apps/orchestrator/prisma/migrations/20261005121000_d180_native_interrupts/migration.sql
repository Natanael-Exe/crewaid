ALTER TABLE "RunInterrupt"
  ADD COLUMN "nativeInterruptId" TEXT,
  ADD COLUMN "nativePayload" JSONB,
  ADD COLUMN "nativeResponse" JSONB,
  ADD COLUMN "nativeStatus" "InterruptStatus",
  ADD COLUMN "nativeRequestedAt" TIMESTAMP(3),
  ADD COLUMN "nativeResolvedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "RunInterrupt_nativeInterruptId_key" ON "RunInterrupt"("nativeInterruptId");
CREATE INDEX "RunInterrupt_conversationId_nativeStatus_nativeRequestedAt__idx"
  ON "RunInterrupt"("conversationId", "nativeStatus", "nativeRequestedAt", "sequence");
CREATE INDEX "RunInterrupt_runId_nativeStatus_nativeRequestedAt_sequence_idx"
  ON "RunInterrupt"("runId", "nativeStatus", "nativeRequestedAt", "sequence");

ALTER TABLE "RunInterrupt" ADD CONSTRAINT "RunInterrupt_native_facet_check" CHECK (
  ("nativeInterruptId" IS NULL AND "nativePayload" IS NULL AND "nativeResponse" IS NULL
    AND "nativeStatus" IS NULL AND "nativeRequestedAt" IS NULL AND "nativeResolvedAt" IS NULL)
  OR
  ("nativeInterruptId" IS NOT NULL AND "nativePayload" IS NOT NULL
    AND jsonb_typeof("nativePayload") = 'object' AND "nativeStatus" IS NOT NULL
    AND "nativeRequestedAt" IS NOT NULL
    AND (("nativeStatus" = 'pending' AND "nativeResolvedAt" IS NULL)
      OR ("nativeStatus" IN ('resolved', 'cancelled') AND "nativeResolvedAt" IS NOT NULL))
    AND ("nativeResponse" IS NULL OR jsonb_typeof("nativeResponse") = 'object'))
);
