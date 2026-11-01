-- Add fields to PlanDelivery for admin-initiated skip/reschedule with notes.
-- actionBy tracks whether the skip/reschedule was done by CUSTOMER or ADMIN.
-- adminNote stores the reason visible to the customer.
-- rescheduledFrom stores the original date when a delivery is rescheduled.

ALTER TABLE "plan_deliveries" ADD COLUMN "action_by" TEXT;
ALTER TABLE "plan_deliveries" ADD COLUMN "admin_note" TEXT;
ALTER TABLE "plan_deliveries" ADD COLUMN "rescheduled_from" DATE;

-- Add SKIP and RESCHEDULE to ChangeRequestType enum for audit trail.
ALTER TYPE "ChangeRequestType" ADD VALUE IF NOT EXISTS 'SKIP';
ALTER TYPE "ChangeRequestType" ADD VALUE IF NOT EXISTS 'RESCHEDULE';
