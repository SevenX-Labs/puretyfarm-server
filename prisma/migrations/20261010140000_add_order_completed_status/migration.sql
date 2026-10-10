-- Order completion workflow.
--
-- COMPLETED is a new terminal order status, reachable only from DELIVERED.
-- It is additive: every existing row keeps its current status, and no existing
-- query filters on it, so dashboards, revenue aggregates and the customer
-- order history are unaffected until an admin actually completes an order.
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'COMPLETED';

-- Timestamp of the completion, following the nullable-timestamp convention
-- already used by `plan_selections.paidAt` and `cash_collections.confirmedAt`.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);
