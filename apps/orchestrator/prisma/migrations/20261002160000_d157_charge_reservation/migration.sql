-- D-157: an included-model charge is reserved before its call and settled
-- after it; settledAt is null while the reservation stands.

-- AlterTable
ALTER TABLE "ModelCharge" ADD COLUMN     "settledAt" TIMESTAMP(3);

