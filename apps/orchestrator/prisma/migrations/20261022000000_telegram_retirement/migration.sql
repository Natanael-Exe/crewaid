-- A managed bot's retirement rotates its token and emits another managed_bot update.
-- Keep only its identity so that update cannot create another pending bot.
CREATE TABLE "TelegramRetiredBot" (
    "telegramBotId" TEXT NOT NULL,
    "retiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramRetiredBot_pkey" PRIMARY KEY ("telegramBotId")
);
