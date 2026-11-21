-- D-234: the person's language and timezone, and what their computer reported.
ALTER TABLE "UserSettings" ADD COLUMN "language" TEXT,
ADD COLUMN "timezone" TEXT,
ADD COLUMN "systemLanguage" TEXT,
ADD COLUMN "systemTimezone" TEXT;
