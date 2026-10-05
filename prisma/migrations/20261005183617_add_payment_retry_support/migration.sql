-- DropIndex
DROP INDEX "payments_walletCreditRequestId_key";

-- CreateIndex
CREATE INDEX "payments_walletCreditRequestId_idx" ON "payments"("walletCreditRequestId");

-- A credit request may accumulate many FAILED / CANCELLED / EXPIRED attempts
-- (that is what a retry is), but it may have at most ONE payment in a live or
-- settled status. This is the database-level guarantee that a single wallet
-- credit request can never be funded twice, no matter how many concurrent
-- callbacks, webhooks or retries arrive.
CREATE UNIQUE INDEX "payments_one_live_payment_per_credit_request"
  ON "payments" ("walletCreditRequestId")
  WHERE "walletCreditRequestId" IS NOT NULL
    AND "status" IN ('PENDING', 'PROCESSING', 'SUCCESS', 'REFUND_PENDING', 'REFUNDED');
