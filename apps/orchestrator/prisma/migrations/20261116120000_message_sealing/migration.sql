-- D-236: message text is sealed before it is stored, so `content` holds
-- ciphertext and a full-text index over it indexes nothing a search can use.
-- It would still be maintained on every insert, tokenising each ciphertext.
-- Transcript search now ranks opened text (messages/transcript-search.ts).
--
-- No column changes: a sealed value says what it is by its prefix, and a row
-- written before this is read as the plaintext it holds until it is resealed.
DROP INDEX IF EXISTS "Message_content_fts_idx";
