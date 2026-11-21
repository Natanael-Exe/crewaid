-- Bot avatar: a chosen mascot silhouette, and an uploaded picture that
-- supersedes it when present.
--
-- Both nullable, and neither carries a default. A default would have restyled
-- every bot that predates this migration: the mascot has always been derived
-- from the name, so a concrete shape written into existing rows changes how
-- they look. NULL keeps the derived shape and means "not chosen yet".
ALTER TABLE "Bot" ADD COLUMN "avatarShape" TEXT;
ALTER TABLE "Bot" ADD COLUMN "avatarUrl" TEXT;
