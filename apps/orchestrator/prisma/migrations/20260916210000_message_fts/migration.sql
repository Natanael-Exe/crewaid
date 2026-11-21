-- ── Full-text search over the transcript (CC-34) ────────────────────────────
--
-- `memory_search` reaches past curated facts into the bot's own past
-- conversations, which is what answers "what did we decide about X" when
-- nobody wrote a fact down. Without this index that is a sequential scan of
-- every message the user has ever sent, recomputing to_tsvector for each one.
--
-- Hand-written for the same reason as Memory_text_fts_idx: schema.prisma
-- cannot express an expression index, and spike 002 (CC-28) measured that the
-- CI drift guard does not see one, so this passes rather than reading as
-- permanent drift.
--
-- THE QUERY MUST REPEAT THIS EXPRESSION EXACTLY, and the same spike showed
-- what happens if it does not: a mismatched spelling returns the same rows by
-- sequential scan and nothing fails. memory-schema.integration.test.ts asserts
-- this index from pg_indexes, because the drift guard cannot.
CREATE INDEX "Message_content_fts_idx"
  ON "Message" USING GIN (to_tsvector('english', "content"));
