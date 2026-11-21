-- D-156: one row per Stripe subscription. The sync upserts by Stripe's id, and
-- the uniqueness is what makes two deliveries racing for a new subscription
-- write one row.

-- DropIndex
DROP INDEX "Subscription_stripeSubscriptionId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_stripeSubscriptionId_key" ON "Subscription"("stripeSubscriptionId");
