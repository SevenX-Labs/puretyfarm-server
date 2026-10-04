-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "adminId" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "admins" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admins_email_key" ON "admins"("email");

-- CreateIndex
CREATE INDEX "admins_email_idx" ON "admins"("email");

-- CreateIndex
CREATE INDEX "admins_isActive_idx" ON "admins"("isActive");

-- CreateIndex
CREATE INDEX "sessions_adminId_idx" ON "sessions"("adminId");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
