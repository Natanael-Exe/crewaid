-- D-192: a new thread is a TanStack thread. Every create site relies on the
-- column default, so this is the one place the answer lives. Existing rows
-- keep the engine they were written by: a thread is written by one engine for
-- its whole life (D-165).
ALTER TABLE "Conversation" ALTER COLUMN "engine" SET DEFAULT 'TANSTACK';
