-- Approval-gated pause / resume for Manage Delivery.
--
-- Pause previously mutated the live plan the moment a customer clicked it,
-- marking every future delivery SKIPPED with no way back. Routing it through
-- the existing ManageDeliveryChangeRequest workflow needs two new enum values
-- plus a PAUSED selection state. Both are additive: no existing row changes,
-- and no existing query filters on the new values.
ALTER TYPE "ChangeRequestType" ADD VALUE IF NOT EXISTS 'PAUSE';
ALTER TYPE "ChangeRequestType" ADD VALUE IF NOT EXISTS 'RESUME';

-- PAUSED is a non-terminal suspension, distinct from CANCELLED.
ALTER TYPE "PlanSelectionStatus" ADD VALUE IF NOT EXISTS 'PAUSED';
