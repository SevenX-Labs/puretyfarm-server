-- Add CASH_COLLECTION to wallet transaction reference type enum.
ALTER TYPE "WalletTransactionReferenceType" ADD VALUE IF NOT EXISTS 'CASH_COLLECTION';
