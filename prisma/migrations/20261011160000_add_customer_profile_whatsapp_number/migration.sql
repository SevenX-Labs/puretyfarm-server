-- AlterTable: Add whatsappNumber column to customer_profiles to resolve schema discrepancy (P2022)
ALTER TABLE "customer_profiles" ADD COLUMN "whatsappNumber" TEXT;
