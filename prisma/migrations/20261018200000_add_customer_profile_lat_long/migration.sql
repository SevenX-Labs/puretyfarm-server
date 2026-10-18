-- AlterTable: Add latitude and longitude to customer_profiles
ALTER TABLE "customer_profiles" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "customer_profiles" ADD COLUMN "longitude" DOUBLE PRECISION;
