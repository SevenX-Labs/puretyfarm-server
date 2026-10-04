-- CreateEnum
CREATE TYPE "PlanType" AS ENUM ('BUY_ONCE', 'SEVEN_DAY_TRIAL', 'MONTHLY');

-- CreateEnum
CREATE TYPE "DeliveryFrequency" AS ENUM ('DAILY', 'ALTERNATE_DAYS');

-- CreateEnum
CREATE TYPE "QuantityMode" AS ENUM ('FIXED', 'ALTERNATING');

-- CreateEnum
CREATE TYPE "PlanQuoteStatus" AS ENUM ('PENDING', 'CONFIRMED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PlanSelectionStatus" AS ENUM ('CONFIRMED', 'PENDING_PAYMENT', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('SCHEDULED', 'SKIPPED', 'DELIVERED');

-- CreateTable
CREATE TABLE "plan_configs" (
    "id" TEXT NOT NULL,
    "planType" "PlanType" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "actualPricePerLitre" INTEGER NOT NULL,
    "sellingPricePerLitre" INTEGER NOT NULL,
    "quantityMin" INTEGER NOT NULL DEFAULT 1,
    "quantityMax" INTEGER NOT NULL DEFAULT 5,
    "maxUsages" INTEGER NOT NULL DEFAULT 7,
    "trialDurationDays" INTEGER NOT NULL DEFAULT 7,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_quotes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planType" "PlanType" NOT NULL,
    "status" "PlanQuoteStatus" NOT NULL DEFAULT 'PENDING',
    "frequency" "DeliveryFrequency",
    "quantityMode" "QuantityMode",
    "quantity" INTEGER,
    "quantityA" INTEGER,
    "quantityB" INTEGER,
    "actualPricePerLitre" INTEGER NOT NULL,
    "sellingPricePerLitre" INTEGER NOT NULL,
    "deliveryOccurrences" INTEGER NOT NULL,
    "totalLitres" INTEGER NOT NULL,
    "totalActualAmount" INTEGER NOT NULL,
    "totalSellingAmount" INTEGER NOT NULL,
    "discountAmount" INTEGER NOT NULL,
    "billingPeriodStart" TIMESTAMP(3),
    "billingPeriodEnd" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_selections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "planType" "PlanType" NOT NULL,
    "status" "PlanSelectionStatus" NOT NULL DEFAULT 'CONFIRMED',
    "frequency" "DeliveryFrequency",
    "quantityMode" "QuantityMode",
    "quantity" INTEGER,
    "quantityA" INTEGER,
    "quantityB" INTEGER,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_selections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_deliveries" (
    "id" TEXT NOT NULL,
    "selectionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "occurrence" INTEGER NOT NULL,
    "quantityLitres" INTEGER NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'SCHEDULED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plan_configs_planType_key" ON "plan_configs"("planType");

-- CreateIndex
CREATE INDEX "plan_configs_planType_idx" ON "plan_configs"("planType");

-- CreateIndex
CREATE INDEX "plan_quotes_userId_idx" ON "plan_quotes"("userId");

-- CreateIndex
CREATE INDEX "plan_quotes_status_idx" ON "plan_quotes"("status");

-- CreateIndex
CREATE INDEX "plan_quotes_expiresAt_idx" ON "plan_quotes"("expiresAt");

-- CreateIndex
CREATE INDEX "plan_selections_userId_idx" ON "plan_selections"("userId");

-- CreateIndex
CREATE INDEX "plan_selections_planType_idx" ON "plan_selections"("planType");

-- CreateIndex
CREATE INDEX "plan_selections_userId_planType_idx" ON "plan_selections"("userId", "planType");

-- CreateIndex
CREATE INDEX "plan_selections_userId_status_idx" ON "plan_selections"("userId", "status");

-- CreateIndex
CREATE INDEX "plan_deliveries_userId_idx" ON "plan_deliveries"("userId");

-- CreateIndex
CREATE INDEX "plan_deliveries_selectionId_idx" ON "plan_deliveries"("selectionId");

-- CreateIndex
CREATE INDEX "plan_deliveries_deliveryDate_idx" ON "plan_deliveries"("deliveryDate");

-- CreateIndex
CREATE UNIQUE INDEX "plan_deliveries_selectionId_deliveryDate_key" ON "plan_deliveries"("selectionId", "deliveryDate");

-- AddForeignKey
ALTER TABLE "plan_quotes" ADD CONSTRAINT "plan_quotes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_selections" ADD CONSTRAINT "plan_selections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_selections" ADD CONSTRAINT "plan_selections_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "plan_quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_deliveries" ADD CONSTRAINT "plan_deliveries_selectionId_fkey" FOREIGN KEY ("selectionId") REFERENCES "plan_selections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_deliveries" ADD CONSTRAINT "plan_deliveries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hard database-level guarantee for the "7-Day Trial is single-use" invariant:
-- at most ONE non-cancelled Trial selection may ever exist per customer. This is
-- a partial UNIQUE index (not expressible in the Prisma schema DSL) and is the
-- last-line backstop behind the per-user advisory lock used during confirmation,
-- so two concurrent Trial confirmations can never both be inserted.
-- NOTE: because it is not in schema.prisma, deploy with `prisma migrate deploy`
-- (which only applies pending migrations) — do not use `prisma migrate dev`,
-- which would treat this index as drift and try to drop it.
CREATE UNIQUE INDEX "plan_selections_single_trial_per_user"
  ON "plan_selections" ("userId")
  WHERE ("planType" = 'SEVEN_DAY_TRIAL' AND "status" <> 'CANCELLED');
