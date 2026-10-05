-- CreateEnum
CREATE TYPE "WalletCreditRequestStatus" AS ENUM ('PENDING', 'COMPLETED', 'REJECTED');

-- CreateEnum
CREATE TYPE "WalletRefundStatus" AS ENUM ('NOT_REQUIRED', 'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED');

-- CreateEnum
CREATE TYPE "WalletTransactionType" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "WalletTransactionReferenceType" AS ENUM ('CREDIT_REQUEST', 'ORDER');

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "balancePaise" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_credit_requests" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "status" "WalletCreditRequestStatus" NOT NULL DEFAULT 'PENDING',
    "refundStatus" "WalletRefundStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "autoApproved" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "reviewedByAdminId" TEXT,
    "adminNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_credit_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "type" "WalletTransactionType" NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "balanceAfterPaise" INTEGER NOT NULL,
    "referenceType" "WalletTransactionReferenceType" NOT NULL,
    "referenceId" TEXT NOT NULL,
    "creditRequestId" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallets_userId_key" ON "wallets"("userId");

-- CreateIndex
CREATE INDEX "wallet_credit_requests_walletId_createdAt_idx" ON "wallet_credit_requests"("walletId", "createdAt");

-- CreateIndex
CREATE INDEX "wallet_credit_requests_status_createdAt_idx" ON "wallet_credit_requests"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_credit_requests_walletId_idempotencyKey_key" ON "wallet_credit_requests"("walletId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_creditRequestId_key" ON "wallet_transactions"("creditRequestId");

-- CreateIndex
CREATE INDEX "wallet_transactions_walletId_createdAt_idx" ON "wallet_transactions"("walletId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_type_referenceType_referenceId_key" ON "wallet_transactions"("type", "referenceType", "referenceId");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_credit_requests" ADD CONSTRAINT "wallet_credit_requests_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_credit_requests" ADD CONSTRAINT "wallet_credit_requests_reviewedByAdminId_fkey" FOREIGN KEY ("reviewedByAdminId") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_creditRequestId_fkey" FOREIGN KEY ("creditRequestId") REFERENCES "wallet_credit_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CHECK: balance can never go negative
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_balancePaise_non_negative" CHECK ("balancePaise" >= 0);

-- Partial unique index: at most one PENDING credit request per wallet
CREATE UNIQUE INDEX "wallet_credit_requests_one_pending_per_wallet"
  ON "wallet_credit_requests" ("walletId")
  WHERE "status" = 'PENDING';

-- Immutable ledger: reject UPDATE and DELETE on wallet_transactions
CREATE OR REPLACE FUNCTION wallet_transactions_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'wallet_transactions rows are immutable: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wallet_transactions_no_update
  BEFORE UPDATE ON "wallet_transactions"
  FOR EACH ROW EXECUTE FUNCTION wallet_transactions_immutable();

CREATE TRIGGER wallet_transactions_no_delete
  BEFORE DELETE ON "wallet_transactions"
  FOR EACH ROW EXECUTE FUNCTION wallet_transactions_immutable();
