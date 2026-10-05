-- Admin-configurable Monthly plan options. Additive and non-destructive: every
-- existing row defaults to all options enabled, preserving current behaviour.

-- AlterTable
ALTER TABLE "plan_configs" ADD COLUMN     "alternateDaysEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "alternatingQuantityEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "dailyEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "fixedQuantityEnabled" BOOLEAN NOT NULL DEFAULT true;
