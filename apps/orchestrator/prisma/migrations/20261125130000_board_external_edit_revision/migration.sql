-- Keep BOARD.md text written outside the board tools before the managed
-- projection overwrites it.

-- AlterEnum
ALTER TYPE "BoardRevisionKind" ADD VALUE 'EXTERNAL_EDIT';
