-- AlterTable
ALTER TABLE "wallets" ADD COLUMN     "autoCreditEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: any wallet that has ever had a COMPLETED credit (i.e. there is at
-- least one CREDIT ledger row of referenceType CREDIT_REQUEST against it) has
-- already satisfied the "first credit requires admin approval" rule for that
-- customer. Enable auto-credit for them so pre-existing customers do not land
-- in a worse state after this change than they were in before.
--
-- Deterministic: based on actual immutable ledger history, not on current
-- balance (which could be 0 after spends) and not on request status (which
-- could be PENDING or REJECTED).
UPDATE "wallets"
SET "autoCreditEnabled" = true
WHERE "id" IN (
  SELECT DISTINCT "walletId"
  FROM "wallet_transactions"
  WHERE "type" = 'CREDIT'
    AND "referenceType" = 'CREDIT_REQUEST'
);
