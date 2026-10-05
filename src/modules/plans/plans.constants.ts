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

/** Lifecycle of a single scheduled delivery (mirrors the Prisma enum). */
export enum DeliveryStatus {
  SCHEDULED = "SCHEDULED",
  SKIPPED = "SKIPPED",
  DELIVERED = "DELIVERED",
}

/** How long a quote remains valid before automatic expiry (in minutes). */
export const QUOTE_EXPIRY_MINUTES = 30;

/** Absolute structural quantity boundaries (enforced in DTOs). */
export const QUANTITY_MIN = 1;
export const QUANTITY_MAX = 5;

/** The 7-Day Trial may be used at most once per customer (business-invariant). */
export const TRIAL_MAX_USES = 1;

/** The 7-Day Trial duration is fixed to exactly 7 days (business-invariant). */
export const TRIAL_DURATION_DAYS = 7;

/**
 * Admin configuration bounds. The price ceiling (₹10,000/litre, in paise) keeps
 * every quote total (price × up to 31 deliveries × 5 L) inside a 32-bit Int column.
 */
export const PRICE_PER_LITRE_MAX_PAISE = 1_000_000;
export const BUY_ONCE_MAX_USAGES_LIMIT = 100;

/** Types of delivery change that require admin approval. */
export enum ChangeRequestType {
  CHANGE_QUANTITY = "CHANGE_QUANTITY",
  CHANGE_FREQUENCY = "CHANGE_FREQUENCY",
  CHANGE_PLAN = "CHANGE_PLAN",
}

/** Lifecycle of an admin-approval request. */
export enum ChangeRequestStatus {
  PENDING = "PENDING",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
}
