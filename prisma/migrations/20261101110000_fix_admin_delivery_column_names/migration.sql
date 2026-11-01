-- Fix column names: the previous migration used snake_case but the schema
-- expects camelCase (no @map annotations).
ALTER TABLE "plan_deliveries" RENAME COLUMN "action_by" TO "actionBy";
ALTER TABLE "plan_deliveries" RENAME COLUMN "admin_note" TO "adminNote";
ALTER TABLE "plan_deliveries" RENAME COLUMN "rescheduled_from" TO "rescheduledFrom";
