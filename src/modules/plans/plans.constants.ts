/**
 * Plan domain constants. Business-invariant structural values live here.
 * Prices and configurable limits live in the PlanConfig database table.
 */

/** The three plan types offered to customers. */
export enum PlanType {
  BUY_ONCE = "BUY_ONCE",
  SEVEN_DAY_TRIAL = "SEVEN_DAY_TRIAL",
  MONTHLY = "MONTHLY",
}

/** Monthly plan delivery frequency. */
export enum DeliveryFrequency {
  DAILY = "DAILY",
  ALTERNATE_DAYS = "ALTERNATE_DAYS",
}

/** Monthly plan quantity customisation mode. */
export enum QuantityMode {
  FIXED = "FIXED",
  ALTERNATING = "ALTERNATING",
}

/** Quote status lifecycle. */
export enum PlanQuoteStatus {
  PENDING = "PENDING",
  CONFIRMED = "CONFIRMED",
  EXPIRED = "EXPIRED",
  CANCELLED = "CANCELLED",
}

/** Selection status lifecycle. */
export enum PlanSelectionStatus {
  CONFIRMED = "CONFIRMED",
  PENDING_PAYMENT = "PENDING_PAYMENT",
  ACTIVE = "ACTIVE",
  COMPLETED = "COMPLETED",
  CANCELLED = "CANCELLED",
}

/** How long a quote remains valid before automatic expiry (in minutes). */
export const QUOTE_EXPIRY_MINUTES = 30;

/** Absolute structural quantity boundaries (enforced in DTOs). */
export const QUANTITY_MIN = 1;
export const QUANTITY_MAX = 5;
