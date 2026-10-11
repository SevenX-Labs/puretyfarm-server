-- Per-delivery wallet billing. Additive only: no column is dropped, renamed or
-- retyped, and no existing row changes meaning.
--
-- Every existing plan_selections row takes the PREPAID_LEGACY default, so plans
-- that were debited upfront are never charged again per delivery. Existing
-- orders keep a NULL settlementStatus for the same reason.

-- AlterEnum
ALTER TYPE "PlanSelectionStatus" ADD VALUE 'PENDING_APPROVAL';

-- CreateEnum
CREATE TYPE "PlanBillingModel" AS ENUM ('PREPAID_LEGACY', 'PER_DELIVERY');

-- CreateEnum
CREATE TYPE "OrderSettlementStatus" AS ENUM ('PENDING', 'SETTLED', 'OUTSTANDING');

-- AlterTable
ALTER TABLE "plan_selections" ADD COLUMN "billingModel" "PlanBillingModel" NOT NULL DEFAULT 'PREPAID_LEGACY';

-- AlterTable
ALTER TABLE "plan_deliveries" ADD COLUMN "deliveredAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "orders" ADD COLUMN "deliveredAt" TIMESTAMP(3),
ADD COLUMN "settlementStatus" "OrderSettlementStatus",
ADD COLUMN "settledAt" TIMESTAMP(3),
ADD COLUMN "walletTransactionId" TEXT;

-- AlterTable
ALTER TABLE "manage_delivery_change_requests" ADD COLUMN "orderId" TEXT,
ADD COLUMN "currentAmountPaise" INTEGER,
ADD COLUMN "requestedAmountPaise" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "orders_walletTransactionId_key" ON "orders"("walletTransactionId");

-- CreateIndex
CREATE INDEX "orders_settlementStatus_idx" ON "orders"("settlementStatus");

-- CreateIndex
CREATE INDEX "manage_delivery_change_requests_orderId_idx" ON "manage_delivery_change_requests"("orderId");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_walletTransactionId_fkey" FOREIGN KEY ("walletTransactionId") REFERENCES "wallet_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manage_delivery_change_requests" ADD CONSTRAINT "manage_delivery_change_requests_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
