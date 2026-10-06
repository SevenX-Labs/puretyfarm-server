-- Add PLAN_SELECTION to wallet transaction reference type enum.
ALTER TYPE "WalletTransactionReferenceType" ADD VALUE IF NOT EXISTS 'PLAN_SELECTION';

-- Add payment tracking fields to plan_selections.
ALTER TABLE "plan_selections"
  ADD COLUMN "paymentMethod" TEXT,
  ADD COLUMN "paidAt" TIMESTAMP(3),
  ADD COLUMN "paidAmountPaise" INTEGER;

-- Make walletCreditRequestId nullable on cash_collections so that
-- plan-payment cash collections do not require a wallet credit request.
ALTER TABLE "cash_collections"
  ALTER COLUMN "walletCreditRequestId" DROP NOT NULL;

-- Add planSelectionId FK to cash_collections for plan cash payments.
ALTER TABLE "cash_collections"
  ADD COLUMN "planSelectionId" TEXT;

-- FK constraint for planSelectionId.
ALTER TABLE "cash_collections"
  ADD CONSTRAINT "cash_collections_planSelectionId_fkey"
  FOREIGN KEY ("planSelectionId") REFERENCES "plan_selections"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one business purpose must be attached to a cash collection.
-- Either walletCreditRequestId OR planSelectionId must be non-null, never both, never neither.
ALTER TABLE "cash_collections"
  ADD CONSTRAINT "cash_collections_single_purpose"
  CHECK (
    (("walletCreditRequestId" IS NOT NULL)::int + ("planSelectionId" IS NOT NULL)::int) = 1
  );

-- Prevent duplicate cash collections for the same plan selection.
CREATE UNIQUE INDEX "cash_collections_planSelectionId_key"
  ON "cash_collections" ("planSelectionId")
  WHERE "planSelectionId" IS NOT NULL;

-- Index for plan selection cash collection lookups.
CREATE INDEX "cash_collections_planSelectionId_idx"
  ON "cash_collections" ("planSelectionId")
  WHERE "planSelectionId" IS NOT NULL;

-- Prevent duplicate plan selections for the same quote.
-- Only non-cancelled selections count.
CREATE UNIQUE INDEX "plan_selections_one_per_quote"
  ON "plan_selections" ("quoteId")
  WHERE "status" != 'CANCELLED';
