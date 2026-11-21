-- Deviation 10 (D-098): the compiler's plain-language summary of the task.
--
-- The compile already reads the whole trace and is the one writer that knows
-- what a recorded skill does in words a person can check; §3's Skill had
-- nowhere to keep that summary, so the review surface could only open on the
-- script. One sentence per step, written once at compile time and carried
-- forward across edits — the same treatment `paramsSchema` gets.
--
-- `[]` backfills every existing row: skills compiled before the column keep
-- rendering the way they always did, and the review surface treats an empty
-- list as "no summary available" rather than "a skill with no steps".

ALTER TABLE "Skill" ADD COLUMN "steps" JSONB NOT NULL DEFAULT '[]';
