-- Add PHONEPE to the payment provider enum for the PayU -> PhonePe migration.
-- PAYU is deliberately left in place so historical payments still deserialise
-- and so the cutover can be rolled back without another migration.
ALTER TYPE "PaymentProviderType" ADD VALUE IF NOT EXISTS 'PHONEPE';
