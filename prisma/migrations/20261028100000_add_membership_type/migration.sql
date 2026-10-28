-- CreateEnum
CREATE TYPE "MembershipType" AS ENUM ('NORMAL', 'VIP');

-- AlterTable
ALTER TABLE "customer_profiles" ADD COLUMN "membershipType" "MembershipType" NOT NULL DEFAULT 'NORMAL';
