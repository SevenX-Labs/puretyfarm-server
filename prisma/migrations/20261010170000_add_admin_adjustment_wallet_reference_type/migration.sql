-- Add ADMIN_ADJUSTMENT to wallet transaction reference type enum.
ALTER TYPE "WalletTransactionReferenceType" ADD VALUE IF NOT EXISTS 'ADMIN_ADJUSTMENT';
