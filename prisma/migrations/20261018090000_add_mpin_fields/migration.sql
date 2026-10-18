-- AlterTable
ALTER TABLE "users" ADD COLUMN "mpinHash" TEXT;
ALTER TABLE "users" ADD COLUMN "mpinCreatedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "mpinUpdatedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "failedMpinAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "mpinLockedUntil" TIMESTAMP(3);
