-- CreateEnum
CREATE TYPE "ChangeRequestType" AS ENUM ('CHANGE_QUANTITY', 'CHANGE_FREQUENCY', 'CHANGE_PLAN');

-- CreateEnum
CREATE TYPE "ChangeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "manage_delivery_change_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planSelectionId" TEXT NOT NULL,
    "requestType" "ChangeRequestType" NOT NULL,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "currentConfiguration" JSONB NOT NULL,
    "requestedConfiguration" JSONB NOT NULL,
    "adminId" TEXT,
    "adminNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manage_delivery_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "manage_delivery_change_requests_userId_idx" ON "manage_delivery_change_requests"("userId");

-- CreateIndex
CREATE INDEX "manage_delivery_change_requests_userId_status_idx" ON "manage_delivery_change_requests"("userId", "status");

-- CreateIndex
CREATE INDEX "manage_delivery_change_requests_planSelectionId_idx" ON "manage_delivery_change_requests"("planSelectionId");

-- CreateIndex
CREATE INDEX "manage_delivery_change_requests_status_idx" ON "manage_delivery_change_requests"("status");

-- AddForeignKey
ALTER TABLE "manage_delivery_change_requests" ADD CONSTRAINT "manage_delivery_change_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manage_delivery_change_requests" ADD CONSTRAINT "manage_delivery_change_requests_planSelectionId_fkey" FOREIGN KEY ("planSelectionId") REFERENCES "plan_selections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manage_delivery_change_requests" ADD CONSTRAINT "manage_delivery_change_requests_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;
