-- Audit trail for admin subscription-schedule approval.
--
-- `adminId` was already passed into adminApproveSubscription and discarded, and
-- the approval note the admin UI collects was validated then dropped on the
-- floor. These three nullable columns give both somewhere to live.
--
-- Deliberately separate from the payment columns: approving a schedule must
-- never write paidAt or paidAmountPaise.
ALTER TABLE "plan_selections" ADD COLUMN IF NOT EXISTS "approvedByAdminId" TEXT;
ALTER TABLE "plan_selections" ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3);
ALTER TABLE "plan_selections" ADD COLUMN IF NOT EXISTS "approvalNote" TEXT;
