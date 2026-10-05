-- CreateEnum
CREATE TYPE "PaymentProviderType" AS ENUM ('PAYU');

-- CreateEnum
CREATE TYPE "PaymentPurpose" AS ENUM ('ORDER', 'WALLET_TOPUP');

-- CreateEnum
CREATE TYPE "PaymentTransactionStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUND_PENDING', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('ONLINE', 'CASH');

-- CreateEnum
CREATE TYPE "CashCollectionStatus" AS ENUM ('PENDING', 'COLLECTED', 'CONFIRMED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "WalletCreditRequestStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "wallet_credit_requests" ADD COLUMN     "source" "PaymentMethod";

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT,
    "walletCreditRequestId" TEXT,
    "provider" "PaymentProviderType" NOT NULL,
    "purpose" "PaymentPurpose" NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'ONLINE',
    "transactionId" TEXT NOT NULL,
    "providerPaymentId" TEXT,
    "amountPaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "PaymentTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "providerResponse" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "providerRefundId" TEXT,
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_collections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletCreditRequestId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "status" "CashCollectionStatus" NOT NULL DEFAULT 'PENDING',
    "collectedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "confirmedByAdminId" TEXT,
    "adminNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cash_collections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_walletCreditRequestId_key" ON "payments"("walletCreditRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_transactionId_key" ON "payments"("transactionId");

-- CreateIndex
CREATE INDEX "payments_userId_createdAt_idx" ON "payments"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "payments_status_createdAt_idx" ON "payments"("status", "createdAt");

-- CreateIndex
CREATE INDEX "payments_purpose_status_idx" ON "payments"("purpose", "status");

-- CreateIndex
CREATE INDEX "payments_orderId_idx" ON "payments"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_userId_idempotencyKey_key" ON "payments"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "cash_collections_walletCreditRequestId_key" ON "cash_collections"("walletCreditRequestId");

-- CreateIndex
CREATE INDEX "cash_collections_userId_createdAt_idx" ON "cash_collections"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "cash_collections_status_createdAt_idx" ON "cash_collections"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_walletCreditRequestId_fkey" FOREIGN KEY ("walletCreditRequestId") REFERENCES "wallet_credit_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_collections" ADD CONSTRAINT "cash_collections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_collections" ADD CONSTRAINT "cash_collections_walletCreditRequestId_fkey" FOREIGN KEY ("walletCreditRequestId") REFERENCES "wallet_credit_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_collections" ADD CONSTRAINT "cash_collections_confirmedByAdminId_fkey" FOREIGN KEY ("confirmedByAdminId") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CHECK: money is always a positive integer number of paise
ALTER TABLE "payments" ADD CONSTRAINT "payments_amountPaise_positive" CHECK ("amountPaise" > 0);
ALTER TABLE "cash_collections" ADD CONSTRAINT "cash_collections_amountPaise_positive" CHECK ("amountPaise" > 0);

-- CHECK: a wallet top-up has no order, an order payment has no credit request.
-- Enforces the purpose/linkage invariant at the database level so no code path
-- can create a payment that funds both or neither.
ALTER TABLE "payments" ADD CONSTRAINT "payments_purpose_linkage" CHECK (
  ("purpose" = 'WALLET_TOPUP' AND "orderId" IS NULL)
  OR ("purpose" = 'ORDER' AND "walletCreditRequestId" IS NULL)
);
