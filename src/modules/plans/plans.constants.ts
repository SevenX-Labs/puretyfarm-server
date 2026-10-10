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

/**
 * Daily order cut-off: 23:00 (11:00 PM) India Standard Time.
 *
 * This is an ORDER cut-off, not a delivery window. It answers "is there still
 * time to put this customer on tomorrow's run?", and is deliberately unrelated
 * to `PlanConfig.deliveryStartTime`/`deliveryEndTime`, which describe when the
 * van arrives. Conflating the two made a 6:00-11:00 window silently mean
 * "stop taking orders at 11 AM".
 *
 * Policy:
 *   - before 23:00 IST  -> first delivery is the NEXT calendar day (IST)
 *   - at/after 23:00 IST -> tomorrow's run is already planned, so the first
 *     delivery is the day AFTER next
 *
 * It is a single operational policy for the whole business (one morning run),
 * not a per-plan setting, so it lives here rather than on PlanConfig. The
 * value is exposed through the plans APIs so neither frontend hardcodes it;
 * promoting it to a configurable column later means adding a nullable field
 * that falls back to this constant, with no change to the rule itself.
 */
export const ORDER_CUTOFF_HHMM = "23:00";

/** `ORDER_CUTOFF_HHMM` as minutes since IST midnight (23 * 60). */
export const ORDER_CUTOFF_MINUTES_IST = 23 * 60;

/**
 * Calendar days from "today in IST" to the first deliverable day.
 * Index 0 is the before-cut-off case, index 1 the at/after-cut-off case.
 */
export const LEAD_DAYS_BEFORE_CUTOFF = 1;
export const LEAD_DAYS_AFTER_CUTOFF = 2;

/**
 * 24-hour "HH:MM" — the only accepted wire format for a delivery window.
 * Re-exported from the shared IST helpers so the DTO, the service and the
 * cut-off logic all validate against one pattern.
 */
export { HH_MM_PATTERN as DELIVERY_TIME_PATTERN } from "../../common/utils/ist-date.util";

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
