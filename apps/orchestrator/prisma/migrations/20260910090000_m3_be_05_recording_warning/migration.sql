-- Why a recording stopped itself (§6/M3 hard limits, M3-BE-05).
--
-- Nullable with no default, because null is the ordinary case and means
-- exactly one thing: capture ended when someone asked it to. Backfilling a
-- value onto existing rows would claim their traces were cut short.
--
-- An enum rather than a message: the renderer picks the sentence and the
-- M3-BE-06 compiler decides whether a truncated trace is still worth
-- compiling, and neither can branch on prose that a later edit rewords.
CREATE TYPE "RecordingWarning" AS ENUM ('EVENT_LIMIT', 'TIME_LIMIT');

ALTER TABLE "Recording" ADD COLUMN     "warning" "RecordingWarning";
